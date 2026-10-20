import type { Account, AccountLimit, LimitKind, Session, SessionLimit } from "@shared/types"

const HOUR = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
const DAY = new Intl.DateTimeFormat("es-AR", { weekday: "short", day: "numeric", month: "short" })
const FULL = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false })

type Window = Pick<AccountLimit, "kind" | "resetsAt" | "source">

/** "las 22:00" si es hoy o dentro de unas horas; si no, "lun 9:00". */
export function limitWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const soon = d.toDateString() === new Date(now).toDateString() || (ms > now && ms - now < 12 * 3_600_000)
  return soon ? `las ${HOUR.format(d)}` : `${DAY.format(d).replace(/\.$/, "")} ${HOUR.format(d)}`
}

/** De qué es el límite, corto. */
export const limitKindLabel: Record<LimitKind, string> = {
  five_hour: "límite de 5 h",
  seven_day: "semanal",
  spend: "tope de gasto",
  other: "límite de uso",
}

/** El texto de la pastilla: "Sin uso hasta las 22:00 · límite de 5 h". */
export function limitText(l: Window, now = Date.now()): string {
  if (l.source === "fallback") return `Sin uso · reintenta a las ${HOUR.format(new Date(l.resetsAt))}`
  return `Sin uso hasta ${limitWhen(l.resetsAt, now)} · ${limitKindLabel[l.kind]}`
}

/** El texto completo para el `title`: qué límite, cuándo se renueva y qué pasa con la sesión. */
export function limitTitle(l: Window & { interrupted?: boolean; willResume?: boolean }): string {
  const what =
    l.kind === "five_hour"
      ? "Se acabó el uso de 5 horas."
      : l.kind === "seven_day"
        ? "Se acabó el uso semanal."
        : l.kind === "spend"
          ? "Se llegó al tope de gasto. Se renueva con el semanal; si lo subís, tocá «Reintentar ahora»."
          : "Se llegó a un límite de uso."
  const when = l.source === "fallback" ? `No se sabe cuándo se renueva: se vuelve a probar a las ${HOUR.format(new Date(l.resetsAt))}.` : `Se renueva ${FULL.format(new Date(l.resetsAt))}.`
  const after = l.willResume ? "La sesión sigue sola cuando se renueve." : l.interrupted ? "La sesión no sigue sola: escribile cuando se renueve." : "Lo que le escribas queda en espera hasta entonces."
  return `${what} ${when} ${after}`
}

/** Las sesiones sin uso de una cuenta (por sesión, `limited` viene de la cuenta o de su propio límite). */
export const limitedSessions = (sessions: Session[]) => sessions.filter((s) => s.limited && !s.archivedAt)

/** El límite más lejano entre varias sesiones o cuentas (el que manda cuando hay más de uno). */
export function latest<T extends Window>(list: T[]): T | null {
  return list.reduce<T | null>((a, b) => (!a || b.resetsAt > a.resetsAt ? b : a), null)
}

export type { Account, SessionLimit }
