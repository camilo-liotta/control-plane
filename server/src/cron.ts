/**
 * Cron de 5 campos (minuto hora día-del-mes mes día-de-la-semana), en la hora local, como el de
 * Claude Code: `*`, listas (`1,15`), rangos (`1-5`), pasos (`*\/10`, `9-17/2`) y nombres de meses y
 * días en inglés. Si se restringen el día del mes y el de la semana, alcanza con que coincida uno.
 */
export interface Cron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** El campo de día del mes (o de la semana) era `*`: sirve para la regla del "o". */
  anyDay: boolean
  anyWeekday: boolean
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

function field(src: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>()
  const value = (s: string) => {
    const lower = s.toLowerCase()
    const byName = names ? names.indexOf(lower) : -1
    const n = byName >= 0 ? byName + (names === MONTHS ? 1 : 0) : /^\d+$/.test(s) ? Number(s) : NaN
    if (!Number.isInteger(n)) throw new Error(`Valor inválido: ${s}`)
    return n
  }
  for (const part of src.split(",")) {
    const [range, stepSrc] = part.split("/")
    if (range === undefined || range === "" || part.split("/").length > 2) throw new Error(`Campo inválido: ${src}`)
    const step = stepSrc === undefined ? 1 : Number(stepSrc)
    if (!Number.isInteger(step) || step < 1) throw new Error(`Paso inválido: ${src}`)
    let lo: number
    let hi: number
    if (range === "*") {
      lo = min
      hi = max
    } else if (range.includes("-")) {
      const [a, b] = range.split("-")
      lo = value(a ?? "")
      hi = value(b ?? "")
    } else {
      lo = value(range)
      hi = stepSrc === undefined ? lo : max
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Fuera de rango: ${src}`)
    for (let n = lo; n <= hi; n += step) out.add(n)
  }
  return out
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error("El cron tiene que tener 5 campos")
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  const weekdays = field(dow, 0, 7, DAYS)
  // El 7 también es domingo.
  if (weekdays.delete(7)) weekdays.add(0)
  return {
    minutes: field(m, 0, 59),
    hours: field(h, 0, 23),
    days: field(dom, 1, 31),
    months: field(mon, 1, 12, MONTHS),
    weekdays,
    anyDay: dom === "*",
    anyWeekday: dow === "*",
  }
}

function dayMatches(c: Cron, d: Date): boolean {
  if (!c.months.has(d.getMonth() + 1)) return false
  const dom = c.days.has(d.getDate())
  const dow = c.weekdays.has(d.getDay())
  if (c.anyDay && c.anyWeekday) return true
  if (c.anyDay) return dow
  if (c.anyWeekday) return dom
  return dom || dow
}

/** La próxima vez que corre (estrictamente después de `from`), o null si no corre en los próximos ~5 años. */
export function nextRun(expr: string | Cron, from: Date | number = Date.now()): Date | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr
  const start = new Date(typeof from === "number" ? from : from.getTime())
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  const hours = [...c.hours].sort((a, b) => a - b)
  const minutes = [...c.minutes].sort((a, b) => a - b)
  const day = new Date(start)
  day.setHours(0, 0, 0, 0)
  for (let i = 0; i < 366 * 5; i++) {
    if (dayMatches(c, day)) {
      for (const h of hours) {
        for (const m of minutes) {
          const t = new Date(day)
          t.setHours(h, m, 0, 0)
          // Un cambio de hora puede saltear o repetir una hora: se toma lo que dé el reloj.
          if (t.getHours() !== h) continue
          if (t >= start) return t
        }
      }
    }
    day.setDate(day.getDate() + 1)
    day.setHours(0, 0, 0, 0)
  }
  return null
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

const DAY_PLURAL = ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"]
const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
const hhmm = (h: number, m: number) => `${h}:${String(m).padStart(2, "0")}`
const single = (s: string) => /^\d+$/.test(s)

/** El cron en palabras ("todos los días a las 9:00"); si es raro, el cron tal cual. */
export function describeCron(expr: string): string {
  let c: Cron
  try {
    c = parseCron(expr)
  } catch {
    return expr
  }
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/) as [string, string, string, string, string]
  const everyDay = dom === "*" && mon === "*" && dow === "*"
  const step = /^\*\/(\d+)$/
  if (m === "*" && h === "*" && everyDay) return "cada minuto"
  if (step.test(m) && h === "*" && everyDay) return `cada ${step.exec(m)![1]} minutos`
  if (single(m) && h === "*" && everyDay) return m === "0" ? "cada hora, en punto" : `cada hora, a los ${m} minutos`
  if (single(m) && step.test(h) && everyDay) return `cada ${step.exec(h)![1]} horas, a los ${m} minutos`
  if (!single(m) || !single(h)) return expr
  const at = `a las ${hhmm(Number(h), Number(m))}`
  if (everyDay) return `todos los días ${at}`
  if (dom === "*" && mon === "*") {
    if (dow === "1-5") return `de lunes a viernes ${at}`
    if (dow === "0,6" || dow === "6,0") return `los sábados y domingos ${at}`
    // Lunes a domingo, con el domingo al final; en plural ("los sábados").
    const days = [...c.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_PLURAL[d]!)
    const list = days.length === 1 ? days[0]! : `${days.slice(0, -1).join(", ")} y ${days.at(-1)}`
    return `los ${list} ${at}`
  }
  if (single(dom) && dow === "*") {
    if (mon === "*") return `el día ${dom} de cada mes ${at}`
    if (single(mon)) return `el ${dom} de ${MONTH_NAMES[Number(mon) - 1]} ${at}`
  }
  return expr
}

/** Un cron que fija día y mes (lo que usa Claude Code para "una vez, a tal hora"). */
export function isPinned(expr: string): boolean {
  const [m, h, dom, mon] = expr.trim().split(/\s+/)
  return [m, h, dom, mon].every((s) => s !== undefined && single(s))
}
