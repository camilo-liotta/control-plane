import { create } from "zustand"

/** Estado de la interfaz que comparten varias pantallas (diálogos y paneles). */
interface UiState {
  newProject: boolean
  newSessionFor: string | null
  inbox: boolean
  palette: boolean
  settingsFor: string | null
  importFor: string | null
  set: (patch: Partial<Omit<UiState, "set">>) => void
}

export const useUi = create<UiState>((set) => ({
  newProject: false,
  newSessionFor: null,
  inbox: false,
  palette: false,
  settingsFor: null,
  importFor: null,
  set: (patch) => set(patch),
}))
