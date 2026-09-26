import { inDesktop } from "@/lib/notify"

const isEditable = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "file", "range", "color"].includes(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable)

/**
 * Ctrl+Z, Ctrl+Shift+Z y Ctrl+Y en la app de escritorio en Linux. WebKitGTK guarda la pila de
 * deshacer de cada campo pero no liga esas teclas: lo hace cada navegador por su cuenta (Epiphany) y
 * wry no. En la Mac las liga el menú Edición de la app, y en los navegadores ya andan.
 */
export function installUndoKeys() {
  if (!inDesktop() || !/Linux/.test(navigator.userAgent)) return
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !e.ctrlKey || e.altKey || e.metaKey || !isEditable(e.target)) return
    const key = e.key.toLowerCase()
    const command = key === "z" ? (e.shiftKey ? "redo" : "undo") : key === "y" && !e.shiftKey ? "redo" : null
    if (!command) return
    e.preventDefault()
    document.execCommand(command)
  })
}
