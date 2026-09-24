import { EventEmitter } from "node:events"
import fs from "node:fs"

import { toRef, VISION_TYPES, type AttachmentStore } from "./attachments.ts"
import { buildLaunch } from "./claude/args.ts"
import { lastCostState, type RestoredSpend } from "./claude/local.ts"
import { isContextFull, parseCommands, StreamNormalizer, type RawImage } from "./claude/normalize.ts"
import { ClaudeProcess, type CliMessage, type ExitInfo } from "./claude/process.ts"
import type { AttachmentRecord, Db, SessionRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import type {
  ContextUsage,
  ExternalSession,
  Meta,
  ModelOption,
  PendingRequest,
  Question,
  Session,
  SessionKind,
  SessionStatus,
  SlashCommand,
  StoredEvent,
  SubagentBrief,
  SubagentSpec,
  SubagentStatus,
  TimelineEvent,
  TokenUsage,
  UsageInfo,
  UserOrigin,
} from "./shared/types.ts"
import { withSubagents } from "./prompts.ts"
import { clampJson, errorMessage, now, oneLine, plainText, shortId, token, uuid } from "./util.ts"

interface PendingControl {
  kind: "question" | "permission"
  eventId: number
  input: Record<string, unknown>
}

interface Runtime {
  proc: ClaudeProcess
  normalizer: StreamNormalizer
  ready: Promise<void>
  cliState: "running" | "idle" | "requires_action"
  status: SessionStatus
  statusDetail: string | null
  pendingControl: Map<string, PendingControl>
  queued: Set<string>
  ownUuids: Set<string>
  startedAt: number
  retried: boolean
  mcpWarned: boolean
  currentModel: string | null
  accountId: string
  /** Subagentes lanzados por esta sesión, por id de la llamada Agent. */
  subagents: Map<string, { eventId: number; status: SubagentStatus }>
  taskToTool: Map<string, string>
  /** Llamadas Agent/Task vistas (para saber nombre, modelo y de quién dependen). */
  agentCalls: Map<string, { input: Record<string, unknown>; parent: string | null }>
  context: ContextUsage | null
  /** Si el turno en curso tuvo respuesta del modelo (los comandos locales, como /compact, no). */
  turnHadAssistant: boolean
  lastCompactEventId: number | null
  /** La sesión espera algo tuyo que no es una pregunta de Claude (ej. elegir qué conservar al compactar). */
  hold: string | null
  /** El turno en curso, para el indicador de "trabajando": cuándo empezó y cuántos tokens van. */
  turn: TurnCounter | null
  /** Lo que la sesión llevaba gastado cuando arrancó este proceso. */
  spentBefore: { usd: number; tokens: TokenUsage | null }
  /**
   * Lo que Claude Code restaura al reanudar (el último cost-state del transcript): sus totales siguen
   * desde ahí. applies se decide con el primer total que informa (si es menor, no restauró nada).
   */
  restored: RestoredSpend & { applies: boolean | null }
  /** Lo que se le mandó en el turno en curso, para reenviarlo si no entra. */
  turnInputs: TurnInput[]
  /** Lo que no entró en el último turno porque el contexto estaba lleno. */
  failedInputs: TurnInput[] | null
  /** El turno en curso es un reenvío: si vuelve a no entrar, no se insiste solo. */
  resending: boolean
  /** Los últimos totales que informó el proceso (para rebasar la cuenta si la conversación se reinicia). */
  lastTotals: { usd: number; tokens: TokenUsage | null }
  /** Hubo un /clear: el próximo fin de turno (el del propio /clear) dice si los totales volvieron a cero. */
  resetPending: boolean
}

interface TurnInput {
  text: string
  opts: SendOptions
}

/** Aviso que reemplaza al mensaje reenviado en el chat (el original ya se ve más arriba). */
const RESENT_NOTICE = "Reenvié el mensaje que no había entrado."

interface TurnCounter {
  startedAt: number
  /** Tokens finales de cada mensaje ya completo. */
  final: Map<string, number>
  /** Caracteres que van llegando de los mensajes en curso (≈ 4 por token). */
  chars: Map<string, number>
  thinking: number
  timer: NodeJS.Timeout | null
}

const AGENT_TOOLS = new Set(["Agent", "Task"])

export interface TurnEndInfo {
  ok: boolean
  aborted: boolean
  result: string
  /** Turno de un comando local (/compact, /context…): el modelo no respondió nada. */
  local: boolean
  /** No salió porque el contexto estaba lleno ("Prompt is too long"). */
  contextFull: boolean
  /** Era un reenvío de algo que ya no había entrado. */
  retried: boolean
}

export interface CreateSessionInput {
  projectId: string
  kind: SessionKind
  name: string
  role: string
  cwd: string
  model?: string | null
  effort?: string | null
  worktree?: boolean
  /** Conversación existente de Claude Code para retomar (importar). */
  claudeSessionId?: string
}

export interface SendOptions {
  origin: UserOrigin
  draftId?: string
  draftTitle?: string
  /** Evento a guardar en lugar del mensaje de usuario (ej. un lote de resultados). */
  event?: TimelineEvent
  attachments?: AttachmentRecord[]
  /** Lo que se muestra en el chat si es distinto de lo que se envía (ej. sin las instrucciones de subagentes). */
  display?: string
  subagents?: SubagentSpec[]
}

/** Todo lo que hace falta para lanzar una sesión: protocolo, modelo y la cuenta con la que corre. */
export interface LaunchContext {
  protocol: string
  orchestratorCanEdit: boolean
  model: string | null
  effort: string | null
  env: Record<string, string>
  bin: string
  accountId: string
}

export interface SessionManagerOptions {
  db: Db
  hub: Hub
  attachments: AttachmentStore
  mcpUrlFor: (token: string) => string
  hookUrlFor: (token: string) => string
  launchFor: (session: SessionRecord) => LaunchContext
  accountIdFor: (session: SessionRecord) => string
  /** Si la conversación está viva fuera del dashboard (terminal o segundo plano). */
  liveElsewhere?: (session: SessionRecord) => Promise<ExternalSession | null>
  meta: Meta
}

/**
 * Dueño de los procesos `claude`: los lanza, les manda mensajes, traduce su stream
 * y mantiene el estado de cada sesión.
 */
export class SessionManager extends EventEmitter<{
  turnEnd: [SessionRecord, TurnEndInfo]
  status: [SessionRecord, SessionStatus]
  meta: [Meta]
  commands: [string, SlashCommand[]]
  account_info: [string, { email?: string; organization?: string; subscription?: string }]
  context: [string, ContextUsage]
  compacted: [string, number]
  compactFailed: [string, string]
}> {
  private runtimes = new Map<string, Runtime>()
  private stoppedDetail = new Map<string, string>()
  private lastTexts = new Map<string, string | null>()
  /** Últimos comandos conocidos por sesión (sirven aunque esté detenida) y los de cada cuenta. */
  private commands = new Map<string, SlashCommand[]>()
  private accountCommands = new Map<string, SlashCommand[]>()
  /** Uso del plan por cuenta (cada cuenta tiene sus propios límites). */
  private usage = new Map<string, UsageInfo>()
  meta: Meta
  private db: Db
  private hub: Hub
  private attachments: AttachmentStore
  private mcpUrlFor: (token: string) => string
  private hookUrlFor: (token: string) => string
  private launchFor: (session: SessionRecord) => LaunchContext
  private accountIdFor: (session: SessionRecord) => string
  private liveElsewhere?: (session: SessionRecord) => Promise<ExternalSession | null>
  /** Conversaciones del dashboard que hoy están abiertas en otro lado (se refresca periódicamente). */
  private external = new Map<string, ExternalSession>()

  constructor(opts: SessionManagerOptions) {
    super()
    this.db = opts.db
    this.hub = opts.hub
    this.attachments = opts.attachments
    this.mcpUrlFor = opts.mcpUrlFor
    this.hookUrlFor = opts.hookUrlFor
    this.launchFor = opts.launchFor
    this.accountIdFor = opts.accountIdFor
    this.liveElsewhere = opts.liveElsewhere
    this.meta = opts.meta
    const db = opts.db
    // Si el server se cortó, ninguna sesión sigue viva: arrancan como detenidas.
    for (const s of db.listSessions()) {
      if (s.status !== "stopped") db.updateSession(s.id, { status: "stopped" })
    }
  }

  // ------------------------------------------------------------------ vistas

  view(rec: SessionRecord): Session {
    const rt = this.runtimes.get(rec.id)
    let pending: PendingRequest | null = null
    if (rt) {
      for (const [requestId, p] of rt.pendingControl) {
        pending =
          p.kind === "question"
            ? { kind: "question", requestId, eventId: p.eventId }
            : { kind: "permission", requestId, eventId: p.eventId, toolName: String(p.input.__toolName ?? "") }
        break
      }
    }
    const { mcpToken: _t, startedOnce: _s, ...rest } = rec
    if (!this.lastTexts.has(rec.id)) this.lastTexts.set(rec.id, this.db.lastText(rec.id))
    const lastText = this.lastTexts.get(rec.id) ?? null
    return {
      ...rest,
      lastText: lastText ? oneLine(plainText(lastText), 400) : null,
      status: rt ? rt.status : rec.status,
      statusDetail: rt ? rt.statusDetail : (this.stoppedDetail.get(rec.id) ?? null),
      pending,
      queuedMessages: rt?.queued.size ?? 0,
      currentModel: rt?.currentModel ?? null,
      subagentsRunning: rt ? [...rt.subagents.values()].filter((s) => s.status === "running").length : 0,
      subagents: rt ? this.subagentBriefs(rt) : [],
      context: rt?.context ?? rec.context,
      external: rt && !rt.proc.exited ? null : (this.external.get(rec.id) ?? null),
    }
  }

  /** Actualiza qué sesiones tienen su conversación abierta fuera del dashboard. */
  setExternal(found: Map<string, ExternalSession>) {
    const changed = new Set<string>([...this.external.keys(), ...found.keys()])
    for (const id of changed) {
      const before = JSON.stringify(this.external.get(id) ?? null)
      const after = JSON.stringify(found.get(id) ?? null)
      if (before === after) continue
      if (found.has(id)) this.external.set(id, found.get(id)!)
      else this.external.delete(id)
      this.broadcastSession(id)
    }
  }

  /** Subagentes trabajando y los que terminaron hace poco (para el mapa del proyecto). */
  private subagentBriefs(rt: Runtime): SubagentBrief[] {
    const recent = now() - 15 * 60_000
    const out: SubagentBrief[] = []
    for (const sub of [...rt.subagents.values()].slice(-12)) {
      const ev = this.db.getEvent(sub.eventId)?.event
      if (!ev || ev.kind !== "subagent") continue
      if (ev.status !== "running" && (ev.endedAt ?? 0) < recent) continue
      out.push({
        toolUseId: ev.toolUseId,
        name: ev.name,
        description: ev.description,
        subagentType: ev.subagentType,
        model: ev.model,
        status: ev.status,
        startedAt: ev.startedAt,
        endedAt: ev.endedAt,
        tokens: ev.usage?.tokens ?? null,
        lastActivity: ev.lastActivity,
      })
    }
    return out.slice(-8)
  }

  usageFor(accountId: string): UsageInfo | null {
    return this.usage.get(accountId) ?? null
  }

  commandsFor(id: string): SlashCommand[] {
    const rec = this.db.getSession(id)
    return this.commands.get(id) ?? (rec ? this.accountCommands.get(this.accountIdFor(rec)) : undefined) ?? []
  }

  /** Comandos guardados de una corrida anterior (para autocompletar antes de que arranque una sesión). */
  seedCommands(byAccount: Record<string, SlashCommand[]>) {
    for (const [accountId, list] of Object.entries(byAccount)) {
      if (Array.isArray(list) && !this.accountCommands.has(accountId)) this.accountCommands.set(accountId, list)
    }
  }

  private rememberCommands(id: string, accountId: string, list: SlashCommand[]) {
    if (!list.length) return
    this.commands.set(id, list)
    const changed = JSON.stringify(list) !== JSON.stringify(this.accountCommands.get(accountId))
    this.accountCommands.set(accountId, list)
    if (changed) this.emit("commands", accountId, list)
  }

  get(id: string): SessionRecord | null {
    return this.db.getSession(id)
  }

  list(): Session[] {
    return this.db.listSessions().map((s) => this.view(s))
  }

  isRunning(id: string) {
    const rt = this.runtimes.get(id)
    return Boolean(rt && !rt.proc.exited)
  }

  statusOf(id: string): SessionStatus {
    return this.runtimes.get(id)?.status ?? "stopped"
  }

  private broadcastSession(id: string) {
    const rec = this.db.getSession(id)
    if (rec) this.hub.broadcast({ type: "session", session: this.view(rec) })
  }

  update(id: string, patch: Partial<SessionRecord>) {
    this.db.updateSession(id, patch)
    this.broadcastSession(id)
  }

  addEvent(sessionId: string, event: TimelineEvent): StoredEvent {
    const stored = this.db.insertEvent(sessionId, now(), event)
    this.hub.broadcast({ type: "event", event: stored })
    if (event.kind === "text" && !event.parent) {
      this.lastTexts.set(sessionId, event.text)
      this.broadcastSession(sessionId)
    }
    return stored
  }

  /** Guarda como adjuntos las imágenes que devolvió una herramienta (capturas, imágenes leídas). */
  private storeImages(sessionId: string, images: RawImage[]) {
    return images.map((img, i) => {
      const ext = img.mediaType.split("/")[1] ?? "png"
      const rec = this.attachments.save(sessionId, {
        name: `imagen-${Date.now()}-${i + 1}.${ext}`,
        mime: img.mediaType,
        data: Buffer.from(img.data, "base64"),
        source: "tool",
      })
      return toRef(rec)
    })
  }

  private patchEvent(eventId: number, patch: Partial<TimelineEvent>) {
    const stored = this.db.getEvent(eventId)
    if (!stored) return
    stored.event = { ...stored.event, ...patch } as TimelineEvent
    this.db.updateEvent(stored)
    this.hub.broadcast({ type: "event_update", event: stored })
  }

  // ---------------------------------------------------------------- creación

  create(input: CreateSessionInput): SessionRecord {
    const rec: SessionRecord = {
      id: shortId("s_"),
      projectId: input.projectId,
      kind: input.kind,
      name: input.name,
      role: input.role,
      claudeSessionId: input.claudeSessionId ?? uuid(),
      startedOnce: Boolean(input.claudeSessionId),
      mcpToken: token(),
      model: input.model ?? null,
      effort: input.effort ?? null,
      worktree: Boolean(input.worktree),
      cwd: input.cwd,
      status: "stopped",
      taskTitle: null,
      taskState: "none",
      lastActivity: null,
      lastActivityAt: null,
      costUsd: 0,
      tokens: null,
      context: null,
      createdAt: now(),
      archivedAt: null,
    }
    this.db.insertSession(rec)
    this.broadcastSession(rec.id)
    return rec
  }

  // ------------------------------------------------------------------ ciclo

  /** Lanza el proceso si no está corriendo. Resuelve cuando el CLI terminó el handshake. */
  async start(id: string): Promise<void> {
    const existing = this.runtimes.get(id)
    if (existing && !existing.proc.exited) return existing.ready
    const rec = this.db.getSession(id)
    if (!rec) throw new Error("Sesión inexistente")
    if (rec.archivedAt) throw new Error("La sesión está archivada")
    // Dos procesos sobre la misma conversación la rompen: si está abierta en otro lado, no se reanuda.
    if (rec.startedOnce && this.liveElsewhere) {
      const live = await this.liveElsewhere(rec).catch(() => null)
      const again = this.runtimes.get(id)
      if (again && !again.proc.exited) return again.ready
      if (live) {
        this.setExternal(new Map([...this.external, [id, live]]))
        throw new Error(
          live.kind === "background"
            ? `Esta conversación corre en segundo plano en Claude Code. Detenela con: claude stop ${live.id ?? ""}`.trim()
            : `Esta conversación está abierta en una terminal${live.pid ? ` (pid ${live.pid})` : ""}. Cerrala con /exit para usarla desde acá: dos procesos sobre la misma conversación la rompen.`
        )
      }
    }
    return this.launch(rec, existing?.retried ?? false)
  }

  private launch(rec: SessionRecord, retried: boolean): Promise<void> {
    const built = this.launchFor(rec)
    const { args, env } = buildLaunch(rec, {
      mcpUrl: this.mcpUrlFor(rec.mcpToken),
      hookUrl: this.hookUrlFor(rec.mcpToken),
      protocol: built.protocol,
      orchestratorCanEdit: built.orchestratorCanEdit,
      model: built.model,
      effort: built.effort,
    })
    const proc = new ClaudeProcess(built.bin, args, rec.cwd, { ...env, ...built.env })
    const rt: Runtime = {
      proc,
      normalizer: new StreamNormalizer((u) => rt.ownUuids.has(u)),
      ready: Promise.resolve(),
      cliState: "idle",
      status: "starting",
      statusDetail: null,
      pendingControl: new Map(),
      queued: new Set(),
      ownUuids: new Set(),
      startedAt: now(),
      retried,
      mcpWarned: false,
      currentModel: null,
      accountId: built.accountId,
      subagents: new Map(),
      taskToTool: new Map(),
      agentCalls: new Map(),
      context: rec.context,
      turnHadAssistant: false,
      lastCompactEventId: null,
      hold: null,
      turn: null,
      spentBefore: { usd: rec.costUsd, tokens: rec.tokens },
      restored: { ...(lastCostState(rec.cwd, rec.claudeSessionId, built.env.CLAUDE_CONFIG_DIR) ?? { usd: 0, tokens: null }), applies: null },
      turnInputs: [],
      failedInputs: null,
      resending: false,
      lastTotals: { usd: 0, tokens: null },
      resetPending: false,
    }
    this.runtimes.set(rec.id, rt)
    this.stoppedDetail.delete(rec.id)
    proc.on("message", (msg) => this.onMessage(rec.id, rt, msg))
    proc.on("control_request", (msg) => this.onControlRequest(rec.id, rt, msg))
    proc.on("exit", (info) => this.onExit(rec.id, rt, info))
    proc.start()
    this.db.updateSession(rec.id, { status: "starting" })
    this.broadcastSession(rec.id)

    rt.ready = proc
      .request("initialize", {}, 90_000)
      .then((resp) => {
        this.captureMeta(resp, rt.accountId)
        this.rememberCommands(rec.id, rt.accountId, parseCommands(resp.commands))
        if (this.runtimes.get(rec.id) !== rt) return
        this.setStatus(rec.id, rt, rt.pendingControl.size ? "needs_input" : "idle")
        void this.refreshContext(rec.id, rt)
      })
      .catch((err) => {
        if (!proc.exited) void proc.close(1000)
        throw new Error(`No se pudo iniciar la sesión: ${errorMessage(err)}`)
      })
    rt.ready.catch(() => {})
    return rt.ready
  }

  private captureMeta(resp: Record<string, unknown>, accountId: string) {
    const models = Array.isArray(resp.models)
      ? (
          resp.models as {
            value: string
            displayName?: string
            description?: string
            supportedEffortLevels?: string[]
            resolvedModel?: string
          }[]
        ).map(
          (m): ModelOption => ({
            value: m.value,
            label: m.displayName ?? m.value,
            description: m.description,
            efforts: m.supportedEffortLevels,
            resolved: m.resolvedModel,
          })
        )
      : this.meta.models
    const account = (resp.account ?? null) as
      | { email?: string; organization?: string; subscriptionType?: string }
      | null
    if (account)
      this.emit("account_info", accountId, {
        email: account.email,
        organization: account.organization,
        subscription: account.subscriptionType,
      })
    const next: Meta = { ...this.meta, models }
    if (JSON.stringify(next) !== JSON.stringify(this.meta)) {
      this.meta = next
      this.hub.broadcast({ type: "meta", meta: next })
      this.emit("meta", next)
    }
  }

  private setStatus(id: string, rt: Runtime, status: SessionStatus, detail: string | null = null) {
    if (detail === null && status === "needs_input" && rt.hold) detail = rt.hold
    const changed = rt.status !== status || rt.statusDetail !== detail
    rt.status = status
    rt.statusDetail = detail
    if (!changed) return
    this.db.updateSession(id, { status })
    this.broadcastSession(id)
    const rec = this.db.getSession(id)
    if (rec) this.emit("status", rec, status)
  }

  private deriveStatus(rt: Runtime): SessionStatus {
    if (rt.hold || rt.pendingControl.size || rt.cliState === "requires_action") return "needs_input"
    return rt.cliState === "running" ? "working" : "idle"
  }

  private onMessage(id: string, rt: Runtime, msg: CliMessage) {
    if (this.runtimes.get(id) !== rt) return
    if (msg.type === "control_cancel_request") {
      this.cancelControl(rt, String(msg.request_id ?? ""))
      this.setStatus(id, rt, this.deriveStatus(rt))
      return
    }
    for (const action of rt.normalizer.handle(msg)) {
      switch (action.type) {
        case "event": {
          const event = action.event
          if (action.images?.length && event.kind === "tool_result") {
            try {
              event.images = this.storeImages(id, action.images)
            } catch {
              // si no se puede guardar, la imagen queda como "[imagen]" en el texto
            }
          }
          if (event.kind === "tool_use" && AGENT_TOOLS.has(event.name)) {
            rt.agentCalls.set(event.id, { input: (event.input ?? {}) as Record<string, unknown>, parent: event.parent })
          }
          if ((event.kind === "text" || event.kind === "tool_use" || event.kind === "thinking") && !event.parent) rt.turnHadAssistant = true
          if (event.kind === "turn_end") {
            if (rt.resetPending) {
              rt.resetPending = false
              this.decideRestored(rt, event.costUsd, null)
            }
            // El "acumulado" del fin de turno es el de la sesión, no el de este proceso.
            if (event.costUsd > 0) event.costUsd = rt.spentBefore.usd + this.processUsd(rt, event.costUsd)
          }
          const stored = this.addEvent(id, event)
          if (event.kind === "compact") {
            rt.lastCompactEventId = stored.id
            this.emit("compacted", id, stored.id)
          }
          break
        }
        case "compact_summary":
          if (rt.lastCompactEventId !== null) this.patchEvent(rt.lastCompactEventId, { summary: action.text } as Partial<TimelineEvent>)
          break
        case "compact_failed":
          this.emit("compactFailed", id, action.reason)
          break
        case "commands":
          this.rememberCommands(id, rt.accountId, action.commands)
          break
        case "subagent_start": {
          const call = rt.agentCalls.get(action.toolUseId)
          const input = call?.input ?? {}
          const ev = this.addEvent(id, {
            kind: "subagent",
            toolUseId: action.toolUseId,
            taskId: action.taskId,
            description: action.description,
            subagentType: action.subagentType,
            name: typeof input.name === "string" ? input.name : null,
            model: typeof input.model === "string" ? input.model : null,
            background: action.background,
            prompt: action.prompt || String(input.prompt ?? ""),
            status: "running",
            startedAt: now(),
            endedAt: null,
            usage: null,
            lastActivity: null,
            summary: null,
            parent: call?.parent ?? null,
          })
          rt.subagents.set(action.toolUseId, { eventId: ev.id, status: "running" })
          rt.taskToTool.set(action.taskId, action.toolUseId)
          this.broadcastSession(id)
          break
        }
        case "subagent_progress": {
          const toolUseId = action.toolUseId ?? rt.taskToTool.get(action.taskId)
          const sub = toolUseId ? rt.subagents.get(toolUseId) : undefined
          if (!sub) break
          this.patchEvent(sub.eventId, {
            ...(action.usage ? { usage: action.usage } : {}),
            ...(action.activity ? { lastActivity: action.activity } : {}),
          } as Partial<TimelineEvent>)
          this.broadcastSession(id)
          break
        }
        case "subagent_end": {
          const toolUseId = action.toolUseId ?? rt.taskToTool.get(action.taskId)
          const sub = toolUseId ? rt.subagents.get(toolUseId) : undefined
          if (!sub || sub.status !== "running") break
          sub.status = action.status
          this.patchEvent(sub.eventId, {
            status: action.status,
            endedAt: now(),
            ...(action.summary ? { summary: action.summary } : {}),
            ...(action.usage ? { usage: action.usage } : {}),
          } as Partial<TimelineEvent>)
          this.broadcastSession(id)
          break
        }
        case "status":
          rt.cliState = action.state
          if (action.state === "running" && !rt.turn) this.startTurn(id, rt)
          this.setStatus(id, rt, this.deriveStatus(rt))
          break
        case "stream_chars":
          if (!rt.turn) this.startTurn(id, rt)
          rt.turn!.chars.set(action.messageId, (rt.turn!.chars.get(action.messageId) ?? 0) + action.chars)
          this.queueTurn(id, rt)
          break
        case "message_tokens":
          if (!rt.turn) break
          rt.turn.final.set(action.messageId, action.outputTokens)
          rt.turn.chars.delete(action.messageId)
          rt.turn.thinking = 0
          this.queueTurn(id, rt)
          break
        case "thinking_estimate":
          if (!rt.turn) this.startTurn(id, rt)
          rt.turn!.thinking += action.delta
          this.queueTurn(id, rt)
          break
        case "partial":
          this.hub.broadcast({
            type: "partial",
            sessionId: id,
            messageId: action.messageId,
            index: action.index,
            block: action.block,
            delta: action.delta,
          })
          break
        case "partial_clear":
          this.hub.broadcast({ type: "partial_clear", sessionId: id })
          break
        case "activity":
          // Sin marcas de markdown (los resúmenes de subagentes suelen traer títulos y negritas).
          this.db.updateSession(id, {
            lastActivity: oneLine(action.text.replace(/(^|\s)#{1,6}\s+/g, "$1").replace(/\*\*/g, ""), 160),
            lastActivityAt: now(),
          })
          this.broadcastSession(id)
          break
        case "cost":
          // total_cost_usd y modelUsage siguen desde lo que Claude Code restauró al reanudar: se suma solo lo nuevo.
          this.decideRestored(rt, action.totalUsd, action.tokens)
          rt.lastTotals = { usd: action.totalUsd, tokens: action.tokens ?? rt.lastTotals.tokens }
          this.db.updateSession(id, {
            ...(action.totalUsd > 0 ? { costUsd: rt.spentBefore.usd + this.processUsd(rt, action.totalUsd) } : {}),
            ...(action.tokens ? { tokens: addTokens(rt.spentBefore.tokens, tokensSince(action.tokens, rt.restored)) } : {}),
          })
          break
        case "usage":
          this.usage.set(rt.accountId, action.usage)
          this.hub.broadcast({ type: "usage", accountId: rt.accountId, usage: action.usage })
          break
        case "init": {
          if (action.model && action.model !== rt.currentModel) {
            rt.currentModel = action.model
            this.broadcastSession(id)
          }
          const rec = this.db.getSession(id)
          if (!rec) break
          const patch: Partial<SessionRecord> = {}
          if (!rec.startedOnce) patch.startedOnce = true
          if (action.cwd && action.cwd !== rec.cwd && rec.worktree) patch.cwd = action.cwd
          if (Object.keys(patch).length) this.db.updateSession(id, patch)
          const cp = action.mcpServers.find((s) => s.name === "control-plane")
          if (cp && cp.status !== "connected" && cp.status !== "pending" && !rt.mcpWarned) {
            rt.mcpWarned = true
            this.addEvent(id, {
              kind: "notice",
              level: "warn",
              text: `El MCP de control-plane no está conectado (${cp.status}). La sesión no va a poder reportar ni proponer.`,
            })
          }
          break
        }
        case "turn_end": {
          if (rt.cliState !== "idle" && !rt.pendingControl.size) {
            rt.cliState = "idle"
            this.setStatus(id, rt, this.deriveStatus(rt))
          }
          const local = !rt.turnHadAssistant
          rt.turnHadAssistant = false
          const inputs = rt.turnInputs
          const retried = rt.resending
          rt.turnInputs = []
          rt.resending = false
          if (action.contextFull && inputs.length) rt.failedInputs = inputs
          else if (action.ok && !local) rt.failedInputs = null
          this.endTurn(id, rt)
          const rec = this.db.getSession(id)
          if (rec) {
            this.broadcastSession(id)
            this.emit("turnEnd", rec, { ok: action.ok, aborted: action.aborted, result: action.result, local, contextFull: action.contextFull, retried })
          }
          void this.refreshContext(id, rt)
          break
        }
        case "command":
          if (action.state !== "queued" && rt.queued.delete(action.uuid)) this.broadcastSession(id)
          break
        case "reset": {
          // /clear: la conversación nueva arranca sus totales de cero (o, si algún día no, sigue desde los
          // últimos). Lo gastado hasta acá queda como base; el resultado del /clear dice cuál de las dos.
          const cur = this.db.getSession(id)
          rt.spentBefore = { usd: cur?.costUsd ?? 0, tokens: cur?.tokens ?? null }
          rt.restored = { ...rt.lastTotals, applies: null }
          rt.resetPending = true
          this.db.updateSession(id, { claudeSessionId: action.newSessionId, startedOnce: true })
          break
        }
      }
    }
  }

  private onControlRequest(id: string, rt: Runtime, msg: CliMessage) {
    const requestId = String(msg.request_id ?? "")
    const req = (msg.request ?? {}) as {
      subtype?: string
      tool_name?: string
      input?: Record<string, unknown>
      tool_use_id?: string
    }
    if (req.subtype === "can_use_tool") {
      const input = req.input ?? {}
      if (req.tool_name === "AskUserQuestion") {
        const questions = normalizeQuestions(input.questions)
        const ev = this.addEvent(id, {
          kind: "question",
          requestId,
          toolUseId: String(req.tool_use_id ?? ""),
          questions,
          state: "pending",
        })
        rt.pendingControl.set(requestId, { kind: "question", eventId: ev.id, input })
      } else {
        const ev = this.addEvent(id, {
          kind: "permission",
          requestId,
          toolName: String(req.tool_name ?? "herramienta"),
          input: clampJson(input, 20_000),
          state: "pending",
        })
        rt.pendingControl.set(requestId, {
          kind: "permission",
          eventId: ev.id,
          input: { ...input, __toolName: req.tool_name },
        })
      }
      this.setStatus(id, rt, "needs_input")
      const rec = this.db.getSession(id)
      if (rec)
        this.hub.broadcast({
          type: "toast",
          level: "warn",
          title: `${rec.name} te necesita`,
          body: req.tool_name === "AskUserQuestion" ? "Tiene una pregunta para vos." : `Pide aprobar ${req.tool_name}.`,
          projectId: rec.projectId,
          sessionId: rec.id,
        })
      return
    }
    rt.proc.respondError(requestId, `control-plane no maneja ${req.subtype ?? "este pedido"}`)
  }

  private cancelControl(rt: Runtime, requestId: string) {
    const p = rt.pendingControl.get(requestId)
    if (!p) return
    rt.pendingControl.delete(requestId)
    this.patchEvent(p.eventId, { state: "cancelled" } as Partial<TimelineEvent>)
  }

  private onExit(id: string, rt: Runtime, info: ExitInfo) {
    if (this.runtimes.get(id) !== rt) return
    this.endTurn(id, rt)
    this.runtimes.delete(id)
    for (const requestId of [...rt.pendingControl.keys()]) this.cancelControl(rt, requestId)
    // Los subagentes mueren con su sesión.
    for (const sub of rt.subagents.values()) {
      if (sub.status !== "running") continue
      sub.status = "killed"
      this.patchEvent(sub.eventId, { status: "killed", endedAt: now(), summary: "La sesión se detuvo" } as Partial<TimelineEvent>)
    }
    const rec = this.db.getSession(id)
    if (!rec) return

    // Fallbacks del primer arranque: la sesión ya existía o todavía no existía.
    const quick = now() - rt.startedAt < 20_000
    if (quick && !rt.retried && !info.expected) {
      if (/No conversation found/i.test(info.stderr)) {
        this.db.updateSession(id, { startedOnce: false })
        void this.launch({ ...rec, startedOnce: false }, true).catch(() => {})
        return
      }
      if (/already in use/i.test(info.stderr)) {
        this.db.updateSession(id, { startedOnce: true })
        void this.launch({ ...rec, startedOnce: true }, true).catch(() => {})
        return
      }
    }

    if (info.expected) {
      this.db.updateSession(id, { status: "stopped" })
      this.addEvent(id, { kind: "notice", level: "info", text: "Sesión detenida." })
    } else {
      const tail = info.stderr.split("\n").filter(Boolean).slice(-3).join(" · ")
      const detail = tail || `el proceso terminó (código ${info.code ?? info.signal ?? "?"})`
      this.stoppedDetail.set(id, detail)
      this.db.updateSession(id, { status: "error" })
      this.addEvent(id, {
        kind: "notice",
        level: "error",
        text: `La sesión terminó inesperadamente: ${oneLine(detail, 400)}`,
      })
    }
    this.broadcastSession(id)
    const after = this.db.getSession(id)
    if (after) this.emit("status", after, after.status)
  }

  // ---------------------------------------------------------------- acciones

  /** Manda un mensaje como si lo escribieras vos. Si la sesión estaba detenida, la reanuda. */
  async send(id: string, text: string, opts: SendOptions): Promise<StoredEvent> {
    await this.start(id)
    const rt = this.runtimes.get(id)
    const rec = this.db.getSession(id)
    if (!rt || !rec) throw new Error("La sesión no está corriendo")
    const u = uuid()
    rt.ownUuids.add(u)
    if (rt.ownUuids.size > 500) rt.ownUuids.delete(rt.ownUuids.values().next().value!)
    rt.queued.add(u)
    const files = opts.attachments ?? []
    const event: TimelineEvent = opts.event ?? {
      kind: "user",
      text: opts.display ?? text,
      origin: opts.origin,
      uuid: u,
      ...(opts.draftId ? { draftId: opts.draftId } : {}),
      ...(opts.draftTitle ? { draftTitle: opts.draftTitle } : {}),
      ...(files.length ? { attachments: files.map(toRef) } : {}),
      ...(opts.subagents?.length ? { subagents: opts.subagents } : {}),
    }
    const stored = this.addEvent(id, event)
    rt.turnInputs.push({ text, opts })
    if (!rt.proc.sendUser(files.length ? contentWithFiles(text, files) : text, u, rec.claudeSessionId)) {
      rt.queued.delete(u)
      throw new Error("No se pudo escribir en la sesión")
    }
    // Hasta que el CLI avise, la mostramos trabajando.
    if (rt.status === "idle") this.setStatus(id, rt, "working")
    this.broadcastSession(id)
    return stored
  }

  /**
   * Pedido de control a la sesión (side_question, mcp_status, mcp_toggle, …). Si está detenida,
   * la reanuda: el proceso carga la conversación, pero no se manda ningún mensaje.
   */
  async control(id: string, subtype: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000) {
    await this.start(id)
    const rt = this.runtimes.get(id)
    if (!rt || rt.proc.exited) throw new Error("La sesión no está corriendo")
    return rt.proc.request(subtype, payload, timeoutMs)
  }

  // ------------------------------------------------------------- turno en curso

  private startTurn(id: string, rt: Runtime) {
    rt.turn = { startedAt: now(), final: new Map(), chars: new Map(), thinking: 0, timer: null }
    this.broadcastTurn(id, rt)
  }

  private turnTokens(t: TurnCounter): number {
    let n = t.thinking
    for (const v of t.final.values()) n += v
    for (const c of t.chars.values()) n += Math.round(c / 4)
    return n
  }

  /** Como mucho una actualización por segundo por sesión: el indicador no necesita más. */
  private queueTurn(id: string, rt: Runtime) {
    const t = rt.turn
    if (!t || t.timer) return
    t.timer = setTimeout(() => {
      t.timer = null
      if (rt.turn === t) this.broadcastTurn(id, rt)
    }, 1000)
    t.timer.unref()
  }

  private broadcastTurn(id: string, rt: Runtime) {
    const t = rt.turn
    this.hub.broadcast({ type: "turn", sessionId: id, turn: t ? { startedAt: t.startedAt, tokens: this.turnTokens(t) } : null })
  }

  private endTurn(id: string, rt: Runtime) {
    if (!rt.turn) return
    if (rt.turn.timer) clearTimeout(rt.turn.timer)
    rt.turn = null
    this.broadcastTurn(id, rt)
  }

  /** Turnos en curso (para quien se conecta a mitad de uno). */
  turns(): { sessionId: string; turn: { startedAt: number; tokens: number } }[] {
    const out: { sessionId: string; turn: { startedAt: number; tokens: number } }[] = []
    for (const [id, rt] of this.runtimes) if (rt.turn) out.push({ sessionId: id, turn: { startedAt: rt.turn.startedAt, tokens: this.turnTokens(rt.turn) } })
    return out
  }

  /** Marca que la sesión espera algo tuyo (aparece como "te necesita" con ese detalle), o lo limpia. */
  setHold(id: string, reason: string | null) {
    const rt = this.runtimes.get(id)
    if (!rt || rt.hold === reason) return
    rt.hold = reason
    this.setStatus(id, rt, this.deriveStatus(rt), reason)
  }

  contextOf(id: string): ContextUsage | null {
    return this.runtimes.get(id)?.context ?? this.db.getSession(id)?.context ?? null
  }

  /** Pide a Claude Code cuánto contexto usa la sesión (estimación local, sin llamar a la API). */
  async refreshContext(id: string, rt = this.runtimes.get(id)) {
    if (!rt || rt.proc.exited) return
    try {
      const usage = toContextUsage(await rt.proc.request("get_context_usage", { detail: "summary" }, 15_000))
      if (!usage || this.runtimes.get(id) !== rt) return
      rt.context = usage
      this.db.updateSession(id, { context: usage })
      this.broadcastSession(id)
      this.emit("context", id, usage)
    } catch {
      // versiones viejas del CLI o proceso cerrándose: no es grave
    }
  }

  async interrupt(id: string) {
    const rt = this.runtimes.get(id)
    if (!rt || rt.proc.exited) return
    await rt.proc.request("interrupt", {}, 15_000)
  }

  /** Con el primer total que informa el proceso se sabe si restauró lo anterior: si es menor, no lo hizo. */
  private decideRestored(rt: Runtime, usd: number, tokens: TokenUsage | null) {
    if (rt.restored.applies !== null) return
    const r = rt.restored
    rt.restored.applies = usd >= r.usd && (!r.tokens || !tokens || tokens.total >= r.tokens.total)
  }

  /** Lo que sumó este proceso: el total que informa Claude Code menos lo que restauró al arrancar. */
  private processUsd(rt: Runtime, total: number): number {
    this.decideRestored(rt, total, null)
    return rt.restored.applies ? total - rt.restored.usd : total
  }

  /**
   * Empieza la conversación de cero (/clear): Claude Code descarta el contexto y sigue con un id nuevo,
   * en el mismo proceso y con el mismo protocolo. Vuelve cuando terminó, para que lo que se mande
   * después vaya a la conversación nueva.
   */
  async clearConversation(id: string): Promise<void> {
    const before = this.runtimes.get(id)
    if (before && (before.status === "working" || before.pendingControl.size)) {
      throw new Error("La sesión está trabajando: esperá a que termine para que empiece de cero")
    }
    const prevId = this.db.getSession(id)?.claudeSessionId
    let onEnd: ((rec: SessionRecord) => void) | null = null
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (onEnd) this.off("turnEnd", onEnd)
        reject(new Error("Claude Code no confirmó que empezó de cero"))
      }, 60_000)
      onEnd = (rec) => {
        if (rec.id !== id) return
        clearTimeout(timer)
        this.off("turnEnd", onEnd!)
        resolve()
      }
      this.on("turnEnd", onEnd)
    })
    try {
      await this.send(id, "/clear", { origin: "control", event: { kind: "notice", level: "info", text: "Empieza de cero para la tarea nueva (/clear)." } })
    } catch (err) {
      if (onEnd) this.off("turnEnd", onEnd)
      throw err
    }
    await done
    const rt = this.runtimes.get(id)
    if (rt) {
      rt.failedInputs = null
      if (rt.hold) this.setHold(id, null)
    }
    if (this.db.getSession(id)?.claudeSessionId === prevId) throw new Error("La conversación no se reinició")
  }

  /** Si el último turno no salió porque el contexto estaba lleno, qué hay para reenviar. */
  hasUnsent(id: string): boolean {
    return this.unsent(id).length > 0
  }

  /**
   * Lo que no entró en el último turno. Si el proceso es otro (se reinició el server), se arma desde el
   * historial: los mensajes entre el fin de turno anterior y el que falló.
   */
  private unsent(id: string): TurnInput[] {
    return this.runtimes.get(id)?.failedInputs ?? this.unsentFromHistory(id)
  }

  /**
   * Deja fijado lo que hay que reenviar antes de compactar: después el último fin de turno es el
   * de /compact y el historial ya no dice qué había fallado.
   */
  async holdUnsent(id: string): Promise<number> {
    const inputs = this.unsent(id)
    if (!inputs.length) return 0
    await this.start(id)
    const rt = this.runtimes.get(id)
    if (rt) rt.failedInputs = inputs
    return inputs.length
  }

  /** Reenvía lo que no entró en el último turno (después de compactar). */
  async resendUnsent(id: string): Promise<number> {
    const inputs = this.unsent(id)
    if (!inputs.length) throw new Error("No encontré un mensaje que no haya salido")
    await this.start(id)
    const rt = this.runtimes.get(id)
    if (!rt) throw new Error("La sesión no está corriendo")
    rt.failedInputs = null
    for (const input of inputs) {
      await this.send(id, input.text, { ...input.opts, event: { kind: "notice", level: "info", text: RESENT_NOTICE } })
      rt.resending = true
    }
    return inputs.length
  }

  private unsentFromHistory(id: string): TurnInput[] {
    const events = this.db.listEvents(id, { limit: 200 })
    const ends = events.map((e, i) => (e.event.kind === "turn_end" ? i : -1)).filter((i) => i >= 0)
    const last = ends.at(-1)
    if (last === undefined) return []
    const end = events[last]!.event
    if (end.kind !== "turn_end" || end.ok || !isContextFull(end.terminalReason, end.error)) return []
    const from = (ends.at(-2) ?? -1) + 1
    const out: TurnInput[] = []
    for (const e of events.slice(from, last)) {
      const ev = e.event
      if (ev.kind !== "user" || ev.text.startsWith("/")) continue
      const files = (ev.attachments ?? []).map((a) => this.db.getAttachment(a.id)).filter((a): a is AttachmentRecord => a !== null)
      const text = ev.subagents?.length ? withSubagents(ev.text, ev.subagents) : ev.text
      out.push({ text, opts: { origin: ev.origin, attachments: files, ...(ev.draftId ? { draftId: ev.draftId } : {}) } })
    }
    return out
  }

  async stop(id: string) {
    const rt = this.runtimes.get(id)
    if (!rt) return
    await rt.proc.close()
  }

  answerQuestion(id: string, requestId: string, answers: Record<string, string>) {
    const rt = this.runtimes.get(id)
    const p = rt?.pendingControl.get(requestId)
    if (!rt || !p || p.kind !== "question") throw new Error("La pregunta ya no está pendiente")
    rt.proc.respond(requestId, { behavior: "allow", updatedInput: { ...p.input, answers } })
    rt.pendingControl.delete(requestId)
    this.patchEvent(p.eventId, { state: "answered", answers } as Partial<TimelineEvent>)
    this.setStatus(id, rt, this.deriveStatus(rt))
  }

  respondPermission(id: string, requestId: string, allow: boolean, message?: string) {
    const rt = this.runtimes.get(id)
    const p = rt?.pendingControl.get(requestId)
    if (!rt || !p || p.kind !== "permission") throw new Error("El pedido ya no está pendiente")
    const { __toolName: _n, ...input } = p.input
    rt.proc.respond(
      requestId,
      allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: message || "El usuario lo rechazó desde el dashboard." }
    )
    rt.pendingControl.delete(requestId)
    this.patchEvent(p.eventId, { state: allow ? "allowed" : "denied" } as Partial<TimelineEvent>)
    this.setStatus(id, rt, this.deriveStatus(rt))
  }

  /** Cambia el modelo: queda guardado y, si la sesión está corriendo, aplica desde el próximo turno. */
  async setModel(id: string, model: string | null) {
    this.update(id, { model })
    const rt = this.runtimes.get(id)
    if (rt && !rt.proc.exited) await rt.proc.request("set_model", { model }, 15_000)
  }

  async setEffort(id: string, effort: string | null) {
    this.update(id, { effort })
    const rt = this.runtimes.get(id)
    if (rt && !rt.proc.exited && effort)
      await rt.proc.request("apply_flag_settings", { settings: { effortLevel: effort } }, 15_000)
  }

  async rename(id: string, name: string) {
    this.update(id, { name })
    const rt = this.runtimes.get(id)
    if (rt && !rt.proc.exited) {
      await rt.proc.request("rename_session", { title: name, source: "host" }, 10_000).catch(() => {})
    }
  }

  async archive(id: string) {
    await this.stop(id)
    this.update(id, { archivedAt: now(), status: "stopped" })
  }

  async shutdown() {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.proc.close(2000)))
  }
}

/**
 * Mensaje con adjuntos: las imágenes van como bloques (Claude las ve directo) y todos los
 * archivos quedan listados con su ruta, para que pueda abrirlos con sus herramientas.
 */
/** Los tokens que sumó este proceso (los totales de Claude Code siguen desde lo restaurado). */
function tokensSince(total: TokenUsage, restored: Runtime["restored"]): TokenUsage {
  const r = restored.tokens
  if (!r || !restored.applies || total.total < r.total) return total
  const d = (a: number, b: number) => Math.max(0, a - b)
  return {
    input: d(total.input, r.input),
    output: d(total.output, r.output),
    cacheRead: d(total.cacheRead, r.cacheRead),
    cacheWrite: d(total.cacheWrite, r.cacheWrite),
    total: d(total.total, r.total),
  }
}

function addTokens(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (!a) return b
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  }
}

function contentWithFiles(text: string, files: AttachmentRecord[]): Record<string, unknown>[] {
  const list = files.map((f) => `- ${f.path} (${f.name}, ${f.mime}, ${Math.max(1, Math.round(f.size / 1024))} KB)`).join("\n")
  const blocks: Record<string, unknown>[] = [
    {
      type: "text",
      text: `${text || "Te paso estos archivos."}\n\nArchivos adjuntos (guardados en disco; podés abrirlos con tus herramientas):\n${list}`,
    },
  ]
  for (const f of files) {
    if (!VISION_TYPES.has(f.mime) || f.size > 5 * 1024 * 1024) continue
    try {
      blocks.push({ type: "image", source: { type: "base64", media_type: f.mime, data: fs.readFileSync(f.path).toString("base64") } })
    } catch {
      // si no se puede leer, queda la ruta en el texto
    }
  }
  return blocks
}

function toContextUsage(raw: Record<string, unknown>): ContextUsage | null {
  const tokens = Number(raw.totalTokens)
  const max = Number(raw.maxTokens)
  if (!Number.isFinite(tokens) || !Number.isFinite(max) || max <= 0) return null
  const autoCompact = raw.isAutoCompactEnabled !== false
  const threshold = Number(raw.autoCompactThreshold)
  const categories = Array.isArray(raw.categories)
    ? (raw.categories as { name?: string; tokens?: number; kind?: string; isDeferred?: boolean }[])
        // Solo lo que ocupa contexto de verdad: sin espacio libre, herramientas diferidas ni el margen reservado para compactar.
        .filter((c) => (c.kind ?? "used") === "used" && !c.isDeferred && !/buffer/i.test(String(c.name)) && typeof c.tokens === "number" && c.tokens > 0)
        .map((c) => ({ name: String(c.name ?? ""), tokens: Number(c.tokens) }))
    : []
  return {
    tokens,
    max,
    threshold: autoCompact && Number.isFinite(threshold) && threshold > 0 ? threshold : null,
    autoCompact,
    categories,
    updatedAt: now(),
  }
}

function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return []
  return raw.map((q: Record<string, unknown>) => ({
    question: String(q.question ?? ""),
    header: q.header ? String(q.header) : undefined,
    multiSelect: Boolean(q.multiSelect),
    options: Array.isArray(q.options)
      ? (q.options as Record<string, unknown>[]).map((o) => ({
          label: String(o.label ?? ""),
          description: o.description ? String(o.description) : undefined,
          preview: o.preview ? String(o.preview) : undefined,
        }))
      : [],
  }))
}
