import { AFK_HEADER } from "./afk.ts"
import type { Db, SessionRecord } from "./db.ts"
import { normalizeSubagents, type Orchestration } from "./orchestration.ts"
import { withSubagents } from "./prompts.ts"
import type { SessionManager, TurnEndInfo } from "./sessions.ts"
import type { Draft, PlanStep, PlanStepState, ReportStatus, SessionStatus } from "./shared/types.ts"
import { errorMessage, now, sanitizeSessionName, shortId } from "./util.ts"

/**
 * Planes por pasos: una lista de prompts para una sola sesión, cada uno con su modelo, esfuerzo y
 * fresh. El usuario aprueba el plan una vez y el server avanza solo: cuando el worker reporta `done`
 * y termina su turno, le manda el paso siguiente sin despertar a la orquestadora. Un `blocked`, un
 * `partial`, un error o una sesión detenida lo pausan y el resultado va a la cola enseguida. Al
 * terminar el último paso, un solo resultado con el resumen de todos.
 *
 * Todo el estado vive en la propuesta (la base), así sobrevive a un reinicio. En memoria queda solo lo
 * que dura un turno: qué planes recibieron un reporte en el turno en curso.
 */

export const MAX_STEPS = 20

/** Lo que manda la orquestadora (o el usuario al editar) por paso. */
export interface StepInput {
  title?: string
  prompt?: string
  model?: string | null
  effort?: string | null
  fresh?: boolean
  subagents?: unknown
}

const STEP_STATE_ES: Record<PlanStepState, string> = {
  pending: "pendiente",
  running: "en curso",
  done: "hecho",
  blocked: "bloqueado",
  partial: "parcial",
  skipped: "salteado",
}

/** Pasos que ya son historia: no se cambian al editar el plan. */
const LOCKED: PlanStepState[] = ["done", "running", "skipped"]

export class Plans {
  private o: Orchestration
  private db: Db
  private sessions: SessionManager
  /** Planes que recibieron un reporte en el turno en curso del worker: se decide al terminar el turno. */
  private reported = new Set<string>()
  /** Planes esperando que la sesión quede libre para mandar un paso: el índice del paso. */
  private waiting = new Map<string, number>()
  /** Planes mandando un paso en este momento (para no mandarlo dos veces). */
  private sending = new Set<string>()
  private disposed = false
  /**
   * Cuánto esperar después de que la sesión queda libre antes de mandar un paso: si le dejaste un
   * mensaje en cola, Claude Code lo agarra enseguida y la sesión vuelve a trabajar (entonces espera).
   */
  graceMs = 1000

  constructor(o: Orchestration, db: Db, sessions: SessionManager) {
    this.o = o
    this.db = db
    this.sessions = sessions
    sessions.on("turnEnd", (rec, info) => this.onTurnEnd(rec, info))
    sessions.on("status", (rec, status) => this.onStatus(rec, status))
    sessions.on("archiving", (id) => this.onArchiving(id))
  }

  /** Al apagar el server: las sesiones se detienen, pero eso no pausa ningún plan. */
  dispose() {
    this.disposed = true
  }

  // ------------------------------------------------------------------ vistas

  /** El plan aprobado que sigue vivo (en curso o pausado) de una sesión. */
  activeFor(sessionId: string): Draft | null {
    return (
      this.db
        .listDrafts({ states: ["sent"] })
        .find((d) => d.kind === "plan" && d.targetSessionId === sessionId && (d.planState === "running" || d.planState === "paused")) ?? null
    )
  }

  /** Una sesión con un plan que le está mandando pasos: no se le mete otro prompt en el medio. */
  busyWith(sessionId: string): Draft | null {
    const d = this.activeFor(sessionId)
    if (!d) return null
    const cur = d.currentStep !== null ? d.steps[d.currentStep] : null
    return d.planState === "running" || cur?.state === "running" ? d : null
  }

  /** "plan «X»: paso 2 de 4 (en curso)" para list_sessions. */
  sessionLine(sessionId: string): string | null {
    const d = this.activeFor(sessionId)
    if (!d || d.currentStep === null) return null
    return `plan ${d.id} «${d.title}»: paso ${d.currentStep + 1} de ${d.steps.length}${d.planState === "paused" ? " (pausado)" : ""}`
  }

  /** Los pasos de un plan en texto, para la orquestadora. */
  describe(d: Draft): string {
    return d.steps
      .map((s, i) => {
        const choice = [s.model ? `modelo ${s.model}` : null, s.effort ? `esfuerzo ${s.effort}` : null, s.fresh ? "de cero" : null]
          .filter(Boolean)
          .join(", ")
        const state = d.planState ? ` [${STEP_STATE_ES[s.state]}]` : ""
        return `${i + 1}. ${s.title}${choice ? ` (${choice})` : ""}${state}${s.summary ? `\n   Reportó: ${s.summary.split("\n")[0]}` : ""}`
      })
      .join("\n")
  }

  // ------------------------------------------------------------- propuestas

  /**
   * Arma los pasos validando modelo y esfuerzo de cada uno. El esfuerzo de un paso sin modelo se
   * valida contra el modelo con que sigue la sesión en ese momento (el del último paso que lo cambió).
   */
  normalizeSteps(raw: StepInput[], base: string | null, require?: { tool: string; target: SessionRecord | null; projectId: string }): PlanStep[] {
    if (!Array.isArray(raw) || !raw.length) throw new Error("El plan no tiene pasos.")
    if (raw.length > MAX_STEPS) throw new Error(`Un plan tiene como mucho ${MAX_STEPS} pasos: partilo en dos.`)
    let current = base
    return raw.map((s, i) => {
      const prompt = String(s.prompt ?? "").trim()
      if (!prompt) throw new Error(`El paso ${i + 1} no tiene prompt.`)
      let choice: { model: string | null; effort: string | null }
      try {
        if (require) this.o.requireChoice(s.model, s.effort, require)
        choice = this.o.checkChoice(s.model, s.effort, current)
      } catch (err) {
        throw new Error(`Paso ${i + 1}: ${errorMessage(err)}`)
      }
      if (choice.model) current = choice.model
      return {
        title: String(s.title ?? "").trim() || `Paso ${i + 1}`,
        prompt,
        model: choice.model,
        effort: choice.effort,
        fresh: s.fresh === true,
        subagents: normalizeSubagents(s.subagents),
        state: "pending",
        startedAt: null,
        endedAt: null,
        summary: null,
        details: null,
      }
    })
  }

  /** propose_plan: un plan para una sesión existente o para una nueva. */
  propose(
    orch: SessionRecord,
    input: { session?: string; newSession?: { name: string; role: string }; title: string; steps: StepInput[]; hold?: boolean }
  ): string {
    let target: SessionRecord | null = null
    let newSession: Draft["newSession"] = null
    if (input.newSession) {
      const name = sanitizeSessionName(input.newSession.name).toUpperCase()
      if (!name) throw new Error("El nombre de la sesión no es válido (usá letras, números y guiones).")
      if (this.o.nameTaken(orch.projectId, name)) throw new Error(`Ya existe una sesión llamada ${name} en este proyecto. Usá session para un plan en una sesión existente.`)
      newSession = { name, role: input.newSession.role.trim() }
    } else {
      target = input.session ? this.o.findSessionByName(orch.projectId, input.session) : null
      if (!target || target.kind !== "worker") {
        const names = this.o.workersOf(orch.projectId).map((w) => w.name).join(", ") || "ninguna"
        throw new Error(`No existe la sesión "${input.session ?? ""}". Sesiones worker: ${names}. Para una nueva, pasá newSession.`)
      }
      const active = this.activeFor(target.id)
      if (active)
        throw new Error(
          `${target.name} ya tiene un plan ${active.planState === "paused" ? "pausado" : "en curso"} (${active.id} «${active.title}»). Cambiá sus pasos con update_proposal, reanudalo con resume_plan o cancelalo con cancel_plan.`
        )
    }
    const base = target ? this.o.effectiveModel(target) : this.o.newWorkerModel(orch.projectId)
    const steps = this.normalizeSteps(input.steps, base, { tool: "propose_plan", target, projectId: orch.projectId })
    const d: Draft = {
      id: shortId("d_"),
      projectId: orch.projectId,
      kind: "plan",
      targetSessionId: target?.id ?? null,
      newSession,
      title: input.title.trim() || "Plan sin título",
      prompt: "",
      state: "staged",
      createdBy: orch.id,
      createdAt: now(),
      updatedAt: now(),
      decidedAt: null,
      edited: false,
      revision: 1,
      subagents: [],
      fresh: false,
      model: null,
      effort: null,
      steps,
      planState: null,
      currentStep: null,
      planNote: null,
      revises: null,
      hold: input.hold === true,
      sentBy: null,
    }
    this.db.insertDraft(d)
    this.o.broadcastDraft(d.id)
    this.o.broadcastProject(orch.projectId)
    return `Plan ${d.id} creado para ${target?.name ?? `la sesión nueva ${newSession!.name}`}: ${steps.length} pasos. Queda en preparación hasta que termines el turno; ${this.o.releaseNote(orch.projectId, d, !!newSession)}. Una vez aprobado avanza solo: te llega un resultado cuando termina o si se frena.`
  }

  /**
   * update_proposal sobre un plan. Sin aprobar: cambia la propuesta. Aprobado y pausado: arma una
   * propuesta nueva que cambia los pasos que faltan (vuelve a pasar por el usuario). `steps` son,
   * en ese caso, solo los que faltan: los hechos quedan como están.
   */
  update(orch: SessionRecord, d: Draft, input: { title?: string; steps?: StepInput[]; hold?: boolean }): string {
    if (d.state === "staged" || d.state === "ready") {
      const patch: Partial<Draft> = { state: "staged", updatedAt: now(), revision: d.revision + 1 }
      if (input.title !== undefined) patch.title = input.title.trim() || d.title
      if (input.hold !== undefined) patch.hold = input.hold
      if (input.steps !== undefined) {
        if (d.revises) {
          const plan = this.db.getDraft(d.revises)
          const kept = plan ? lockedPrefix(plan) : []
          patch.steps = [...kept, ...this.normalizeSteps(input.steps, this.baseAfter(plan, kept.length), { tool: "update_proposal", target: plan?.targetSessionId ? this.db.getSession(plan.targetSessionId) : null, projectId: d.projectId })]
          patch.currentStep = kept.length
        } else {
          const target = d.targetSessionId ? this.db.getSession(d.targetSessionId) : null
          patch.steps = this.normalizeSteps(input.steps, target ? this.o.effectiveModel(target) : this.o.newWorkerModel(d.projectId), { tool: "update_proposal", target, projectId: d.projectId })
        }
      }
      this.db.updateDraft(d.id, patch)
      this.o.broadcastDraft(d.id)
      this.o.broadcastProject(d.projectId)
      return `Plan ${d.id} actualizado (revisión ${d.revision + 1}).`
    }
    if (d.state !== "sent" || d.planState !== "paused")
      throw new Error(
        d.planState === "running"
          ? `El plan ${d.id} está en curso: sus pasos se cambian cuando se pausa (se pausa solo si un paso se frena; el usuario también lo puede pausar).`
          : `El plan ${d.id} ya ${d.planState === "done" ? "terminó" : "no sigue"}: proponé uno nuevo con propose_plan.`
      )
    if (!input.steps) throw new Error("Pasá steps: los pasos que faltan, como tienen que quedar.")
    const kept = lockedPrefix(d)
    const steps = [...kept, ...this.normalizeSteps(input.steps, this.baseAfter(d, kept.length), { tool: "update_proposal", target: d.targetSessionId ? this.db.getSession(d.targetSessionId) : null, projectId: d.projectId })]
    // Si ya hay una propuesta de cambio abierta para este plan, se actualiza esa.
    const open = this.db.listDrafts({ projectId: d.projectId, states: ["staged", "ready"] }).find((x) => x.revises === d.id)
    if (open) {
      this.db.updateDraft(open.id, { steps, title: input.title?.trim() || open.title, state: "staged", updatedAt: now(), revision: open.revision + 1, ...(input.hold !== undefined ? { hold: input.hold } : {}) })
      this.o.broadcastDraft(open.id)
      this.o.broadcastProject(d.projectId)
      return `Actualicé la propuesta ${open.id}, que cambia los pasos del plan ${d.id}. ${this.o.releaseNote(d.projectId, { hold: input.hold ?? open.hold }, false)}; al aprobarla, el plan sigue desde el paso ${kept.length + 1}.`
    }
    const rev: Draft = {
      ...d,
      id: shortId("d_"),
      title: input.title?.trim() || d.title,
      state: "staged",
      createdBy: orch.id,
      createdAt: now(),
      updatedAt: now(),
      decidedAt: null,
      edited: false,
      revision: 1,
      steps,
      planState: null,
      currentStep: kept.length,
      planNote: null,
      revises: d.id,
      hold: input.hold === true,
      sentBy: null,
    }
    this.db.insertDraft(rev)
    this.o.broadcastDraft(rev.id)
    this.o.broadcastProject(d.projectId)
    return `Propuesta ${rev.id} creada: cambia los pasos que faltan del plan ${d.id} (quedan ${steps.length - kept.length}). ${this.o.releaseNote(d.projectId, rev)}; al aprobarla, el plan sigue desde el paso ${kept.length + 1}.`
  }

  /** El modelo con que sigue la sesión después de los primeros `upto` pasos de un plan. */
  private baseAfter(plan: Draft | null, upto: number): string | null {
    const withModel = plan?.steps.slice(0, upto).reverse().find((s) => s.model)
    if (withModel) return withModel.model
    const target = plan?.targetSessionId ? this.db.getSession(plan.targetSessionId) : null
    return target ? this.o.effectiveModel(target) : plan ? this.o.newWorkerModel(plan.projectId) : null
  }

  // ------------------------------------------------------------ aprobación

  /**
   * El usuario aprobó un plan (o un cambio de un plan). `steps`, si los cambió al aprobar. Devuelve
   * el plan que quedó corriendo.
   */
  async approve(d: Draft, edits: { title?: string; steps?: StepInput[]; name?: string; role?: string }, auto: boolean): Promise<void> {
    const title = edits.title?.trim() || d.title
    if (d.revises) return this.approveRevision(d, title, edits.steps, auto)
    let steps = d.steps
    if (edits.steps !== undefined) {
      const target = d.targetSessionId ? this.db.getSession(d.targetSessionId) : null
      steps = this.normalizeSteps(edits.steps, target ? this.o.effectiveModel(target) : this.o.newWorkerModel(d.projectId))
    }
    const edited = title !== d.title || JSON.stringify(steps) !== JSON.stringify(d.steps) || Boolean(edits.name || edits.role)
    let target: SessionRecord
    let created = false
    if (d.targetSessionId) {
      const t = this.db.getSession(d.targetSessionId)
      if (!t || t.archivedAt) throw new Error("La sesión destino ya no existe")
      target = t
      const active = this.activeFor(target.id)
      if (active && active.id !== d.id)
        throw new Error(`${target.name} ya tiene un plan ${active.planState === "paused" ? "pausado" : "en curso"} («${active.title}»): cancelalo o esperá a que termine.`)
      if (this.busyWith(target.id)) throw new Error(`${target.name} está en medio de un plan.`)
    } else {
      const name = sanitizeSessionName(edits.name || d.newSession?.name || "").toUpperCase()
      const role = (edits.role ?? d.newSession?.role ?? "").trim()
      if (!name) throw new Error("Falta el nombre de la sesión")
      if (this.o.nameTaken(d.projectId, name)) throw new Error(`Ya existe una sesión llamada ${name} en este proyecto`)
      // Se marca antes de crear la sesión: un doble click (o el auto-envío a la vez) no crea dos.
      this.db.updateDraft(d.id, { state: "sent", decidedAt: now(), updatedAt: now() })
      const first = steps[0]
      try {
        target = await this.o.createWorker(d.projectId, { name, role, model: first?.model ?? null, effort: first?.effort ?? null })
      } catch (err) {
        this.db.updateDraft(d.id, { state: "ready", decidedAt: null })
        this.o.broadcastDraft(d.id)
        throw err
      }
      created = true
    }
    this.db.updateDraft(d.id, {
      state: "sent",
      decidedAt: now(),
      updatedAt: now(),
      title,
      edited,
      steps,
      targetSessionId: target.id,
      planState: "running",
      currentStep: 0,
      planNote: null,
    })
    this.o.broadcastDraft(d.id)
    try {
      // Si la sesión está con otra cosa, el primer paso sale cuando quede libre.
      await this.kick(d.id, 0)
    } catch (err) {
      // Si no salió el primer paso, la propuesta vuelve a estar para aprobar (con la sesión que ya se creó, si se creó).
      this.db.updateDraft(d.id, {
        state: "ready",
        decidedAt: null,
        planState: null,
        currentStep: null,
        steps: d.steps,
        targetSessionId: created ? target.id : d.targetSessionId,
      })
      this.o.broadcastDraft(d.id)
      throw err
    }
    this.o.noteDecision(
      d.projectId,
      `${auto ? "Se envió automáticamente" : edited ? "Aprobó con cambios" : "Aprobó"} el plan ${d.id} → ${target.name}: "${title}" (${steps.length} pasos)${edited ? `. Pasos:\n${this.describe({ ...d, steps, planState: null })}` : ""}`
    )
  }

  private async approveRevision(rev: Draft, title: string, edited: StepInput[] | undefined, auto: boolean): Promise<void> {
    const plan = this.db.getDraft(rev.revises!)
    if (!plan || plan.planState !== "paused") throw new Error("El plan que cambia esta propuesta ya no está pausado")
    const kept = lockedPrefix(plan)
    // Desde dónde cambiaba la propuesta (lo de antes ya era historia). Desde la web llega la lista completa.
    const from = rev.currentStep ?? kept.length
    let fresh = edited !== undefined ? this.normalizeSteps(edited.slice(from), this.baseAfter(plan, from)) : rev.steps.slice(from)
    // Un paso que corría cuando se armó la propuesta y después se frenó: se repite antes de los nuevos.
    const again = kept.length < from ? plan.steps.slice(kept.length, from) : []
    // Uno que terminó entretanto ya no se repite.
    if (kept.length > from) fresh = fresh.slice(kept.length - from)
    if (!fresh.length && !again.length) throw new Error("No quedan pasos para seguir: cancelá el plan si ya no hace falta.")
    const steps = [...kept, ...[...again, ...fresh].map(reset)]
    this.db.updateDraft(rev.id, { state: "sent", decidedAt: now(), updatedAt: now(), title, steps, edited: edited !== undefined })
    this.db.updateDraft(plan.id, { steps, title, planState: "running", currentStep: kept.length, planNote: null, updatedAt: now() })
    this.o.noteDecision(
      plan.projectId,
      `${auto ? "Se envió automáticamente" : edited ? "Aprobó con cambios" : "Aprobó"} el cambio ${rev.id} del plan ${plan.id}: sigue desde el paso ${kept.length + 1} de ${steps.length}`
    )
    this.o.broadcastDraft(rev.id)
    this.o.broadcastDraft(plan.id)
    await this.kickOrPause(plan.id, kept.length)
  }

  // --------------------------------------------------------------- avanzar

  /** Manda el paso i: de cero si corresponde, el modelo y el esfuerzo, y el prompt con su encabezado. */
  private async startStep(planId: string, i: number): Promise<void> {
    if (this.sending.has(planId)) return
    this.sending.add(planId)
    this.waiting.delete(planId)
    try {
      const d = this.db.getDraft(planId)
      if (!d || d.planState !== "running" || !d.targetSessionId) return
      const step = d.steps[i]
      if (!step) return this.finish(d)
      const target = this.db.getSession(d.targetSessionId)
      if (!target || target.archivedAt) throw new Error("La sesión del plan ya no existe")
      // Se marca antes de mandar: un reporte que llegue en el medio ya es de este paso.
      const steps = d.steps.map((s, j) => (j === i ? { ...s, state: "running" as const, startedAt: now(), endedAt: null, summary: null, details: null } : s))
      this.db.updateDraft(d.id, { steps, currentStep: i, updatedAt: now() })
      this.o.broadcastDraft(d.id)
      const total = d.steps.length
      const last = i === total - 1
      const header = last
        ? `Paso ${i + 1} de ${total} (el último) del plan «${d.title}». Cuando termines este paso, reportá con report_result.`
        : `Paso ${i + 1} de ${total} del plan «${d.title}». Cuando termines este paso, reportá con report_result: el siguiente te llega solo.`
      const prev = step.fresh ? d.steps.slice(0, i).reverse().find((s) => s.summary) : undefined
      const prevIndex = prev ? d.steps.indexOf(prev) : -1
      const before = prev
        ? `\n\n## Dónde quedó el paso anterior (${prevIndex + 1}. ${prev.title})\nEmpezás de cero: esto es lo que reportó.\n\n${prev.summary}${prev.details ? `\n\n${prev.details}` : ""}`
        : ""
      const display = `${header}${before}\n\n${step.prompt}`
      if (step.fresh) await this.sessions.clearConversation(target.id)
      await this.o.applyChoice(target, step.model, step.effort, step.title)
      // Mientras esperaba, lo pudieron pausar, cancelar o archivar: entonces no sale.
      const now_ = this.db.getDraft(d.id)
      if (now_?.planState !== "running" || this.db.getSession(target.id)?.archivedAt) {
        if (now_?.steps[i]?.state === "running")
          this.db.updateDraft(d.id, { steps: now_.steps.map((s, j) => (j === i ? reset(s) : s)) })
        this.o.broadcastDraft(d.id)
        return
      }
      this.sessions.update(target.id, { taskTitle: `${d.title} · paso ${i + 1} de ${total}`, taskState: "assigned" })
      // En AFK el worker no tiene a quién preguntarle (también en los pasos de un plan que sigue solo).
      const afkLine = this.db.getProject(d.projectId)?.afk ? `${AFK_HEADER}\n\n` : ""
      await this.sessions.send(target.id, afkLine + withSubagents(display, step.subagents), {
        origin: "draft",
        draftId: d.id,
        draftTitle: d.title,
        display,
        subagents: step.subagents,
        plan: { draftId: d.id, step: i, total, title: step.title },
      })
    } finally {
      this.sending.delete(planId)
    }
  }

  /** Después de un `done`: el paso siguiente apenas la sesión quede libre, o el resultado final. */
  private async advance(planId: string) {
    const d = this.db.getDraft(planId)
    if (!d || d.planState !== "running" || d.currentStep === null || !d.targetSessionId) return
    if (d.steps[d.currentStep]?.state !== "done") return
    const next = d.currentStep + 1
    if (next >= d.steps.length) return this.finish(d)
    this.waiting.set(planId, next)
    await new Promise((r) => setTimeout(r, this.graceMs))
    this.flush(planId)
  }

  /** Si la sesión está ocupada (trabajando o esperando una respuesta). */
  private busy(sessionId: string): boolean {
    const status = this.sessions.statusOf(sessionId)
    return status === "working" || status === "needs_input" || status === "starting"
  }

  /** Manda el paso i, o lo deja esperando a que la sesión quede libre. Los errores, para quien llama. */
  private async kick(planId: string, i: number) {
    const d = this.db.getDraft(planId)
    if (!d?.targetSessionId) return
    if (this.busy(d.targetSessionId)) {
      this.waiting.set(planId, i)
      return
    }
    await this.startStep(planId, i)
  }

  /** Como kick, pero si no sale, el plan se pausa y la orquestadora se entera. */
  private async kickOrPause(planId: string, i: number) {
    try {
      await this.kick(planId, i)
    } catch (err) {
      this.pause(planId, `No se pudo mandar el paso ${i + 1}: ${errorMessage(err)}`, "blocked")
    }
  }

  /** El último paso terminó: un solo resultado en la cola con lo de cada paso. */
  private finish(d: Draft) {
    const skipped = d.steps.filter((s) => s.state === "skipped").length
    const total = `${d.steps.length} ${d.steps.length === 1 ? "paso" : "pasos"}${skipped ? ` (${skipped} ${skipped === 1 ? "salteado" : "salteados"})` : ""}`
    this.db.updateDraft(d.id, { planState: "done", planNote: `Terminó: ${total}.`, updatedAt: now() })
    this.o.broadcastDraft(d.id)
    const worker = d.targetSessionId ? this.db.getSession(d.targetSessionId) : null
    if (!worker) return
    // El id va en el detalle (la orquestadora lo lee ahí); el resumen es lo que ve el usuario en los avisos.
    const details = `Plan ${d.id}.\n\n` + d.steps
      .map((s, i) => `### Paso ${i + 1}: ${s.title}${s.model ? ` (${s.model}${s.effort ? `, ${s.effort}` : ""})` : ""}\n${s.summary ?? "(sin resumen)"}${s.details ? `\n\n${s.details}` : ""}`)
      .join("\n\n")
    this.o.enqueueReport(worker, {
      status: "done",
      taskTitle: d.title,
      summary: `«${d.title}» terminado: ${total}.\nÚltimo paso: ${d.steps.at(-1)?.summary ?? ""}`,
      details,
    })
  }

  /**
   * Pausa el plan. Con `status`, el resultado va a la cola de la orquestadora con el estado del plan
   * y los pasos que faltan (un paso que se frenó, un error, la sesión detenida).
   */
  pause(planId: string, note: string, status: ReportStatus | null, reported = false) {
    const d = this.db.getDraft(planId)
    if (!d || (d.planState !== "running" && d.planState !== "paused")) return
    this.waiting.delete(planId)
    this.db.updateDraft(d.id, { planState: "paused", planNote: note, updatedAt: now() })
    this.o.broadcastDraft(d.id)
    // Si ya estaba pausado (lo pausó el usuario, o ya se avisó), un error más no manda otro resultado; un
    // reporte del worker sí, que es información nueva.
    if (!status || (d.planState === "paused" && !reported)) return
    const worker = d.targetSessionId ? this.db.getSession(d.targetSessionId) : null
    if (!worker) return
    const i = d.currentStep ?? 0
    const step = d.steps[i]
    const remaining = d.steps.slice(i + 1)
    this.o.enqueueReport(worker, {
      status,
      taskTitle: d.title,
      // Sin el id (va en el detalle): el resumen sale en los avisos y en la tarjeta de la sesión.
      summary: `«${d.title}» en pausa en el paso ${i + 1} de ${d.steps.length} («${step?.title ?? "?"}»). ${note}${step?.summary && step.summary !== note ? `\n${step.summary}` : ""}`,
      details: [
        `Plan ${d.id}.`,
        step?.details ?? null,
        `## Estado del plan\n${this.describe(this.db.getDraft(d.id)!)}`,
        remaining.length ? `Faltan ${remaining.length} ${remaining.length === 1 ? "paso" : "pasos"} después de este.` : "Era el último paso.",
        `Podés reanudarlo con resume_plan (retry repite este paso, next sigue con el siguiente), cambiar los pasos que faltan con update_proposal sobre ${d.id} (vuelve a pasar por el usuario) o cancelarlo con cancel_plan.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    })
  }

  // ---------------------------------------------------------------- eventos

  /**
   * Un report_result de una sesión con un paso en curso es de ese paso. Se guarda en el paso y se
   * decide al terminar el turno: si reporta dos veces en el mismo turno, vale el último.
   * Devuelve null si el reporte no es de un plan (va a la cola como siempre).
   */
  onReport(worker: SessionRecord, input: { status: ReportStatus; summary: string; details?: string | null }): string | null {
    const d = this.activeFor(worker.id)
    if (!d || d.currentStep === null) return null
    const step = d.steps[d.currentStep]
    if (!step) return null
    if (step.state !== "running" && !this.reported.has(d.id)) return null
    const steps = d.steps.map((s, j) =>
      j === d.currentStep
        ? { ...s, state: input.status as PlanStepState, endedAt: now(), summary: input.summary.trim(), details: input.details?.trim() || null }
        : s
    )
    this.db.updateDraft(d.id, { steps, updatedAt: now() })
    this.reported.add(d.id)
    this.o.broadcastDraft(d.id)
    this.sessions.update(worker.id, {
      taskState: input.status === "done" ? "reported_done" : input.status === "blocked" ? "reported_blocked" : "reported_partial",
    })
    const last = d.currentStep === d.steps.length - 1
    if (input.status !== "done")
      return "Registrado. El plan se pausa cuando termines el turno y tu resultado va a la orquestadora. Quedate disponible."
    if (d.planState === "paused") return "Paso registrado. El plan está pausado: el siguiente paso sale cuando lo reanuden. Quedate disponible."
    return last
      ? "Último paso registrado: cuando termines el turno, el resultado del plan va a la orquestadora. Quedate disponible."
      : "Paso registrado. Terminá el turno sin seguir con otra cosa: el siguiente paso te llega solo."
  }

  private onTurnEnd(rec: SessionRecord, info: TurnEndInfo) {
    if (this.disposed || rec.kind !== "worker") return
    // Un comando local (el /clear de un paso de cero) no cuenta. Si no entró por el contexto lleno, lo reenvía la compactación.
    if ((info.local && info.ok) || info.contextFull) return
    const d = this.activeFor(rec.id)
    if (!d || d.currentStep === null) return
    const step = d.steps[d.currentStep]
    if (!step) return
    if (this.reported.delete(d.id)) return this.decide(d.id)
    if (step.state !== "running") return
    // Interrumpido: el paso sigue siendo el que estaba (si le pedís que siga y reporta, cuenta); el plan espera.
    if (info.aborted) this.pause(d.id, `Interrumpiste el paso ${d.currentStep + 1}.`, null)
    else if (!info.ok) this.failStep(d, `La sesión dio error en el paso ${d.currentStep + 1}${info.result ? `: ${info.result.slice(0, 200)}` : ""}.`)
    // Un turno que termina bien sin reporte (el usuario le escribió en el medio): el paso sigue en curso.
  }

  /**
   * El paso no pudo seguir (error, sesión detenida): queda bloqueado (así se puede repetir o cambiar) y
   * el plan se pausa. Si después el worker reporta igual, va a la cola como un resultado común.
   */
  private failStep(d: Draft, note: string) {
    const i = d.currentStep!
    const steps = d.steps.map((s, j) => (j === i ? { ...s, state: "blocked" as const, endedAt: now(), summary: note } : s))
    this.db.updateDraft(d.id, { steps })
    this.pause(d.id, note, "blocked")
  }

  /** Lo que reportó el paso, al terminar el turno: seguir, terminar o pausar. */
  private decide(planId: string) {
    const d = this.db.getDraft(planId)
    if (!d || d.currentStep === null) return
    const step = d.steps[d.currentStep]
    if (!step) return
    if (step.state === "done") {
      if (d.planState === "running") void this.advance(d.id)
      return
    }
    if (step.state === "blocked" || step.state === "partial")
      this.pause(d.id, step.state === "blocked" ? "Quedó bloqueado." : "Quedó a medias.", step.state, true)
  }

  private onStatus(rec: SessionRecord, status: SessionStatus) {
    if (this.disposed || rec.kind !== "worker") return
    const d = this.activeFor(rec.id)
    if (!d) return
    if (status === "idle" && this.waiting.has(d.id)) {
      // Después del fin de turno (que sale en el mismo tick) y de que Claude Code agarre lo que hubiera en cola.
      setTimeout(() => this.flush(d.id), this.graceMs)
      return
    }
    if (status !== "stopped" && status !== "error") return
    const i = d.currentStep ?? 0
    if (this.reported.delete(d.id)) {
      // Reportó y la detuviste antes de que terminara el turno: un done no relanza la sesión, queda pausado.
      if (d.steps[i]?.state === "done") return this.pause(d.id, `La sesión se detuvo después de terminar el paso ${i + 1}.`, null)
      return this.decide(d.id)
    }
    if (d.steps[i]?.state !== "running") return
    this.failStep(d, status === "error" ? `La sesión terminó con error en el paso ${i + 1}.` : `La sesión se detuvo en el paso ${i + 1}.`)
  }

  /** La sesión quedó libre: sale el paso que esperaba. */
  private flush(planId: string) {
    const i = this.waiting.get(planId)
    const d = this.db.getDraft(planId)
    if (i === undefined || d?.planState !== "running" || !d.targetSessionId) return
    if (this.busy(d.targetSessionId)) return
    this.waiting.delete(planId)
    void this.kickOrPause(planId, i)
  }

  /** Archivar la sesión cancela su plan y descarta los que esperaban aprobación. */
  private onArchiving(sessionId: string) {
    const d = this.activeFor(sessionId)
    if (d) this.cancel(d.id, "Se archivó la sesión.", null)
    for (const open of this.db.listDrafts({ states: ["staged", "ready"] })) {
      if (open.kind !== "plan" || open.targetSessionId !== sessionId) continue
      this.db.updateDraft(open.id, { state: "discarded", decidedAt: now(), updatedAt: now() })
      this.o.broadcastDraft(open.id)
    }
  }

  // ------------------------------------------------- acciones (usuario y orquestadora)

  userPause(planId: string): Draft {
    const d = this.requirePlan(planId)
    if (d.planState !== "running") throw new Error("El plan no está en curso")
    this.pause(d.id, "Lo pausaste.", null)
    this.o.noteDecision(d.projectId, `Pausó el plan ${d.id} «${d.title}» en el paso ${(d.currentStep ?? 0) + 1}`)
    return this.db.getDraft(d.id)!
  }

  /**
   * Reanuda un plan pausado. retry: repite el paso en que se frenó; next: sigue con el siguiente.
   * Por defecto, retry si el paso no terminó y next si terminó. Si el paso todavía corre (lo pausaste
   * mientras trabajaba), solo vuelve a quedar en curso: el siguiente sale cuando reporte.
   */
  async resume(planId: string, mode?: "retry" | "next", by: "user" | "orchestrator" = "user"): Promise<Draft> {
    const d = this.requirePlan(planId)
    if (d.planState !== "paused") throw new Error("El plan no está pausado")
    if (d.targetSessionId && this.db.getSession(d.targetSessionId)?.archivedAt) throw new Error("La sesión del plan está archivada")
    const i = d.currentStep ?? 0
    const step = d.steps[i]
    const open = this.db.listDrafts({ projectId: d.projectId, states: ["staged", "ready"] }).find((x) => x.revises === d.id)
    if (open) {
      this.db.updateDraft(open.id, { state: "discarded", decidedAt: now(), updatedAt: now() })
      this.o.broadcastDraft(open.id)
    }
    this.db.updateDraft(d.id, { planState: "running", planNote: null, updatedAt: now() })
    this.o.broadcastDraft(d.id)
    this.o.noteDecision(d.projectId, `${by === "user" ? "Reanudó" : "Reanudaste"} el plan ${d.id} «${d.title}»`)
    // Lo pausaste mientras el paso corría y la sesión sigue con él (o ya reportó en este turno): espera su
    // reporte. Si la sesión ya no está con él (la interrumpiste), por defecto se repite.
    const stillOnIt = step?.state === "running" && (this.busy(d.targetSessionId ?? "") || this.reported.has(d.id))
    if (stillOnIt && mode === undefined) return this.db.getDraft(d.id)!
    const how = mode ?? (step?.state === "done" || step?.state === "skipped" ? "next" : "retry")
    try {
      if (how === "next" || !step) {
        if (step && step.state !== "done" && step.state !== "skipped") {
          const steps = d.steps.map((s, j) => (j === i ? { ...s, state: "skipped" as const, endedAt: s.endedAt ?? now() } : s))
          this.db.updateDraft(d.id, { steps })
        }
        if (i + 1 >= d.steps.length) this.finish(this.db.getDraft(d.id)!)
        else await this.kick(d.id, i + 1)
      } else {
        await this.kick(d.id, i)
      }
    } catch (err) {
      this.pause(d.id, `No se pudo reanudar: ${errorMessage(err)}`, null)
      throw err
    }
    return this.db.getDraft(d.id)!
  }

  cancel(planId: string, note: string, by: "user" | "orchestrator" | null): Draft {
    const d = this.requirePlan(planId)
    if (d.planState !== "running" && d.planState !== "paused") throw new Error("El plan ya terminó")
    this.waiting.delete(d.id)
    // Si el paso ya reportó en este turno, ese resultado no se pierde: va a la cola como uno común.
    const reported = this.reported.delete(d.id) ? d.steps[d.currentStep ?? 0] : undefined
    const steps = d.steps.map((s) => (s.state === "pending" || s.state === "running" ? { ...s, state: "skipped" as const, endedAt: now() } : s))
    this.db.updateDraft(d.id, { steps, planState: "cancelled", planNote: note, updatedAt: now() })
    for (const open of this.db.listDrafts({ projectId: d.projectId, states: ["staged", "ready"] })) {
      if (open.revises !== d.id) continue
      this.db.updateDraft(open.id, { state: "discarded", decidedAt: now(), updatedAt: now() })
      this.o.broadcastDraft(open.id)
    }
    this.o.broadcastDraft(d.id)
    const worker = d.targetSessionId ? this.db.getSession(d.targetSessionId) : null
    if (reported?.summary && worker && (reported.state === "done" || reported.state === "blocked" || reported.state === "partial"))
      this.o.enqueueReport(worker, { status: reported.state, summary: reported.summary, details: reported.details, taskTitle: `${d.title} · ${reported.title}` })
    if (by === "user") this.o.noteDecision(d.projectId, `Canceló el plan ${d.id} «${d.title}»`)
    return this.db.getDraft(d.id)!
  }

  /**
   * El usuario cambia los pasos que faltan de un plan pausado (él es quien aprueba: no hace falta otra
   * vuelta). Llega la lista completa, como la ve: los pasos hechos no se tocan.
   */
  editPaused(planId: string, edits: { title?: string; steps?: StepInput[] }): Draft {
    const d = this.requirePlan(planId)
    if (d.planState !== "paused") throw new Error("Los pasos de un plan aprobado se cambian con el plan pausado")
    const patch: Partial<Draft> = { updatedAt: now(), edited: true }
    if (edits.title !== undefined) patch.title = edits.title.trim() || d.title
    if (edits.steps !== undefined) {
      const kept = lockedPrefix(d)
      const fresh = this.normalizeSteps(edits.steps.slice(kept.length), this.baseAfter(d, kept.length))
      patch.steps = [...kept, ...fresh]
      patch.currentStep = Math.min(d.currentStep ?? 0, kept.length)
    }
    this.db.updateDraft(d.id, patch)
    this.o.noteDecision(d.projectId, `Cambió los pasos del plan pausado ${d.id} «${d.title}»:\n${this.describe(this.db.getDraft(d.id)!)}`)
    this.o.broadcastDraft(d.id)
    return this.db.getDraft(d.id)!
  }

  /**
   * Al arrancar el server: los planes en curso cuyo paso ya reportó `done` y no llegaron a mandar el
   * siguiente (se cortó en el medio) siguen. Los pasos en curso esperan su reporte como siempre
   * (si la sesión estaba trabajando, el reinicio le pide que siga).
   */
  recover() {
    for (const d of this.db.listDrafts({ states: ["sent"] })) {
      if (d.kind !== "plan" || d.planState !== "running" || d.currentStep === null || !d.targetSessionId) continue
      const i = d.currentStep
      const state = d.steps[i]?.state
      if (state === "done") void this.advance(d.id)
      // Reportó blocked o partial y el server se cortó antes del fin del turno.
      else if (state === "blocked" || state === "partial") this.decide(d.id)
      // Estaba esperando que la sesión quedara libre.
      else if (state === "pending") void this.kickOrPause(d.id, i)
      // En curso, pero la sesión no se retomó (o el prompt no llegó a salir): queda pausado para que lo reanudes.
      else if (state === "running" && !this.busy(d.targetSessionId)) this.pause(d.id, `El server se reinició en medio del paso ${i + 1}: reanudalo para repetirlo.`, null)
    }
  }

  private requirePlan(id: string): Draft {
    const d = this.db.getDraft(id)
    if (!d || d.kind !== "plan" || d.state !== "sent") throw new Error("El plan no existe o todavía no se aprobó")
    return d
  }
}

/** Un paso como si no hubiera corrido. */
function reset(s: PlanStep): PlanStep {
  return { ...s, state: "pending", startedAt: null, endedAt: null, summary: null, details: null }
}

/** Los pasos de un plan que ya son historia (hechos, en curso o salteados), desde el principio. */
function lockedPrefix(d: Draft): PlanStep[] {
  const out: PlanStep[] = []
  for (const s of d.steps) {
    if (!LOCKED.includes(s.state)) break
    out.push(s)
  }
  return out
}
