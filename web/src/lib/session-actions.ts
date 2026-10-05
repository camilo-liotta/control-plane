import { toast } from "sonner"

import { api } from "@/lib/api"
import { useTerminal } from "@/lib/terminal"
import { useUi } from "@/lib/ui"

/**
 * Lo que se puede hacer con una sesión, en un solo lugar: lo usan los botones de la sesión, la
 * paleta de comandos y los atajos de teclado (así hacen siempre lo mismo).
 */

const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))

/** Reanuda una sesión detenida. */
export const startSession = (id: string) => api.start(id).then(() => void toast.success("Sesión reanudada"), fail)

/** Detiene el proceso de la sesión (se reanuda al escribirle o con Reanudar). */
export const stopSession = (id: string) => api.stop(id).then(() => void toast.success("Sesión detenida"), fail)

/** Corta el turno en curso; la sesión sigue viva y espera tu próximo mensaje. */
export const interruptSession = (id: string) => api.interrupt(id).then(() => {}, fail)

export const toggleTerminal = (id: string) => useTerminal.getState().toggle(id)
export const openCompaction = (id: string) => useUi.getState().set({ compactFor: id })
export const openSessionTools = (id: string) => useUi.getState().set({ toolsFor: id })
export const renameSession = (id: string) => useUi.getState().set({ renameFor: id })
/** Pide confirmar y, si confirmás, la archiva y vuelve al tablero. */
export const archiveSession = (id: string) => useUi.getState().set({ archiveFor: id })
/** Baja el chat abierto hasta lo último. */
export const jumpToEnd = () => useUi.getState().set({ jumpToEnd: Date.now() })
