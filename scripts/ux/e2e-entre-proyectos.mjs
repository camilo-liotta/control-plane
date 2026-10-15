#!/usr/bin/env node
// Prueba de punta a punta de los mensajes entre orquestadoras y del cerrojo de SendMessage, contra un
// server de verdad (otro puerto, otros datos, el Claude falso de los tests). No toca el :4700, ~/.control-plane ni ~/.claude.
//   node scripts/ux/e2e-entre-proyectos.mjs          # corre todo y muestra la tabla
//   node scripts/ux/e2e-entre-proyectos.mjs keep     # deja el server levantado al final (puerto CP_E2E_PORT, 4730)
// Datos y logs en ~/.cache/cp-ux/entre-proyectos (CP_UX_HOME cambia la base).
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { CACHE, REPO } from "./paths.mjs"

const ROOT = path.join(CACHE, "entre-proyectos")
const PORT = Number(process.env.CP_E2E_PORT ?? 4730)
const BASE = `http://127.0.0.1:${PORT}`
const keep = process.argv.includes("keep")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.rmSync(ROOT, { recursive: true, force: true })
for (const d of ["data", "home/.claude", "repos/alfa", "repos/beta"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true })
const { writeFakeClaude } = await import(pathToFileURL(path.join(REPO, "server/test/fake-claude.ts")).href)
const fake = writeFakeClaude(ROOT)

let server = null
const launch = () => {
  const log = fs.openSync(path.join(ROOT, "server.log"), "a")
  server = spawn(process.execPath, [path.join(REPO, "server/src/index.ts")], {
    cwd: path.join(REPO, "server"),
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      HOME: path.join(ROOT, "home"),
      PATH: process.env.PATH,
      CONTROL_PLANE_PORT: String(PORT),
      CONTROL_PLANE_HOME: path.join(ROOT, "data"),
      CLAUDE_BIN: fake,
      CLAUDE_CONFIG_DIR: path.join(ROOT, "home/.claude"),
      FAKE_LONG_MS: "9000",
    },
  })
  server.unref()
}
const stop = async () => {
  if (!server) return
  process.kill(server.pid, "SIGTERM")
  for (let i = 0; i < 60; i++) {
    try { process.kill(server.pid, 0) } catch { server = null; return }
    await sleep(250)
  }
  process.kill(server.pid, "SIGKILL")
  server = null
}
const waitUp = async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + "/api/health")).ok) return } catch {}
    await sleep(250)
  }
  throw new Error("el server no levantó (mirá " + path.join(ROOT, "server.log") + ")")
}
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const until = async (what, fn, ms = 30000) => {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  throw new Error("Se esperaba: " + what)
}
const events = async (sid) => (await api("GET", `/api/sessions/${sid}/events?limit=500`)).map((e) => e.event)
const batches = async (sid) => (await events(sid)).filter((e) => e.kind === "batch" && e.projectMessages?.length)
const say = (sid, text) => api("POST", `/api/sessions/${sid}/messages`, { text })
const mp = (sid, project, message, replyTo) => say(sid, `MCP message_project ${JSON.stringify({ project, message, ...(replyTo ? { replyTo } : {}) })}`)
/** Lo que contestó la última herramienta (el Claude falso lo repite como "OK: …" o "ERROR: …"). */
const lastTool = async (sid, name) => {
  const evs = await events(sid)
  const use = [...evs].reverse().find((e) => e.kind === "tool_use" && e.name === name)
  const res = use && evs.find((e) => e.kind === "tool_result" && e.toolUseId === use.id)
  return res ? String(res.content) : null
}
const messages = (pid) => api("GET", `/api/projects/${pid}/messages`)

const rows = []
const check = (n, what, ok, detail = "") => {
  rows.push({ n, what, ok, detail })
  console.log(`${ok ? "✅" : "❌"} ${n}. ${what}${detail ? " — " + detail : ""}`)
  if (!ok) process.exitCode = 1
}

try {
  launch()
  await waitUp()
  const mkProject = (name, repo) => api("POST", "/api/projects", { name, repoPath: path.join(ROOT, "repos", repo), orchestratorName: "ORQ-" + name.toUpperCase(), settings: { batchWindowSec: 1 } })
  const alfa = await mkProject("Alfa", "alfa")
  const beta = await mkProject("Beta", "beta")
  const snap = async () => api("GET", "/api/snapshot")
  const find = async (name) => (await snap()).sessions.find((s) => s.name === name)
  const orqA = await find("ORQ-ALFA")
  const orqB = await find("ORQ-BETA")
  const wA = await api("POST", `/api/projects/${alfa.id}/sessions`, { name: "W-ALFA", role: "worker" })
  const wB = await api("POST", `/api/projects/${beta.id}/sessions`, { name: "W-BETA", role: "worker" })
  const idle = (sid) => until("sesión quieta " + sid, async () => (await snap()).sessions.find((s) => s.id === sid)?.status === "idle", 60000)
  for (const s of [orqA, orqB, wA, wB]) { await api("POST", `/api/sessions/${s.id}/start`).catch(() => {}); await idle(s.id) }

  // 1 y 2: A le escribe a B (quieta): se despierta.
  await mp(orqA.id, "Beta", "Necesitamos GET /api/turnos?inquilino=<id> con los turnos de las próximas 4 semanas, para la ficha del contrato. ¿Para el jueves?")
  const m1 = (await until("el mensaje en la base", async () => (await messages(alfa.id))[0])).id
  const b1 = await until("lote en la orquestadora de Beta", async () => (await batches(orqB.id))[0], 20000)
  check(1, "A le escribe a B con message_project", /enviado/.test((await lastTool(orqA.id, "mcp__control-plane__message_project")) ?? ""), m1)
  check(2, "B está quieta: se despierta y le llega el lote", b1.projectMessages[0].id === m1 && /^\[control-plane\] Mensajes de otros proyectos: 1 mensaje nuevo \(de «Alfa»\)/.test(b1.text) && /De la orquestadora de «Alfa» \(id m_/.test(b1.text) && b1.reportIds.length === 0, b1.text.split("\n")[0])
  await idle(orqB.id)

  // 3 y 4: B contesta con replyTo y a A le llega.
  await mp(orqB.id, "Alfa", "Sí, lo hacemos nosotros: devuelve { id, fecha, estado }. Les aviso cuando esté en staging.", m1)
  const m2 = await until("la respuesta en la base", async () => (await messages(beta.id)).find((m) => m.fromProjectId === beta.id))
  const a1 = await until("lote en la orquestadora de Alfa", async () => (await batches(orqA.id))[0], 20000)
  check(3, "B contesta con replyTo", m2.replyTo === m1 && /enviado/.test((await lastTool(orqB.id, "mcp__control-plane__message_project")) ?? ""), `${m2.id} → ${m1}`)
  check(4, "a A le llega la respuesta, marcada en respuesta a m1", a1.projectMessages[0].replyTo === m1 && a1.text.includes(`en respuesta a ${m1}`))
  await idle(orqA.id)

  // 5: B trabajando: el mensaje espera hasta que termine el turno.
  await say(orqB.id, "LARGO")
  await until("B trabajando", async () => (await snap()).sessions.find((s) => s.id === orqB.id)?.status === "working", 10000)
  const before = (await batches(orqB.id)).length
  await mp(orqA.id, "Beta", "¿Pueden sumar el nombre del técnico asignado?")
  const m3 = await until("el segundo mensaje", async () => (await messages(alfa.id)).find((m) => m.fromProjectId === alfa.id && m.id !== m1))
  await sleep(3500)
  const waited = (await batches(orqB.id)).length === before && (await messages(alfa.id)).find((m) => m.id === m3.id).deliveredAt === null
  const queuedCount = (await snap()).projects.find((p) => p.id === beta.id).review.queued
  const b2 = await until("entrega al terminar el turno de B", async () => (await batches(orqB.id))[before], 30000)
  check(5, "B trabajando: el mensaje espera y llega al terminar el turno", waited && queuedCount === 1 && b2.projectMessages[0].id === m3.id, `en cola mientras trabajaba (queued=${queuedCount})`)
  await idle(orqB.id)

  // 6: el límite (10 por hora y por sentido).
  let limitText = null
  for (let i = 0; i < 10 && !limitText; i++) {
    await mp(orqA.id, "Beta", "mensaje de relleno " + i)
    await until("turno de A", async () => (await snap()).sessions.find((s) => s.id === orqA.id)?.status === "idle")
    const t = await lastTool(orqA.id, "mcp__control-plane__message_project")
    if (/límite/.test(t ?? "")) limitText = t
  }
  const sent = (await messages(alfa.id)).filter((m) => m.fromProjectId === alfa.id).length
  check(6, "el límite corta el mensaje 11 con un error en palabras", sent === 10 && /el límite es 10 por hora.*pedile al usuario/s.test(limitText ?? ""), `${sent} enviados; ${(limitText ?? "").slice(0, 90)}…`)

  // 7: reinicio con un mensaje en cola (B→A: el límite de A→B ya se usó; cada sentido cuenta aparte).
  await say(orqA.id, "LARGO")
  await until("A trabajando", async () => (await snap()).sessions.find((s) => s.id === orqA.id)?.status === "working", 10000)
  await mp(orqB.id, "Alfa", "Mensaje que espera durante el reinicio")
  const waiting = await until("mensaje B→A sin entregar", async () => (await messages(alfa.id)).find((m) => m.text === "Mensaje que espera durante el reinicio"), 15000)
  await stop()
  launch()
  await waitUp()
  const after = (await messages(alfa.id)).find((m) => m.id === waiting.id)
  const stillQueued = after && after.deliveredAt === null
  const snap2 = await snap()
  const q = snap2.projects.find((p) => p.id === alfa.id).review.queued
  check(7, "un reinicio en el medio: el mensaje sigue en la cola", stillQueued && q >= 1, `queued=${q} tras reiniciar`)
  await api("POST", `/api/sessions/${orqA.id}/start`)
  const b3 = await until("entrega tras reiniciar", async () => (await batches(orqA.id)).find((b) => b.projectMessages.some((m) => m.id === waiting.id)), 30000)
  check("7b", "al levantar la orquestadora de A se le entrega", Boolean(b3), "lote con el mensaje de antes del reinicio")

  // 8: el cerrojo de SendMessage.
  const out = async (sid, to) => {
    const n = (await events(sid)).length
    await say(sid, "SENDMSG " + to)
    await until("turno " + to, async () => (await events(sid)).length > n && (await snap()).sessions.find((s) => s.id === sid)?.status === "idle", 20000)
    return JSON.stringify((await events(sid)).slice(n))
  }
  await api("POST", `/api/sessions/${wA.id}/start`).catch(() => {})
  await idle(wA.id)
  await api("POST", `/api/sessions/${orqA.id}/start`).catch(() => {})
  await idle(orqA.id)
  const r1 = await out(wA.id, "W-BETA")
  check(8, "SendMessage de un worker de A a un worker de B: rechazado", r1.includes("Solo podés hablar con sesiones de tu proyecto") && !r1.includes("ENVIADO"))
  const r2 = await out(wA.id, "ORQ-BETA")
  check("8b", "…y a la orquestadora de B también", r2.includes("pedíselo a tu orquestadora"))
  const r3 = await out(orqA.id, "ORQ-BETA")
  check("8c", "SendMessage de la orquestadora de A a la de B: rechazado, con message_project", r3.includes("Para hablar con otro proyecto usá message_project"))
  const r4 = await out(wA.id, "ORQ-ALFA")
  check("8d", "SendMessage dentro del propio proyecto: pasa", r4.includes("ENVIADO a ORQ-ALFA"))
  const r5 = await out(wA.id, "MI-TERMINAL")
  check("8e", "SendMessage a algo que no es del dashboard: rechazado", r5.includes("no es una sesión de este dashboard"))

  console.log("\n| # | Qué | Resultado |\n|---|---|---|")
  for (const r of rows) console.log(`| ${r.n} | ${r.what} | ${r.ok ? "✅" : "❌"} |`)
} catch (err) {
  console.error("❌ " + (err instanceof Error ? err.message : err))
  process.exitCode = 1
} finally {
  if (keep && process.exitCode !== 1) console.log(`\nServer levantado: ${BASE} (pid ${server?.pid}). Datos: ${ROOT}. Para bajarlo: kill ${server?.pid}`)
  else await stop()
}
