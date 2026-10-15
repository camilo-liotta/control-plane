import { toast } from "sonner"

/** El motivo de un error, para la descripción de un toast. */
export const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * El toast de algo que falló, con la voz de la guía: "No se pudo <qué>" y el motivo abajo.
 *
 *   api.start(id).catch(failed("reanudar la sesión"))
 */
export const failed = (what: string) => (err: unknown) => {
  toast.error(`No se pudo ${what}`, { description: reason(err) })
}
