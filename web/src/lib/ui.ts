import { create } from "zustand"

/** Estado de la interfaz que comparten varias pantallas (diálogos y paneles). */
interface UiState {
  newProject: boolean
  newSessionFor: string | null
  inbox: boolean
  palette: boolean
  settingsFor: string | null
  importFor: string | null
  /** Proyecto cuyo diálogo de borrar está abierto. */
  deleteFor: string | null
  /** Subagente abierto en el panel lateral. */
  subagent: { sessionId: string; toolUseId: string } | null
  /** Imagen abierta en grande: un adjunto (`id`) o, mientras se sube, su vista previa local (`src`). */
  lightbox: { id?: string; name: string; src?: string } | null
  /** Cuenta de Claude Code elegida en el selector (se recuerda en este navegador). */
  account: string | null
  accountsDialog: boolean
  settingsForAccount: string | null
  /** Sesión cuyo panel de compactación está abierto. */
  compactFor: string | null
  /** Sesión cuyo panel de herramientas (MCP, skills, plugins) está abierto. */
  toolsFor: string | null
  /** Sesión que se está renombrando (el diálogo es uno solo, para el menú y la paleta). */
  renameFor: string | null
  /** Sesión que se está por archivar (se pide confirmar). */
  archiveFor: string | null
  /** La ayuda de los atajos de teclado. */
  shortcuts: boolean
  /** Cada vez que cambia, el chat abierto baja hasta lo último (el atajo y la paleta). */
  jumpToEnd: number
  /**
   * Lo que la página de destino tiene que mostrar al llegar desde un aviso: las propuestas listas
   * en el chat de la orquestadora (`id`: la sesión) o las tareas del tablero (`id`: el proyecto).
   * La página lo limpia cuando lo muestra.
   */
  /**
   * Lo que la página de destino tiene que mostrar al llegar. Con `item`, además, cuál dentro de la
   * sección (con "tasks", el id de la tarea: el resumen del proyecto la abre).
   */
  reveal: { kind: "proposals" | "tasks" | "environments" | "archived"; id: string; item?: string; at: number } | null
  /** Versión nueva de la app de escritorio (la avisa la app; se actualiza desde el menú de su ícono). */
  desktopUpdate: { version: string; notesUrl: string } | null
  /** La actualización de la app falló: el motivo y lo último de su log (para "Ver log"). */
  updateFailure: UpdateFailure | null
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

/** Una actualización que falló, como la cuenta la app de escritorio. */
export interface UpdateFailure {
  version: string
  error: string
  logPath: string
  log: string
  /** La URL de acción de la app para reintentar (con el token de esta falla), si vino. */
  retryUrl: string | null
}

export const useUi = create<UiState>((set) => ({
  newProject: false,
  newSessionFor: null,
  inbox: false,
  palette: false,
  settingsFor: null,
  importFor: null,
  deleteFor: null,
  subagent: null,
  lightbox: null,
  account: storedAccount(),
  accountsDialog: false,
  settingsForAccount: null,
  compactFor: null,
  toolsFor: null,
  renameFor: null,
  archiveFor: null,
  shortcuts: false,
  jumpToEnd: 0,
  reveal: null,
  desktopUpdate: null,
  updateFailure: null,
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
