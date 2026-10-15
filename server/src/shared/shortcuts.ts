// Los atajos de teclado del dashboard: qué tecla hace qué, en Linux (y Windows) y en la Mac, y la
// decisión de si una tecla es un atajo o le corresponde al campo donde estás escribiendo.
//
// Reglas:
// - Nada de lo que el navegador se guarda (Ctrl+Tab, Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+L…).
// - Adentro del composer y de los campos de texto, solo combinaciones que un campo de texto no usa:
//   Alt+flechas en Linux, ⌥⌘ en la Mac (⌥ solo mueve por párrafo y ⌥+letra escribe caracteres:
//   en un teclado en español, @, [ o ~ salen con ⌥). Las de una tecla sola (?, End), solo afuera.
// - En la terminal, nada: todas sus teclas son de la shell (Alt+flechas, Ctrl+K de readline…).
// - Las letras se reconocen por `code` (la tecla física): con ⌥ la Mac cambia `key` (⌥N es "˜").

export type ShortcutId =
  | "palette"
  | "help"
  | "prev-session"
  | "next-session"
  | "next-needs-you"
  | "jump-to-end"
  | "interrupt"

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
}

export interface KeyContext {
  mac: boolean
  /** El foco está en un campo de texto (el composer, un input, un contenteditable). */
  editable: boolean
  /** El foco está en la terminal (xterm). */
  terminal: boolean
}

export interface ShortcutInfo {
  id: ShortcutId
  label: string
  /** Las teclas, para mostrarlas con <Kbd> (una por tecla). */
  keys: { linux: string[]; mac: string[] }
  /** Dónde vale (para la ayuda). */
  where?: string
}

export const SHORTCUTS: ShortcutInfo[] = [
  { id: "palette", label: "Paleta de comandos: ir a cualquier lado o hacer algo", keys: { linux: ["Ctrl", "K"], mac: ["⌘", "K"] } },
  { id: "next-needs-you", label: "Ir a la próxima sesión que te necesita", keys: { linux: ["Alt", "N"], mac: ["⌥", "⌘", "N"] } },
  { id: "prev-session", label: "Sesión anterior del proyecto", keys: { linux: ["Alt", "↑"], mac: ["⌥", "⌘", "↑"] } },
  { id: "next-session", label: "Sesión siguiente del proyecto", keys: { linux: ["Alt", "↓"], mac: ["⌥", "⌘", "↓"] } },
  { id: "jump-to-end", label: "Ir a lo último del chat", keys: { linux: ["Alt", "⇧", "↓"], mac: ["⌥", "⌘", "⇧", "↓"] } },
  {
    id: "interrupt",
    label: "Interrumpir el turno: Esc dos veces seguidas",
    keys: { linux: ["Esc", "Esc"], mac: ["Esc", "Esc"] },
    where: "con la sesión trabajando; el primero avisa y el segundo (antes de un segundo) interrumpe",
  },
  { id: "help", label: "Ver estos atajos", keys: { linux: ["?"], mac: ["?"] }, where: "fuera de un campo de texto; adentro, Ctrl / (⌘ / en la Mac)" },
]

/** Atajos que no son de esta lista pero conviene mostrar en la ayuda (los maneja cada pantalla). */
export const OTHER_SHORTCUTS: { label: string; keys: { linux: string[]; mac: string[] } }[] = [
  { label: "Abrir o esconder la terminal de la sesión", keys: { linux: ["Ctrl", "`"], mac: ["⌃", "`"] } },
  { label: "Mostrar u ocultar la barra lateral", keys: { linux: ["Ctrl", "B"], mac: ["⌘", "B"] } },
  { label: "Enviar el mensaje (Shift+Enter: salto de línea)", keys: { linux: ["Enter"], mac: ["Enter"] } },
]

const plain = (e: KeyLike) => !e.ctrlKey && !e.altKey && !e.metaKey

/**
 * La familia de los atajos de navegación: Alt en Linux, ⌥⌘ en la Mac (sin Ctrl en ninguna; en Linux,
 * AltGr llega como Ctrl+Alt y no cuenta).
 */
function nav(e: KeyLike, mac: boolean) {
  return mac ? e.altKey && e.metaKey && !e.ctrlKey : e.altKey && !e.ctrlKey && !e.metaKey
}

/**
 * Qué atajo es una tecla, o null si no es ninguno (o le toca al campo donde está el foco).
 * "interrupt" es cada Esc: la doble pulsación la cuenta `EscCounter`.
 */
export function matchShortcut(e: KeyLike, ctx: KeyContext): ShortcutId | null {
  if (e.isComposing || ctx.terminal) return null
  const mod = ctx.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (mod && !e.altKey && !e.shiftKey && e.code === "KeyK") return "palette"
  if (mod && !e.altKey && (e.code === "Slash" || e.key === "/")) return "help"
  if (nav(e, ctx.mac)) {
    if (e.code === "ArrowUp" && !e.shiftKey) return "prev-session"
    if (e.code === "ArrowDown") return e.shiftKey ? "jump-to-end" : "next-session"
    if (e.code === "KeyN" && !e.shiftKey) return "next-needs-you"
    return null
  }
  if (e.key === "Escape" && plain(e) && !e.shiftKey) return e.repeat ? null : "interrupt"
  if (ctx.editable) return null
  if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) return "help"
  if (e.key === "End" && plain(e) && !e.shiftKey) return "jump-to-end"
  return null
}

/**
 * Esc dos veces seguidas para interrumpir: un Esc suelto (para cerrar algo, o sin querer) no corta
 * un turno largo. El primero "arma" y el segundo, dentro de `windowMs`, dispara.
 */
export class EscCounter {
  private armedAt: number | null = null
  private readonly windowMs: number
  constructor(windowMs = 1000) {
    this.windowMs = windowMs
  }

  press(now: number): "arm" | "fire" {
    if (this.armedAt !== null && now - this.armedAt <= this.windowMs) {
      this.armedAt = null
      return "fire"
    }
    this.armedAt = now
    return "arm"
  }

  /** Otra tecla en el medio, o un Esc que se usó para otra cosa: empieza de nuevo. */
  reset() {
    this.armedAt = null
  }
}

/** Las teclas de un atajo según el sistema. */
export function keysFor(info: { keys: { linux: string[]; mac: string[] } }, mac: boolean): string[] {
  return mac ? info.keys.mac : info.keys.linux
}

/** "Ctrl K" o "⌘K", para un texto o un title. */
export function shortcutText(id: ShortcutId, mac: boolean): string {
  const info = SHORTCUTS.find((s) => s.id === id)
  if (!info) return ""
  const keys = keysFor(info, mac)
  return mac ? keys.join("") : keys.join("+")
}
