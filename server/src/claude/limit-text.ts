import type { LimitKind } from "../shared/types.ts"

/**
 * Reconoce cuándo un turno terminó porque se acabó el uso, por el texto del error de Claude Code:
 *   You've hit your session limit · resets 10pm (America/New_York)                 → five_hour
 *   You've hit your weekly limit · resets 9am (America/New_York)                   → seven_day
 *   You've hit your individual spend limit · run /usage-credits to raise it, or visit
 *     claude.ai/admin-settings/usage · your weekly limit resets 9am (…)            → spend
 * y de dónde sale cuándo se renueva ("resets 10pm" en esa zona horaria: la próxima vez que llega esa hora).
 */

export interface LimitHit {
  kind: LimitKind
  /** El texto tal cual. */
  message: string
  /** Lo que sigue a "resets" ("10pm (America/New_York)"), si lo trae. */
  resetText: string | null
}

const HIT = /you['’]ve (?:hit|reached) your ([^·\n]*?)\s*(?:[·.]|$)/i

/** De qué límite habla el texto ("session limit", "weekly limit", "individual spend limit"…). */
export function kindOfLimit(what: string): LimitKind {
  const w = what.toLowerCase()
  if (/\bsession\b|5[- ]?hour|five[- ]hour/.test(w)) return "five_hour"
  if (/\bspend\b|\bcredits?\b|\bbudget\b|\busage limit\b/.test(w)) return "spend"
  if (/\bweekly\b|\b7[- ]?day\b|\bseven[- ]day\b/.test(w)) return "seven_day"
  return "other"
}

export function parseLimitError(text: string | null | undefined): LimitHit | null {
  if (!text) return null
  const m = HIT.exec(text)
  if (!m || !/\blimit\b|\bbudget\b/i.test(m[1]!)) return null
  return { kind: kindOfLimit(m[1]!), message: text.trim(), resetText: lastResetText(text) }
}

/** Lo que sigue al último "resets" ("your weekly limit resets 9am (…)" va al final del tope de gasto). */
function lastResetText(text: string): string | null {
  const all = [...text.matchAll(/\bresets?\s+(?:at\s+|on\s+)?([^·\n]+)/gi)]
  const last = all.at(-1)
  return last ? last[1]!.trim().replace(/[.\s]+$/, "") : null
}

// ---------------------------------------------------------------- hora de renovación

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const HOUR = 3_600_000

interface Parts {
  y: number
  m: number
  d: number
  h: number
  min: number
  s: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(zone: string | undefined): Intl.DateTimeFormat {
  const key = zone ?? ""
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      ...(zone ? { timeZone: zone } : {}),
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    formatters.set(key, f)
  }
  return f
}

/** El reloj de pared de `ms` en esa zona (undefined = la de esta máquina). */
function partsIn(ms: number, zone: string | undefined): Parts {
  const out: Record<string, number> = {}
  for (const p of formatter(zone).formatToParts(ms)) if (p.type !== "literal") out[p.type] = Number(p.value)
  return { y: out.year!, m: out.month!, d: out.day!, h: out.hour! % 24, min: out.minute!, s: out.second! }
}

/** El instante en que el reloj de esa zona marca y-m-d h:min (una pasada más corrige el cambio de horario). */
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, zone: string | undefined): number {
  const wall = Date.UTC(y, m - 1, d, h, min)
  let guess = wall
  for (let i = 0; i < 2; i++) {
    const p = partsIn(guess, zone)
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s)
    guess -= shown - wall
  }
  return guess
}

const validZone = (zone: string | undefined): string | undefined => {
  if (!zone) return undefined
  try {
    formatter(zone)
    return zone
  } catch {
    return undefined
  }
}

/**
 * Cuándo se renueva según "10pm (America/New_York)", "Oct 24, 9am (…)", "Mon 9am (…)" o "10:30pm":
 * sin fecha, la próxima vez que llega esa hora en la zona; con fecha o día, esa. Sin zona, la de esta
 * máquina. null si no se entiende.
 */
export function parseResetText(text: string | null | undefined, nowMs: number): number | null {
  if (!text) return null
  const zoneMatch = /\(([^)]+)\)/.exec(text)
  const zone = validZone(zoneMatch?.[1]?.trim())
  const body = text.replace(/\([^)]*\)/g, " ").trim()

  let hour: number
  let minute = 0
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(body)
  if (ampm) {
    if (Number(ampm[1]) < 1 || Number(ampm[1]) > 12) return null
    hour = Number(ampm[1]) % 12 + (ampm[3]!.toLowerCase() === "pm" ? 12 : 0)
    minute = Number(ampm[2] ?? 0)
  } else {
    const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(body)
    if (!h24) return null
    hour = Number(h24[1])
    minute = Number(h24[2])
  }
  if (minute > 59 || hour > 23) return null

  const today = partsIn(nowMs, zone)
  const at = (y: number, m: number, d: number) => zonedToUtc(y, m, d, hour, minute, zone)
  // Un día después en el calendario de la zona (sumar 24 h se desfasa con un cambio de horario).
  const plusDays = (days: number) => {
    const t = new Date(Date.UTC(today.y, today.m - 1, today.d + days))
    return at(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
  }

  const date = new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "i").exec(body)
  if (date) {
    const month = MONTHS.indexOf(date[1]!.toLowerCase()) + 1
    const day = Number(date[2])
    let year = date[3] ? Number(date[3]) : today.y
    let when = at(year, month, day)
    // Sin año: un día que ya pasó hace tiempo es el del año que viene.
    if (!date[3] && when < nowMs - 36 * HOUR) when = at(++year, month, day)
    return when
  }
  if (/\btomorrow\b/i.test(body)) return plusDays(1)
  const weekday = new RegExp(`\\b(${WEEKDAYS.join("|")})[a-z]*\\b`, "i").exec(body)
  if (weekday) {
    const want = WEEKDAYS.indexOf(weekday[1]!.toLowerCase())
    const have = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay()
    let ahead = (want - have + 7) % 7
    if (ahead === 0 && plusDays(0) <= nowMs) ahead = 7
    return plusDays(ahead)
  }
  const first = plusDays(0)
  return first > nowMs ? first : plusDays(1)
}
