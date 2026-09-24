import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { StreamNormalizer, type Action } from "../src/claude/normalize.ts"

// Mensajes con la forma real que emite `claude -p --output-format stream-json`.
const own = new Set(["own-1"])
const norm = () => new StreamNormalizer((u) => own.has(u))
const events = (actions: Action[]) => actions.filter((a) => a.type === "event").map((a) => (a as { event: unknown }).event)

describe("StreamNormalizer", () => {
  it("texto y tool_use del asistente", () => {
    const n = norm()
    const actions = n.handle({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_1",
        content: [
          { type: "text", text: "Voy a correr los tests" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
        ],
      },
    })
    const evs = events(actions) as { kind: string }[]
    assert.deepEqual(evs.map((e) => e.kind), ["text", "tool_use"])
    assert.ok(actions.some((a) => a.type === "activity" && a.text === "$ npm test"))
    assert.ok(actions.some((a) => a.type === "partial_clear"))
  })

  it("mensaje de otra sesión (replay con origin peer)", () => {
    const [ev] = events(
      norm().handle({
        type: "user",
        isReplay: true,
        isSynthetic: true,
        message: { role: "user", content: "Another Claude session sent a message: ..." },
        origin: { kind: "peer", name: "BACKEND", from: "uds:/run/x.sock", body: "Cambié el schema" },
        uuid: "x",
      })
    ) as { kind: string; from: string; body: string }[]
    assert.equal(ev!.kind, "peer")
    assert.equal(ev!.from, "BACKEND")
    assert.equal(ev!.body, "Cambié el schema")
  })

  it("ignora el eco de los mensajes propios", () => {
    const actions = norm().handle({
      type: "user",
      isReplay: true,
      message: { role: "user", content: "hola" },
      uuid: "own-1",
    })
    assert.equal(actions.length, 0)
  })

  it("tool_result con salida estructurada", () => {
    const [ev] = events(
      norm().handle({
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "listo", is_error: false }] },
        tool_use_result: { stdout: "listo", stderr: "" },
      })
    ) as { kind: string; content: string; structured: unknown }[]
    assert.equal(ev!.kind, "tool_result")
    assert.equal(ev!.content, "listo")
    assert.deepEqual(ev!.structured, { stdout: "listo", stderr: "" })
  })

  it("fin de turno interrumpido no se muestra como error", () => {
    const actions = norm().handle({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      errors: ["[ede_diagnostic] result_type=user"],
      duration_ms: 100,
      total_cost_usd: 0,
    })
    const turn = actions.find((a) => a.type === "turn_end") as { aborted: boolean; ok: boolean }
    assert.equal(turn.aborted, true)
    const [ev] = events(actions) as { kind: string; error?: string }[]
    assert.equal(ev!.kind, "turn_end")
    assert.equal(ev!.error, undefined)
  })

  it("rutea deltas parciales de texto", () => {
    const n = norm()
    n.handle({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_9" } } })
    n.handle({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } })
    const [a] = n.handle({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hola" } },
    })
    assert.deepEqual(a, { type: "partial", messageId: "msg_9", index: 0, block: "text", delta: "Hola" })
  })

  it("estado de sesión y uso", () => {
    const n = norm()
    assert.deepEqual(n.handle({ type: "system", subtype: "session_state_changed", state: "running" }), [
      { type: "status", state: "running" },
    ])
    const [u] = n.handle({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.28, resetsAt: 1790234400 } } },
    })
    assert.equal(u!.type, "usage")
    assert.equal((u as { usage: { fiveHour: { utilization: number } } }).usage.fiveHour.utilization, 0.28)
  })
})
