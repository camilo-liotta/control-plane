import fs from "node:fs"
import path from "node:path"

/**
 * Un Claude Code de mentira para los tests, con lo que importa del de verdad:
 * - contesta el handshake y cierra cada turno con los totales acumulados;
 * - como Claude Code, sigue desde el último cost-state del transcript al reanudar y guarda uno al salir;
 * - con FAKE_FULL=1 la conversación "no entra": los mensajes terminan en blocking_limit hasta un /compact;
 * - /clear sigue con una conversación nueva que arranca sus totales de cero (como el de verdad);
 * - con FAKE_NO_COMPACT=1, /compact contesta "No messages to compact" sin compactar.
 */
const SCRIPT = String.raw`#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const args = process.argv.slice(2)
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
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
