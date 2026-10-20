import { parseResetText, type LimitHit } from "./claude/limit-text.ts"
import type { RejectedWindow } from "./claude/normalize.ts"
import type { Db, HeldRow, SessionRecord, StoredSessionLimit } from "./db.ts"
import type { Hub } from "./hub.ts"
import type { Orchestration } from "./orchestration.ts"
import type { SendOptions, SessionManager } from "./sessions.ts"
import type { AccountLimit, AppSettings, HeldMessage, LimitKind, LimitSource, SessionLimit, StoredEvent, UserOrigin } from "./shared/types.ts"
import { errorMessage, now, oneLine, shortId } from "./util.ts"

/**
 * Cuando se acaba el uso (el límite de 5 horas, el semanal o el tope de gasto de un plan Team), el límite es de la
 * cuenta: mientras dura, el server no le manda nada a sus sesiones (cada intento es un turno que falla y gasta una
 * vuelta) y, cuando se renueva, las que se cortaron siguen solas.
 *
 * - Se reconoce por el error del fin de turno (ver claude/limit-text.ts); cuándo se renueva sale del reloj que informa
 *   el CLI (rate_limit_event), del texto ("resets 10pm" en su zona horaria) o, si nada sirve, de reintentar cada 15 min.
 * - Todo se guarda en la base (el límite de la cuenta, la marca de cada sesión cortada y lo retenido): si se cerró la
 *   app, al volver a abrirla se retoma lo que ya se renovó.
 * - Retiene los mensajes tuyos (y las propuestas que apruebes), los pasos de los planes y los lotes de la
 *   orquestadora; las sesiones cortadas reciben un mensaje de continuación, de a una.
 */

/** Se suma a la hora de renovación: el reloj del servidor y el nuestro no coinciden al segundo. */
export const RESUME_MARGIN_MS = 90_000
/** Sin saber cuándo se renueva: cada cuánto se vuelve a probar. */
export const RETRY_MS = 15 * 60_000
/** Revisa los vencimientos aunque no haya llegado ningún evento (la máquina se puede suspender y el temporizador llegar tarde). */
export const SWEEP_MS = 45_000
/** Entre una sesión que sigue y la próxima. */
export const CONTINUE_GAP_MS = 4_000
/** Para que las demás sesiones de la cuenta alcancen a frenarse antes de contar cuántas esperan. */
export const ANNOUNCE_MS = 2_500
/** setTimeout no acepta más de 2^31-1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1
const MAX_ATTEMPTS = 3
/** Después de mandarle algo a una sesión que seguía, cuánto se espera a ver si vuelve a cortarse (un rechazo de la API llega en segundos) antes de soltar el resto. */
export const PROBE_MS = 8_000
/** Una prueba a ciegas (sin saber cuándo se renueva) que no se vuelve a cortar en este tiempo se da por buena. */
const PROBE_GRACE_MS = 60_000
/** Un reloj que dice una renovación más lejana que esto para ese tipo de límite no es creíble: se prueba a los 15 min. */
const HORIZON_MS: Record<LimitKind, number> = {
  five_hour: 5 * 3_600_000 + 10 * 60_000,
  seven_day: 7 * 24 * 3_600_000 + 3_600_000,
  spend: 32 * 24 * 3_600_000,
  other: 8 * 24 * 3_600_000,
}
/** El reloj del CLI y el texto del error se dan por de acuerdo si difieren menos que esto. */
const AGREE_MS = 2 * 3_600_000

const KIND_LONG: Record<LimitKind, string> = { five_hour: "de 5 horas", seven_day: "semanal", spend: "de gasto", other: "de uso" }

/** "Se terminó el uso de 5 horas", "Se llegó al tope de gasto". */
export const headline = (kind: LimitKind): string =>
  kind === "five_hour" ? "Se terminó el uso de 5 horas" : kind === "seven_day" ? "Se terminó el uso semanal" : kind === "spend" ? "Se llegó al tope de gasto" : "Se llegó a un límite de uso"

/** Lo que se le pide a una sesión cuya tarea se cortó por el límite. Va como mensaje del sistema, no del usuario. */
export const limitContinuePrompt = (kind: LimitKind) =>
  `Se renovó tu límite de uso (${KIND_LONG[kind]}) y se había cortado tu turno. Revisá si quedó algo a medias y seguí con lo que estabas haciendo.`

/** Lo que frena un envío: el límite de la cuenta o, en un límite de un modelo, el de la sesión. */
export interface Blocked {
  kind: LimitKind
  resetsAt: number
  source: LimitSource
}

/** Se intentó mandarle algo a una sesión sin uso. */
export class LimitedError extends Error {
  blocked: Blocked
  constructor(blocked: Blocked) {
    super(`${headline(blocked.kind)}: no se manda nada hasta que se renueve, ${untilText(blocked.resetsAt)} (o tocá «Reintentar ahora»).`)
    this.name = "LimitedError"
    this.blocked = blocked
  }
}

const HOUR_FMT = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
const DAY_FMT = new Intl.DateTimeFormat("es-AR", { weekday: "short", day: "numeric", month: "short" })

/** "a las 22:00", o "el mié 22 oct a las 09:00" si no es hoy ni dentro de unas horas. */
export function whenText(ms: number, at = now()): string {
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date(at).toDateString()
  const soon = ms - at < 12 * 3_600_000 && ms > at
  return sameDay || soon ? `a las ${HOUR_FMT.format(d)}` : `el ${DAY_FMT.format(d)} a las ${HOUR_FMT.format(d)}`
}

/** "hasta las 22:00", o "hasta el mié 22 oct a las 09:00". */
export function untilText(ms: number, at = now()): string {
  return whenText(ms, at).replace(/^a las /, "hasta las ").replace(/^el /, "hasta el ")
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Lo que de SendOptions viaja a la base (el evento y el paso de plan no: esos no se retienen). */
interface HeldOpts {
  origin: UserOrigin
  draftId?: string
  draftTitle?: string
  display?: string
  subagents?: SendOptions["subagents"]
  clientId?: string
  attachmentIds?: string[]
}

interface Held {
  row: HeldRow
  opts: HeldOpts
}

export interface UsageLimitsDeps {
  db: Db
  hub: Hub
  sessions: SessionManager
  orchestration: Orchestration
  /** Para avisar a la web que cambió una cuenta. */
  broadcastAccount: (accountId: string) => void
  accountName: (accountId: string) => string
  clock?: () => number
  sweepMs?: number
  gapMs?: number
  announceMs?: number
  /** Se suma a la hora de renovación (RESUME_MARGIN_MS). */
  marginMs?: number
  /** Sin saber cuándo se renueva: cada cuánto se vuelve a probar (RETRY_MS). */
  retryMs?: number
  /** Cuánto se espera a ver si lo que se mandó al renovarse vuelve a cortarse (PROBE_MS). */
  probeMs?: number
}

export class UsageLimits {
  private db: Db
  private hub: Hub
  private sessions: SessionManager
  private o: Orchestration
  private broadcastAccount: (accountId: string) => void
  private accountName: (accountId: string) => string
  private clock: () => number
  private sweepMs: number
  private gapMs: number
  private announceMs: number
  private marginMs: number
  private retryMs: number
  private probeMs: number
  private limits = new Map<string, AccountLimit>()
  private held = new Map<string, Held[]>()
  private timer: NodeJS.Timeout | null = null
  private sweep: NodeJS.Timeout | null = null
  private announcing = new Map<string, NodeJS.Timeout>()
  /** Sesiones que esperan su mensaje de continuación, en orden, y cuentas cuya retención hay que liberar. */
  private queue: string[] = []
  private toRelease: string[] = []
  private attempts = new Map<string, number>()
  private running: Promise<void> | null = null
  private ticking = false
  /** Sesiones a las que se les está pidiendo que sigan, y las que se detuvieron o archivaron en el medio. */
  private continuing = new Set<string>()
  private cancelled = new Set<string>()
  /** Mensajes en espera que se están mandando (sesión → el id del que va), para no mandar dos veces ni cancelar uno que ya salió. */
  private sendingHeld = new Map<string, string | null>()
  private heldAttempts = new Map<string, number>()
  /** Cuentas que se volvieron a probar a ciegas: si se vuelven a cortar es la misma tanda (un solo aviso y un solo lapso anotado). */
  private probing = new Map<string, { since: number; at: number }>()
  private disposed = false

  constructor(deps: UsageLimitsDeps) {
    this.db = deps.db
    this.hub = deps.hub
    this.sessions = deps.sessions
    this.o = deps.orchestration
    this.broadcastAccount = deps.broadcastAccount
    this.accountName = deps.accountName
    this.clock = deps.clock ?? now
    this.sweepMs = deps.sweepMs ?? SWEEP_MS
    this.gapMs = deps.gapMs ?? CONTINUE_GAP_MS
    this.announceMs = deps.announceMs ?? ANNOUNCE_MS
    this.marginMs = deps.marginMs ?? RESUME_MARGIN_MS
    this.retryMs = deps.retryMs ?? RETRY_MS
    this.probeMs = deps.probeMs ?? PROBE_MS
    for (const { accountId, ...l } of this.db.listAccountLimits()) this.limits.set(accountId, l)
    for (const row of this.db.listHeld()) {
      try {
        const list = this.held.get(row.sessionId) ?? []
        list.push({ row, opts: JSON.parse(row.opts) as HeldOpts })
        this.held.set(row.sessionId, list)
      } catch {
        this.db.deleteHeld(row.id)
      }
    }
    this.sessions.limits = this
  }

  /** Arranca los temporizadores y mira qué ya se renovó (al levantar el server: la app pudo estar cerrada). */
  start() {
    this.sweep = setInterval(() => this.safeTick(), this.sweepMs)
    this.sweep.unref()
    this.safeTick()
  }

  private safeTick() {
    this.tick().catch((err) => console.error(`No pude revisar el límite de uso: ${errorMessage(err)}`))
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.sweep) clearInterval(this.sweep)
    for (const t of this.announcing.values()) clearTimeout(t)
    this.announcing.clear()
    this.timer = this.sweep = null
  }

  // ---------------------------------------------------------------- ajustes

  settings(): AppSettings {
    return { resumeOnRenewal: this.db.getSetting("resumeOnRenewal") !== "0" }
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    if (typeof patch.resumeOnRenewal === "boolean") this.db.setSetting("resumeOnRenewal", patch.resumeOnRenewal ? "1" : "0")
    const settings = this.settings()
    this.hub.broadcast({ type: "settings", settings })
    // Lo que cambia de cada sesión cortada: si sigue sola o no.
    for (const rec of this.db.listLimitedSessions()) this.sessions.touch(rec.id)
    return settings
  }

  // ---------------------------------------------------------------- consultas

  /** Cuándo se vuelve a mandar: la renovación más el margen (si se sabe; un reintento a ciegas no lo necesita). */
  private resumeAt(l: { resetsAt: number; source: LimitSource }) {
    return l.resetsAt + (l.source === "fallback" ? 0 : this.marginMs)
  }

  accountLimit(accountId: string): AccountLimit | null {
    return this.limits.get(accountId) ?? null
  }

  /** Lo que frena a esa sesión: el límite de su cuenta o, en un límite de un modelo, el suyo. null: se le puede escribir. */
  blocking(rec: SessionRecord): Blocked | null {
    const account = this.limits.get(this.sessions.accountOf(rec))
    if (account) return account
    const own = rec.limited
    if (own && own.kind === "other" && this.clock() < this.resumeAt(own)) return own
    return null
  }

  /** El límite visto desde la sesión (para el Session que ve la web). */
  sessionView(rec: SessionRecord): SessionLimit | null {
    const account = this.limits.get(this.sessions.accountOf(rec))
    const own = rec.limited ?? null
    const base = account ?? (own && own.kind === "other" && this.clock() < this.resumeAt(own) ? own : null)
    if (!base) return null
    const interrupted = own?.interrupted ?? false
    return {
      kind: base.kind,
      resetsAt: base.resetsAt,
      source: base.source,
      since: "since" in base ? base.since : this.clock(),
      interrupted,
      willResume: interrupted && this.settings().resumeOnRenewal,
    }
  }

  heldFor(sessionId: string): HeldMessage[] {
    return (this.held.get(sessionId) ?? []).map(({ row, opts }) => ({
      id: row.id,
      sessionId: row.sessionId,
      text: opts.display ?? row.text,
      origin: opts.origin,
      draftTitle: opts.draftTitle ?? null,
      attachments: opts.attachmentIds?.length ?? 0,
      createdAt: row.createdAt,
    }))
  }

  /** Cuántas sesiones de la cuenta esperan (cortadas o con algo retenido): para el aviso. */
  private waitingOf(accountId: string): string[] {
    const ids = new Set<string>()
    for (const rec of this.db.listLimitedSessions()) if (this.sessions.accountOf(rec) === accountId && rec.limited?.kind !== "other") ids.add(rec.id)
    for (const sessionId of this.held.keys()) {
      const rec = this.db.getSession(sessionId)
      if (rec && !rec.archivedAt && this.sessions.accountOf(rec) === accountId) ids.add(sessionId)
    }
    return [...ids]
  }

  // ---------------------------------------------------------------- detectar

  /**
   * Un turno terminó porque se acabó el uso. `rejected` es lo que el CLI marcó como rechazado en ese turno
   * (rate_limit_event con status "rejected"), que sirve de reloj y, si el texto no se reconoció, de señal.
   */
  hit(rec: SessionRecord, accountId: string, hit: LimitHit, rejected: RejectedWindow | null) {
    if (this.disposed) return
    const t = this.clock()
    const { resetsAt, source } = this.resolveReset(accountId, hit, rejected, t)
    const prevOwn = this.db.getSession(rec.id)?.limited ?? null

    if (hit.kind === "other") {
      // Un límite de un modelo no frena a la cuenta: solo a esta sesión.
      const own: StoredSessionLimit = { kind: "other", resetsAt, source, since: prevOwn?.kind === "other" ? prevOwn.since : t, interrupted: prevOwn?.kind === "other" && prevOwn.interrupted === false ? false : true }
      this.markSession(rec, own, prevOwn === null || prevOwn.kind !== "other")
      this.arm()
      return
    }

    const prev = this.limits.get(accountId)
    // Una prueba a ciegas que vuelve a cortarse sigue siendo la misma tanda (no un aviso nuevo cada 15 minutos).
    const probe = !prev ? this.probing.get(accountId) : undefined
    this.probing.delete(accountId)
    const candidate: AccountLimit = { kind: hit.kind, resetsAt, source, message: hit.message, since: prev?.since ?? probe?.since ?? t }
    let next = candidate
    if (prev) {
      // Otro corte de la misma tanda (o el semanal después del de 5 h): manda el más lejano, y una renovación que se sabe le gana a una prueba a ciegas.
      const known = (l: AccountLimit) => l.source !== "fallback"
      if (known(prev) && !known(candidate)) next = prev
      else if (!known(prev) && known(candidate)) next = candidate
      else next = candidate.resetsAt >= prev.resetsAt ? candidate : prev
      next = { ...next, since: prev.since }
    }
    this.limits.set(accountId, next)
    this.db.setAccountLimit(accountId, next)
    if (!prev && !probe) this.db.openLimitWait(accountId, next.kind, next.since)
    else if (prev ? prev.kind !== next.kind : probe) this.db.updateOpenLimitWait(accountId, next.kind)
    // La marca queda con la renovación de la cuenta: es la que decide cuándo sigue.
    const own: StoredSessionLimit = {
      kind: next.kind,
      resetsAt: next.resetsAt,
      source: next.source,
      since: next.since,
      interrupted: prevOwn && prevOwn.since === next.since && prevOwn.interrupted === false ? false : true,
    }
    this.markSession(rec, own, !probe && (!prevOwn || prevOwn.since !== next.since))
    this.broadcastAccount(accountId)
    if (!prev && !probe) this.announceLater(accountId)
    this.arm()
  }

  /** Cuándo se renueva: el reloj del CLI, si no el texto del error y, si nada sirve, probar en 15 minutos. */
  resolveReset(accountId: string, hit: LimitHit, rejected: RejectedWindow | null, t: number): { resetsAt: number; source: LimitSource } {
    const valid = (n: number | null): n is number => n !== null && n > t && n - t <= HORIZON_MS[hit.kind]
    const usage = this.sessions.usageFor(accountId)
    let clockMs: number | null = rejected && (rejected.kind === hit.kind || hit.kind === "other") ? rejected.resetsAt : null
    if (!valid(clockMs)) {
      const w = hit.kind === "five_hour" ? usage?.fiveHour : hit.kind === "seven_day" || hit.kind === "spend" ? usage?.sevenDay : null
      clockMs = w && w.resetsAt > 0 ? w.resetsAt : null
    }
    const text = parseResetText(hit.resetText, t)
    if (valid(clockMs) && (!valid(text) || Math.abs(clockMs - text) <= AGREE_MS)) return { resetsAt: clockMs, source: "event" }
    if (valid(text)) return { resetsAt: text, source: "text" }
    return { resetsAt: t + this.retryMs, source: "fallback" }
  }

  private markSession(rec: SessionRecord, limited: StoredSessionLimit, first: boolean) {
    this.sessions.update(rec.id, { limited })
    if (!first) return
    const willResume = limited.interrupted && this.settings().resumeOnRenewal
    const when = limited.source === "fallback" ? `no se sabe cuándo se renueva: reintenta a las ${HOUR_FMT.format(new Date(limited.resetsAt))}` : untilText(limited.resetsAt, this.clock())
    this.sessions.addEvent(rec.id, {
      kind: "notice",
      level: "info",
      text: `${headline(limited.kind)}. ${willResume ? "control-plane la retoma sola cuando se renueve" : "Espera a que se renueve"} (${when}).`,
    })
  }

  /** Un aviso por tanda (no uno por sesión): con la cuenta, cuántas esperan y hasta cuándo. */
  private announceLater(accountId: string) {
    const timer = setTimeout(() => {
      this.announcing.delete(accountId)
      const l = this.limits.get(accountId)
      if (!l || this.disposed) return
      const waiting = this.waitingOf(accountId)
      const n = waiting.length
      const resume = this.settings().resumeOnRenewal && waiting.some((id) => this.db.getSession(id)?.limited?.interrupted)
      const title = `${headline(l.kind)} de la cuenta ${this.accountName(accountId)}`
      const until = l.source === "fallback" ? `las ${HOUR_FMT.format(new Date(l.resetsAt))}` : untilText(l.resetsAt, this.clock()).replace(/^hasta /, "")
      const body =
        n > 0
          ? `${n} ${n === 1 ? "sesión espera" : "sesiones esperan"} hasta ${until}${resume ? ` y ${n === 1 ? "sigue sola" : "siguen solas"}` : ""}.`
          : `${l.source === "fallback" ? "Reintenta" : "Se renueva"} ${l.source === "fallback" ? `a ${until}` : whenText(l.resetsAt, this.clock())}.`
      this.hub.broadcast({
        type: "toast",
        level: "info",
        title,
        body: l.kind === "spend" ? `${body} Si subís el tope, tocá «Reintentar ahora».` : body,
      })
    }, this.announceMs)
    timer.unref()
    this.announcing.set(accountId, timer)
  }

  // ---------------------------------------------------------------- retener mensajes

  /**
   * Como SessionManager.send, pero si la cuenta está sin uso deja el mensaje en espera (sale solo cuando se renueve) en
   * vez de fallar: para lo que escribe el usuario y las propuestas que aprueba.
   */
  async sendOrHold(id: string, text: string, opts: SendOptions): Promise<{ event: StoredEvent } | { held: HeldMessage; note: string }> {
    const rec = this.db.getSession(id)
    if (opts.clientId) {
      // Un reintento de algo que ya salió (se cortó la respuesta): no se retiene ni se manda de nuevo.
      const sent = this.sessions.sentByClientId(id, opts.clientId)
      if (sent) return { event: sent }
    }
    if (rec && this.sessions.blockedFor(id, text, opts)) return { held: this.hold(id, text, opts), note: this.heldNote(rec) }
    // Ya se renovó, pero todavía quedan mensajes en espera: este sale después de ellos, en orden.
    if (rec && !opts.bypassLimit && this.held.has(id)) {
      const held = this.hold(id, text, opts)
      void this.sendHeld(id)
      return { held, note: "Sale en un momento, después de los que estaban en espera." }
    }
    return { event: await this.sessions.send(id, text, opts) }
  }

  /** La sesión se cortó por el límite de uso (o su cuenta está sin uso): se retoma sola cuando se renueve. */
  cutByLimit(id: string): boolean {
    const rec = this.db.getSession(id)
    return Boolean(rec && (rec.limited?.interrupted || this.blocking(rec)))
  }

  /** Lo que la cuenta del proyecto esperó el uso en un período (para el registro del AFK). */
  waitsFor(projectId: string, from: number, to: number): { kind: LimitKind; since: number; endedAt: number | null }[] {
    const any = this.db.listSessions().find((x) => x.projectId === projectId)
    if (!any) return []
    return this.db.listLimitWaits(this.sessions.accountOf(any), from, to).map((w) => ({ kind: w.kind, since: w.since, endedAt: w.endedAt }))
  }

  /** Guarda un mensaje para mandarlo cuando se renueve el uso. Un reintento con el mismo clientId no lo duplica. */
  hold(sessionId: string, text: string, opts: SendOptions): HeldMessage {
    if (opts.clientId) {
      const dup = (this.held.get(sessionId) ?? []).find((h) => h.opts.clientId === opts.clientId)
      if (dup) return this.heldFor(sessionId).find((h) => h.id === dup.row.id)!
    }
    const kept: HeldOpts = {
      origin: opts.origin,
      ...(opts.draftId ? { draftId: opts.draftId } : {}),
      ...(opts.draftTitle ? { draftTitle: opts.draftTitle } : {}),
      ...(opts.display !== undefined ? { display: opts.display } : {}),
      ...(opts.subagents?.length ? { subagents: opts.subagents } : {}),
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      ...(opts.attachments?.length ? { attachmentIds: opts.attachments.map((a) => a.id) } : {}),
    }
    const row: HeldRow = { id: shortId("h_"), sessionId, text, opts: JSON.stringify(kept), createdAt: this.clock() }
    this.db.insertHeld(row)
    const list = this.held.get(sessionId) ?? []
    list.push({ row, opts: kept })
    this.held.set(sessionId, list)
    this.sessions.touch(sessionId)
    return this.heldFor(sessionId).at(-1)!
  }

  cancelHeld(sessionId: string, heldId: string) {
    const list = this.held.get(sessionId) ?? []
    const i = list.findIndex((h) => h.row.id === heldId)
    if (i < 0) throw new Error("Ese mensaje ya no está en espera")
    if (this.sendingHeld.get(sessionId) === heldId) throw new Error("Ese mensaje ya se está enviando")
    this.db.deleteHeld(heldId)
    list.splice(i, 1)
    if (!list.length) this.held.delete(sessionId)
    this.sessions.touch(sessionId)
  }

  /** Cuándo se manda lo retenido (el texto que ve quien escribió). */
  heldNote(rec: SessionRecord): string {
    const b = this.blocking(rec)
    return b ? `Queda en espera: se envía cuando se renueve el uso, ${whenText(b.resetsAt, this.clock())}.` : "Queda en espera."
  }

  // ---------------------------------------------------------------- retomar

  private resumeTimes(): number[] {
    const times = [...this.limits.values()].map((l) => this.resumeAt(l))
    for (const rec of this.db.listLimitedSessions()) if (rec.limited?.kind === "other") times.push(this.resumeAt(rec.limited))
    return times
  }

  /** Programa el temporizador hasta la próxima renovación (el barrido cubre lo que se atrase). */
  private arm() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.disposed) return
    const times = this.resumeTimes()
    if (!times.length) return
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, Math.min(...times) - this.clock()))
    this.timer = setTimeout(() => this.safeTick(), wait)
    this.timer.unref()
  }

  /** Lo que venció: libera las cuentas que se renovaron y encola a las sesiones cortadas que ya pueden seguir. */
  async tick() {
    if (this.disposed || this.ticking) return
    this.ticking = true
    try {
      const t = this.clock()
      for (const [accountId, l] of [...this.limits]) if (t >= this.resumeAt(l)) this.release(accountId)
      for (const rec of this.db.listLimitedSessions()) {
        const own = rec.limited!
        if (this.blocking(rec) || (own.kind === "other" && t < this.resumeAt(own))) continue
        this.enqueue(rec.id)
      }
      // Una prueba a ciegas que no se volvió a cortar en un rato funcionó: el lapso sin uso terminó cuando se probó.
      for (const [accountId, p] of [...this.probing]) {
        if (this.limits.has(accountId) || t - p.at < PROBE_GRACE_MS) continue
        this.probing.delete(accountId)
        this.db.closeLimitWait(accountId, p.at)
        this.hub.broadcast({ type: "toast", level: "info", title: `Volvió el uso de la cuenta ${this.accountName(accountId)}` })
      }
      // Lo retenido de una cuenta que ya no está sin uso (por ejemplo, un envío que falló al liberarlo) sale en este barrido.
      for (const sessionId of this.held.keys()) {
        const rec = this.db.getSession(sessionId)
        if (!rec || rec.archivedAt || this.blocking(rec)) continue
        const accountId = this.sessions.accountOf(rec)
        if (!this.toRelease.includes(accountId)) this.toRelease.push(accountId)
      }
      this.kick()
    } finally {
      this.ticking = false
      this.arm()
    }
  }

  /** Se renovó el uso de la cuenta (o lo pidió el usuario con «Reintentar ahora»): sale lo que estaba retenido. */
  private release(accountId: string, manual = false) {
    const l = this.limits.get(accountId)
    if (!l) return
    this.limits.delete(accountId)
    this.db.setAccountLimit(accountId, null)
    // Una prueba a ciegas no cierra el lapso ni avisa: si funciona se da por terminado más tarde (ver tick).
    const blind = l.source === "fallback" && !manual
    if (blind) this.probing.set(accountId, { since: l.since, at: this.clock() })
    else this.db.closeLimitWait(accountId, this.clock())
    const timer = this.announcing.get(accountId)
    if (timer) clearTimeout(timer)
    this.announcing.delete(accountId)
    this.broadcastAccount(accountId)
    const resume = this.settings().resumeOnRenewal
    const ids = this.db
      .listLimitedSessions()
      .filter((rec) => this.sessions.accountOf(rec) === accountId && rec.limited!.kind !== "other")
      .map((rec) => rec.id)
    const continuing = ids.filter((id) => resume && this.db.getSession(id)?.limited?.interrupted)
    for (const id of ids) this.enqueue(id)
    this.toRelease.push(accountId)
    const waiting = new Set([...ids, ...this.waitingOf(accountId)]).size
    if (!blind)
      this.hub.broadcast({
        type: "toast",
        level: "info",
        title: `${manual ? "Se volvió a probar" : "Se renovó"} el uso de la cuenta ${this.accountName(accountId)}`,
        body: continuing.length ? `Siguieron ${continuing.length} ${continuing.length === 1 ? "sesión" : "sesiones"}.` : waiting ? "Sale lo que estaba en espera." : undefined,
      })
    this.kick()
  }

  private enqueue(sessionId: string) {
    if (!this.queue.includes(sessionId)) this.queue.push(sessionId)
  }

  /** Procesa la cola de a una (con una pausa entre sesiones) y después libera lo retenido, de a una cuenta. */
  private kick() {
    if (this.running || this.disposed) return
    if (!this.queue.length && !this.toRelease.length) return
    this.running = (async () => {
      // A qué sesión se le pidió seguir por última vez en cada cuenta: es la prueba de que ya hay uso.
      const probes = new Map<string, string>()
      while (this.queue.length && !this.disposed) {
        const id = this.queue.shift()!
        const did = await this.continueSession(id)
        const rec = this.db.getSession(id)
        if (did && rec) probes.set(this.sessions.accountOf(rec), id)
        if (this.queue.length && did) await sleep(this.gapMs)
      }
      while (this.toRelease.length && !this.disposed) {
        const accountId = this.toRelease.shift()!
        await this.releaseHeld(accountId, probes.get(accountId) ?? null)
      }
    })()
      .catch((err) => console.error(`No pude retomar lo que esperaba el uso: ${errorMessage(err)}`))
      .finally(() => {
        this.running = null
        if (this.queue.length || this.toRelease.length) this.kick()
      })
  }

  /** Le pide a una sesión cortada que siga. Devuelve si le mandó algo. */
  private async continueSession(id: string, force = false): Promise<boolean> {
    const rec = this.db.getSession(id)
    const limited = rec?.limited
    if (!rec || rec.archivedAt || !limited) return false
    if (!force && this.blocking(rec)) return false
    const resume = limited.interrupted && (force || this.settings().resumeOnRenewal)
    // Una propuesta aprobada mientras esperaba es una tarea nueva: lo que estaba a medias no se retoma.
    const superseded = (this.held.get(id) ?? []).some((h) => h.opts.origin === "draft")
    if (!resume || superseded) {
      this.sessions.update(id, { limited: null })
      // Se queda sin quien siga el paso de un plan o la revisión que traía: se avisa en lugar de esperar para siempre.
      if (!superseded && limited.interrupted) this.o.onResumeSkipped(id, "Se renovó el uso, pero «Retomar solas» está apagado")
      this.o.onSessionLimitCleared(id)
      return false
    }
    // Se limpia antes de mandar: si el turno vuelve a cortarse, hit() la marca de nuevo.
    this.sessions.update(id, { limited: null })
    this.continuing.add(id)
    try {
      await this.sessions.start(id)
      // Se detuvo o se archivó mientras arrancaba: no se la sigue.
      if (this.cancelled.has(id) || this.db.getSession(id)?.archivedAt) return false
      await this.sessions.send(id, limitContinuePrompt(limited.kind), {
        origin: "control",
        bypassLimit: force,
        event: { kind: "notice", level: "info", text: `Se renovó el uso ${KIND_LONG[limited.kind]}: se le pidió que revise lo que quedó a medias y siga.` },
      })
      this.attempts.delete(id)
      this.o.onSessionLimitCleared(id)
      return true
    } catch (err) {
      if (this.cancelled.has(id) || this.db.getSession(id)?.archivedAt) return false
      if (err instanceof LimitedError) {
        this.sessions.update(id, { limited })
        return false
      }
      const n = (this.attempts.get(id) ?? 0) + 1
      this.attempts.set(id, n)
      if (n < MAX_ATTEMPTS) {
        // Sigue marcada: el próximo barrido lo vuelve a intentar.
        this.sessions.update(id, { limited })
        return false
      }
      this.attempts.delete(id)
      this.sessions.update(id, { limited: { ...limited, interrupted: false } })
      this.sessions.addEvent(id, {
        kind: "notice",
        level: "error",
        text: `Se renovó el uso, pero no se pudo retomar esta sesión: ${oneLine(errorMessage(err), 300)}. Pedile que siga desde acá.`,
      })
      this.o.onResumeSkipped(id, "Se renovó el uso, pero la sesión no se pudo retomar")
      return false
    } finally {
      this.continuing.delete(id)
      this.cancelled.delete(id)
    }
  }

  /**
   * Lo retenido de la cuenta, en orden: pasos de planes, lotes de la orquestadora y mensajes tuyos. Antes se mira si
   * lo que se mandó para seguir vuelve a cortarse (con otra renovación pendiente, o si el reloj estaba mal): si es así,
   * no se suelta nada más. Si nadie seguía, el primer mensaje en espera hace de prueba.
   */
  private async releaseHeld(accountId: string, probed: string | null) {
    let probe = probed
    if (!probe) {
      const first = this.oldestHeld(accountId)
      if (first) {
        await this.sendHeld(first, false, true)
        probe = first
      }
    }
    if (probe) await this.settle(accountId)
    if (this.limits.has(accountId) || this.disposed) return
    this.o.onLimitCleared(accountId)
    for (const [sessionId, list] of [...this.held]) {
      const rec = this.db.getSession(sessionId)
      if (!rec) {
        for (const h of list) this.db.deleteHeld(h.row.id)
        this.held.delete(sessionId)
        continue
      }
      if (this.sessions.accountOf(rec) !== accountId) continue
      await this.sendHeld(sessionId)
    }
  }

  /** La sesión con el mensaje en espera más viejo de la cuenta (y que se le puede mandar). */
  private oldestHeld(accountId: string): string | null {
    let best: { id: string; at: number } | null = null
    for (const [sessionId, list] of this.held) {
      const rec = this.db.getSession(sessionId)
      if (!rec || rec.archivedAt || this.sessions.accountOf(rec) !== accountId || this.blocking(rec) || !list.length) continue
      if (!best || list[0]!.row.createdAt < best.at) best = { id: sessionId, at: list[0]!.row.createdAt }
    }
    return best?.id ?? null
  }

  /** Espera un rato a ver si la cuenta vuelve a quedar sin uso (el rechazo de la API llega en segundos). */
  private async settle(accountId: string) {
    const end = this.clock() + this.probeMs
    while (this.clock() < end && !this.limits.has(accountId) && !this.disposed) await sleep(Math.min(50, this.probeMs))
  }

  /** Manda los mensajes en espera de una sesión, en orden y de a uno (con `one`, solo el primero). */
  private async sendHeld(sessionId: string, force = false, one = false) {
    // Si ya se están mandando (el barrido, «Reintentar ahora», la renovación), esa tanda sigue: no se duplica ni se saltea ninguno.
    if (this.sendingHeld.has(sessionId)) return
    this.sendingHeld.set(sessionId, null)
    try {
      const list = this.held.get(sessionId) ?? []
      while (list.length) {
        const rec = this.db.getSession(sessionId)
        if (!rec || rec.archivedAt) break
        if (!force && this.blocking(rec)) return
        const h = list[0]!
        this.sendingHeld.set(sessionId, h.row.id)
        const files = (h.opts.attachmentIds ?? []).map((id) => this.db.getAttachment(id)).filter((a): a is NonNullable<typeof a> => a !== null)
        try {
          await this.sessions.send(sessionId, h.row.text, {
            origin: h.opts.origin,
            bypassLimit: force,
            ...(h.opts.draftId ? { draftId: h.opts.draftId } : {}),
            ...(h.opts.draftTitle ? { draftTitle: h.opts.draftTitle } : {}),
            ...(h.opts.display !== undefined ? { display: h.opts.display } : {}),
            ...(h.opts.subagents ? { subagents: h.opts.subagents } : {}),
            ...(h.opts.clientId ? { clientId: h.opts.clientId } : {}),
            ...(files.length ? { attachments: files } : {}),
          })
        } catch (err) {
          // Sin uso otra vez: queda en espera.
          if (err instanceof LimitedError) return
          // Otro motivo (la conversación está abierta en una terminal, el proceso se cerró): se reintenta unas veces y después se avisa.
          const n = (this.heldAttempts.get(h.row.id) ?? 0) + 1
          this.heldAttempts.set(h.row.id, n)
          if (n < MAX_ATTEMPTS) return
          this.heldAttempts.delete(h.row.id)
          this.db.deleteHeld(h.row.id)
          list.shift()
          this.sessions.addEvent(sessionId, {
            kind: "notice",
            level: "error",
            text: `No se pudo mandar un mensaje que estaba en espera por el uso: ${oneLine(errorMessage(err), 300)}. Era: «${oneLine(h.opts.display ?? h.row.text, 200)}».`,
          })
          continue
        }
        this.heldAttempts.delete(h.row.id)
        this.db.deleteHeld(h.row.id)
        // El que salió es el primero de la lista (nadie más la toca: se cancela solo lo que no está en vuelo).
        const i = list.indexOf(h)
        if (i >= 0) list.splice(i, 1)
        if (one) break
      }
      if (!list.length) this.held.delete(sessionId)
    } finally {
      this.sendingHeld.delete(sessionId)
      this.sessions.touch(sessionId)
    }
  }

  // ---------------------------------------------------------------- acciones del usuario

  /** «Reintentar ahora» en una cuenta: da el límite por renovado (por ejemplo, si subiste el tope de gasto). */
  retryAccount(accountId: string) {
    if (!this.limits.has(accountId)) throw new Error("La cuenta no está sin uso")
    this.release(accountId, true)
  }

  /** «Reintentar ahora» en una sesión: sigue o manda lo que tenía en espera sin esperar a la cuenta. Si todavía no hay uso, se vuelve a frenar. */
  async retrySession(sessionId: string) {
    const rec = this.db.getSession(sessionId)
    if (!rec) throw new Error("La sesión no existe")
    if (!this.blocking(rec) && !rec.limited && !this.held.has(sessionId)) throw new Error("La sesión no está sin uso")
    await this.continueSession(sessionId, true)
    await this.sendHeld(sessionId, true)
  }

  /** «No retomar»: cancela la continuación de esta sesión (con enabled en true, la vuelve a pedir). */
  setResume(sessionId: string, enabled: boolean) {
    const rec = this.db.getSession(sessionId)
    if (!rec?.limited) throw new Error("La sesión no está sin uso")
    this.sessions.update(sessionId, { limited: { ...rec.limited, interrupted: enabled } })
    if (!enabled) this.o.onResumeSkipped(sessionId, "Pediste que la sesión no siga sola cuando se renueve el uso")
  }

  /** La sesión se detuvo a mano: no se la vuelve a lanzar sola. */
  onStoppedByUser(sessionId: string) {
    const rec = this.db.getSession(sessionId)
    if (!rec) return
    if (this.continuing.has(sessionId)) this.cancelled.add(sessionId)
    const cut = this.cutByLimit(sessionId)
    if (rec.limited?.interrupted) this.sessions.update(sessionId, { limited: { ...rec.limited, interrupted: false } })
    if (cut) this.o.onResumeSkipped(sessionId, "Detuviste la sesión mientras esperaba que se renueve el uso")
  }

  /**
   * Una sesión que tenía trabajo en curso cuando la cuenta se frenó (se estaba reiniciando, o era el paso de un plan):
   * queda marcada para que siga cuando se renueve. false si no hacía falta.
   */
  adopt(sessionId: string): boolean {
    const rec = this.db.getSession(sessionId)
    const account = rec ? this.limits.get(this.sessions.accountOf(rec)) : undefined
    if (!rec || rec.archivedAt || rec.limited || !account) return false
    this.sessions.update(sessionId, { limited: { kind: account.kind, resetsAt: account.resetsAt, source: account.source, since: account.since, interrupted: true } })
    return true
  }

  onArchived(sessionId: string) {
    if (this.continuing.has(sessionId)) this.cancelled.add(sessionId)
    this.queue = this.queue.filter((id) => id !== sessionId)
    for (const h of this.held.get(sessionId) ?? []) this.db.deleteHeld(h.row.id)
    this.held.delete(sessionId)
    if (this.db.getSession(sessionId)?.limited) this.db.updateSession(sessionId, { limited: null })
  }
}
