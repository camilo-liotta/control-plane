#!/usr/bin/env node
// Prueba de punta a punta de «Retomar solas las sesiones cuando se renueva el uso» contra un server de verdad
// (otro puerto, otros datos, el Claude falso de los tests con su comando LIMITE). No toca el :4700,
// ~/.control-plane ni ~/.claude. El server corre con CONTROL_PLANE_LIMIT_FAST=1: el margen, el barrido y las
// pausas son de décimas de segundo en lugar de minutos.
//   node scripts/ux/e2e-limite.mjs            # corre todo, saca capturas y muestra la tabla
//   node scripts/ux/e2e-limite.mjs keep       # deja el server levantado al final (puerto CP_E2E_PORT, 4733)
//   node scripts/ux/e2e-limite.mjs nocap      # sin capturas (no necesita el navegador del banco)
// Datos, logs y capturas en ~/.cache/cp-ux/limite (CP_UX_HOME cambia la base). Necesita `npm run build -w web`.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { CACHE, REPO } from "./paths.mjs"

const ROOT = path.join(CACHE, "limite")
const PORT = Number(process.env.CP_E2E_PORT ?? 4733)
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
      FAKE_LONG_MS: "4000",
      FAKE_LOG_INPUT: path.join(ROOT, "inputs.log"),
      CONTROL_PLANE_LIMIT_FAST: "1",
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

// El Claude falso: lo que le llega (cada mensaje de usuario), el límite de la cuenta (un archivo) y las continuaciones.
const LOG = path.join(ROOT, "inputs.log")
const inputs = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
const conts = () => inputs().filter((t) => t.includes("Se renovó tu límite de uso"))
const LIMIT_FILE = path.join(ROOT, "home/.claude/fake-limit.json")
/** Deja la cuenta sin uso `secs` segundos, a partir de `from` segundos (sin pasar por ninguna sesión). */
const arm = (kind, secs, from = 0) => fs.writeFileSync(LIMIT_FILE, JSON.stringify({ until: Date.now() + secs * 1000, kind, from: Date.now() + from * 1000 }))
const disarm = () => fs.rmSync(LIMIT_FILE, { force: true })
const account = async () => (await snap()).accounts[0]
const sess = async (id) => (await snap()).sessions.find((s) => s.id === id)
const toastText = () => toasts.map((t) => t.title)
/** Una sesión sin uso que se corta al recibir un mensaje: queda marcada. */
const cut = async (sid, kind, secs) => {
  arm(kind, secs)
  await say(sid, "trabajá en algo")
  await until("la cuenta quedó sin uso", async () => (await account()).limit?.kind === kind)
  await until("la sesión quedó marcada", async () => (await sess(sid)).limited?.interrupted === true)
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

/** Varias capturas en una sola pasada por tema (una pestaña por tema): para sacarlas mientras dura el límite. */
const shootAll = async (items, { width = 1440, height = 900 } = {}) => {
  if (!captures) return
  try {
    cdp ??= await import(pathToFileURL(path.join(REPO, "scripts/ux/cdp.mjs")).href)
    for (const theme of ["light", "dark"]) {
      const t = await cdp.open({ base: BASE, width, height })
      try {
        await t.goto("/")
        await t.theme(theme)
        for (const { name, route, before } of items) {
          await t.goto(route, 1200)
          if (before) await before(t)
          const file = path.join(ROOT, `${name}--${theme}-${width}.png`)
          await t.shot(file)
          shots.push(file)
        }
      } finally {
        await t.close()
      }
    }
  } catch (err) {
    console.log("⚠️  sin capturas: " + (err instanceof Error ? err.message : err))
  }
}

try {
  launch()
  await waitUp()
  wsConn = listen()
  const demo = await api("POST", "/api/projects", { name: "Demo uso", repoPath: path.join(ROOT, "repos/demo"), orchestratorName: "ORQ-DEMO", settings: { batchWindowSec: 2 } })
  const pid = demo.id
  const find = async (name) => (await snap()).sessions.find((s) => s.name === name)
  const orq = await find("ORQ-DEMO")
  const wApi = await api("POST", `/api/projects/${pid}/sessions`, { name: "W-API", role: "API" })
  const wWeb = await api("POST", `/api/projects/${pid}/sessions`, { name: "W-WEB", role: "Web" })
  for (const s of [orq, wApi, wWeb]) { await api("POST", `/api/sessions/${s.id}/start`).catch(() => {}); await idle(s.id) }

  // Un plan para W-WEB: el paso 1 tarda (LARGO) y el 2 sale cuando el 1 reporta.
  await tool(orq.id, "propose_plan", { session: "W-WEB", title: "Ficha del contrato", steps: [{ title: "Armar la vista", prompt: "LARGO armá la vista", model: "sonnet", effort: "medium" }, { title: "Conectar la API", prompt: "Conectá la API", model: "sonnet", effort: "medium" }] })
  const plan = await until("el plan listo", async () => (await drafts()).find((d) => d.kind === "plan" && d.state === "ready"))

  // 1–4: llegan juntos al límite de 5 h una sesión trabajando (W-API), el paso de un plan (W-WEB) y la orquestadora en una revisión.
  // Un resultado de W-API entra a la cola; el límite arranca 1,2 s después (antes de que se entregue el lote) y dura 45 s (alcanza para sacar las capturas).
  await api("POST", `/api/drafts/${plan.id}/send`, {})
  await say(wApi.id, `MCP report_result ${JSON.stringify({ status: "done", summary: "Endpoint de turnos listo", details: "GET /api/turnos" })}`)
  await sleep(400)
  arm("five_hour", 45, 1.2)
  await say(wApi.id, "LARGO una tarea larga")
  await until("el lote llegó a la orquestadora y la cortó", async () => (await sess(orq.id)).limited?.interrupted === true, 25000)
  await until("las tres quedaron marcadas", async () => (await sess(wApi.id)).limited?.interrupted && (await sess(wWeb.id)).limited?.interrupted, 25000)
  const acc1 = await account()
  const afterCut = inputs().length
  const planNow = (await drafts()).find((d) => d.id === plan.id)
  const proj1 = await project(pid)
  check(1, "una sesión trabajando llega al límite de 5 h: la cuenta y la sesión quedan marcadas", acc1.limit?.kind === "five_hour" && acc1.limit.source === "event" && (await sess(wApi.id)).limited.willResume === true && (await sess(wApi.id)).limited.kind === "five_hour", `${acc1.limit?.message}`)
  await sleep(3500)
  check("1b", "…y no reintenta: no llega ningún mensaje más al Claude falso mientras dura", inputs().length === afterCut, `${afterCut} mensajes antes, ${inputs().length} después`)
  check(3, "un plan con un paso frenado no se pausa: el paso sigue en curso", planNow.planState === "running" && planNow.steps[0].state === "running" && (await drafts()).find((d) => d.id === plan.id).planState === "running", `plan ${planNow.planState}, paso 1 ${planNow.steps[0].state}`)
  check(4, "la orquestadora frenada en una revisión: la revisión sigue abierta, sin pausa", proj1.review.inReview >= 1 && proj1.review.paused === false && (await sess(orq.id)).limited.interrupted === true, `${proj1.review.inReview} en revisión, pausada: ${proj1.review.paused}`)

  // 2: lo que escribe el usuario mientras tanto queda en cola.
  const r1 = await say(wApi.id, "mensaje durante el límite")
  const r2 = await say(wWeb.id, "otro mensaje durante el límite")
  const sApi = await sess(wApi.id)
  check(2, "un mensaje del usuario mientras tanto queda en cola, con la hora a la que sale", Boolean(r1.held) && Boolean(r2.held) && /Queda en espera: se envía cuando se renueve el uso, a las \d\d:\d\d/.test(r1.note) && sApi.held.length === 1 && !inputs().some((t) => t.includes("mensaje durante el límite")), r1.note)
  await sleep(800)
  const tmsg = toasts.find((t) => /^Se terminó el uso de 5 horas de la cuenta/.test(t.title))
  check("2b", "aviso al frenarse: informativo, con cuántas esperan (no es «te necesita»)", tmsg?.level === "info" && !tmsg.event && /sesi(ón espera|ones esperan) hasta .* y sigu(e|en) sola/.test(tmsg.body ?? ""), `${tmsg?.title} — ${tmsg?.body}`)

  // Capturas del estado «sin uso».
  const sessionUrl = (s) => `/p/${pid}/s/${s.id}`
  await shootAll([
    { name: "pastilla", route: sessionUrl(wApi) },
    { name: "medidor-y-sidebar", route: `/p/${pid}` },
    { name: "composer-en-cola", route: sessionUrl(wApi), before: async (t) => { await t.ev(`document.querySelector("textarea")?.focus(); 1`) } },
    { name: "plan-esperando", route: sessionUrl(wWeb) },
    { name: "inicio", route: "/" },
    { name: "menu-sesion", route: sessionUrl(wApi), before: async (t) => { await t.press('button[aria-label="Más acciones"]'); await sleep(400) } },
    { name: "ajustes", route: `/p/${pid}`, before: async (t) => { await t.press('button[aria-label="Ajustes"]'); await sleep(500) } },
  ])

  // 5: llega el reset: siguen todas, con el mensaje de continuación, y después sale lo encolado.
  await until("se renovó el uso", async () => (await account()).limit === null, 90000)
  await until("siguieron las tres y salió lo encolado", async () => conts().length >= 3 && inputs().includes("mensaje durante el límite") && inputs().includes("otro mensaje durante el límite"), 40000)
  const all = inputs()
  const lastCont = Math.max(...all.map((t, i) => (t.includes("Se renovó tu límite de uso") ? i : -1)))
  const firstHeld = all.indexOf("mensaje durante el límite")
  await until("la orquestadora cerró la revisión", async () => (await snap()).reports.every((r) => r.state !== "in_review"), 30000)
  const contText = conts()[0]
  const toastBack = toasts.find((t) => /^Se renovó el uso de la cuenta/.test(t.title))
  check(5, "llega el reset y siguen todas con el mensaje de continuación; después sale lo encolado", conts().length === 3 && /^Se renovó tu límite de uso \(de 5 horas\) y se había cortado tu turno\./.test(contText) && firstHeld > lastCont && toastBack?.body === "Siguieron 3 sesiones.", `${contText.slice(0, 70)}…; ${toastBack?.body}`)
  check("5b", "…el plan sigue en curso (no se pausó) y la revisión de la orquestadora se cerró", (await drafts()).find((d) => d.id === plan.id).planState === "running" && (await project(pid)).review.inReview === 0)
  // El paso 1 reporta y sale el 2.
  await tool(wWeb.id, "report_result", { status: "done", summary: "Vista armada" })
  const planAfter = await until("el paso 2 salió", async () => { const d = (await drafts()).find((x) => x.id === plan.id); return d.currentStep === 1 ? d : null }, 20000)
  check("5c", "después de seguir, el plan avanza al paso 2", planAfter.planState === "running" && planAfter.steps[0].state === "done", `paso ${planAfter.currentStep + 1}`)
  await idle(wApi.id); await idle(wWeb.id); await idle(orq.id)

  // 6: el límite semanal y el tope de gasto, con «Reintentar ahora».
  const c0 = conts().length
  await cut(wApi.id, "seven_day", 90)
  const weekly = (await account()).limit
  check("6a", "límite semanal: se reconoce y la renovación es la del reloj del CLI", weekly.kind === "seven_day" && weekly.source === "event" && weekly.resetsAt > Date.now() + 60_000, weekly.message)
  disarm()
  const retried = await api("POST", `/api/accounts/${(await account()).id}/limit/retry`, {})
  await until("siguió sola tras reintentar", async () => (await account()).limit === null && conts().length === c0 + 1, 30000)
  check("6b", "«Reintentar ahora» en la cuenta: sigue sin esperar la renovación", retried.limit === null && conts().at(-1).includes("(semanal)"))
  await idle(wApi.id)
  await cut(wApi.id, "spend", 90)
  const spend = (await account()).limit
  await shoot("medidor-tope-de-gasto", `/p/${pid}`)
  await shoot("pastilla-tope-de-gasto", sessionUrl(wApi))
  disarm()
  await api("POST", `/api/accounts/${(await account()).id}/limit/retry`, {})
  await until("siguió tras subir el tope", async () => (await account()).limit === null && conts().length === c0 + 2, 30000)
  check("6c", "tope de gasto: se reconoce («individual spend limit») y «Reintentar ahora» (subiste el tope) la retoma", spend.kind === "spend" && /individual spend limit/.test(spend.message) && conts().at(-1).includes("(de gasto)") && toastText().some((t) => /^Se llegó al tope de gasto de la cuenta/.test(t)))
  await idle(wApi.id)

  // 7: se vuelve a frenar al retomar (era otra ventana): marca de nuevo, sin bucle.
  const c1 = conts().length
  await cut(wApi.id, "five_hour", 4)
  arm("seven_day", 25) // cuando se renueve el de 5 h, el semanal sigue agotado
  await until("se volvió a frenar, ahora por el semanal", async () => (await account()).limit?.kind === "seven_day", 30000)
  const n7 = conts().length
  await sleep(3000)
  check(7, "se vuelve a frenar al retomar: marca de nuevo con la renovación nueva, sin bucle", n7 === c1 + 1 && conts().length === n7 && (await sess(wApi.id)).limited?.kind === "seven_day" && (await sess(wApi.id)).limited.interrupted === true, `${n7 - c1} intento; ${conts().length - n7} más en 3 s`)
  disarm()
  await api("POST", `/api/accounts/${(await account()).id}/limit/retry`, {})
  await until("siguió", async () => (await account()).limit === null && (await sess(wApi.id)).limited === null, 30000)
  await idle(wApi.id)

  // 9: «No retomar sola».
  const c2 = conts().length
  await cut(wApi.id, "five_hour", 5)
  await say(wApi.id, "esto sí tiene que salir")
  const skipped = await api("PATCH", `/api/sessions/${wApi.id}/limit`, { resume: false })
  check("9a", "«No retomar sola»: la sesión queda sin continuación, pero lo encolado sigue", skipped.limited?.interrupted === false && skipped.limited?.willResume === false && skipped.held.length === 1)
  await until("se renovó", async () => (await account()).limit === null, 30000)
  await until("salió lo encolado", async () => inputs().includes("esto sí tiene que salir"), 30000)
  await sleep(1500)
  check(9, "…y al renovarse no recibe el mensaje de continuación", conts().length === c2 && (await sess(wApi.id)).limited === null, `continuaciones: ${conts().length - c2}`)
  await idle(wApi.id)

  // 8: server apagado con sesiones limitadas; el reset pasa con todo apagado; se levanta y siguen solas.
  const c3 = conts().length
  await cut(wApi.id, "five_hour", 6)
  await say(wApi.id, "mensaje que espera con el server apagado")
  const limitedBefore = (await account()).limit
  await stop()
  await sleep(8000)
  launch()
  await waitUp()
  wsConn = listen()
  await until("siguió sola al levantar el server", async () => conts().length === c3 + 1 && inputs().includes("mensaje que espera con el server apagado"), 40000)
  check(8, "server apagado con una sesión limitada, el reset pasa apagado: al levantarlo sigue sola y sale lo encolado", limitedBefore?.kind === "five_hour" && (await account()).limit === null && (await sess(wApi.id)).limited === null, `el límite era de ${new Date(limitedBefore.resetsAt).toLocaleTimeString("es-AR")}; levantó ${new Date().toLocaleTimeString("es-AR")}`)
  await idle(wApi.id)
  await idle(wWeb.id).catch(() => {})

  // 10: el reinicio para actualizar con una sesión limitada (y otra trabajando).
  const c4 = conts().length
  await say(wWeb.id, "LARGO algo que tarda") // W-WEB queda trabajando cuando se apaga
  await until("W-WEB trabajando", async () => (await sess(wWeb.id)).status === "working", 10000)
  await cut(wApi.id, "five_hour", 9)
  await api("POST", "/api/restart/prepare", { reason: "update" })
  await stop()
  launch()
  await waitUp()
  wsConn = listen()
  await sleep(2500)
  const continues = inputs().filter((t) => t.includes("control-plane se reinició para actualizarse y cortó tu turno"))
  await until("siguieron después de renovarse", async () => conts().length >= c4 + 2 && (await account()).limit === null, 40000)
  const stillUp = await sess(wApi.id)
  check(10, "el reinicio para actualizar con una sesión limitada: no recibe el «seguí» del reinicio; sigue cuando se renueva el uso", continues.length === 0 && conts().length === c4 + 2 && stillUp.limited === null, `${continues.length} «seguí» del reinicio; ${conts().length - c4} continuaciones por el límite`)

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
