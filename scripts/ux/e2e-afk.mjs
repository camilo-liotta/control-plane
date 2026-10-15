#!/usr/bin/env node
// Prueba de punta a punta del modo AFK contra un server de verdad (otro puerto, otros datos, el Claude
// falso de los tests). No toca el :4700, ~/.control-plane ni ~/.claude. Cada turno del Claude falso
// cuesta US$ 0,25: con eso se prueba el tope de gasto.
//   node scripts/ux/e2e-afk.mjs            # corre todo, saca capturas y muestra la tabla
//   node scripts/ux/e2e-afk.mjs keep       # deja el server levantado al final (puerto CP_E2E_PORT, 4731)
//   node scripts/ux/e2e-afk.mjs nocap      # sin capturas (no necesita el navegador del banco)
// Datos, logs y capturas en ~/.cache/cp-ux/afk (CP_UX_HOME cambia la base). Necesita `npm run build -w web`.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { CACHE, REPO } from "./paths.mjs"

const ROOT = path.join(CACHE, "afk")
const PORT = Number(process.env.CP_E2E_PORT ?? 4731)
const BASE = `http://127.0.0.1:${PORT}`
const keep = process.argv.includes("keep")
const captures = !process.argv.includes("nocap")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.rmSync(ROOT, { recursive: true, force: true })
for (const d of ["data", "home/.claude", "repos/demo"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true })
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
const say = (sid, text) => api("POST", `/api/sessions/${sid}/messages`, { text })
const snap = () => api("GET", "/api/snapshot")
const idle = (sid) => until("sesión quieta " + sid, async () => (await snap()).sessions.find((s) => s.id === sid)?.status === "idle", 60000)
/** Una herramienta de control-plane por el MCP de la sesión; devuelve lo que contestó. */
const tool = async (sid, name, input) => {
  const n = (await events(sid)).length
  await say(sid, `MCP ${name} ${JSON.stringify(input)}`)
  await until("turno de " + name, async () => (await events(sid)).length > n && (await snap()).sessions.find((s) => s.id === sid)?.status === "idle", 30000)
  const evs = await events(sid)
  const use = [...evs].reverse().find((e) => e.kind === "tool_use" && e.name === "mcp__control-plane__" + name)
  const res = use && evs.find((e) => e.kind === "tool_result" && e.toolUseId === use.id)
  return res ? String(res.content) : ""
}
const notices = async (sid) => (await events(sid)).filter((e) => e.kind === "notice").map((e) => e.text)
const drafts = async () => (await snap()).drafts
const project = async (pid) => (await snap()).projects.find((p) => p.id === pid)

// Los avisos que llegan por el WS (el toast que ve la web y el que muestra el escritorio).
const toasts = []
const listen = () => {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/ws")
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data)
    if (m.type === "toast") toasts.push(m)
  })
  return ws
}
let wsConn = null

const rows = []
const check = (n, what, ok, detail = "") => {
  rows.push({ n, what, ok, detail })
  console.log(`${ok ? "✅" : "❌"} ${n}. ${what}${detail ? " — " + detail : ""}`)
  if (!ok) process.exitCode = 1
}

// Capturas (claro y oscuro) con el navegador del banco.
const shots = []
let cdp = null
const shoot = async (name, route, { width = 1440, height = 900, before } = {}) => {
  if (!captures) return
  try {
    cdp ??= await import(pathToFileURL(path.join(REPO, "scripts/ux/cdp.mjs")).href)
    for (const theme of ["light", "dark"]) {
      const t = await cdp.open({ base: BASE, width, height })
      try {
        await t.goto(route)
        await t.theme(theme)
        if (before) await before(t)
        const file = path.join(ROOT, `${name}--${theme}-${width}.png`)
        await t.shot(file)
        shots.push(file)
      } finally {
        await t.close()
      }
    }
  } catch (err) {
    console.log("⚠️  sin captura " + name + ": " + (err instanceof Error ? err.message : err))
  }
}

try {
  launch()
  await waitUp()
  wsConn = listen()
  const demo = await api("POST", "/api/projects", { name: "Demo AFK", repoPath: path.join(ROOT, "repos/demo"), orchestratorName: "ORQ-DEMO", settings: { batchWindowSec: 1 } })
  const pid = demo.id
  const find = async (name) => (await snap()).sessions.find((s) => s.name === name)
  const orq = await find("ORQ-DEMO")
  const wApi = await api("POST", `/api/projects/${pid}/sessions`, { name: "W-API", role: "API" })
  const wWeb = await api("POST", `/api/projects/${pid}/sessions`, { name: "W-WEB", role: "Web" })
  for (const s of [orq, wApi, wWeb]) { await api("POST", `/api/sessions/${s.id}/start`).catch(() => {}); await idle(s.id) }
  await shoot("antes", `/p/${pid}`)
  await shoot("dialogo", `/p/${pid}`, { before: async (t) => { await t.press('button[aria-label="Más acciones"]'); await t.clickText("Ponerse AFK"); await sleep(600) } })

  // 1: ponerse AFK con tiempo y presupuesto (el diálogo de la web llama a lo mismo).
  const until1 = Date.now() + 120_000
  const started = await api("POST", `/api/projects/${pid}/afk`, { until: until1, budgetUsd: 5 })
  const n1 = await until("aviso de AFK en el chat", async () => (await notices(orq.id)).find((t) => /^El usuario está AFK hasta/.test(t)))
  check(1, "ponerse AFK con tiempo y presupuesto", started.afk?.budgetUsd === 5 && started.afk?.until === until1 && /presupuesto US\$ 5\)/.test(n1), n1)

  // 2: la orquestadora propone un prompt, un plan y una sesión nueva: salen solos.
  const rPrompt = await tool(orq.id, "propose_prompt", { session: "W-API", title: "Agregar el endpoint de turnos", prompt: "Implementá GET /api/turnos", model: "sonnet", effort: "medium" })
  const rPlan = await tool(orq.id, "propose_plan", { session: "W-WEB", title: "Ficha del contrato", steps: [{ title: "Armar la vista", prompt: "Armá la vista", model: "sonnet", effort: "medium" }, { title: "Conectar la API", prompt: "Conectá la API", model: "sonnet", effort: "medium" }] })
  const rSession = await tool(orq.id, "propose_session", { name: "QA", role: "Pruebas", title: "Suite de turnos", prompt: "Armá la suite", model: "sonnet", effort: "medium" })
  const rHold = await tool(orq.id, "propose_prompt", { session: "W-API", title: "Publicar la versión 1.2", prompt: "Publicá la versión", model: "sonnet", effort: "medium", hold: true })
  await sleep(1500)
  const ds = await drafts()
  const byTitle = (t) => ds.find((d) => d.title === t)
  const sentAfk = ["Agregar el endpoint de turnos", "Ficha del contrato", "Suite de turnos"].map((t) => byTitle(t) ?? ds.find((d) => d.kind === "session"))
  const qa = (await find("QA"))
  check(2, "prompt, plan y sesión nueva salen solos", sentAfk.every((d) => d?.state === "sent" && d.sentBy === "afk") && Boolean(qa) && byTitle("Ficha del contrato")?.planState === "running" && /sale sola/.test(rPrompt + rPlan + rSession), `${sentAfk.map((d) => d?.kind).join(", ")}; sesión QA creada`)
  const held = byTitle("Publicar la versión 1.2")
  check(3, "lo marcado con hold espera", held?.state === "ready" && held.hold === true && held.sentBy === null && /hold/.test(rHold), `estado ${held?.state}; ${rHold.slice(0, 80)}…`)

  // Un resultado de W-WEB (avanza el plan) y uno de W-API (llega a la orquestadora).
  await idle(wWeb.id)
  await tool(wWeb.id, "report_result", { status: "done", summary: "Vista armada" })
  await idle(wApi.id)
  await tool(wApi.id, "report_result", { status: "done", summary: "Endpoint de turnos listo", details: "GET /api/turnos?inquilino=<id>" })
  await until("el resultado revisado por la orquestadora", async () => (await snap()).reports.some((r) => r.state === "reviewed"), 40000).catch(() => {})
  await sleep(1500)
  await shoot("afk-activo", `/p/${pid}`)
  await shoot("bandeja", `/p/${pid}`, { before: async (t) => { await t.press('button[aria-label="Bandeja"]').catch(() => t.clickText("Bandeja")); await sleep(800) } })
  const sinceBefore = started.afk.since

  // 7a: reinicio con el AFK en curso.
  await stop()
  launch()
  await waitUp()
  wsConn = listen()
  const afterRestart = await project(pid)
  check("7a", "reinicio en el medio: el AFK sigue con sus topes", afterRestart.afk?.since === sinceBefore && afterRestart.afk?.budgetUsd === 5 && afterRestart.afk?.until === until1, `desde ${new Date(sinceBefore).toLocaleTimeString("es-AR")}`)
  for (const s of [orq, wApi, wWeb]) { await api("POST", `/api/sessions/${s.id}/start`).catch(() => {}); await idle(s.id) }

  // 4a: se vence el tiempo (se acorta el límite del período en curso).
  const soon = Date.now() + 4000
  await api("POST", `/api/projects/${pid}/afk`, { until: soon, budgetUsd: 5 })
  await until("el AFK terminó por tiempo", async () => (await project(pid)).afk === null, 20000)
  const log1 = await api("GET", `/api/projects/${pid}/afk-log`)
  const toastUntil = toasts.find((t) => /se cumplió el tiempo/.test(t.title))
  const planAfter = (await drafts()).find((d) => d.title === "Ficha del contrato")
  check("4a", "se vence el tiempo: termina solo, con su aviso", log1.endReason === "until" && toastUntil?.event === "needs_you" && toastUntil.level === "warn" && toastUntil.projectId === pid && (await notices(orq.id)).some((t) => /Se cumplió el tiempo del AFK/.test(t)), `${toastUntil?.title}; ${toastUntil?.body}`)
  check("4b", "…y el plan que aprobó el AFK queda pausado; lo que esperaba sigue esperando", planAfter?.planState === "paused" && (await drafts()).find((d) => d.title === "Publicar la versión 1.2")?.state === "ready", planAfter?.planNote)
  check(5, "el registro del período: lo que salió solo, lo que espera, resultados y costo", log1.sent.length === 3 && log1.held.some((d) => d.title === "Publicar la versión 1.2") && log1.results.length >= 1 && log1.spentUsd > 0, `${log1.sent.length} salieron solas, ${log1.held.length} esperan, ${log1.results.length} resultados, US$ ${log1.spentUsd.toFixed(2)}`)
  await sleep(1000)
  await shoot("mientras-estabas-afk", `/p/${pid}`)

  // 4c: se agota el presupuesto (cada turno del Claude falso cuesta US$ 0,25).
  const p2 = await api("POST", `/api/projects/${pid}/afk`, { until: null, budgetUsd: 0.6 })
  check("4c0", "otro AFK sin límite de tiempo y con tope de US$ 0,60", p2.afk?.until === null && p2.afk?.budgetUsd === 0.6)
  let turns = 0
  while ((await project(pid)).afk && turns < 6) {
    await say(wApi.id, "HOLA " + turns)
    await sleep(600)
    await idle(wApi.id)
    turns++
    if (turns === 2) await shoot("afk-presupuesto", `/p/${pid}`)
    await sleep(400)
  }
  const log2 = await api("GET", `/api/projects/${pid}/afk-log`)
  const toastBudget = toasts.find((t) => /se agotó el presupuesto/.test(t.title))
  check("4c", "se agota el presupuesto: termina solo, con su aviso", (await project(pid)).afk === null && log2.endReason === "budget" && log2.spentUsd >= 0.6 && toastBudget?.event === "needs_you", `tras ${turns} turnos; ${toastBudget?.title}; gastado US$ ${log2.spentUsd.toFixed(2)}`)
  await shoot("mientras-estabas-afk-presupuesto", `/p/${pid}`)

  // 7b: un `until` que vence con el server apagado termina al arrancar.
  const p3 = await api("POST", `/api/projects/${pid}/afk`, { until: Date.now() + 3000, budgetUsd: null })
  await stop()
  await sleep(5000)
  launch()
  await waitUp()
  wsConn = listen()
  const log3 = await api("GET", `/api/projects/${pid}/afk-log`)
  check("7b", "un tiempo vencido con el server apagado: termina al arrancar", (await project(pid)).afk === null && log3.since === p3.afk.since && log3.endReason === "until")

  // 6: volver a mano, y la tarjeta "Mientras estabas AFK" se cierra con Listo.
  await api("POST", `/api/projects/${pid}/afk`, { until: null, budgetUsd: null })
  const back = await api("DELETE", `/api/projects/${pid}/afk`)
  const log4 = await api("GET", `/api/projects/${pid}/afk-log`)
  check(6, "volver: el AFK termina y las propuestas vuelven a esperar", back.afk === null && log4.endReason === "user" && (await notices(orq.id)).some((t) => /^El usuario volvió/.test(t)))

  if (captures) {
    try {
      cdp ??= await import(pathToFileURL(path.join(REPO, "scripts/ux/cdp.mjs")).href)
      const t = await cdp.open({ base: BASE, width: 1440, height: 900 })
      await t.goto(`/p/${pid}`)
      await t.theme("light")
      const shown = await t.ev(`document.querySelector("[data-afk-summary]") !== null`)
      await t.shot(path.join(ROOT, "volver--light-1440.png"))
      shots.push(path.join(ROOT, "volver--light-1440.png"))
      await t.clickText("Listo")
      await sleep(500)
      await t.goto(`/p/${pid}`)
      const hidden = await t.ev(`document.querySelector("[data-afk-summary]") === null`)
      check(8, "la tarjeta aparece al volver, se cierra con Listo y no vuelve", shown && hidden, `visible: ${shown}; después de Listo y recargar, oculta: ${hidden}`)
      await t.close()
    } catch (err) {
      console.log("⚠️  sin prueba de la tarjeta: " + (err instanceof Error ? err.message : err))
    }
  }

  console.log("\n| # | Qué | Resultado |\n|---|---|---|")
  for (const r of rows) console.log(`| ${r.n} | ${r.what} | ${r.ok ? "✅" : "❌"} |`)
  if (shots.length) console.log("\nCapturas:\n" + shots.map((s) => "- " + s).join("\n"))
} catch (err) {
  console.error("❌ " + (err instanceof Error ? err.message : err))
  process.exitCode = 1
} finally {
  try { wsConn?.close() } catch {}
  if (keep && process.exitCode !== 1) console.log(`\nServer levantado: ${BASE} (pid ${server?.pid}). Datos: ${ROOT}. Para bajarlo: kill ${server?.pid}`)
  else await stop()
}
