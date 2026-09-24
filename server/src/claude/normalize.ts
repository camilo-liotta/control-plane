import path from "node:path"

import type { SlashCommand, SubagentUsage, TimelineEvent, TokenUsage, UsageInfo } from "../shared/types.ts"
import { clampJson, oneLine, truncate } from "../util.ts"
import type { CliMessage } from "./process.ts"

/** Lo que el SessionManager tiene que hacer con cada mensaje del CLI. */
export interface RawImage {
  mediaType: string
  data: string
}

export type Action =
  /** images: imágenes crudas (base64) que el SessionManager guarda como adjuntos. */
  | { type: "event"; event: TimelineEvent; images?: RawImage[] }
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
  | { type: "cost"; totalUsd: number; tokens: TokenUsage | null }
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
  | { type: "commands"; commands: SlashCommand[] }
  | {
      type: "subagent_start"
      toolUseId: string
      taskId: string
      description: string
      subagentType: string | null
      background: boolean
      prompt: string
    }
  | { type: "subagent_progress"; taskId: string; toolUseId: string | null; activity: string | null; usage: SubagentUsage | null }
  | { type: "subagent_end"; taskId: string; toolUseId: string | null; status: "completed" | "failed" | "killed"; summary: string | null; usage: SubagentUsage | null }
  /** El resumen con el que sigue la conversación después de compactar. */
  | { type: "compact_summary"; text: string }
  | { type: "compact_failed"; reason: string }

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

export function parseCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof (c as { name?: unknown }).name === "string")
    .map((c) => ({
      name: String(c.name),
      description: String(c.description ?? ""),
      argumentHint: String(c.argumentHint ?? ""),
      ...(c.builtin ? { builtin: true } : {}),
    }))
}

function imagesOf(content: unknown): RawImage[] {
  if (!Array.isArray(content)) return []
  const out: RawImage[] = []
  for (const b of content as Block[]) {
    const source = b.source as { type?: string; media_type?: string; data?: string } | undefined
    if (b.type === "image" && source?.type === "base64" && typeof source.data === "string")
      out.push({ mediaType: source.media_type ?? "image/png", data: source.data })
  }
  return out
}

/** La salida estructurada de leer una imagen trae el base64 entero: no vale la pena guardarla. */
function isBinaryResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const v = value as { type?: string; file?: { base64?: unknown } }
  return v.type === "image" || typeof v.file?.base64 === "string"
}

/** Suma el uso acumulado de todos los modelos de la sesión (incluye subagentes y turnos anteriores). */
export function sessionTokens(modelUsage: unknown): TokenUsage | null {
  if (!modelUsage || typeof modelUsage !== "object") return null
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let any = false
  for (const u of Object.values(modelUsage as Record<string, Record<string, unknown>>)) {
    if (!u || typeof u !== "object") continue
    any = true
    t.input += Number(u.inputTokens ?? 0)
    t.output += Number(u.outputTokens ?? 0)
    t.cacheRead += Number(u.cacheReadInputTokens ?? 0)
    t.cacheWrite += Number(u.cacheCreationInputTokens ?? 0)
  }
  if (!any) return null
  t.total = t.input + t.output + t.cacheRead + t.cacheWrite
  return t
}

function turnTokens(usage: unknown): number | undefined {
  const u = usage as Record<string, unknown> | undefined
  if (!u) return undefined
  const n =
    Number(u.input_tokens ?? 0) +
    Number(u.output_tokens ?? 0) +
    Number(u.cache_read_input_tokens ?? 0) +
    Number(u.cache_creation_input_tokens ?? 0)
  return n > 0 ? n : undefined
}

function usageOf(raw: unknown): SubagentUsage | null {
  const u = raw as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | undefined
  if (!u || typeof u.total_tokens !== "number") return null
  return { tokens: u.total_tokens, toolUses: Number(u.tool_uses ?? 0), durationMs: Number(u.duration_ms ?? 0) }
}

const LOCAL_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/

const SUMMARY_HEAD = /^This session is being continued from a previous conversation[^\n]*\n+/
const SUMMARY_TAIL = /\n+If you need specific details from before compaction[\s\S]*$/

const COMPACT_ERRORS: Record<string, string> = {
  too_few_groups: "había muy pocos mensajes para resumir",
  exhausted: "la conversación no entró ni achicándola",
  aborted: "se interrumpió",
}

export function compactError(reason: string): string {
  return COMPACT_ERRORS[reason] ?? reason
}

/** El resumen de compactación sin el encabezado y las instrucciones que agrega Claude Code. */
export function cleanCompactSummary(text: string): string {
  return text.replace(SUMMARY_HEAD, "").replace(SUMMARY_TAIL, "").replace(/^Summary:\s*\n/, "").trim()
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

    if (msg.isSynthetic && parent === null) {
      const text = textOf(content)
      if (SUMMARY_HEAD.test(text)) return [{ type: "compact_summary", text: cleanCompactSummary(text) }]
    }

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
      const local = LOCAL_OUTPUT.exec(text.trim())
      if (local) {
        const body = (local[2] ?? "").trim()
        // "Compacted …" (con la salida de los hooks): lo muestra la tarjeta de compactación.
        if (/^Compacted\b/.test(body)) return []
        return body
          ? [{ type: "event", event: { kind: "notice", level: local[1] === "stderr" ? "warn" : "info", text: body } }]
          : []
      }
      if (!text.trim() || msg.isSynthetic) return []
      return [{ type: "event", event: { kind: "user", text, origin: "external", uuid } }]
    }

    if (!Array.isArray(content)) return []
    const actions: Action[] = []
    for (const block of content as Block[]) {
      if (block.type === "tool_result") {
        const { text, truncated } = truncate(toolResultText(block.content), TOOL_RESULT_MAX)
        const images = imagesOf(block.content)
        const structured =
          msg.tool_use_result !== undefined && !isBinaryResult(msg.tool_use_result)
            ? { structured: clampJson(msg.tool_use_result, TOOL_RESULT_MAX) }
            : {}
        actions.push({
          type: "event",
          event: {
            kind: "tool_result",
            toolUseId: String(block.tool_use_id ?? ""),
            content: text,
            isError: Boolean(block.is_error),
            ...(truncated ? { truncated } : {}),
            ...structured,
            parent,
          },
          ...(images.length ? { images } : {}),
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
    const tokens = turnTokens(msg.usage)
    const actions: Action[] = [
      {
        type: "event",
        event: {
          kind: "turn_end",
          ok: !isError,
          subtype: String(msg.subtype ?? ""),
          durationMs: Number(msg.duration_ms ?? 0),
          costUsd: cost,
          ...(tokens ? { tokens } : {}),
          ...(terminal ? { terminalReason: terminal } : {}),
          ...(errorText ? { error: errorText } : {}),
        },
      },
      { type: "turn_end", ok: !isError, aborted, result: String(msg.result ?? "") },
    ]
    const total = sessionTokens(msg.modelUsage)
    if (cost > 0 || total) actions.push({ type: "cost", totalUsd: cost, tokens: total })
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
      case "status": {
        if (msg.status === "compacting") return [{ type: "activity", text: "Compactando el contexto…" }]
        const result = typeof msg.compact_result === "string" ? msg.compact_result : null
        if (!result || result === "success") return []
        const reason = typeof msg.compact_error === "string" ? msg.compact_error : result
        return [
          { type: "event", event: { kind: "notice", level: "warn", text: `La compactación no se completó: ${compactError(reason)}.` } },
          { type: "compact_failed", reason },
        ]
      }
      case "compact_boundary": {
        const meta = (msg.compact_metadata ?? {}) as {
          trigger?: string
          pre_tokens?: number
          post_tokens?: number
          duration_ms?: number
        }
        return [
          {
            type: "event",
            event: {
              kind: "compact",
              trigger: String(meta.trigger ?? "auto"),
              preTokens: Number(meta.pre_tokens ?? 0),
              ...(typeof meta.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}),
              ...(typeof meta.duration_ms === "number" ? { durationMs: meta.duration_ms } : {}),
            },
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
      case "commands_changed":
        return [{ type: "commands", commands: parseCommands(msg.commands) }]
      case "task_started": {
        if (msg.task_type === "local_agent" && typeof msg.tool_use_id === "string") {
          return [
            {
              type: "subagent_start",
              toolUseId: msg.tool_use_id,
              taskId: String(msg.task_id ?? ""),
              description: String(msg.description ?? "subagente"),
              subagentType: typeof msg.subagent_type === "string" ? msg.subagent_type : null,
              background: Boolean(msg.is_backgrounded),
              prompt: String(msg.prompt ?? ""),
            },
          ]
        }
        if (msg.owned_by_subagent) return []
        return typeof msg.description === "string" ? [{ type: "activity", text: oneLine(msg.description, 120) }] : []
      }
      case "task_progress":
        return [
          {
            type: "subagent_progress",
            taskId: String(msg.task_id ?? ""),
            toolUseId: typeof msg.tool_use_id === "string" ? msg.tool_use_id : null,
            activity: typeof msg.description === "string" ? oneLine(msg.description.replace(/^Running /, ""), 160) : null,
            usage: usageOf(msg.usage),
          },
        ]
      case "task_updated": {
        const patch = (msg.patch ?? {}) as { status?: string; error?: string }
        if (patch.status === "completed" || patch.status === "failed" || patch.status === "killed") {
          return [
            {
              type: "subagent_end",
              taskId: String(msg.task_id ?? ""),
              toolUseId: null,
              status: patch.status,
              summary: patch.error ? oneLine(patch.error, 300) : null,
              usage: null,
            },
          ]
        }
        return []
      }
      case "task_notification": {
        const status = msg.status === "failed" ? "failed" : msg.status === "stopped" ? "killed" : "completed"
        const actions: Action[] = [
          {
            type: "subagent_end",
            taskId: String(msg.task_id ?? ""),
            toolUseId: typeof msg.tool_use_id === "string" ? msg.tool_use_id : null,
            status,
            summary: typeof msg.summary === "string" ? oneLine(msg.summary, 300) : null,
            usage: usageOf(msg.usage),
          },
        ]
        if (typeof msg.summary === "string" && !msg.owned_by_subagent) actions.push({ type: "activity", text: oneLine(msg.summary, 120) })
        return actions
      }
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
