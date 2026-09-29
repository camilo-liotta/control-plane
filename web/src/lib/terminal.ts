import { create } from "zustand"

/**
 * La terminal de cada sesión: si su panel está abierto y qué comando espera pegarse ("Llevar a la
 * terminal"). La terminal en sí vive en el server; esto es solo la pantalla.
 */
interface TerminalState {
  open: Record<string, boolean>
  /** Lo próximo a pegar (sin Enter) en la terminal de esa sesión. */
  pending: { sessionId: string; text: string; at: number } | null
  setOpen: (sessionId: string, open: boolean) => void
  toggle: (sessionId: string) => void
  /** Abre la terminal de la sesión y le pega el comando. */
  send: (sessionId: string, text: string) => void
  take: (sessionId: string) => string | null
}

export const useTerminal = create<TerminalState>((set, get) => ({
  open: {},
  pending: null,
  setOpen: (id, open) => set((s) => ({ open: { ...s.open, [id]: open } })),
  toggle: (id) => set((s) => ({ open: { ...s.open, [id]: !s.open[id] } })),
  send: (id, text) =>
    set((s) => ({
      open: { ...s.open, [id]: true },
      pending: { sessionId: id, text, at: Date.now() },
    })),
  take: (id) => {
    const p = get().pending
    if (!p || p.sessionId !== id) return null
    set({ pending: null })
    return p.text
  },
}))

const valuesKey = (projectId: string) => `control-plane:values:${projectId}`

/** Los valores que ya usaste en este proyecto, para no volver a tipearlos. */
export function rememberedValues(projectId: string): Record<string, string> {
  try {
    return JSON.parse(
      localStorage.getItem(valuesKey(projectId)) ?? "{}"
    ) as Record<string, string>
  } catch {
    return {}
  }
}

export function rememberValues(
  projectId: string,
  values: Record<string, string>
) {
  try {
    localStorage.setItem(
      valuesKey(projectId),
      JSON.stringify({ ...rememberedValues(projectId), ...values })
    )
  } catch {
    // sin localStorage: no se recuerdan
  }
}
