import { toast } from "sonner"

import { api } from "@/lib/api"
import { useStore } from "@/lib/store"
import { useTerminal } from "@/lib/terminal"
import { undoable } from "@/lib/undo"
import { useUi } from "@/lib/ui"
import { failed } from "@/lib/errors"

/**
 * Lo que se puede hacer con una sesión, en un solo lugar: lo usan los botones de la sesión, la
 * paleta de comandos y los atajos de teclado (así hacen siempre lo mismo).
 */


/** Reanuda una sesión detenida. */
export const startSession = (id: string) => api.start(id).then(() => void toast.success("Sesión reanudada"), failed("reanudar la sesión"))

/**
 * Detiene el proceso de la sesión (se reanuda al escribirle o con Reanudar). Si está trabajando o
 * esperándote, corta lo que hacía: no pregunta, pero deja 5 s para deshacerlo.
 */
export const stopSession = async (id: string) => {
  const status = useStore.getState().sessions[id]?.status
  if (status === "working" || status === "needs_input") {
    undoable({ message: "Sesión detenida", run: () => api.stop(id), failMessage: "No se pudo detener la sesión" })
    return
  }
  await api.stop(id).then(() => void toast.success("Sesión detenida"), failed("detener la sesión"))
}

/** Corta el turno en curso; la sesión sigue viva y espera tu próximo mensaje. */
export const interruptSession = (id: string) => api.interrupt(id).then(() => void toast("Turno interrumpido"), failed("interrumpir el turno"))

export const toggleTerminal = (id: string) => useTerminal.getState().toggle(id)
export const openCompaction = (id: string) => useUi.getState().set({ compactFor: id })
export const openSessionTools = (id: string) => useUi.getState().set({ toolsFor: id })
export const renameSession = (id: string) => useUi.getState().set({ renameFor: id })
/** Pide confirmar y, si confirmás, la archiva y vuelve al tablero. */
export const archiveSession = (id: string) => useUi.getState().set({ archiveFor: id })
/** Baja el chat abierto hasta lo último. */
export const jumpToEnd = () => useUi.getState().set({ jumpToEnd: Date.now() })
