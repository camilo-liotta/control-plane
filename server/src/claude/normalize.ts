import path from "node:path"

import type { TimelineEvent, UsageInfo } from "../shared/types.ts"
import { clampJson, oneLine, truncate } from "../util.ts"
import type { CliMessage } from "./process.ts"

/** Lo que el SessionManager tiene que hacer con cada mensaje del CLI. */
export type Action =
  | { type: "event"; event: TimelineEvent }
  | { type: "status"; state: "running" | "idle" | "requires_action" }
  | {
      type: "partial"
      messageId: string
      index: number
      block: "text" | "thinking"
      delta: string
    }
  | { type: "partial_clear" }
  | { type: "activity"; text: string }
  | { type: "cost"; totalUsd: number }
  | { type: "usage"; usage: UsageInfo }
  | {
      type: "init"
      cwd: string
      model: string
      mcpServers: { name: string; status: string }[]
    }
  | { type: "turn_end"; ok: boolean; aborted: boolean; result: string }
  | { type: "command"; uuid: string; state: string }
  | { type: "reset"; newSessionId: string }

const TOOL_RESULT_MAX = 12_000
const TOOL_INPUT_MAX = 24_000

type Block = { type: string; [key: string]: unknown }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b: Block) => (b.type === "text" ? String(b.text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
  return content
    .map((b: Block) => {
      if (b.type === "text") return String(b.text ?? "")
      if (b.type === "image") return "[imagen]"
      if (b.type === "tool_reference") return `[herramienta ${String(b.tool_name ?? "")}]`
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

const base = (p: unknown) => (typeof p === "string" ? path.basename(p) : "")

/** Una línea legible de lo que está haciendo la sesión. */
export function toolActivity(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `$ ${oneLine(String(input.command ?? ""), 120)}`
    case "Read":
      return `Leyendo ${base(input.file_path)}`
    case "Edit":
    case "MultiEdit":
      return `Editando ${base(input.file_path)}`
    case "Write":
      return `Escribiendo ${base(input.file_path)}`
    case "NotebookEdit":
      return `Editando ${base(input.notebook_path)}`
    case "Grep":
      return `Buscando “${oneLine(String(input.pattern ?? ""), 60)}”`
    case "Glob":
      return `Buscando archivos ${oneLine(String(input.pattern ?? ""), 60)}`
    case "Task":
    case "Agent":
      return `Subagente: ${oneLine(String(input.description ?? input.prompt ?? ""), 80)}`
    case "WebFetch":
      return `Leyendo ${oneLine(String(input.url ?? ""), 80)}`
    case "WebSearch":
      return `Buscando en la web: ${oneLine(String(input.query ?? ""), 80)}`
    case "TodoWrite":
      return "Actualizando la lista de tareas"
    case "SendMessage":
      return `Mensaje a ${String(input.to ?? input.recipient ?? "otra sesión")}`
    case "ListAgents":
      return "Listando sesiones"
    case "AskUserQuestion":
      return "Te hizo una pregunta"
    case "ToolSearch":
      return "Cargando herramientas"
    case "mcp__control-plane__report_result":
      return "Reportó su resultado"
    case "mcp__control-plane__propose_prompt":
      return `Propuso un prompt para ${String(input.session ?? "")}`
    case "mcp__control-plane__propose_session":
      return `Propuso una sesión nueva: ${String(input.name ?? "")}`
    case "mcp__control-plane__read_results":
      return "Leyendo la cola de resultados"
    default:
      return name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name
  }
}

function usageFrom(info: Record<string, unknown> | undefined): UsageInfo | null {
  if (!info) return null
  const windows = (info.unifiedWindows ?? {}) as Record<
    string,
    { utilization?: number; resetsAt?: number } | undefined
  >
  const win = (w: { utilization?: number; resetsAt?: number } | undefined) =>
    w && typeof w.utilization === "number"
      ? { utilization: w.utilization, resetsAt: Number(w.resetsAt ?? 0) * 1000 }
      : null
  return {
    status: typeof info.status === "string" ? info.status : null,
    fiveHour: win(windows.five_hour),
    sevenDay: win(windows.seven_day),
    updatedAt: Date.now(),
  }
}

/**
 * Convierte el stream del CLI en eventos de timeline y acciones de estado.
 * Guarda el tipo de cada bloque en streaming para rutear los deltas parciales.
 */
export class StreamNormalizer {
  private currentMessageId: string | null = null
  private blockKinds = new Map<number, "text" | "thinking" | "other">()
  private isOwnMessage: (uuid: string) => boolean

  constructor(isOwnMessage: (uuid: string) => boolean) {
    this.isOwnMessage = isOwnMessage
  }

  handle(msg: CliMessage): Action[] {
    switch (msg.type) {
      case "assistant":
        return this.assistant(msg)
      case "user":
        return this.user(msg)
      case "result":
        return this.result(msg)
      case "system":
        return this.system(msg)
      case "stream_event":
        return this.streamEvent(msg)
      case "rate_limit_event": {
        const usage = usageFrom(msg.rate_limit_info as Record<string, unknown> | undefined)
        return usage ? [{ type: "usage", usage }] : []
      }
      case "command_lifecycle":
        return typeof msg.command_uuid === "string"
          ? [{ type: "command", uuid: msg.command_uuid, state: String(msg.state) }]
          : []
      case "conversation_reset":
        return typeof msg.new_conversation_id === "string"
          ? [
              { type: "reset", newSessionId: msg.new_conversation_id },
              {
                type: "event",
                event: { kind: "notice", level: "info", text: "La conversación se reinició (/clear)." },
              },
            ]
          : []
      default:
        return []
    }
  }

  private assistant(msg: CliMessage): Action[] {
    const message = msg.message as { id?: string; content?: Block[] } | undefined
    const parent = (msg.parent_tool_use_id as string | null) ?? null
    const messageId = message?.id ?? "unknown"
    const actions: Action[] = []
    for (const block of message?.content ?? []) {
      if (block.type === "text") {
        const text = String(block.text ?? "")
        if (!text.trim()) continue
        actions.push({
          type: "event",
          event: {
            kind: "text",
            text,
            messageId,
            parent,
            ...(msg.aborted ? { aborted: true } : {}),
          },
        })
      } else if (block.type === "thinking") {
        const text = String(block.thinking ?? "")
        if (!text.trim()) continue
        actions.push({ type: "event", event: { kind: "thinking", text, messageId, parent } })
      } else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
        const name = String(block.name ?? "herramienta")
        const input = (block.input ?? {}) as Record<string, unknown>
        actions.push({
          type: "event",
          event: {
            kind: "tool_use",
            id: String(block.id ?? ""),
            name,
            input: clampJson(input, TOOL_INPUT_MAX),
            parent,
          },
        })
        if (parent === null) actions.push({ type: "activity", text: toolActivity(name, input) })
      }
    }
    if (parent === null) actions.push({ type: "partial_clear" })
    if (typeof msg.error === "string" && msg.error) {
      actions.push({
        type: "event",
        event: { kind: "notice", level: "error", text: `Error de la API: ${msg.error}` },
      })
    }
    return actions
  }

  private user(msg: CliMessage): Action[] {
    const message = msg.message as { content?: unknown } | undefined
    const content = message?.content
    const parent = (msg.parent_tool_use_id as string | null) ?? null
    const origin = msg.origin as
      | { kind?: string; name?: string; from?: string; body?: string }
      | undefined

    if (msg.isReplay) {
      if (origin?.kind === "peer") {
        return [
          {
            type: "event",
            event: {
              kind: "peer",
              from: origin.name || origin.from || "otra sesión",
              body: origin.body ?? textOf(content),
            },
          },
        ]
      }
      if (origin?.kind === "task-notification" || origin?.kind === "channel") return []
      const uuid = typeof msg.uuid === "string" ? msg.uuid : ""
      if (uuid && this.isOwnMessage(uuid)) return []
      const text = textOf(content)
      if (!text.trim() || msg.isSynthetic) return []
      return [{ type: "event", event: { kind: "user", text, origin: "external", uuid } }]
    }

    if (!Array.isArray(content)) return []
    const actions: Action[] = []
    for (const block of content as Block[]) {
      if (block.type === "tool_result") {
        const { text, truncated } = truncate(toolResultText(block.content), TOOL_RESULT_MAX)
        actions.push({
          type: "event",
          event: {
            kind: "tool_result",
            toolUseId: String(block.tool_use_id ?? ""),
            content: text,
            isError: Boolean(block.is_error),
            ...(truncated ? { truncated } : {}),
            ...(msg.tool_use_result !== undefined
              ? { structured: clampJson(msg.tool_use_result, TOOL_RESULT_MAX) }
              : {}),
            parent,
          },
        })
      } else if (block.type === "text" && parent === null) {
        const text = String(block.text ?? "")
        if (text.startsWith("[Request interrupted")) {
          actions.push({
            type: "event",
            event: { kind: "notice", level: "warn", text: "Turno interrumpido." },
          })
        }
      }
    }
    return actions
  }

  private result(msg: CliMessage): Action[] {
    const isError = Boolean(msg.is_error)
    const terminal = typeof msg.terminal_reason === "string" ? msg.terminal_reason : undefined
    const aborted = Boolean(terminal?.startsWith("aborted")) || terminal === "interrupted"
    const errors = Array.isArray(msg.errors) ? (msg.errors as string[]) : []
    const errorText = isError && !aborted
      ? oneLine(errors.filter((e) => !e.startsWith("[ede_diagnostic]")).join(" · ") || String(msg.result ?? "Error"), 400)
      : undefined
    const cost = Number(msg.total_cost_usd ?? 0)
    const actions: Action[] = [
      {
        type: "event",
        event: {
          kind: "turn_end",
          ok: !isError,
          subtype: String(msg.subtype ?? ""),
          durationMs: Number(msg.duration_ms ?? 0),
          costUsd: cost,
          ...(terminal ? { terminalReason: terminal } : {}),
          ...(errorText ? { error: errorText } : {}),
        },
      },
      { type: "turn_end", ok: !isError, aborted, result: String(msg.result ?? "") },
    ]
    if (cost > 0) actions.push({ type: "cost", totalUsd: cost })
    return actions
  }

  private system(msg: CliMessage): Action[] {
    switch (msg.subtype) {
      case "init":
        return [
          {
            type: "init",
            cwd: String(msg.cwd ?? ""),
            model: String(msg.model ?? ""),
            mcpServers: Array.isArray(msg.mcp_servers)
              ? (msg.mcp_servers as { name: string; status: string }[])
              : [],
          },
        ]
      case "session_state_changed": {
        const state = msg.state
        return state === "running" || state === "idle" || state === "requires_action"
          ? [{ type: "status", state }]
          : []
      }
      case "status":
        return msg.status === "compacting" ? [{ type: "activity", text: "Compactando el contexto…" }] : []
      case "compact_boundary": {
        const meta = (msg.compact_metadata ?? {}) as { trigger?: string; pre_tokens?: number }
        return [
          {
            type: "event",
            event: { kind: "compact", trigger: String(meta.trigger ?? "auto"), preTokens: Number(meta.pre_tokens ?? 0) },
          },
        ]
      }
      case "informational": {
        const level = msg.level === "warning" ? "warn" : "info"
        const text = String(msg.content ?? "").trim()
        return text ? [{ type: "event", event: { kind: "notice", level, text } }] : []
      }
      case "local_command_output": {
        const text = String(msg.content ?? "").trim()
        return text ? [{ type: "event", event: { kind: "notice", level: "info", text } }] : []
      }
      case "api_retry": {
        const attempt = Number(msg.attempt ?? 0)
        const max = Number(msg.max_retries ?? 0)
        return [{ type: "activity", text: `Reintentando la API (${attempt}/${max})…` }]
      }
      case "task_started":
        return typeof msg.description === "string"
          ? [{ type: "activity", text: oneLine(msg.description, 120) }]
          : []
      case "task_notification":
        return typeof msg.summary === "string" ? [{ type: "activity", text: oneLine(msg.summary, 120) }] : []
      default:
        return []
    }
  }

  private streamEvent(msg: CliMessage): Action[] {
    if (msg.parent_tool_use_id) return []
    const event = msg.event as
      | {
          type: string
          index?: number
          message?: { id?: string }
          content_block?: { type?: string }
          delta?: { type?: string; text?: string; thinking?: string }
        }
      | undefined
    if (!event) return []
    switch (event.type) {
      case "message_start":
        this.currentMessageId = event.message?.id ?? null
        this.blockKinds.clear()
        return []
      case "content_block_start": {
        const t = event.content_block?.type
        this.blockKinds.set(event.index ?? 0, t === "text" ? "text" : t === "thinking" ? "thinking" : "other")
        return []
      }
      case "content_block_delta": {
        const index = event.index ?? 0
        const kind = this.blockKinds.get(index)
        const messageId = this.currentMessageId
        if (!messageId) return []
        if (kind === "text" && event.delta?.type === "text_delta" && event.delta.text)
          return [{ type: "partial", messageId, index, block: "text", delta: event.delta.text }]
        if (kind === "thinking" && event.delta?.type === "thinking_delta" && event.delta.thinking)
          return [{ type: "partial", messageId, index, block: "thinking", delta: event.delta.thinking }]
        return []
      }
      default:
        return []
    }
  }
}
