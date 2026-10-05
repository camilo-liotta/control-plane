import { toast } from "sonner"

/** Cuánto se espera antes de hacer de verdad lo que se puede deshacer. */
export const UNDO_MS = 5000

const pending = new Set<() => void>()

/**
 * Para lo que se puede deshacer (descartar una propuesta, quitar de la cola, cerrar una tarea,
 * detener una sesión): no se pregunta. Se muestra un toast con "Deshacer" y la acción recién se
 * ejecuta al vencer los 5 s. Mientras tanto, la pantalla ya la muestra hecha (`onHide`) y, si se
 * deshace o falla, la vuelve atrás (`onRestore`).
 *
 *   undoable({ message: "Propuesta descartada", run: () => api.discardDraft(id), onHide, onRestore })
 *
 * Si se cierra la pestaña antes de que venza, se ejecuta en ese momento (lo mejor posible).
 */
export function undoable({
  message,
  run,
  onHide,
  onRestore,
  undoLabel = "Deshacer",
  failMessage = "No se pudo hacer",
  ms = UNDO_MS,
}: {
  message: string
  run: () => unknown
  onHide?: () => void
  onRestore?: () => void
  undoLabel?: string
  failMessage?: string
  ms?: number
}): { undo: () => void; now: () => void } {
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    pending.delete(finish)
    toast.dismiss(toastId)
    Promise.resolve()
      .then(run)
      .catch((err: unknown) => {
        onRestore?.()
        toast.error(failMessage, { description: err instanceof Error ? err.message : String(err) })
      })
  }
  const undo = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    pending.delete(finish)
    toast.dismiss(toastId)
    onRestore?.()
  }
  onHide?.()
  const toastId = toast(message, { duration: ms, action: { label: undoLabel, onClick: undo }, onAutoClose: finish, onDismiss: finish })
  timer = setTimeout(finish, ms + 50)
  pending.add(finish)
  return { undo, now: finish }
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => [...pending].forEach((f) => f()))
