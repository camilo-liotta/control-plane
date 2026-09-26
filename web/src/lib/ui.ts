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
  /** Cuenta de Claude Code elegida en el selector (se recuerda en este navegador). */
  account: string | null
  accountsDialog: boolean
  settingsForAccount: string | null
  /** Sesión cuyo panel de compactación está abierto. */
  compactFor: string | null
  /** Sesión cuyo panel de herramientas (MCP, skills, plugins) está abierto. */
  toolsFor: string | null
  /**
   * Lo que la página de destino tiene que mostrar al llegar desde un aviso: las propuestas listas
   * en el chat de la orquestadora (`id`: la sesión) o las tareas del tablero (`id`: el proyecto).
   * La página lo limpia cuando lo muestra.
   */
  reveal: { kind: "proposals" | "tasks"; id: string; at: number } | null
  set: (patch: Partial<Omit<UiState, "set">>) => void
  selectAccount: (id: string) => void
}

const ACCOUNT_KEY = "control-plane:account"

function storedAccount(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY)
  } catch {
    return null
  }
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
  account: storedAccount(),
  accountsDialog: false,
  settingsForAccount: null,
  compactFor: null,
  toolsFor: null,
  reveal: null,
  set: (patch) => set(patch),
  selectAccount: (id) => {
    try {
      localStorage.setItem(ACCOUNT_KEY, id)
    } catch {
      // sin almacenamiento local: se recuerda solo en esta pestaña
    }
    set({ account: id })
  },
}))
