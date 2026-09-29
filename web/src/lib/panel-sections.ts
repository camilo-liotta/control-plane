import { create } from "zustand"

/** Secciones del panel de la sesión. Las dos de propuestas comparten id: son la misma cosa. */
export type PanelSection =
  | "review"
  | "proposals"
  | "pending-reports"
  | "task"
  | "reports"
  | "changes"
  | "subagents"
  | "attachments"
  | "tools"
  | "details"

const KEY = "session-panel-open"

function load(): Partial<Record<PanelSection, boolean>> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown
    return raw && typeof raw === "object" ? (raw as Partial<Record<PanelSection, boolean>>) : {}
  } catch {
    return {}
  }
}

interface SectionsState {
  /** Lo que abriste o cerraste vos: se recuerda en este navegador, igual para todas las sesiones. */
  open: Partial<Record<PanelSection, boolean>>
  /** Lo que se abrió solo para mostrarte algo (un aviso): no se guarda. */
  forced: Partial<Record<PanelSection, boolean>>
  toggle: (id: PanelSection, open: boolean) => void
  reveal: (id: PanelSection) => void
}

export const usePanelSections = create<SectionsState>((set) => ({
  open: load(),
  forced: {},
  toggle: (id, open) =>
    set((s) => {
      const next = { ...s.open, [id]: open }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {}
      return { open: next, forced: { ...s.forced, [id]: false } }
    }),
  reveal: (id) => set((s) => ({ forced: { ...s.forced, [id]: true } })),
}))

/** Si la sección está abierta: arrancan todas plegadas. */
export function useSectionOpen(id: PanelSection): boolean {
  return usePanelSections((s) => Boolean(s.forced[id] || s.open[id]))
}
