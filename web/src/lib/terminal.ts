import { create } from "zustand"

/**
 * La terminal de cada sesión: si su panel está abierto y qué comando espera pegarse ("Llevar a la
 * terminal"). La terminal en sí vive en el server; esto es solo la pantalla.
 */
interface TerminalState {
  /** Si el panel de cada sesión está abierto: se recuerda al recargar (la shell sigue viva en el server). */
  open: Record<string, boolean>
  /** El alto del panel en px (el mismo para todas las sesiones), o null para el de siempre. */
  height: number | null
  /** Lo próximo a pegar (sin Enter) en la terminal de esa sesión. */
  pending: { sessionId: string; text: string; at: number } | null
  setOpen: (sessionId: string, open: boolean) => void
  toggle: (sessionId: string) => void
  setHeight: (px: number) => void
  /** Abre la terminal de la sesión y le pega el comando. */
  send: (sessionId: string, text: string) => void
  take: (sessionId: string) => string | null
}

const OPEN_KEY = "control-plane:terminal-open"
const HEIGHT_KEY = "control-plane:terminal-height"

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // sin localStorage: se recuerda mientras la pestaña esté abierta
  }
}
/** Solo se guardan las abiertas, para que la lista no crezca con cada sesión que pasó. */
function withOpen(open: Record<string, boolean>, id: string, on: boolean) {
  const next = { ...open }
  if (on) next[id] = true
  else delete next[id]
  write(OPEN_KEY, next)
  return next
}

export const useTerminal = create<TerminalState>((set, get) => ({
  open: read<Record<string, boolean>>(OPEN_KEY, {}),
  height: read<number | null>(HEIGHT_KEY, null),
  pending: null,
  setOpen: (id, open) => set((s) => ({ open: withOpen(s.open, id, open) })),
  toggle: (id) => set((s) => ({ open: withOpen(s.open, id, !s.open[id]) })),
  setHeight: (px) => {
    write(HEIGHT_KEY, Math.round(px))
    set({ height: Math.round(px) })
  },
  send: (id, text) =>
    set((s) => ({
      open: withOpen(s.open, id, true),
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
