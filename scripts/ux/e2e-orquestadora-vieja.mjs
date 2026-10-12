#!/usr/bin/env node
// Prueba de punta a punta de una orquestadora "de antes de actualizar": propone sin modelo y recibe el error que
// le enseña a corregirse, y en su primer mensaje después de actualizar recibe el aviso de lo que cambió. Corre
// contra un server de verdad (otro puerto, otros datos, el Claude falso). No toca el :4700, ~/.control-plane ni ~/.claude.
//   node scripts/ux/e2e-orquestadora-vieja.mjs
// Datos y logs en ~/.cache/cp-ux/orq-vieja (CP_UX_HOME cambia la base).
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"

import { CACHE, REPO } from "./paths.mjs"

const ROOT = path.join(CACHE, "orq-vieja")
const PORT = Number(process.env.CP_E2E_PORT ?? 4732)
const BASE = `http://127.0.0.1:${PORT}`
const INPUT = path.join(ROOT, "input.log")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.rmSync(ROOT, { recursive: true, force: true })
for (const d of ["data", "home/.claude", "repos/demo"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true })
const { writeFakeClaude } = await import(pathToFileURL(path.join(REPO, "server/test/fake-claude.ts")).href)
const fake = writeFakeClaude(ROOT)

let server = null
const launch = () => {
  const log = fs.openSync(path.join(ROOT, "server.log"), "a")
  // Sin las CONTROL_PLANE_* heredadas de otra sesión: solo las de acá.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CONTROL_PLANE_") && k !== "NODE_ENV"))
  server = spawn(process.execPath, [path.join(REPO, "server/src/index.ts")], {
    cwd: path.join(REPO, "server"),
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...env, HOME: path.join(ROOT, "home"), CONTROL_PLANE_PORT: String(PORT), CONTROL_PLANE_HOME: path.join(ROOT, "data"), CLAUDE_BIN: fake, CLAUDE_CONFIG_DIR: path.join(ROOT, "home/.claude"), FAKE_LOG_INPUT: INPUT },
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
const snap = () => api("GET", "/api/snapshot")
const idle = (sid) => until("sesión quieta " + sid, async () => (await snap()).sessions.find((s) => s.id === sid)?.status === "idle", 60000)
const tool = async (sid, name, input) => {
  const n = (await events(sid)).length
  await api("POST", `/api/sessions/${sid}/messages`, { text: `MCP ${name} ${JSON.stringify(input)}` })
  await until("turno de " + name, async () => (await events(sid)).length > n && (await snap()).sessions.find((s) => s.id === sid)?.status === "idle", 30000)
  const evs = await events(sid)
  const use = [...evs].reverse().find((e) => e.kind === "tool_use" && e.name === "mcp__control-plane__" + name)
  const res = use && evs.find((e) => e.kind === "tool_result" && e.toolUseId === use.id)
  return res ? String(res.content) : ""
}
const received = () => (fs.existsSync(INPUT) ? fs.readFileSync(INPUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])

const rows = []
const check = (n, what, ok, detail = "") => {
  rows.push({ n, what, ok })
  console.log(`${ok ? "✅" : "❌"} ${n}. ${what}${detail ? " — " + detail : ""}`)
  if (!ok) process.exitCode = 1
}

try {
  launch()
  await waitUp()
  const project = await api("POST", "/api/projects", { name: "Demo", repoPath: path.join(ROOT, "repos/demo"), orchestratorName: "ORQ-DEMO", settings: { batchWindowSec: 1 } })
  const find = async (name) => (await snap()).sessions.find((s) => s.name === name)
  const orq = await find("ORQ-DEMO")
  const worker = await api("POST", `/api/projects/${project.id}/sessions`, { name: "WEB", role: "Web" })
  for (const s of [orq, worker]) { await api("POST", `/api/sessions/${s.id}/start`).catch(() => {}); await idle(s.id) }
  // La sesión WEB está en Opus, como las de la Mac del usuario.
  await api("PATCH", `/api/sessions/${worker.id}`, { model: "opus", effort: "high" }).catch(() => {})

  // Una orquestadora de antes de actualizar: con historia (ya tuvo un turno) y sin huella.
  await tool(orq.id, "list_sessions", {})
  await stop()
  const db = new DatabaseSync(path.join(ROOT, "data", "control-plane.db"))
  const had = db.prepare("SELECT COUNT(*) AS n FROM session_fingerprints WHERE session_id = ?").get(orq.id).n
  db.prepare("DELETE FROM session_fingerprints").run()
  // (El Claude falso no manda el init que marca "ya arrancó": se marca a mano, como estaría la de antes.)
  db.prepare("UPDATE sessions SET started_once = 1 WHERE id = ?").run(orq.id)
  db.close()
  launch()
  await waitUp()
  await api("POST", `/api/sessions/${orq.id}/start`).catch(() => {})
  await idle(orq.id)
  check(1, "una sesión nueva arranca con huella; la de antes no la tiene", had === 1)

  // 2: propone sin modelo (el esquema viejo se lo permite) y recibe el error.
  const fail = await tool(orq.id, "propose_prompt", { session: "WEB", title: "Ajustar la ficha", prompt: "Ajustá la ficha" })
  check(2, "propone sin modelo: el server la rechaza con un error que enseña", /Falta model y effort\. La sesión WEB está con .*Elegí según el trabajo: sonnet \(medium o high\).*select:mcp__control-plane__propose_prompt/s.test(fail), fail.slice(0, 120) + "…")
  check("2b", "…y no dejó ninguna propuesta", (await snap()).drafts.filter((d) => d.title === "Ajustar la ficha").length === 0)

  // 3: reintenta con modelo y esfuerzo, y queda.
  const ok = await tool(orq.id, "propose_prompt", { session: "WEB", title: "Ajustar la ficha", prompt: "Ajustá la ficha", model: "sonnet", effort: "medium" })
  const draft = (await snap()).drafts.find((d) => d.title === "Ajustar la ficha")
  check(3, "reintenta con model y effort: la propuesta queda con Sonnet", /creada/.test(ok) && draft?.model === "sonnet" && draft?.effort === "medium", ok.slice(0, 90))

  // 4: el aviso de lo que cambió llegó una sola vez, antes del primer mensaje que recibió.
  const msgs = received().filter((t) => t.includes("propose_prompt") || t.startsWith("[control-plane] control-plane se actualizó"))
  const withNotice = received().filter((t) => t.startsWith("[control-plane] control-plane se actualizó"))
  const text = withNotice[0] ?? ""
  check(4, "su primer mensaje después de actualizar trae el aviso, una sola vez", withNotice.length === 1 && /propose_plan/.test(text) && /select:mcp__control-plane__/.test(text) && /Releelas/.test(text) && /«Qué modelo usar»/.test(text), `${withNotice.length} aviso; ${text.split("\n")[0]}`)
  const shown = (await events(orq.id)).filter((e) => e.kind === "user").every((e) => !e.text.startsWith("[control-plane] control-plane se actualizó"))
  check("4b", "no se ve en el chat como mensaje del usuario (queda una línea discreta)", shown && (await events(orq.id)).some((e) => e.kind === "notice" && /se actualizó/.test(e.text)), msgs.length + " mensajes con herramientas")

  // 5: un reinicio sin cambios no vuelve a avisar.
  await stop()
  launch()
  await waitUp()
  await api("POST", `/api/sessions/${orq.id}/start`).catch(() => {})
  await idle(orq.id)
  await tool(orq.id, "list_sessions", {})
  check(5, "reiniciar sin cambios no vuelve a avisar", received().filter((t) => t.startsWith("[control-plane] control-plane se actualizó")).length === 1)

  console.log("\n| # | Qué | Resultado |\n|---|---|---|")
  for (const r of rows) console.log(`| ${r.n} | ${r.what} | ${r.ok ? "✅" : "❌"} |`)
} catch (err) {
  console.error("❌ " + (err instanceof Error ? err.message : err))
  process.exitCode = 1
} finally {
  await stop()
}
