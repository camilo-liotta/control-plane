import fs from "node:fs"
import path from "node:path"

import { describeCron, isPinned, isValidCron, nextRun } from "./cron.ts"
import type { ScheduledItem, StoredEvent, TimelineEvent } from "./shared/types.ts"

/** Claude Code borra solos los crons recurrentes a los 7 días (salvo los "permanent"). */
export const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Cuánto de lo que ya no está activo se sigue mostrando. */
const HISTORY_MS = 24 * 60 * 60 * 1000
const MAX_ITEMS = 20

export const SCHEDULE_TOOLS = ["CronCreate", "CronDelete", "ScheduleWakeup", "RemoteTrigger"]
const TOOLS = new Set(SCHEDULE_TOOLS)

interface Item {
  id: string
  kind: ScheduledItem["kind"]
  cron: string | null
  human: string | null
  prompt: string
  reason: string | null
  recurring: boolean
  durable: boolean
  permanent: boolean
  createdAt: number
  /** Los wakeups: cuándo vuelve. */
  at: number | null
  lastFiredAt: number | null
  fires: number
  cancelledAt: number | null
  doneAt: number | null
}

interface State {
  items: Map<string, Item>
  /** tool_use que todavía esperan su resultado. */
  uses: Map<string, { name: string; input: Record<string, unknown>; ts: number }>
}

/** Una tarea de `.claude/scheduled_tasks.json` (lo que escribe Claude Code para los crons durables). */
export interface DurableTask {
  id: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  recurring?: boolean
  permanent?: boolean
  createdBySessionId?: string
}

const str = (v: unknown) => (typeof v === "string" ? v : "")
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Lee `.claude/scheduled_tasks.json` de una carpeta: `{ tasks: [...] }`. Lo inválido se saltea. */
export function readDurable(dir: string): DurableTask[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "scheduled_tasks.json"), "utf8"))
  } catch {
    return null
  }
  const tasks = Array.isArray(obj(raw).tasks) ? (obj(raw).tasks as unknown[]) : []
  return tasks
    .map(obj)
    .filter((t) => typeof t.id === "string" && typeof t.cron === "string" && typeof t.prompt === "string" && typeof t.createdAt === "number")
    .map((t) => ({
      id: t.id as string,
      cron: t.cron as string,
      prompt: t.prompt as string,
      createdAt: t.createdAt as number,
      ...(typeof t.lastFiredAt === "number" ? { lastFiredAt: t.lastFiredAt } : {}),
      ...(t.recurring === true ? { recurring: true } : {}),
      ...(t.permanent === true ? { permanent: true } : {}),
      ...(typeof t.createdBySessionId === "string" ? { createdBySessionId: t.createdBySessionId } : {}),
    }))
}

/** El id de un job en el texto del resultado ("Scheduled recurring job 1a2b3c4d (…)"). */
const jobIdOf = (text: string) => /\bjob ([0-9a-f]{6,})\b/i.exec(text)?.[1] ?? null

/**
 * Lleva la cuenta de lo que programó cada sesión a partir de sus eventos: el `tool_use` de
 * `CronCreate`/`CronDelete`/`ScheduleWakeup`/`RemoteTrigger`, su resultado y los disparos (el prompt
 * que vuelve como mensaje de usuario). Se arma de la base la primera vez y después se actualiza en vivo.
 */
export class Schedules {
  private states = new Map<string, State>()
  private durableCache = new Map<string, { at: number; tasks: DurableTask[] | null }>()
  private load: (sessionId: string) => StoredEvent[]
  private clock: () => number

  constructor({ load, now = Date.now }: { load: (sessionId: string) => StoredEvent[]; now?: () => number }) {
    this.load = load
    this.clock = now
  }

  private state(sessionId: string): State {
    let st = this.states.get(sessionId)
    if (!st) {
      st = { items: new Map(), uses: new Map() }
      this.states.set(sessionId, st)
      for (const ev of this.load(sessionId)) this.apply(st, ev)
    }
    return st
  }

  /** Un evento nuevo de la sesión. Devuelve true si cambió lo programado. */
  observe(ev: StoredEvent): boolean {
    if (!this.states.has(ev.sessionId)) {
      // Todavía no se armó: se arma con todo lo que hay en la base (que ya incluye este evento).
      if (!relevant(ev.event)) return false
      this.state(ev.sessionId)
      return true
    }
    return this.apply(this.state(ev.sessionId), ev)
  }

  forget(sessionId: string) {
    this.states.delete(sessionId)
  }

  private apply(st: State, { event: e, ts }: StoredEvent): boolean {
    if (e.kind === "tool_use") {
      if (!TOOLS.has(e.name)) return false
      st.uses.set(e.id, { name: e.name, input: obj(e.input), ts })
      return false
    }
    if (e.kind === "tool_result") {
      const use = st.uses.get(e.toolUseId)
      if (!use) return false
      st.uses.delete(e.toolUseId)
      if (e.isError) return false
      return this.result(st, use, e, ts)
    }
    if (e.kind === "user" && e.origin === "external") return this.fired(st, e.text, ts)
    return false
  }

  private result(st: State, use: { name: string; input: Record<string, unknown> }, e: Extract<TimelineEvent, { kind: "tool_result" }>, ts: number): boolean {
    const out = obj(e.structured)
    const input = use.input
    if (use.name === "CronCreate") {
      const id = str(out.id) || jobIdOf(e.content)
      const cron = str(input.cron)
      if (!id || !cron) return false
      const recurring = typeof out.recurring === "boolean" ? out.recurring : input.recurring !== false
      st.items.set(id, {
        id,
        kind: "cron",
        cron,
        human: str(out.humanSchedule) || null,
        prompt: str(input.prompt),
        reason: null,
        recurring,
        durable: out.durable === true || (out.durable === undefined && input.durable === true),
        permanent: false,
        createdAt: ts,
        at: null,
        lastFiredAt: null,
        fires: 0,
        cancelledAt: null,
        doneAt: null,
      })
      return true
    }
    if (use.name === "CronDelete") {
      const item = st.items.get(str(input.id) || str(out.id))
      if (!item || item.cancelledAt) return false
      item.cancelledAt = ts
      return true
    }
    if (use.name === "ScheduleWakeup") {
      // Un wakeup nuevo reemplaza al que estaba pendiente; `stop` los cancela a todos.
      for (const it of st.items.values()) if (it.kind === "wakeup" && !it.cancelledAt && !it.doneAt) it.cancelledAt = ts
      const at = typeof out.scheduledFor === "number" && out.scheduledFor > 0 ? out.scheduledFor : null
      if (out.stopped === true || input.stop === true || !at) return true
      st.items.set(e.toolUseId, {
        id: e.toolUseId,
        kind: "wakeup",
        cron: null,
        human: null,
        prompt: str(input.prompt),
        reason: str(input.reason) || null,
        recurring: false,
        durable: false,
        permanent: false,
        createdAt: ts,
        at,
        lastFiredAt: null,
        fires: 0,
        cancelledAt: null,
        doneAt: null,
      })
      return true
    }
    if (use.name === "RemoteTrigger" && str(input.action) === "create") {
      const body = obj(input.body)
      const cron = str(body.cron_expression)
      if (!/^HTTP 2\d\d\b/.test(e.content) || !cron) return false
      let id = ""
      try {
        id = str(obj(obj(JSON.parse(e.content.slice(e.content.indexOf("{")))).trigger).id)
      } catch {}
      id ||= `routine-${ts}`
      st.items.set(id, {
        id,
        kind: "routine",
        cron,
        human: null,
        prompt: str(body.name),
        reason: null,
        recurring: true,
        durable: true,
        permanent: true,
        createdAt: ts,
        at: null,
        lastFiredAt: null,
        fires: 0,
        cancelledAt: null,
        doneAt: null,
      })
      return true
    }
    return false
  }

  /**
   * Un mensaje que llegó sin que lo mandara el dashboard: si es el prompt de un cron, ese cron se
   * disparó. Un wakeup vuelve con el primer mensaje después de su hora (su prompt puede venir expandido).
   */
  private fired(st: State, text: string, ts: number): boolean {
    let changed = false
    for (const it of st.items.values()) {
      if (it.cancelledAt || it.doneAt || it.kind === "routine") continue
      const match =
        it.kind === "wakeup" ? it.at !== null && ts >= it.at - 90_000 : it.prompt.trim() !== "" && text.includes(it.prompt.trim())
      if (!match || ts < it.createdAt) continue
      it.lastFiredAt = ts
      it.fires++
      if (!it.recurring) it.doneAt = ts
      changed = true
    }
    return changed
  }

  private durableFor(dirs: string[]): DurableTask[] | null {
    let found: DurableTask[] | null = null
    for (const dir of new Set(dirs)) {
      const hit = this.durableCache.get(dir)
      const tasks = hit && this.clock() - hit.at < 3000 ? hit.tasks : readDurable(dir)
      if (!hit || hit.tasks !== tasks) this.durableCache.set(dir, { at: this.clock(), tasks })
      if (tasks) found = [...(found ?? []), ...tasks]
    }
    return found
  }

  /**
   * Lo programado por una sesión, listo para mostrar: lo activo (por la próxima ejecución) y lo que
   * terminó en el último día. `runtimeStartedAt` es cuándo arrancó su proceso actual (null si está
   * detenida): lo de la sesión que se creó antes se perdió con el proceso anterior.
   */
  list(
    sessionId: string,
    opts: { claudeSessionId: string; dirs: string[]; running: boolean; runtimeStartedAt: number | null }
  ): ScheduledItem[] {
    const st = this.state(sessionId)
    const now = this.clock()
    const durable = this.durableFor(opts.dirs)
    const mine = durable?.filter((t) => t.createdBySessionId === opts.claudeSessionId) ?? null
    const items = new Map(st.items)
    // Lo durable del archivo: completa lo que vimos (última ejecución) y suma lo de antes del dashboard.
    for (const t of mine ?? []) {
      const it = items.get(t.id)
      if (it) {
        items.set(t.id, { ...it, durable: true, permanent: Boolean(t.permanent), lastFiredAt: t.lastFiredAt ?? it.lastFiredAt })
      } else {
        items.set(t.id, {
          id: t.id,
          kind: "cron",
          cron: t.cron,
          human: null,
          prompt: t.prompt,
          reason: null,
          recurring: Boolean(t.recurring),
          durable: true,
          permanent: Boolean(t.permanent),
          createdAt: t.createdAt,
          at: null,
          lastFiredAt: t.lastFiredAt ?? null,
          fires: t.lastFiredAt ? 1 : 0,
          cancelledAt: null,
          doneAt: null,
        })
      }
    }
    const out: ScheduledItem[] = []
    for (const it of items.values()) {
      const view = this.view(it, now, opts, mine)
      const endedAt =
        it.cancelledAt ?? it.doneAt ?? (view.status === "expired" ? it.createdAt + RECURRING_MAX_AGE_MS : null) ?? view.nextAt ?? it.lastFiredAt ?? it.createdAt
      if (view.status !== "active" && now - endedAt > HISTORY_MS) continue
      out.push(view)
    }
    const rank = (s: ScheduledItem) => (s.status === "active" ? 0 : 1)
    return out
      .sort((a, b) => rank(a) - rank(b) || (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || b.createdAt - a.createdAt)
      .slice(0, MAX_ITEMS)
  }

  private view(
    it: Item,
    now: number,
    opts: { running: boolean; runtimeStartedAt: number | null },
    durable: DurableTask[] | null
  ): ScheduledItem {
    let status: ScheduledItem["status"] = "active"
    let nextAt: number | null = null
    const valid = it.cron !== null && isValidCron(it.cron)
    if (it.kind === "wakeup") nextAt = it.at
    else if (it.kind === "cron" && valid) {
      // Uno de una vez corre en la primera coincidencia después de crearse; uno recurrente, en la próxima.
      nextAt = nextRun(it.cron!, it.recurring ? Math.max(now, it.createdAt) : it.createdAt)?.getTime() ?? null
    }
    if (it.cancelledAt) status = "cancelled"
    else if (it.doneAt) status = "done"
    else if (it.kind === "routine") status = "active"
    else if (!it.durable && (opts.runtimeStartedAt === null || it.createdAt < opts.runtimeStartedAt)) status = "lost"
    else if (it.durable && durable !== null && !durable.some((t) => t.id === it.id))
      // Claude Code lo sacó del archivo: si era de una vez, ya corrió; si no, lo borraron.
      status = it.recurring ? "cancelled" : "done"
    else if (it.recurring && !it.permanent && now - it.createdAt >= RECURRING_MAX_AGE_MS) status = "expired"
    else if (!it.recurring && nextAt !== null && nextAt < now - 60_000) status = "missed"
    if (status !== "active" && it.kind !== "routine") nextAt = status === "missed" ? nextAt : null
    return {
      id: it.id,
      kind: it.kind,
      cron: it.cron,
      when: whenText(it, nextAt),
      prompt: it.prompt,
      reason: it.reason,
      recurring: it.recurring,
      durable: it.durable,
      createdAt: it.createdAt,
      nextAt: it.kind === "routine" ? null : nextAt,
      lastFiredAt: it.lastFiredAt,
      fires: it.fires,
      status,
      paused: status === "active" && it.kind !== "routine" && !opts.running,
    }
  }
}

function relevant(e: TimelineEvent) {
  return e.kind === "tool_use" && TOOLS.has(e.name)
}

const clock = (t: number) => {
  const d = new Date(t)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`
}

function whenText(it: Item, nextAt: number | null): string {
  if (it.kind === "wakeup") return it.at ? `vuelve a las ${clock(it.at)}` : "vuelve más tarde"
  if (!it.cron) return ""
  if (it.kind === "routine") return `${describeCron(it.cron)} (en la nube)`
  if (!it.recurring || isPinned(it.cron)) {
    const d = nextAt ? new Date(nextAt) : null
    if (!d) return describeCron(it.cron)
    const today = new Date()
    const sameDay = d.toDateString() === today.toDateString()
    return sameDay ? `una vez, a las ${clock(nextAt!)}` : `una vez, el ${d.getDate()}/${d.getMonth() + 1} a las ${clock(nextAt!)}`
  }
  return describeCron(it.cron)
}
