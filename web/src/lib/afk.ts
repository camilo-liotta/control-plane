import type { AfkLog, AfkState, Project } from "@shared/types"

import { clock, usd } from "@/lib/format"

/**
 * Modo AFK de un proyecto (contrato de TRAY): la orquestadora envía sus propuestas sin esperar tu
 * aprobación hasta que vence `until`, se gasta `budgetUsd` o volvés.
 */
export type Afk = AfkState

/** El AFK del proyecto, o null si está presente. */
export const afkOf = (project: Project): Afk | null => project.afk

async function call(method: "POST" | "DELETE", projectId: string, body?: { until: number | null; budgetUsd: number | null }) {
  // Un DELETE sin cuerpo no manda Content-Length en los navegadores y la puerta del listener remoto lo rechaza (411): va con {}.
  const payload = body ?? {}
  const res = await fetch(`/api/projects/${projectId}/afk`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`)
}

export const startAfk = (projectId: string, body: { until: number | null; budgetUsd: number | null }) => call("POST", projectId, body)
export const endAfk = (projectId: string) => call("DELETE", projectId)

/** "hasta las 14:30", "hasta mañana 09:00", "hasta el lun 6/10 09:00" o "sin límite de tiempo". */
export function afkUntil(until: number | null, now = Date.now()): string {
  if (until === null) return "sin límite de tiempo"
  const d = new Date(until)
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(until).setHours(0, 0, 0, 0) - day.getTime()) / 86_400_000)
  if (days <= 0) return `hasta las ${clock(until)}`
  if (days === 1) return `hasta mañana ${clock(until)}`
  const label = d.toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "numeric" }).replace(",", "")
  return `hasta el ${label} ${clock(until)}`
}

/** El texto de la marca: "AFK hasta mañana 09:00 · tope US$ 5". */
export function afkSummary(afk: Afk, now = Date.now()): string {
  return `AFK ${afkUntil(afk.until, now)}${afk.budgetUsd !== null ? ` · tope ${usd(afk.budgetUsd)}` : ""}`
}

/** Lo gastado en el proyecto desde que empezó el AFK (suma de sus sesiones menos lo que llevaba al entrar). */
export function afkSpent(afk: Afk, sessionsCost: number): number {
  return Math.max(0, sessionsCost - afk.spentAtStart)
}

/** "AFK hasta las 18:00 · US$ 1,20 de 5": la marca del encabezado. */
export function afkPillText(afk: Afk, spent: number, now = Date.now()): string {
  const budget = afk.budgetUsd !== null ? ` · ${usd(spent)} de ${afk.budgetUsd.toLocaleString("es-AR", { maximumFractionDigits: 2 })}` : ""
  return `AFK ${afkUntil(afk.until, now)}${budget}`
}

/** Por qué terminó un período AFK, en una frase. */
export const afkEndText: Record<NonNullable<AfkLog["endReason"]>, string> = {
  user: "Terminó porque volviste.",
  until: "Terminó porque se cumplió el tiempo.",
  budget: "Terminó porque se agotó el presupuesto.",
}

const seenKey = (projectId: string) => `cp-afk-seen:${projectId}`

/** El período AFK (por su `since`) cuyo resumen ya cerraste con "Listo". */
export const afkSeen = (projectId: string): number | null => {
  try {
    return Number(localStorage.getItem(seenKey(projectId))) || null
  } catch {
    return null
  }
}

export const markAfkSeen = (projectId: string, since: number) => {
  try {
    localStorage.setItem(seenKey(projectId), String(since))
  } catch {
    // sin almacenamiento: el resumen vuelve en la próxima carga
  }
}
