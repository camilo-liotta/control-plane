import { create } from "zustand"

import { pushRecent, type ScrollSpot } from "@shared/navigation"

/**
 * Lo que la app recuerda de cómo te movés: dónde quedó el scroll de cada sesión, las sesiones que
 * abriste hace poco, la última pantalla y qué proyectos plegaste en la barra lateral.
 */

/** En la Mac los atajos van con ⌘ (y la ayuda los muestra así). */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// ---- scroll por sesión (en memoria: sobrevive a navegar, no a recargar)

const scrolls = new Map<string, ScrollSpot>()
export const scrollMemory = {
  get: (sessionId: string) => scrolls.get(sessionId),
  set: (sessionId: string, spot: ScrollSpot) => void scrolls.set(sessionId, spot),
}

// ---- localStorage

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // sin almacenamiento local: se recuerda solo en esta pestaña
  }
}

const RECENT_KEY = "control-plane:recent-sessions"
const ROUTE_KEY = "control-plane:last-route"
const FOLDED_KEY = "control-plane:folded-projects"

interface NavState {
  /** Sesiones abiertas hace poco, la más reciente primero. */
  recent: string[]
  /** Proyectos plegados en la barra lateral. */
  folded: Record<string, true>
  visit: (sessionId: string) => void
  setFolded: (projectId: string, folded: boolean) => void
}

export const useNav = create<NavState>((set) => ({
  recent: read<string[]>(RECENT_KEY, []),
  folded: read<Record<string, true>>(FOLDED_KEY, {}),
  visit: (id) =>
    set((s) => {
      const recent = pushRecent(s.recent, id)
      write(RECENT_KEY, recent)
      return { recent }
    }),
  setFolded: (id, folded) =>
    set((s) => {
      const next = { ...s.folded }
      if (folded) next[id] = true
      else delete next[id]
      write(FOLDED_KEY, next)
      return { folded: next }
    }),
}))

/** La última pantalla (sin el inicio): para volver al abrir la app o desde "Seguir donde estabas". */
export const lastRoute = {
  get: () => read<string | null>(ROUTE_KEY, null),
  set: (route: string) => write(ROUTE_KEY, route),
}
