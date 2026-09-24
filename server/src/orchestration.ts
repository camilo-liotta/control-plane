import type { Accounts } from "./accounts.ts"
import { lastCostState, listLiveSessions, readTranscript, type ClaudeTarget } from "./claude/local.ts"
import type { Db, ProjectRecord, SessionRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import { formatDraftLine, withSubagents } from "./prompts.ts"
import type { SessionManager, TurnEndInfo } from "./sessions.ts"
import type { Draft, Project, Report, ReportStatus, ReviewState, SubagentSpec } from "./shared/types.ts"
import { errorMessage, now, sanitizeSessionName, shortId } from "./util.ts"

const STATUS_LABEL: Record<ReportStatus, string> = {
  done: "✅ terminado",
  blocked: "⛔ bloqueado",
  partial: "🟡 parcial",
}

interface Decision {
  at: number
  text: string
}

const SUBAGENT_MODELS = new Set(["haiku", "sonnet", "opus", "fable"])

/** Normaliza los subagentes que llegan de la orquestadora o de tus ediciones. */
export function normalizeSubagents(raw: unknown): SubagentSpec[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 12).map((item, i) => {
    const s = (item ?? {}) as Record<string, unknown>
    const name = sanitizeSessionName(String(s.name ?? "")).toLowerCase() || `subagente-${i + 1}`
    const rules = Array.isArray(s.rules)
      ? s.rules.map((r) => String(r).trim()).filter(Boolean)
      : typeof s.rules === "string"
        ? s.rules.split("\n").map((r) => r.trim()).filter(Boolean)
        : []
    const model = typeof s.model === "string" && SUBAGENT_MODELS.has(s.model) ? s.model : null
    return {
      name,
      role: String(s.role ?? "").trim(),
      task: String(s.task ?? "").trim(),
      rules,
      model,
      background: Boolean(s.background),
      readOnly: Boolean(s.readOnly),
    }
  }).filter((s) => s.task)
}

export interface CreateWorkerInput {
  name: string
  role: string
  prompt?: string
  model?: string | null
  effort?: string | null
  worktree?: boolean
}

/**
 * La cola de resultados y la regla de oro: ninguna propuesta se libera mientras la orquestadora
 * tenga resultados sin leer. Los resultados que llegan juntos se entregan en un solo lote.
 */
export class Orchestration {
  private timers = new Map<string, NodeJS.Timeout>()
  private deliverAt = new Map<string, number>()
  private firstQueuedAt = new Map<string, number>()
  private decisions = new Map<string, Decision[]>()
  /** Proyectos cuya revisión quedó en pausa porque interrumpiste a la orquestadora. */
  private paused = new Set<string>()
  /** Entregas de seguimiento (lo que llegó mientras la orquestadora analizaba). */
  private followUps = new Map<string, NodeJS.Timeout>()
  private db: Db
  private hub: Hub
  private sessions: SessionManager
  private accounts: Accounts | null

  constructor(db: Db, hub: Hub, sessions: SessionManager, accounts: Accounts | null = null) {
    this.db = db
    this.hub = hub
    this.sessions = sessions
    this.accounts = accounts
    sessions.on("turnEnd", (rec, info) => this.onTurnEnd(rec, info))
    sessions.on("status", (rec, status) => {
      // Si la orquestadora quedó libre (por ejemplo, tras arrancar) y hay cola, se la entregamos.
      if (rec.kind === "orchestrator" && status === "idle") this.schedule(rec.projectId)
    })
  }

  // ------------------------------------------------------------------ vistas

  reviewState(projectId: string): ReviewState {
    const queued = this.db.listReports({ projectId, states: ["queued"] }).length
    const inReview = this.db.listReports({ projectId, states: ["in_review"] }).length
    return {
      queued,
      inReview,
      active: inReview > 0,
      paused: this.paused.has(projectId),
      deliverAt: this.deliverAt.get(projectId) ?? null,
    }
  }

  projectView(p: ProjectRecord): Project {
    return { ...p, review: this.reviewState(p.id) }
  }

  reportView(r: Omit<Report, "sessionName">): Report {
    return { ...r, sessionName: this.db.getSession(r.sessionId)?.name ?? "?" }
  }

  private broadcastProject(projectId: string) {
    const p = this.db.getProject(projectId)
    if (p) this.hub.broadcast({ type: "project", project: this.projectView(p) })
  }

  private broadcastDraft(id: string) {
    const d = this.db.getDraft(id)
    if (d) this.hub.broadcast({ type: "draft", draft: d })
  }

  private broadcastReport(id: string) {
    const r = this.db.getReport(id)
    if (r) this.hub.broadcast({ type: "report", report: this.reportView(r) })
  }

  orchestratorOf(projectId: string): SessionRecord | null {
    return this.db.listSessions().find((s) => s.projectId === projectId && s.kind === "orchestrator") ?? null
  }

  workersOf(projectId: string): SessionRecord[] {
    return this.db.listSessions().filter((s) => s.projectId === projectId && s.kind === "worker")
  }

  findSessionByName(projectId: string, name: string): SessionRecord | null {
    const n = name.trim().toLowerCase()
    return this.db.listSessions().find((s) => s.projectId === projectId && s.name.toLowerCase() === n) ?? null
  }

  private noteDecision(projectId: string, text: string) {
    const list = this.decisions.get(projectId) ?? []
    list.push({ at: now(), text })
    this.decisions.set(projectId, list.slice(-30))
  }

  // ------------------------------------------------------------- resultados

  /** Un worker terminó (report_result). */
  report(worker: SessionRecord, input: { status: ReportStatus; summary: string; details?: string | null }): string {
    const report = {
      id: shortId("r_"),
      projectId: worker.projectId,
      sessionId: worker.id,
      taskTitle: worker.taskTitle,
      status: input.status,
      summary: input.summary.trim(),
      details: input.details?.trim() || null,
      state: "queued" as const,
      createdAt: now(),
      deliveredAt: null,
      reviewedAt: null,
    }
    this.db.insertReport(report)
    this.sessions.update(worker.id, {
      taskState:
        input.status === "done" ? "reported_done" : input.status === "blocked" ? "reported_blocked" : "reported_partial",
    })
    this.broadcastReport(report.id)
    this.hub.broadcast({
      type: "toast",
      level: input.status === "blocked" ? "warn" : "success",
      title: `${worker.name} reportó: ${STATUS_LABEL[input.status]}`,
      body: input.summary.slice(0, 180),
      projectId: worker.projectId,
      sessionId: worker.id,
    })
    // Regla: con resultados sin leer, ninguna propuesta queda lista para enviar.
    this.lockReadyDrafts(worker.projectId)
    this.schedule(worker.projectId)
    this.broadcastProject(worker.projectId)
    return "Resultado registrado en la cola de la orquestadora. Quedate disponible: el usuario o una nueva tarea pueden llegar en cualquier momento. No hace falta que le avises a nadie más."
  }

  private lockReadyDrafts(projectId: string) {
    for (const d of this.db.listDrafts({ projectId, states: ["ready"] })) {
      this.db.updateDraft(d.id, { state: "staged", updatedAt: now() })
      this.broadcastDraft(d.id)
    }
  }

  /** Programa la entrega del próximo lote respetando la ventana de agrupación. */
  schedule(projectId: string) {
    const project = this.db.getProject(projectId)
    if (!project) return
    const queued = this.db.listReports({ projectId, states: ["queued"] })
    if (!queued.length) {
      this.clearTimer(projectId)
      this.broadcastProject(projectId)
      return
    }
    // Ya hay una entrega de seguimiento en camino: se lleva todo lo que haya en cola.
    if (this.followUps.has(projectId)) return
    const orch = this.orchestratorOf(projectId)
    const status = orch ? this.sessions.statusOf(orch.id) : "stopped"
    // Si está en medio de un turno, el lote se entrega apenas termine (ver onTurnEnd).
    // Si la interrumpiste, esperamos a que retomes o toques "Revisar ahora".
    if (status === "working" || status === "needs_input" || status === "starting" || this.paused.has(projectId)) {
      this.clearTimer(projectId)
      this.broadcastProject(projectId)
      return
    }
    const windowMs = Math.max(0, project.settings.batchWindowSec) * 1000
    const first = this.firstQueuedAt.get(projectId) ?? Math.min(...queued.map((r) => r.createdAt))
    this.firstQueuedAt.set(projectId, first)
    const last = Math.max(...queued.map((r) => r.createdAt))
    // Se reinicia con cada resultado nuevo, pero nunca espera más de 4 ventanas (o 60 s).
    const cap = first + Math.max(60_000, windowMs * 4)
    const at = Math.min(last + windowMs, cap)
    this.clearTimer(projectId)
    this.deliverAt.set(projectId, at)
    const timer = setTimeout(() => {
      this.timers.delete(projectId)
      this.deliverAt.delete(projectId)
      void this.deliver(projectId, false)
    }, Math.max(0, at - now()))
    this.timers.set(projectId, timer)
    this.broadcastProject(projectId)
  }

  /** Cancela las entregas programadas (al apagar el server). */
  dispose() {
    for (const t of [...this.timers.values(), ...this.followUps.values()]) clearTimeout(t)
    this.timers.clear()
    this.followUps.clear()
    this.deliverAt.clear()
  }

  private clearTimer(projectId: string) {
    const t = this.timers.get(projectId)
    if (t) clearTimeout(t)
    this.timers.delete(projectId)
    this.deliverAt.delete(projectId)
  }

  private clearFollowUp(projectId: string) {
    const t = this.followUps.get(projectId)
    if (t) clearTimeout(t)
    this.followUps.delete(projectId)
  }

  /** Entrega todos los resultados en cola a la orquestadora, en un solo mensaje. */
  async deliver(projectId: string, followUp: boolean): Promise<boolean> {
    this.clearTimer(projectId)
    this.clearFollowUp(projectId)
    const orch = this.orchestratorOf(projectId)
    const queued = this.db.listReports({ projectId, states: ["queued"] })
    if (!orch || !queued.length) {
      this.broadcastProject(projectId)
      return false
    }
    const deliveredAt = now()
    for (const r of queued) {
      this.db.updateReport(r.id, { state: "in_review", deliveredAt })
      this.broadcastReport(r.id)
    }
    this.firstQueuedAt.delete(projectId)
    const text = this.composeBatch(projectId, queued.map((r) => this.reportView(r)), followUp)
    try {
      await this.sessions.send(orch.id, text, {
        origin: "control",
        event: { kind: "batch", reportIds: queued.map((r) => r.id), text, followUp },
      })
    } catch (err) {
      // No se pudo entregar: vuelven a la cola.
      for (const r of queued) {
        this.db.updateReport(r.id, { state: "queued", deliveredAt: null })
        this.broadcastReport(r.id)
      }
      this.hub.broadcast({
        type: "toast",
        level: "error",
        title: "No pude entregarle la cola a la orquestadora",
        body: errorMessage(err),
        projectId,
      })
      this.broadcastProject(projectId)
      return false
    }
    this.broadcastProject(projectId)
    return true
  }

  private composeBatch(projectId: string, reports: Report[], followUp: boolean): string {
    const names = [...new Set(reports.map((r) => r.sessionName))].join(", ")
    const lines: string[] = []
    lines.push(
      followUp
        ? `[control-plane] Cola de resultados: llegaron ${reports.length} más mientras analizabas (${names}).`
        : `[control-plane] Cola de resultados: ${reports.length} ${reports.length === 1 ? "resultado nuevo" : "resultados nuevos"} (${names}).`
    )
    reports.forEach((r, i) => {
      lines.push("")
      lines.push(`## ${i + 1}. ${r.sessionName} (${STATUS_LABEL[r.status]})${r.taskTitle ? `. Tarea: ${r.taskTitle}` : ""}`)
      lines.push(r.summary)
      if (r.details) {
        lines.push("")
        lines.push(r.details)
      }
    })
    const open = this.db.listDrafts({ projectId, states: ["staged", "ready"] })
    if (open.length) {
      lines.push("")
      lines.push("## Propuestas sin enviar (bloqueadas hasta que termines de revisar)")
      for (const d of open) lines.push(formatDraftLine(d, d.targetSessionId ? (this.db.getSession(d.targetSessionId)?.name ?? null) : null))
      lines.push("Revisá si estos resultados las cambian: ajustalas con update_proposal o descartalas con discard_proposal.")
    }
    const decisions = this.decisions.get(projectId) ?? []
    if (decisions.length) {
      lines.push("")
      lines.push("## Lo que decidió el usuario desde tu última revisión")
      for (const d of decisions) lines.push(`- ${d.text}`)
      this.decisions.set(projectId, [])
    }
    lines.push("")
    lines.push(
      followUp
        ? "Integrá estos resultados con los anteriores antes de cerrar: tus propuestas se liberan recién cuando termines con la cola vacía."
        : "Analizá todos los resultados juntos antes de proponer: pueden afectarse entre sí. Tus propuestas se liberan cuando termines tu turno con la cola vacía."
    )
    return lines.join("\n")
  }

  /** Cuando la orquestadora termina un turno: o entrega lo nuevo, o cierra la revisión. */
  private onTurnEnd(rec: SessionRecord, info: TurnEndInfo) {
    if (rec.kind !== "orchestrator") return
    const projectId = rec.projectId
    if (!info.ok) {
      // Turno interrumpido o con error: la revisión queda en pausa, sin liberar nada a medias.
      this.paused.add(projectId)
      this.clearTimer(projectId)
      this.clearFollowUp(projectId)
      this.broadcastProject(projectId)
      return
    }
    // Un comando local (/compact, /context…) no es una revisión: no cierra ni reanuda nada.
    if (info.local) return
    this.paused.delete(projectId)
    const queued = this.db.listReports({ projectId, states: ["queued"] })
    if (queued.length) {
      // Llegaron resultados mientras analizaba: se los damos antes de liberar nada.
      this.clearTimer(projectId)
      const timer = setTimeout(() => {
        this.followUps.delete(projectId)
        void this.deliver(projectId, true)
      }, 1500)
      this.followUps.set(projectId, timer)
      return
    }
    this.closeReview(projectId)
  }

  /** Cierra la revisión: los resultados quedan revisados y las propuestas se liberan. */
  closeReview(projectId: string) {
    const inReview = this.db.listReports({ projectId, states: ["in_review"] })
    const reviewedAt = now()
    for (const r of inReview) {
      this.db.updateReport(r.id, { state: "reviewed", reviewedAt })
      this.broadcastReport(r.id)
    }
    const staged = this.db.listDrafts({ projectId, states: ["staged"] })
    for (const d of staged) {
      this.db.updateDraft(d.id, { state: "ready", updatedAt: now() })
      this.broadcastDraft(d.id)
    }
    this.broadcastProject(projectId)
    if (staged.length) {
      const project = this.db.getProject(projectId)
      this.hub.broadcast({
        type: "toast",
        level: "info",
        title: `${staged.length === 1 ? "Hay una propuesta lista" : `Hay ${staged.length} propuestas listas`} para revisar`,
        body: inReview.length
          ? `La orquestadora terminó de revisar ${inReview.length} ${inReview.length === 1 ? "resultado" : "resultados"}.`
          : undefined,
        projectId,
      })
      if (project?.settings.autoDispatch) {
        for (const d of staged) {
          if (d.kind === "prompt") void this.sendDraft(d.id, {}, true).catch(() => {})
        }
      }
    }
  }

  // -------------------------------------------------------------- propuestas

  private openDraftGuard(projectId: string): string {
    const queued = this.db.listReports({ projectId, states: ["queued"] })
    if (!queued.length) return ""
    const names = [...new Set(queued.map((r) => this.db.getSession(r.sessionId)?.name ?? "?"))].join(", ")
    return `\n\n⚠️ Hay ${queued.length} ${queued.length === 1 ? "resultado nuevo" : "resultados nuevos"} en la cola (${names}). Leelos con read_results antes de terminar: tus propuestas no se liberan hasta que la cola esté vacía.`
  }

  proposePrompt(orch: SessionRecord, input: { session: string; title: string; prompt: string; subagents?: unknown; fresh?: boolean }): string {
    const target = this.findSessionByName(orch.projectId, input.session)
    if (!target || target.kind !== "worker") {
      const names = this.workersOf(orch.projectId).map((w) => w.name).join(", ") || "ninguna"
      throw new Error(`No existe la sesión "${input.session}". Sesiones worker: ${names}. Si hace falta una nueva, usá propose_session.`)
    }
    const d: Draft = {
      id: shortId("d_"),
      projectId: orch.projectId,
      kind: "prompt",
      targetSessionId: target.id,
      newSession: null,
      title: input.title.trim() || "Sin título",
      prompt: input.prompt.trim(),
      state: "staged",
      createdBy: orch.id,
      createdAt: now(),
      updatedAt: now(),
      decidedAt: null,
      edited: false,
      revision: 1,
      subagents: normalizeSubagents(input.subagents),
      fresh: input.fresh === true,
    }
    this.db.insertDraft(d)
    this.broadcastDraft(d.id)
    this.broadcastProject(orch.projectId)
    const subs = d.subagents.length ? ` Con ${d.subagents.length} ${d.subagents.length === 1 ? "subagente" : "subagentes"} (${d.subagents.map((s) => s.name).join(", ")}).` : ""
    return `Propuesta ${d.id} creada para ${target.name}${d.fresh ? " (empieza de cero)" : ""}.${subs} Queda en preparación hasta que termines el turno; después la aprueba el usuario${this.db.getProject(orch.projectId)?.settings.autoDispatch ? " (el proyecto tiene auto-envío: se va a enviar sola)" : ""}.${this.openDraftGuard(orch.projectId)}`
  }

  proposeSession(orch: SessionRecord, input: { name: string; role: string; title: string; prompt: string; subagents?: unknown }): string {
    const name = sanitizeSessionName(input.name).toUpperCase()
    if (!name) throw new Error("El nombre de la sesión no es válido (usá letras, números y guiones).")
    if (this.nameTaken(name)) throw new Error(`Ya existe una sesión llamada ${name}. Elegí otro nombre o usá propose_prompt.`)
    const d: Draft = {
      id: shortId("d_"),
      projectId: orch.projectId,
      kind: "session",
      targetSessionId: null,
      newSession: { name, role: input.role.trim() },
      title: input.title.trim() || `Nueva sesión ${name}`,
      prompt: input.prompt.trim(),
      state: "staged",
      createdBy: orch.id,
      createdAt: now(),
      updatedAt: now(),
      decidedAt: null,
      edited: false,
      revision: 1,
      subagents: normalizeSubagents(input.subagents),
      fresh: false,
    }
    this.db.insertDraft(d)
    this.broadcastDraft(d.id)
    this.broadcastProject(orch.projectId)
    return `Propuesta ${d.id} creada: sesión nueva ${name}. El usuario la tiene que aprobar para que se cree.${this.openDraftGuard(orch.projectId)}`
  }

  updateProposal(
    orch: SessionRecord,
    input: { id: string; title?: string; prompt?: string; session?: string; subagents?: unknown; fresh?: boolean }
  ): string {
    const d = this.db.getDraft(input.id)
    if (!d || d.projectId !== orch.projectId) throw new Error(`No existe la propuesta ${input.id}.`)
    if (d.state === "sent" || d.state === "discarded")
      throw new Error(`La propuesta ${d.id} ya fue ${d.state === "sent" ? "enviada" : "descartada"}; creá una nueva si hace falta.`)
    const patch: Partial<Draft> = { state: "staged", updatedAt: now(), revision: d.revision + 1 }
    if (input.title !== undefined) patch.title = input.title.trim()
    if (input.prompt !== undefined) patch.prompt = input.prompt.trim()
    if (input.subagents !== undefined) patch.subagents = normalizeSubagents(input.subagents)
    if (input.fresh !== undefined && d.kind === "prompt") patch.fresh = input.fresh
    if (input.session !== undefined && d.kind === "prompt") {
      const target = this.findSessionByName(orch.projectId, input.session)
      if (!target || target.kind !== "worker") throw new Error(`No existe la sesión "${input.session}".`)
      patch.targetSessionId = target.id
    }
    this.db.updateDraft(d.id, patch)
    this.broadcastDraft(d.id)
    this.broadcastProject(orch.projectId)
    return `Propuesta ${d.id} actualizada (revisión ${d.revision + 1}).${this.openDraftGuard(orch.projectId)}`
  }

  discardProposal(orch: SessionRecord, input: { id: string; reason?: string }): string {
    const d = this.db.getDraft(input.id)
    if (!d || d.projectId !== orch.projectId) throw new Error(`No existe la propuesta ${input.id}.`)
    if (d.state === "sent") throw new Error(`La propuesta ${d.id} ya fue enviada.`)
    this.db.updateDraft(d.id, { state: "discarded", decidedAt: now(), updatedAt: now() })
    this.broadcastDraft(d.id)
    this.broadcastProject(orch.projectId)
    return `Propuesta ${d.id} descartada.${this.openDraftGuard(orch.projectId)}`
  }

  listProposals(projectId: string): string {
    const open = this.db.listDrafts({ projectId, states: ["staged", "ready"] })
    if (!open.length) return "No hay propuestas abiertas."
    return open
      .map((d) => {
        const target = d.targetSessionId ? (this.db.getSession(d.targetSessionId)?.name ?? null) : null
        const subs = d.subagents.length
          ? `\nSubagentes: ${d.subagents.map((s) => `${s.name} (${s.role || "sin rol"}): ${s.task}`).join(" | ")}`
          : ""
        return `${formatDraftLine(d, target)}\n${d.prompt}${subs}`
      })
      .join("\n\n")
  }

  /** La orquestadora trae los resultados en cola a mitad de turno. */
  readResults(orch: SessionRecord): string {
    const queued = this.db.listReports({ projectId: orch.projectId, states: ["queued"] })
    if (!queued.length) return "La cola está vacía: no hay resultados nuevos."
    const deliveredAt = now()
    for (const r of queued) {
      this.db.updateReport(r.id, { state: "in_review", deliveredAt })
      this.broadcastReport(r.id)
    }
    this.clearTimer(orch.projectId)
    this.clearFollowUp(orch.projectId)
    this.firstQueuedAt.delete(orch.projectId)
    this.broadcastProject(orch.projectId)
    return this.composeBatch(orch.projectId, queued.map((r) => this.reportView(r)), true)
  }

  // ------------------------------------------------------- acciones del usuario

  private nameTaken(name: string): boolean {
    const n = name.toLowerCase()
    return this.db.listSessions().some((s) => s.name.toLowerCase() === n)
  }

  /** Aprueba y envía una propuesta (con tus ediciones, si las hay). */
  async sendDraft(
    id: string,
    edits: { title?: string; prompt?: string; name?: string; role?: string; subagents?: unknown; fresh?: boolean },
    auto = false
  ): Promise<Draft> {
    const d = this.db.getDraft(id)
    if (!d) throw new Error("La propuesta no existe")
    if (d.state === "staged")
      throw new Error("La orquestadora todavía está revisando resultados: la propuesta se libera cuando termine.")
    if (d.state !== "ready") throw new Error("La propuesta ya no está pendiente")
    const title = edits.title?.trim() || d.title
    const prompt = edits.prompt?.trim() || d.prompt
    const subagents = edits.subagents !== undefined ? normalizeSubagents(edits.subagents) : d.subagents
    const fresh = d.kind === "prompt" && (typeof edits.fresh === "boolean" ? edits.fresh : d.fresh)
    const edited =
      prompt !== d.prompt ||
      title !== d.title ||
      Boolean(edits.name || edits.role) ||
      JSON.stringify(subagents) !== JSON.stringify(d.subagents) ||
      fresh !== d.fresh
    const message = withSubagents(prompt, subagents)
    // La marcamos antes de mandar para que un doble click no la envíe dos veces.
    this.db.updateDraft(d.id, { state: "sent", decidedAt: now(), updatedAt: now(), title, prompt, edited, subagents, fresh })
    try {
      if (d.kind === "prompt") {
        if (!d.targetSessionId) throw new Error("La propuesta no tiene sesión destino")
        const target = this.db.getSession(d.targetSessionId)
        if (!target || target.archivedAt) throw new Error("La sesión destino ya no existe")
        // Empezar de cero: /clear y, cuando Claude Code confirma la conversación nueva, el prompt.
        if (fresh) await this.sessions.clearConversation(target.id)
        this.sessions.update(target.id, { taskTitle: title, taskState: "assigned" })
        await this.sessions.send(target.id, message, { origin: "draft", draftId: d.id, draftTitle: title, display: prompt, subagents })
        this.noteDecision(
          d.projectId,
          `${auto ? "Se envió automáticamente" : edited ? "Aprobó con cambios" : "Aprobó"} ${d.id} → ${target.name}${fresh ? " (empezando de cero)" : ""}: "${title}"${edited ? `. Versión enviada:\n${prompt}` : ""}`
        )
      } else {
        const name = sanitizeSessionName(edits.name || d.newSession?.name || "").toUpperCase()
        const role = (edits.role ?? d.newSession?.role ?? "").trim()
        if (!name) throw new Error("Falta el nombre de la sesión")
        if (this.nameTaken(name)) throw new Error(`Ya existe una sesión llamada ${name}`)
        const worker = await this.createWorker(d.projectId, { name, role })
        this.sessions.update(worker.id, { taskTitle: title, taskState: "assigned" })
        await this.sessions.send(worker.id, message, { origin: "draft", draftId: d.id, draftTitle: title, display: prompt, subagents })
        this.noteDecision(d.projectId, `Creó la sesión ${name} (${d.id}) con el prompt "${title}"${edited ? " (con cambios)" : ""}`)
      }
    } catch (err) {
      this.db.updateDraft(d.id, { state: "ready", decidedAt: null })
      this.broadcastDraft(d.id)
      throw err
    }
    this.broadcastDraft(d.id)
    this.broadcastProject(d.projectId)
    return this.db.getDraft(d.id)!
  }

  discardDraft(id: string): Draft {
    const d = this.db.getDraft(id)
    if (!d) throw new Error("La propuesta no existe")
    if (d.state === "sent" || d.state === "discarded") throw new Error("La propuesta ya no está pendiente")
    this.db.updateDraft(d.id, { state: "discarded", decidedAt: now(), updatedAt: now() })
    this.noteDecision(d.projectId, `Descartó ${d.id}: "${d.title}"`)
    this.broadcastDraft(d.id)
    this.broadcastProject(d.projectId)
    return this.db.getDraft(d.id)!
  }

  editDraft(id: string, edits: { title?: string; prompt?: string; subagents?: unknown; fresh?: boolean }): Draft {
    const d = this.db.getDraft(id)
    if (!d) throw new Error("La propuesta no existe")
    if (d.state !== "ready") throw new Error("Solo se pueden editar propuestas listas")
    this.db.updateDraft(d.id, {
      title: edits.title?.trim() || d.title,
      prompt: edits.prompt?.trim() || d.prompt,
      ...(edits.subagents !== undefined ? { subagents: normalizeSubagents(edits.subagents) } : {}),
      ...(typeof edits.fresh === "boolean" && d.kind === "prompt" ? { fresh: edits.fresh } : {}),
      edited: true,
      updatedAt: now(),
    })
    this.broadcastDraft(d.id)
    return this.db.getDraft(d.id)!
  }

  dismissReport(id: string) {
    const r = this.db.getReport(id)
    if (!r) throw new Error("El resultado no existe")
    if (r.state !== "queued") throw new Error("Solo se pueden quitar resultados que siguen en cola")
    this.db.updateReport(id, { state: "dismissed" })
    this.broadcastReport(id)
    this.schedule(r.projectId)
  }

  /** "Revisar ahora": entrega la cola sin esperar la ventana. */
  async reviewNow(projectId: string) {
    const orch = this.orchestratorOf(projectId)
    if (!orch) throw new Error("El proyecto no tiene orquestadora")
    const status = this.sessions.statusOf(orch.id)
    if (status === "working" || status === "needs_input") {
      throw new Error("La orquestadora está en medio de un turno: la cola se le entrega apenas termine.")
    }
    this.paused.delete(projectId)
    await this.deliver(projectId, false)
  }

  /** Salida de emergencia: da la revisión por cerrada y libera las propuestas. */
  forceRelease(projectId: string) {
    const queued = this.db.listReports({ projectId, states: ["queued"] })
    if (queued.length) throw new Error("Todavía hay resultados en cola sin entregar")
    this.paused.delete(projectId)
    this.closeReview(projectId)
  }

  /** Cómo invocar Claude Code con la cuenta de un proyecto. */
  targetFor(projectId: string): ClaudeTarget | undefined {
    if (!this.accounts) return undefined
    const a = this.accounts.forProject(projectId)
    return { bin: this.accounts.bin(a), env: this.accounts.env(a), configDir: this.accounts.dir(a) }
  }

  /** Evita chocar con una sesión viva fuera del dashboard: los mensajes irían a la equivocada. */
  private async assertNameFree(name: string, exceptClaudeId?: string, projectId?: string) {
    if (this.nameTaken(name)) throw new Error(`Ya existe una sesión llamada ${name}`)
    const ours = new Set(this.db.listSessions().map((s) => s.claudeSessionId))
    const clash = (await listLiveSessions(projectId ? this.targetFor(projectId) : undefined)).find(
      (l) => l.name?.toLowerCase() === name.toLowerCase() && l.sessionId !== exceptClaudeId && !ours.has(l.sessionId ?? "")
    )
    if (clash)
      throw new Error(
        `Ya hay una sesión viva llamada ${name} fuera del dashboard (en ${clash.cwd}). Elegí otro nombre, o cerrala e importala.`
      )
  }

  assertNameFreeFor(name: string, claudeSessionId: string, projectId: string) {
    return this.assertNameFree(name, claudeSessionId, projectId)
  }

  async createWorker(projectId: string, input: CreateWorkerInput): Promise<SessionRecord> {
    const project = this.db.getProject(projectId)
    if (!project) throw new Error("El proyecto no existe")
    const name = sanitizeSessionName(input.name).toUpperCase()
    if (!name) throw new Error("El nombre no es válido: usá letras, números y guiones")
    await this.assertNameFree(name, undefined, projectId)
    const rec = this.sessions.create({
      projectId,
      kind: "worker",
      name,
      role: input.role.trim(),
      cwd: project.repoPath,
      model: input.model || null,
      effort: input.effort || null,
      worktree: input.worktree,
    })
    this.broadcastProject(projectId)
    if (input.prompt?.trim()) {
      this.sessions.update(rec.id, { taskTitle: firstLine(input.prompt), taskState: "assigned" })
      await this.sessions.send(rec.id, input.prompt.trim(), { origin: "user" })
    } else {
      await this.sessions.start(rec.id)
    }
    return rec
  }
}

/** Trae al dashboard una conversación que empezaste en una terminal, con su historial. */
export async function importSession(
  db: Db,
  sessions: SessionManager,
  orchestration: Orchestration,
  projectId: string,
  input: { claudeSessionId: string; name: string; role: string; allowLive?: boolean }
): Promise<SessionRecord> {
  const project = db.getProject(projectId)
  if (!project) throw new Error("El proyecto no existe")
  if (db.listSessions().some((s) => s.claudeSessionId === input.claudeSessionId))
    throw new Error("Esa conversación ya está en el dashboard")
  const target = orchestration.targetFor(projectId)
  const live = (await listLiveSessions(target)).find((l) => l.sessionId === input.claudeSessionId)
  // Se puede traer igual (queda registrada y el dashboard no la reanuda hasta que la cierres).
  if (live && !input.allowLive)
    throw new Error(
      live.kind === "background"
        ? `La sesión sigue corriendo en segundo plano. Detenela con: claude stop ${live.id ?? ""}`
        : `La sesión sigue abierta en otra terminal (pid ${live.pid}). Cerrala y volvé a intentar.`
    )
  const name = sanitizeSessionName(input.name).toUpperCase()
  if (!name) throw new Error("El nombre no es válido: usá letras, números y guiones")
  await orchestration.assertNameFreeFor(name, input.claudeSessionId, projectId)
  const { events } = readTranscript(project.repoPath, input.claudeSessionId, target?.configDir)
  const rec = sessions.create({
    projectId,
    kind: "worker",
    name,
    role: input.role.trim(),
    cwd: project.repoPath,
    claudeSessionId: input.claudeSessionId,
  })
  for (const e of events) db.insertEvent(rec.id, e.ts, e.event)
  // Lo que ya había gastado la conversación (Claude Code lo guarda en el transcript y lo sigue sumando).
  const spent = lastCostState(project.repoPath, input.claudeSessionId, target?.configDir)
  if (spent) db.updateSession(rec.id, { costUsd: spent.usd, ...(spent.tokens ? { tokens: spent.tokens } : {}) })
  sessions.addEvent(rec.id, {
    kind: "notice",
    level: "info",
    text: `Sesión importada desde Claude Code${events.length ? ` con ${events.length} eventos de historial` : ""}. Al reanudarla recibe el protocolo de control-plane.`,
  })
  if (live) {
    sessions.addEvent(rec.id, {
      kind: "notice",
      level: "warn",
      text:
        live.kind === "background"
          ? `Sigue corriendo en segundo plano en Claude Code. Detenela con claude stop ${live.id ?? ""} y después usala desde acá.`
          : `Sigue abierta en una terminal (pid ${live.pid}). Cerrala con /exit y después usala desde acá: el dashboard no la reanuda mientras esté abierta.`,
    })
  }
  return rec
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > 80 ? line.slice(0, 79) + "…" : line
}
