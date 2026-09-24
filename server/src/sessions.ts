import { EventEmitter } from "node:events"

import { buildLaunch } from "./claude/args.ts"
import { StreamNormalizer } from "./claude/normalize.ts"
import { ClaudeProcess, type CliMessage, type ExitInfo } from "./claude/process.ts"
import { config } from "./config.ts"
import type { Db, SessionRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import type {
  Meta,
  ModelOption,
  PendingRequest,
  Question,
  Session,
  SessionKind,
  SessionStatus,
  StoredEvent,
  TimelineEvent,
  UsageInfo,
  UserOrigin,
} from "./shared/types.ts"
import { clampJson, errorMessage, now, oneLine, shortId, token, uuid } from "./util.ts"

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
}

export interface TurnEndInfo {
  ok: boolean
  aborted: boolean
  result: string
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
}

type ProtocolBuilder = (session: SessionRecord) => {
  protocol: string
  orchestratorCanEdit: boolean
  model: string | null
  effort: string | null
}

/**
 * Dueño de los procesos `claude`: los lanza, les manda mensajes, traduce su stream
 * y mantiene el estado de cada sesión.
 */
export class SessionManager extends EventEmitter<{
  turnEnd: [SessionRecord, TurnEndInfo]
  status: [SessionRecord, SessionStatus]
}> {
  private runtimes = new Map<string, Runtime>()
  private stoppedDetail = new Map<string, string>()
  private lastTexts = new Map<string, string | null>()
  usage: UsageInfo | null = null
  meta: Meta
  private db: Db
  private hub: Hub
  private mcpUrlFor: (token: string) => string
  private protocolFor: ProtocolBuilder

  constructor(
    db: Db,
    hub: Hub,
    mcpUrlFor: (token: string) => string,
    protocolFor: ProtocolBuilder,
    meta: Meta
  ) {
    super()
    this.db = db
    this.hub = hub
    this.mcpUrlFor = mcpUrlFor
    this.protocolFor = protocolFor
    this.meta = meta
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
      lastText: lastText ? oneLine(lastText, 400) : null,
      status: rt ? rt.status : rec.status,
      statusDetail: rt ? rt.statusDetail : (this.stoppedDetail.get(rec.id) ?? null),
      pending,
      queuedMessages: rt?.queued.size ?? 0,
    }
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
      createdAt: now(),
      archivedAt: null,
    }
    this.db.insertSession(rec)
    this.broadcastSession(rec.id)
    return rec
  }

  // ------------------------------------------------------------------ ciclo

  /** Lanza el proceso si no está corriendo. Resuelve cuando el CLI terminó el handshake. */
  start(id: string): Promise<void> {
    const existing = this.runtimes.get(id)
    if (existing && !existing.proc.exited) return existing.ready
    const rec = this.db.getSession(id)
    if (!rec) return Promise.reject(new Error("Sesión inexistente"))
    if (rec.archivedAt) return Promise.reject(new Error("La sesión está archivada"))
    return this.launch(rec, existing?.retried ?? false)
  }

  private launch(rec: SessionRecord, retried: boolean): Promise<void> {
    const built = this.protocolFor(rec)
    const { args, env } = buildLaunch(rec, {
      mcpUrl: this.mcpUrlFor(rec.mcpToken),
      protocol: built.protocol,
      orchestratorCanEdit: built.orchestratorCanEdit,
      model: built.model,
      effort: built.effort,
    })
    const proc = new ClaudeProcess(config.claudeBin, args, rec.cwd, env)
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
        this.captureMeta(resp)
        if (this.runtimes.get(rec.id) !== rt) return
        this.setStatus(rec.id, rt, rt.pendingControl.size ? "needs_input" : "idle")
      })
      .catch((err) => {
        if (!proc.exited) void proc.close(1000)
        throw new Error(`No se pudo iniciar la sesión: ${errorMessage(err)}`)
      })
    rt.ready.catch(() => {})
    return rt.ready
  }

  private captureMeta(resp: Record<string, unknown>) {
    const models = Array.isArray(resp.models)
      ? (resp.models as { value: string; displayName?: string; description?: string; supportedEffortLevels?: string[] }[]).map(
          (m): ModelOption => ({
            value: m.value,
            label: m.displayName ?? m.value,
            description: m.description,
            efforts: m.supportedEffortLevels,
          })
        )
      : this.meta.models
    const account = (resp.account ?? null) as
      | { email?: string; organization?: string; subscriptionType?: string }
      | null
    const next: Meta = {
      ...this.meta,
      models,
      account: account
        ? { email: account.email, organization: account.organization, subscription: account.subscriptionType }
        : this.meta.account,
    }
    if (JSON.stringify(next) !== JSON.stringify(this.meta)) {
      this.meta = next
      this.hub.broadcast({ type: "meta", meta: next })
    }
  }

  private setStatus(id: string, rt: Runtime, status: SessionStatus, detail: string | null = null) {
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
    if (rt.pendingControl.size || rt.cliState === "requires_action") return "needs_input"
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
        case "event":
          this.addEvent(id, action.event)
          break
        case "status":
          rt.cliState = action.state
          this.setStatus(id, rt, this.deriveStatus(rt))
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
          this.db.updateSession(id, { lastActivity: oneLine(action.text, 160), lastActivityAt: now() })
          this.broadcastSession(id)
          break
        case "cost":
          this.db.updateSession(id, { costUsd: action.totalUsd })
          break
        case "usage":
          this.usage = action.usage
          this.hub.broadcast({ type: "usage", usage: action.usage })
          break
        case "init": {
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
            this.setStatus(id, rt, "idle")
          }
          const rec = this.db.getSession(id)
          if (rec) {
            this.broadcastSession(id)
            this.emit("turnEnd", rec, { ok: action.ok, aborted: action.aborted, result: action.result })
          }
          break
        }
        case "command":
          if (action.state !== "queued" && rt.queued.delete(action.uuid)) this.broadcastSession(id)
          break
        case "reset":
          this.db.updateSession(id, { claudeSessionId: action.newSessionId, startedOnce: true })
          break
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
    this.runtimes.delete(id)
    for (const requestId of [...rt.pendingControl.keys()]) this.cancelControl(rt, requestId)
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
    const event: TimelineEvent = opts.event ?? {
      kind: "user",
      text,
      origin: opts.origin,
      uuid: u,
      ...(opts.draftId ? { draftId: opts.draftId } : {}),
      ...(opts.draftTitle ? { draftTitle: opts.draftTitle } : {}),
    }
    const stored = this.addEvent(id, event)
    if (!rt.proc.sendUser(text, u, rec.claudeSessionId)) {
      rt.queued.delete(u)
      throw new Error("No se pudo escribir en la sesión")
    }
    // Hasta que el CLI avise, la mostramos trabajando.
    if (rt.status === "idle") this.setStatus(id, rt, "working")
    this.broadcastSession(id)
    return stored
  }

  async interrupt(id: string) {
    const rt = this.runtimes.get(id)
    if (!rt || rt.proc.exited) return
    await rt.proc.request("interrupt", {}, 15_000)
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
