import type { AfkPeriodRow, Db, ProjectRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import type { Orchestration } from "./orchestration.ts"
import type { SessionManager } from "./sessions.ts"
import type { AfkEndReason, AfkLog, AfkLogDraft, AfkState, Draft, Project } from "./shared/types.ts"
import { now } from "./util.ts"

/** Lo que se le suma a lo que sale en AFK, para que el worker no se quede esperando una respuesta. */
export const AFK_HEADER =
  "El usuario está AFK: no le hagas preguntas con AskUserQuestion. Tomá la decisión razonable y explicala en tu report_result, o reportá blocked si de verdad no podés seguir."

/** setTimeout no acepta más de 2^31-1 ms: un `until` más lejano se re-arma cada tanto. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** Revisa los vencimientos aunque no haya llegado ningún evento (por si un temporizador se atrasó, ej. al suspender la PC). */
const SWEEP_MS = 30_000
/** Cuántos resultados y propuestas lista el registro como máximo. */
const LOG_LIMIT = 200

export interface AfkInput {
  /** Cuándo termina solo (ms desde epoch); null o ausente = sin límite. */
  until?: number | null
  /** Tope de gasto en US$ desde que empieza; null o ausente = sin límite. */
  budgetUsd?: number | null
}

interface Deps {
  db: Db
  hub: Hub
  sessions: SessionManager
  orchestration: Orchestration
}

const usd = (n: number) => `US$ ${Number.isInteger(n) ? n : n.toFixed(2)}`
const clock = (ms: number) => new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
const WHEN_DAY = new Intl.DateTimeFormat("es-AR", { weekday: "short", day: "numeric", month: "short" })

/** "hasta las 18:00", o con el día si no es hoy ni mañana temprano. */
function untilText(until: number): string {
  const d = new Date(until)
  const t = new Date()
  const sameDay = d.toDateString() === t.toDateString()
  return sameDay ? `hasta las ${clock(until)}` : `hasta el ${WHEN_DAY.format(d)} a las ${clock(until)}`
}

/** El texto con el que se avisa a la orquestadora (y se deja en su chat) al entrar en AFK. */
export function afkEnterNotice(afk: Pick<AfkState, "until" | "budgetUsd">): string {
  const until = afk.until ? ` ${untilText(afk.until)}` : ""
  const budget = afk.budgetUsd ? ` (presupuesto ${usd(afk.budgetUsd)})` : ""
  return `El usuario está AFK${until}${budget}: tus propuestas salen solas, salvo las que marques con hold.`
}

const END_TEXT: Record<AfkEndReason, { notice: string; title: string; body: string }> = {
  user: {
    notice: "El usuario volvió: tus propuestas vuelven a esperar su aprobación.",
    title: "",
    body: "",
  },
  until: {
    notice: "Se cumplió el tiempo del AFK: tus propuestas vuelven a esperar la aprobación del usuario.",
    title: "El AFK terminó: se cumplió el tiempo",
    body: "Las propuestas que queden esperan tu aprobación.",
  },
  budget: {
    notice: "Se agotó el presupuesto del AFK: tus propuestas vuelven a esperar la aprobación del usuario.",
    title: "El AFK terminó: se agotó el presupuesto",
    body: "Las propuestas que queden esperan tu aprobación.",
  },
}

/**
 * Modo AFK: un proyecto puede quedar sin vos. Mientras dura, lo que propone la orquestadora sale solo
 * (ver Orchestration.closeReview), con barandas: un tiempo y un presupuesto, y al terminar todo vuelve a
 * esperarte. Acá vive el estado, los vencimientos y el registro de lo que pasó.
 */
export class Afk {
  private db: Db
  private hub: Hub
  private sessions: SessionManager
  private o: Orchestration
  private timers = new Map<string, NodeJS.Timeout>()
  private sweep: NodeJS.Timeout

  constructor({ db, hub, sessions, orchestration }: Deps) {
    this.db = db
    this.hub = hub
    this.sessions = sessions
    this.o = orchestration
    // El costo se actualiza al terminar el turno: ahí se mira el presupuesto.
    sessions.on("turnEnd", (rec) => this.check(rec.projectId))
    this.sweep = setInterval(() => this.checkAll(), SWEEP_MS)
    this.sweep.unref()
    // Después de un reinicio: lo que venció con el server apagado termina ya; el resto vuelve a armar su temporizador.
    this.checkAll()
    for (const p of this.db.listAfkProjects()) this.arm(p.id)
  }

  dispose() {
    clearInterval(this.sweep)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  // ------------------------------------------------------------- consultas

  /** Lo gastado en el proyecto desde que empezó el AFK, y por modelo. */
  spent(project: Pick<ProjectRecord, "id">, afk: AfkState, period: AfkPeriodRow | null = this.db.lastAfkPeriod(project.id)) {
    const cost = this.db.projectCost(project.id)
    const start = period && period.endedAt === null && period.since === afk.since ? period.costByModelAtStart : {}
    return { usd: Math.max(0, cost.usd - afk.spentAtStart), byModel: diffCosts(cost.byModel, start) }
  }

  /** Lo que pasó en el último período AFK del proyecto (null si nunca estuvo AFK). */
  log(projectId: string): AfkLog | null {
    const p = this.db.getProject(projectId)
    if (!p) throw new Error("El proyecto no existe")
    const period = this.db.lastAfkPeriod(projectId)
    if (!period) return null
    const from = period.since
    const to = period.endedAt ?? now()
    const live = period.endedAt === null && p.afk ? this.spent(p, p.afk, period) : null
    const name = (id: string | null) => (id ? (this.db.getSession(id)?.name ?? null) : null)
    const item = (d: Draft): AfkLogDraft => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      state: d.state,
      hold: d.hold,
      sentBy: d.sentBy,
      sessionId: d.targetSessionId,
      sessionName: name(d.targetSessionId) ?? d.newSession?.name ?? null,
      createdSession: d.kind === "session" || (d.kind === "plan" && d.newSession !== null),
      sentAt: d.state === "sent" ? d.decidedAt : null,
    })
    // Una propuesta ya del período si se creó o se envió dentro de él (un plan de antes puede avanzar en AFK, pero no cuenta).
    const drafts = this.db.listDrafts({ projectId }).filter((d) => d.createdAt >= from && d.createdAt <= to)
    const sent = drafts.filter((d) => d.sentBy === "afk" && d.state === "sent").sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0))
    const held = drafts.filter((d) => d.sentBy !== "afk" && d.state !== "discarded" && (d.hold || d.state === "staged" || d.state === "ready"))
    const results = this.db
      .listReports({ projectId })
      .filter((r) => r.createdAt >= from && r.createdAt <= to)
      .sort((a, b) => a.createdAt - b.createdAt)
    return {
      projectId,
      since: period.since,
      until: period.until,
      budgetUsd: period.budgetUsd,
      endedAt: period.endedAt,
      endReason: period.endReason,
      spentUsd: period.spentUsd ?? live?.usd ?? 0,
      costByModel: period.costByModel ?? live?.byModel ?? {},
      sent: sent.slice(0, LOG_LIMIT).map(item),
      held: held.slice(0, LOG_LIMIT).map(item),
      results: results.slice(-LOG_LIMIT).map((r) => ({
        id: r.id,
        sessionName: name(r.sessionId) ?? "?",
        taskTitle: r.taskTitle,
        status: r.status,
        summary: r.summary,
        createdAt: r.createdAt,
      })),
    }
  }

  // ----------------------------------------------------------- entrar y salir

  /** Pone el proyecto en AFK. Si ya lo estaba, cambia el tiempo y el presupuesto (el período sigue). */
  start(projectId: string, input: AfkInput = {}): Project {
    const p = this.db.getProject(projectId)
    if (!p) throw new Error("El proyecto no existe")
    if (p.archivedAt) throw new Error("El proyecto está archivado")
    const until = input.until ?? null
    const budgetUsd = input.budgetUsd ?? null
    if (until !== null && (typeof until !== "number" || !Number.isFinite(until))) throw new Error("until tiene que ser una fecha (ms desde epoch) o null")
    if (until !== null && until <= now()) throw new Error("until ya pasó: elegí una hora futura o dejalo sin límite")
    if (budgetUsd !== null && (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0)) throw new Error("budgetUsd tiene que ser un número mayor que 0 (en US$) o null")
    if (p.afk) {
      const afk = { ...p.afk, until, budgetUsd }
      this.db.updateProject(p.id, { afk })
      this.db.updateOpenAfkPeriod(p.id, { until, budgetUsd })
      this.note(p.id, afkEnterNotice(afk))
    } else {
      const cost = this.db.projectCost(p.id)
      const afk: AfkState = { since: now(), until, budgetUsd, spentAtStart: cost.usd }
      this.db.updateProject(p.id, { afk })
      this.db.insertAfkPeriod({ projectId: p.id, since: afk.since, until, budgetUsd, spentAtStart: cost.usd, costByModelAtStart: cost.byModel })
      this.note(p.id, afkEnterNotice(afk))
    }
    this.arm(p.id)
    this.o.broadcastProject(p.id)
    return this.o.projectView(this.db.getProject(p.id)!)
  }

  /** Saca al proyecto de AFK. Devuelve null si no estaba. */
  stop(projectId: string, reason: AfkEndReason = "user"): Project | null {
    const p = this.db.getProject(projectId)
    if (!p?.afk) return null
    const period = this.db.lastAfkPeriod(projectId)
    const spent = this.spent(p, p.afk, period)
    this.db.closeAfkPeriod(projectId, { endedAt: now(), endReason: reason, spentUsd: spent.usd, costByModel: spent.byModel })
    this.db.updateProject(projectId, { afk: null })
    this.disarm(projectId)
    this.note(projectId, END_TEXT[reason].notice)
    // Un plan que aprobó el AFK no sigue gastando después de un tope: queda pausado hasta que vuelvas.
    if (reason !== "user") this.pausePlans(projectId, reason)
    this.o.broadcastProject(projectId)
    if (reason !== "user") {
      const orch = this.o.orchestratorOf(projectId)
      const waiting = this.db.listDrafts({ projectId, states: ["staged", "ready"] }).length
      this.hub.broadcast({
        type: "toast",
        level: "warn",
        // "needs_you": hay que volver a mirar el proyecto (y es el sonido de lo que te necesita).
        event: "needs_you",
        title: END_TEXT[reason].title,
        body: `${p.name}: ${waiting ? `${waiting} ${waiting === 1 ? "propuesta espera" : "propuestas esperan"} tu aprobación.` : END_TEXT[reason].body} Gastado: ${usd(spent.usd)}.`,
        projectId,
        ...(orch ? { sessionId: orch.id, ...(waiting ? { open: "proposals" as const } : {}) } : {}),
      })
    }
    return this.o.projectView(this.db.getProject(projectId)!)
  }

  /** Termina el AFK si se cumplió el tiempo o se gastó el presupuesto. */
  check(projectId: string) {
    const p = this.db.getProject(projectId)
    if (!p?.afk) return
    if (p.afk.until !== null && now() >= p.afk.until) return void this.stop(projectId, "until")
    if (p.afk.budgetUsd !== null && this.spent(p, p.afk).usd >= p.afk.budgetUsd) this.stop(projectId, "budget")
  }

  private checkAll() {
    for (const p of this.db.listAfkProjects()) this.check(p.id)
  }

  // ------------------------------------------------------------------ detalles

  private arm(projectId: string) {
    this.disarm(projectId)
    const until = this.db.getProject(projectId)?.afk?.until
    if (!until) return
    const t = setTimeout(() => {
      this.timers.delete(projectId)
      this.check(projectId)
      // Si falta más que lo que aguanta un temporizador, sigue contando.
      if (this.db.getProject(projectId)?.afk) this.arm(projectId)
    }, Math.min(MAX_TIMER_MS, Math.max(0, until - now())))
    t.unref()
    this.timers.set(projectId, t)
  }

  private disarm(projectId: string) {
    const t = this.timers.get(projectId)
    if (t) clearTimeout(t)
    this.timers.delete(projectId)
  }

  /** Un aviso en el chat de la orquestadora. */
  private note(projectId: string, text: string) {
    const orch = this.o.orchestratorOf(projectId)
    if (orch) this.sessions.addEvent(orch.id, { kind: "notice", level: "info", text })
  }

  private pausePlans(projectId: string, reason: AfkEndReason) {
    const why = reason === "budget" ? "se agotó el presupuesto del AFK" : "se cumplió el tiempo del AFK"
    for (const d of this.db.listDrafts({ projectId, states: ["sent"] })) {
      if (d.kind === "plan" && d.sentBy === "afk" && d.planState === "running") this.o.plans.pause(d.id, `Pausado: ${why}. Reanudalo cuando quieras.`, null)
    }
  }
}

/** a − b, solo lo positivo. */
function diffCosts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(a)) {
    const d = v - (b[k] ?? 0)
    if (d > 0.000001) out[k] = d
  }
  return out
}
