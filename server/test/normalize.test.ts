import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sessionTokens, StreamNormalizer, type Action } from "../src/claude/normalize.ts"

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

describe("StreamNormalizer · subagentes, comandos e imágenes", () => {
  it("ciclo de vida de un subagente", () => {
    const n = norm()
    const [start] = n.handle({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_A",
      description: "contar archivos",
      subagent_type: "general-purpose",
      is_backgrounded: true,
      task_type: "local_agent",
      prompt: "Listá los archivos",
    })
    assert.deepEqual(start, {
      type: "subagent_start",
      toolUseId: "toolu_A",
      taskId: "t1",
      description: "contar archivos",
      subagentType: "general-purpose",
      background: true,
      prompt: "Listá los archivos",
    })
    const [progress] = n.handle({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      tool_use_id: "toolu_A",
      description: "Running ls -la",
      usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 900 },
      last_tool_name: "Bash",
    })
    assert.deepEqual(progress, {
      type: "subagent_progress",
      taskId: "t1",
      toolUseId: "toolu_A",
      activity: "ls -la",
      usage: { tokens: 1200, toolUses: 1, durationMs: 900 },
    })
    const [end] = n.handle({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_A", status: "completed", summary: "Hay 3 archivos" })
    assert.equal(end!.type, "subagent_end")
    assert.equal((end as { status: string }).status, "completed")
  })

  it("las tareas de bash no se toman como subagentes", () => {
    const actions = norm().handle({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "toolu_B", description: "sleep 4", task_type: "local_bash" })
    assert.deepEqual(actions, [{ type: "activity", text: "sleep 4" }])
  })

  it("la salida de un comando local (/model) se muestra como aviso", () => {
    const [a] = norm().handle({
      type: "user",
      isReplay: true,
      message: { role: "user", content: "<local-command-stdout>Set model to `sonnet (claude-sonnet-5)`</local-command-stdout>" },
      uuid: "x1",
    })
    assert.deepEqual(a, { type: "event", event: { kind: "notice", level: "info", text: "Set model to `sonnet (claude-sonnet-5)`" } })
  })

  it("las imágenes de un tool_result salen aparte y sin estructurado binario", () => {
    const [a] = norm().handle({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_R", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }],
      },
      tool_use_result: { type: "image", file: { base64: "AAAA", type: "image/png" } },
    })
    const action = a as { images: { mediaType: string; data: string }[]; event: { structured?: unknown; content: string } }
    assert.deepEqual(action.images, [{ mediaType: "image/png", data: "AAAA" }])
    assert.equal(action.event.structured, undefined)
    assert.equal(action.event.content, "[imagen]")
  })
})

describe("tokens", () => {
  it("suma el uso acumulado de todos los modelos", () => {
    const t = sessionTokens({
      "claude-sonnet-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 10 },
      "claude-haiku-4-5": { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 },
    })
    assert.deepEqual(t, { input: 120, output: 55, cacheRead: 1300, cacheWrite: 10, total: 1485 })
  })

  it("el fin de turno trae los tokens del turno y el acumulado", () => {
    const actions = norm().handle({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1200,
      total_cost_usd: 0.05,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
      modelUsage: { "claude-haiku-4-5": { inputTokens: 40, outputTokens: 60, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 } },
    })
    const [ev] = events(actions) as { tokens?: number }[]
    assert.equal(ev!.tokens, 330)
    const cost = actions.find((a) => a.type === "cost") as { tokens: { total: number } }
    assert.equal(cost.tokens.total, 1000)
  })
})
