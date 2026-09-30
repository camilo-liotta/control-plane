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
 * - "CRON …", "CRONDEL …", "WAKEUP …" y "FIRE …" programan, cancelan y disparan tareas (ver el script).
 */
const SCRIPT = String.raw`#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const args = process.argv.slice(2)
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
// Lo que el server corre aparte (versión, auth status, agents): contesta y sale.
if (args[0] === "--version") { console.log("0.0.0-fake (Claude Code)"); process.exit(0) }
if (!args.includes("-p")) process.exit(0)
let sid = flag("--resume") ?? flag("--session-id")
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"))
const file = path.join(dir, sid + ".jsonl")
let usd = 0
let tok = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
try {
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.includes('"cost-state"')) continue
    const j = JSON.parse(l)
    usd = j.totalCostUSD
    tok = j.modelUsage["claude-x"]
  }
} catch {}
let full = process.env.FAKE_FULL === "1"
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n")
let saved = false
const save = () => {
  if (saved) return
  saved = true
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ type: "cost-state", sessionId: sid, totalCostUSD: usd, modelUsage: { "claude-x": tok } }) + "\n")
}
const state = (s) => out({ type: "system", subtype: "session_state_changed", state: s })
const result = (extra) => {
  out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: usd, usage: {}, modelUsage: { "claude-x": tok }, ...extra })
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
  const text = typeof c === "string" ? c : (c?.find?.((b) => b.type === "text")?.text ?? "")
  state("running")
  if (text === "/clear") {
    save()
    saved = false
    sid = "clear-" + Math.random().toString(36).slice(2, 8)
    usd = 0
    tok = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    full = false
    out({ type: "conversation_reset", new_conversation_id: sid, session_id: sid, trigger: "clear" })
    out({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0, usage: {}, modelUsage: {} })
    state("idle")
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
  // Programar para más tarde, con la forma que tienen en el stream de Claude Code:
  //   "CRON <cron>|<recurrente 1/0>|<durable 1/0>|<prompt>", "CRONDEL <id>", "WAKEUP <segundos>|<motivo>",
  //   "FIRE <prompt>" (un cron que se dispara: su prompt vuelve como mensaje de usuario).
  const tool = (name, input, content, structured) => {
    const id = "toolu_" + Math.random().toString(36).slice(2, 10)
    out({ type: "assistant", message: { id: "m" + Math.random(), role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null })
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: null, tool_use_result: structured })
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
