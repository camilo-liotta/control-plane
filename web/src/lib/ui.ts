import { create } from "zustand"

/** Estado de la interfaz que comparten varias pantallas (diálogos y paneles). */
interface UiState {
  newProject: boolean
  newSessionFor: string | null
  inbox: boolean
  palette: boolean
  settingsFor: string | null
  importFor: string | null
  /** Subagente abierto en el panel lateral. */
  subagent: { sessionId: string; toolUseId: string } | null
  /** Imagen abierta en grande. */
  lightbox: { id: string; name: string } | null
  set: (patch: Partial<Omit<UiState, "set">>) => void
}

export const useUi = create<UiState>((set) => ({
  newProject: false,
  newSessionFor: null,
  inbox: false,
  palette: false,
  settingsFor: null,
  importFor: null,
  subagent: null,
  lightbox: null,
  set: (patch) => set(patch),
}))
