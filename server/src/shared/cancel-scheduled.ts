import type { ScheduledItem, SessionStatus } from "./types.ts"

/**
 * Cancelar algo programado: solo la sesión puede llamar a CronDelete (o cortar su /loop, o apagar
 * una rutina), así que el dashboard se lo pide con un mensaje. Esto arma ese mensaje y dice en qué
 * quedó el pedido. Lo usan el server (para no pedirlo dos veces) y la web (para mostrarlo).
 */

/** Cuánto se espera después del último turno de la sesión antes de dar el pedido por no cumplido. */
export const CANCEL_GRACE_MS = 60_000

export interface CancelRequest {
  requestedAt: number
  /** El último fin de turno de la sesión después del pedido. */
  lastTurnEndAt: number | null
}

const FROM_PANEL = 'Pedido del usuario desde el panel "Programado":'

/** El mensaje que le llega a la sesión, según qué hay que cancelar. */
export function cancelMessage(item: Pick<ScheduledItem, "kind" | "id" | "when">): string {
  if (item.kind === "wakeup") return `${FROM_PANEL} cortá el /loop con ScheduleWakeup y stop: true.`
  if (item.kind === "routine")
    return `${FROM_PANEL} desactivá o borrá la rutina en la nube \`${item.id}\` (${item.when}) con RemoteTrigger. Si no tenés esa herramienta, avisame.`
  return `${FROM_PANEL} cancelá la tarea programada \`${item.id}\` (${item.when}) con CronDelete.`
}

export type CancelState = "none" | "pending" | "failed"

/**
 * En qué quedó un pedido: `pending` hasta que llega la cancelación; `failed` si la sesión terminó
 * su turno, pasó un rato y sigue activa (la sesión no lo hizo: hay que mirar el chat); `none` si no
 * hay pedido o lo programado ya no está activo (se canceló o terminó).
 */
export function cancelState(
  req: CancelRequest | null | undefined,
  item: Pick<ScheduledItem, "status">,
  sessionStatus: SessionStatus,
  now: number
): CancelState {
  if (!req || item.status !== "active") return "none"
  // Trabajando, arrancando o esperándote (una pregunta): todavía puede cancelarla.
  const settled = sessionStatus === "idle" || sessionStatus === "stopped" || sessionStatus === "error"
  if (settled && req.lastTurnEndAt !== null && now - req.lastTurnEndAt >= CANCEL_GRACE_MS) return "failed"
  return "pending"
}
