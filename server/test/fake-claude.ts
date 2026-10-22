import fs from "node:fs"
import path from "node:path"

/**
 * Un Claude Code de mentira para los tests, con lo que importa del de verdad:
 * - contesta el handshake y cierra cada turno con los totales acumulados;
 * - como Claude Code, sigue desde el último cost-state del transcript al reanudar y guarda uno al salir;
 * - con FAKE_FULL=1 la conversación "no entra": los mensajes terminan en blocking_limit hasta un /compact;
 * - /clear sigue con una conversación nueva que arranca sus totales de cero (como el de verdad);
 * - con FAKE_NO_COMPACT=1, /compact contesta "No messages to compact" sin compactar;
 * - `--version` contesta una versión y los otros subcomandos (auth status, agents) salen sin nada;
 * - "CRON …", "CRONDEL …", "WAKEUP …" y "FIRE …" programan, cancelan y disparan tareas (ver el script);
 * - "PREGUNTA" deja una pregunta pendiente y "LARGO" hace un turno que tarda (para los reinicios);
 *   "SECRETO <valor>" llama add_credential y list_environments con ese secreto;
 *   "MCP <herramienta> <json>" llama esa herramienta de control-plane por el MCP de la sesión (la URL sale de --mcp-config);
 *   "SENDMSG <a quién>" hace un SendMessage pasando por el hook PreToolUse de --settings, como Claude Code (y muestra si lo frenó);
 *   "SUBAGENTE" cierra el turno con un subagente en segundo plano que sigue andando;
 * - como el de verdad, --resume de una conversación sin transcript sale con "No conversation found";
 * - con FAKE_LOG_INPUT=<archivo> anota cada mensaje de usuario que recibe;
 * - con FALLA1 en el --name, el primer arranque sale con error (los siguientes andan);
 * - "LIMITE <five_hour|seven_day|spend|other> <segundos> [<desde en segundos>]" deja la cuenta sin uso (el límite es de la cuenta: vive en
 *   <CLAUDE_CONFIG_DIR>/fake-limit.json) y rechaza todo turno hasta que pasen esos segundos, con el rate_limit_event
 *   (status "rejected", resetsAt en segundos) y el texto real del error ("You've hit your session limit · resets 10pm
 *   (America/New_York)"). Con FAKE_LIMIT_EVENT=0 no manda el evento; con FAKE_LIMIT_TEXT=0 el error no dice de qué límite es;
 *   el tipo "other" (el de un modelo) solo corta a las sesiones con OPUS en el nombre.
 */
const SCRIPT = String.raw`#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { spawnSync } from "node:child_process"

const args = process.argv.slice(2)
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
// Como Claude Code, --mcp-config y --settings aceptan una ruta a un archivo JSON o el JSON mismo.
const jsonFlag = (f) => { const v = flag(f); return JSON.parse(v.trim().startsWith("{") ? v : fs.readFileSync(v, "utf8")) }
// Lo que el server corre aparte (versión, auth status, agents): contesta y sale.
if (args[0] === "--version") { console.log("0.0.0-fake (Claude Code)"); process.exit(0) }
if (!args.includes("-p")) process.exit(0)
let sid = flag("--resume") ?? flag("--session-id")
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"))
let file = path.join(dir, sid + ".jsonl")
const name = flag("--name") ?? ""
// Como ListAgents: los procesos que corren, por su --name. Un SendMessage solo llega a un nombre que exista.
const procs = path.join(process.env.CLAUDE_CONFIG_DIR, "fake-procs")
fs.mkdirSync(procs, { recursive: true })
fs.writeFileSync(path.join(procs, encodeURIComponent(name)), String(process.pid))
if (name.includes("FALLA1")) {
  const mark = path.join(process.env.CLAUDE_CONFIG_DIR, "falla1-" + name.replace(/[^A-Za-z0-9]/g, "-"))
  if (!fs.existsSync(mark)) {
    fs.writeFileSync(mark, "")
    process.stderr.write("API Error: 529 Overloaded\n")
    process.exit(1)
  }
}
if (flag("--resume") && process.env.FAKE_STRICT_RESUME === "1" && !fs.existsSync(file)) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid, total_cost_usd: 0, usage: {}, modelUsage: {}, errors: ["No conversation found with session ID: " + sid] }) + "\n")
  process.stderr.write("No conversation found with session ID: " + sid + "\n")
  process.exit(1)
}
let usd = 0
// Con "HAIKU" en el mensaje, una parte del turno va a otro modelo (SUB), como un subagente.
const MAIN = process.env.FAKE_MODEL ?? "claude-x"
const SUB = process.env.FAKE_SUB_MODEL ?? "claude-y"
let sub = 0
let tok = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
// Lo que gastaron otros modelos antes de reanudar con este (Claude Code lo sigue informando aparte).
let other = {}
const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
const otherUsd = () => Object.values(other).reduce((a, b) => a + b, 0)
const usage = () => ({ ...Object.fromEntries(Object.entries(other).map(([k, v]) => [k, { ...zero, costUSD: v }])), [MAIN]: { ...tok, costUSD: usd - sub - otherUsd() }, ...(sub ? { [SUB]: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: sub } } : {}) })
try {
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.includes('"cost-state"')) continue
    const j = JSON.parse(l)
    usd = j.totalCostUSD
    tok = j.modelUsage[MAIN] ?? tok
    sub = j.modelUsage[SUB]?.costUSD ?? 0
    other = Object.fromEntries(Object.entries(j.modelUsage).filter(([k, v]) => k !== MAIN && k !== SUB && v.costUSD).map(([k, v]) => [k, v.costUSD]))
  }
} catch {}
let full = process.env.FAKE_FULL === "1"
const out = (m) => process.stdout.write(JSON.stringify({ session_id: sid, ...m }) + "\n")
let saved = false
const save = () => {
  if (saved) return
  saved = true
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ type: "cost-state", sessionId: sid, totalCostUSD: usd, modelUsage: usage() }) + "\n")
}
const state = (s) => out({ type: "system", subtype: "session_state_changed", state: s })
const result = (extra) => {
  out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: usd, usage: {}, modelUsage: usage(), ...extra })
  state("idle")
}
const say = (text) => out({ type: "assistant", message: { id: "m" + Math.random(), role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null })
process.on("SIGTERM", () => { save(); process.exit(0) })
for await (const line of readline.createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line)
  if (msg.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } })
    continue
  }
  if (msg.type !== "user") continue
  const c = msg.message?.content
  const raw = typeof c === "string" ? c : (c?.find?.((b) => b.type === "text")?.text ?? "")
  // El aviso de control-plane que se antepone a lo primero que recibe una sesión después de actualizar no es parte de lo que le piden.
  const text = raw.startsWith("[control-plane] control-plane se actualizó") ? raw.split("\n\n").slice(1).join("\n\n") : raw
  // Con FAKE_LOG_INPUT=<archivo>, anota cada mensaje de usuario que recibe (para ver lo que de verdad le llega al modelo).
  if (process.env.FAKE_LOG_INPUT) fs.appendFileSync(process.env.FAKE_LOG_INPUT, JSON.stringify(raw) + "\n")
  state("running")
  // Como Claude Code 2.1.285: el conversation_reset sale con el session_id de antes y un
  // new_conversation_id que no es el del transcript; el id nuevo es el session_id de lo que sigue.
  if (text === "/clear") {
    save()
    saved = false
    const before = sid
    sid = "clear-" + Math.random().toString(36).slice(2, 8)
    file = path.join(dir, sid + ".jsonl")
    usd = 0
    sub = 0
    other = {}
    tok = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    full = false
    out({ type: "conversation_reset", new_conversation_id: "otro-" + Math.random().toString(36).slice(2, 8), session_id: before, trigger: "clear" })
    out({ type: "system", subtype: "init", cwd: process.cwd(), model: MAIN, mcp_servers: [], tools: [] })
    out({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0, usage: {}, modelUsage: {} })
    state("idle")
    continue
  }
  // El límite de uso es de la cuenta: "LIMITE <tipo> <segundos> [<desde en segundos>]" lo arma y, mientras dura, todo turno se rechaza
  // (menos /clear, que es local). Un turno largo (LARGO) lo vuelve a mirar al terminar, como uno que llega al límite a la mitad.
  const limitFile = path.join(process.env.CLAUDE_CONFIG_DIR, "fake-limit.json")
  if (text.startsWith("LIMITE ")) {
    const [kind, secs, from] = text.slice(7).trim().split(" ")
    fs.writeFileSync(limitFile, JSON.stringify({ until: Date.now() + Number(secs) * 1000, kind, from: Date.now() + Number(from ?? 0) * 1000 }))
  }
  const activeLimit = () => {
    let l = null
    try { l = JSON.parse(fs.readFileSync(limitFile, "utf8")) } catch {}
    // El de un modelo ("other") solo corta a las sesiones con OPUS en el nombre.
    return l && Date.now() >= (l.from ?? 0) && Date.now() < l.until && (l.kind !== "other" || name.includes("OPUS")) ? l : null
  }
  const rejectLimit = (limit) => {
    const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true }).format(limit.until + 59000).replace(":00", "").replace(" ", "").toLowerCase()
    const when = "resets " + clock + " (America/New_York)"
    const wording = { five_hour: "You've hit your session limit \u00b7 " + when, seven_day: "You've hit your weekly limit \u00b7 " + when, spend: "You've hit your individual spend limit \u00b7 run /usage-credits to raise it, or visit claude.ai/admin-settings/usage \u00b7 your weekly " + "limit " + when, other: "You've hit your Opus limit \u00b7 " + when }
    const message = process.env.FAKE_LIMIT_TEXT === "0" ? "API Error: 429 rate limited" : wording[limit.kind]
    const resetsAt = Math.ceil(limit.until / 1000)
    const window = { utilization: 1, resetsAt }
    const type = limit.kind === "other" ? "seven_day_opus" : limit.kind === "spend" ? "overage" : limit.kind
    if (process.env.FAKE_LIMIT_EVENT !== "0")
      out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: type, utilization: 1, unifiedWindows: limit.kind === "five_hour" ? { five_hour: window } : { seven_day: window } } })
    say(message)
    result({ is_error: true, result: message, terminal_reason: "api_error", errors: [] })
  }
  const limited = activeLimit()
  if (limited) {
    rejectLimit(limited)
    continue
  }
  if (text.startsWith("/compact") && process.env.FAKE_NO_COMPACT === "1") {
    out({ type: "system", subtype: "local_command_output", content: "Error: No messages to compact" })
    result({})
    continue
  }
  if (text.startsWith("/compact")) {
    full = false
    out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1000000, post_tokens: 40000 } })
    result({})
    continue
  }
  if (full) {
    say("Prompt is too long")
    result({ is_error: true, result: "Prompt is too long", terminal_reason: "blocking_limit", errors: [] })
    continue
  }
  // "PREGUNTA": pide contestar una pregunta (AskUserQuestion) y se queda esperando, sin cerrar el turno.
  if (text.includes("PREGUNTA")) {
    out({ type: "control_request", request_id: "q-" + Math.random().toString(36).slice(2), request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "toolu_q" + Math.random().toString(36).slice(2, 8), input: { questions: [{ question: "¿Sigo con el plan B?", header: "Plan", multiSelect: false, options: [{ label: "Sí", description: "" }, { label: "No", description: "" }] }] } } })
    continue
  }
  // "SUBAGENTE": lanza un subagente en segundo plano y cierra el turno mientras sigue andando.
  if (text.includes("SUBAGENTE")) {
    const id = "toolu_sub" + Math.random().toString(36).slice(2, 8)
    out({ type: "assistant", message: { id: "m" + Math.random(), role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: { description: "revisar", prompt: "revisá", run_in_background: true } }] }, parent_tool_use_id: null })
    out({ type: "system", subtype: "task_started", task_id: "t" + id, tool_use_id: id, description: "revisar", subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent", prompt: "revisá" })
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Async agent launched" }] }, parent_tool_use_id: null })
    say("Lancé un subagente.")
    result({})
    continue
  }
  // "LARGO" (en cualquier parte del mensaje): un turno que tarda FAKE_LONG_MS (30 s si no está).
  if (text.includes("LARGO")) {
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LONG_MS ?? 30000)))
    const late = activeLimit()
    if (late) {
      rejectLimit(late)
      continue
    }
  }
  // Programar para más tarde, con la forma que tienen en el stream de Claude Code:
  //   "CRON <cron>|<recurrente 1/0>|<durable 1/0>|<prompt>", "CRONDEL <id>", "WAKEUP <segundos>|<motivo>",
  //   "FIRE <prompt>" (un cron que se dispara: su prompt vuelve como mensaje de usuario).
  const tool = (name, input, content, structured) => {
    const id = "toolu_" + Math.random().toString(36).slice(2, 10)
    out({ type: "assistant", message: { id: "m" + Math.random(), role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null })
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: null, tool_use_result: structured })
  }
  // "MCP <herramienta> <json>": una herramienta de control-plane por el MCP de la sesión, y su resultado en el chat.
  if (text.startsWith("MCP ")) {
    const rest = text.slice(4).trim()
    const sp = rest.indexOf(" ")
    const toolName = sp < 0 ? rest : rest.slice(0, sp)
    const input = sp < 0 ? {} : JSON.parse(rest.slice(sp + 1))
    const url = jsonFlag("--mcp-config").mcpServers["control-plane"].url
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: input } }) })
    const j = await res.json()
    const body = (j.result?.content ?? []).map((b) => b.text).join("\n") || JSON.stringify(j.error ?? j)
    tool("mcp__control-plane__" + toolName, input, body)
    say((j.result?.isError ? "ERROR: " : "OK: ") + body)
    result({})
    continue
  }
  // "SENDMSG <a quién>": como Claude Code, antes de mandar corre el hook PreToolUse de --settings; un deny frena la herramienta.
  if (text.startsWith("SENDMSG ")) {
    const to = text.slice(8).trim()
    const input = { to, recipient: to, recipient_kind: "name", message: "hola", content: "hola" }
    const cmd = jsonFlag("--settings").hooks.PreToolUse.find((h) => h.matcher === "SendMessage").hooks[0].command
    const run = spawnSync("/bin/sh", ["-c", cmd], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: input }), encoding: "utf8" })
    let verdict = null
    try { verdict = JSON.parse(run.stdout).hookSpecificOutput } catch {}
    const denied = verdict?.permissionDecision === "deny"
    // Con updatedInput, la herramienta corre con el destino que cambió el hook (probado con el binario real).
    const final = verdict?.permissionDecision === "allow" && verdict.updatedInput ? String(verdict.updatedInput.to ?? to) : to
    const exists = fs.existsSync(path.join(procs, encodeURIComponent(final)))
    tool("SendMessage", { ...input, to: final }, denied ? verdict.permissionDecisionReason : exists ? "Message sent to " + final + "." : "No agent is named '" + final + "' exactly.")
    say(denied ? "BLOQUEADO: " + verdict.permissionDecisionReason : exists ? "ENVIADO a " + final : "NO LLEGÓ: no hay un proceso llamado " + final)
    result({})
    continue
  }
  if (text.startsWith("CRON ")) {
    const [cron, rec, dur, ...rest] = text.slice(5).split("|")
    const prompt = rest.join("|")
    const jobId = Math.random().toString(16).slice(2, 10).padEnd(8, "0")
    const recurring = rec !== "0"
    const durable = dur === "1"
    if (durable) {
      const f = path.join(process.cwd(), ".claude", "scheduled_tasks.json")
      let tasks = []
      try { tasks = JSON.parse(fs.readFileSync(f, "utf8")).tasks } catch {}
      tasks.push({ id: jobId, cron, prompt, createdAt: Date.now(), ...(recurring ? { recurring: true } : {}), createdBySessionId: sid, createdByPid: process.pid, createdInProject: process.cwd() })
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify({ tasks }, null, 2) + "\n")
    }
    tool("CronCreate", { cron, prompt, recurring, ...(durable ? { durable: true } : {}) },
      "Scheduled " + (recurring ? "recurring" : "one-shot") + " job " + jobId + " (" + cron + "). " + (durable ? "Persisted to .claude/scheduled_tasks.json." : "Session-only (not written to disk, dies when Claude exits)."),
      { id: jobId, humanSchedule: cron, recurring, durable })
    say("Programado: " + jobId)
    result({})
    continue
  }
  // El pedido de cancelar del panel "Programado". Con "TERCA" en el nombre de la sesión no lo hace;
  // con "LENTA", tarda FAKE_CANCEL_DELAY_MS (15 s si no está) en hacerlo.
  if (text.startsWith('Pedido del usuario desde el panel "Programado":')) {
    const name = flag("--name") ?? ""
    if (name.includes("LENTA")) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CANCEL_DELAY_MS ?? 15000)))
    if (name.includes("TERCA")) {
      say("Prefiero no cancelarla todavía: la necesito para revisar el deploy.")
    } else if (text.includes("CronDelete")) {
      const jobId = (/\x60([^\x60]+)\x60/.exec(text) ?? [])[1] ?? ""
      tool("CronDelete", { id: jobId }, "Cancelled job " + jobId + ".", { id: jobId })
      say("Listo, la cancelé.")
    } else if (text.includes("ScheduleWakeup")) {
      tool("ScheduleWakeup", { stop: true }, "Loop stopped — cancelled 1 pending wakeup(s).", { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 })
      say("Corté el loop.")
    } else if (text.includes("RemoteTrigger")) {
      const trigger = (/\x60([^\x60]+)\x60/.exec(text) ?? [])[1] ?? ""
      tool("RemoteTrigger", { action: "update", trigger_id: trigger, body: { enabled: false } }, "HTTP 200\n" + JSON.stringify({ trigger: { id: trigger, enabled: false } }))
      say("Apagué la rutina.")
    }
    result({})
    continue
  }
  // "SECRETO <valor>": deja una credencial y lista los entornos, como haría una sesión de verdad.
  if (text.startsWith("SECRETO ")) {
    const secret = text.slice(8).trim()
    tool("mcp__control-plane__add_credential", { environment: "Local", name: "Inquilino", username: "inq", secret }, "Credencial guardada.")
    tool("mcp__control-plane__list_environments", {}, "## Local\n- Inquilino | usuario: inq | secreto: " + secret)
    say("Listo.")
    result({})
    continue
  }
  if (text.startsWith("FIRE ")) {
    out({ type: "user", message: { role: "user", content: text.slice(5) }, isReplay: true, uuid: "fire-" + Math.random().toString(36).slice(2) })
    say("Corrió lo programado.")
    result({})
    continue
  }
  if (text.startsWith("CRONDEL ")) {
    const jobId = text.slice(8).trim()
    tool("CronDelete", { id: jobId }, "Cancelled job " + jobId + ".", { id: jobId })
    result({})
    continue
  }
  if (text.startsWith("WAKEUP ")) {
    const [secs, reason] = text.slice(7).split("|")
    const at = Date.now() + Number(secs) * 1000
    tool("ScheduleWakeup", { delaySeconds: Number(secs), reason, prompt: "<<autonomous-loop-dynamic>>" },
      "Next wakeup scheduled for " + new Date(at).toTimeString().slice(0, 8) + " (in " + secs + "s).",
      { scheduledFor: at, clampedDelaySeconds: Number(secs), wasClamped: false })
    result({})
    continue
  }
  usd += 0.25
  if (text.includes("HAIKU")) {
    usd += 0.05
    sub += 0.05
  }
  tok = { inputTokens: tok.inputTokens + 10, outputTokens: tok.outputTokens + 5, cacheReadInputTokens: tok.cacheReadInputTokens + 100, cacheCreationInputTokens: 0 }
  say("respuesta a: " + text.slice(0, 40))
  result({})
}
save()
`

export function writeFakeClaude(dir: string): string {
  const bin = path.join(dir, "claude.mjs")
  fs.writeFileSync(bin, SCRIPT, { mode: 0o755 })
  return bin
}
