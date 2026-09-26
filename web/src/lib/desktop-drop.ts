import { toast } from "sonner"

/**
 * Archivos soltados en la ventana de la app de escritorio. El webview no se los da a la página: la
 * app los lee y los manda con `window.__cpDesktop.dropFiles`. Los recibe el composer de la sesión
 * abierta, por el mismo camino que el clip y el pegado.
 */
interface DropTarget {
  add: (files: File[]) => void
  dragging: (on: boolean) => void
}

const targets: DropTarget[] = []

/** El composer se anota mientras está en pantalla; gana el último que se montó. */
export function registerDropTarget(target: DropTarget) {
  targets.push(target)
  return () => {
    const i = targets.lastIndexOf(target)
    if (i >= 0) targets.splice(i, 1)
  }
}

let recent: { key: string; at: number }[] = []

/**
 * Descarta los archivos que ya llegaron por el otro camino hace un instante: si algún webview
 * entrega el `File` en el drop y además la app los manda, no se adjuntan dos veces.
 */
export function freshFiles(files: File[]): File[] {
  const now = Date.now()
  recent = recent.filter((r) => now - r.at < 3000)
  return files.filter((f) => {
    const key = `${f.name}\0${f.size}`
    if (recent.some((r) => r.key === key)) return false
    recent.push({ key, at: now })
    return true
  })
}

function decode(base64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(base64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const MIME = /^[\w.+-]+\/[\w.+-]+$/

function toFile(v: unknown): File | null {
  if (!isRecord(v)) return null
  const { name, mime, base64 } = v
  if (typeof name !== "string" || !name || name.length > 255 || typeof base64 !== "string") return null
  const type = typeof mime === "string" && MIME.test(mime) ? mime : "application/octet-stream"
  const data = decode(base64)
  return data ? new File([data], name, { type }) : null
}

/** Para la app de escritorio: archivos leídos por la app y los que no pudo leer. Ignora lo inválido. */
export function dropFromDesktop(files: unknown, errors: unknown): boolean {
  try {
    if (Array.isArray(errors)) {
      for (const e of errors) {
        if (!isRecord(e) || typeof e.name !== "string") continue
        toast.error(`No se pudo adjuntar ${e.name}`, { description: typeof e.reason === "string" ? e.reason : undefined })
      }
    }
    const list = Array.isArray(files) ? files.map(toFile).filter((f): f is File => f !== null) : []
    if (!list.length) return false
    const target = targets.at(-1)
    if (!target) {
      toast.error("Abrí una sesión para adjuntar", {
        id: "drop-no-session",
        description: "Los archivos que soltás se suman al mensaje de la sesión que tenés abierta.",
      })
      return false
    }
    const fresh = freshFiles(list)
    if (fresh.length) target.add(fresh)
    return true
  } catch {
    return false
  }
}

/** Para la app de escritorio: se está arrastrando algo sobre la ventana (o dejó de hacerlo). */
export function draggingFromDesktop(on: unknown) {
  if (typeof on === "boolean") targets.at(-1)?.dragging(on)
}
