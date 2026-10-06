import type { ModelOption } from "@shared/types"

export const VISION_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const MAX_SIDE = 2000
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el archivo"))
    reader.readAsDataURL(blob)
  })
}

export interface Shrunk {
  /** Lado mayor antes y después, en px. */
  from: number
  to: number
  /** Bytes antes. */
  size: number
}

/** Achica imágenes muy grandes antes de subirlas (Claude las ve igual de bien y viajan más rápido). */
async function shrinkImage(file: File): Promise<{ blob: Blob; shrunk: Shrunk | null }> {
  const same = { blob: file as Blob, shrunk: null }
  if (!VISION_TYPES.has(file.type) || file.type === "image/gif") return same
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return same
  const side = Math.max(bitmap.width, bitmap.height)
  const scale = Math.min(1, MAX_SIDE / side)
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) {
    bitmap.close()
    return same
  }
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const type = file.type === "image/png" && file.size <= MAX_IMAGE_BYTES * 2 ? "image/png" : "image/jpeg"
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), type, 0.9))
  return { blob, shrunk: blob === file ? null : { from: side, to: Math.round(side * scale), size: file.size } }
}

/** Lo que se dice cuando una imagen se achicó para subirla. */
export function shrunkText(s: Shrunk): string {
  return s.to < s.from
    ? `Se achicó de ${s.from} a ${s.to} px para que Claude la pueda ver (máximo ${MAX_SIDE} px y ${formatSize(MAX_IMAGE_BYTES)}).`
    : `Se comprimió desde ${formatSize(s.size)} para que Claude la pueda ver (máximo ${MAX_SIDE} px y ${formatSize(MAX_IMAGE_BYTES)}).`
}

export async function prepareUpload(file: File): Promise<{ name: string; mime: string; data: string; size: number; shrunk: Shrunk | null }> {
  const { blob, shrunk } = await shrinkImage(file)
  const mime = blob.type || file.type || "application/octet-stream"
  let name = file.name || "pegado"
  if (mime === "image/jpeg" && file.type !== "image/jpeg") name = name.replace(/\.\w+$/, "") + ".jpg"
  return { name, mime, data: await readAsBase64(blob), size: blob.size, shrunk }
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }

/**
 * Las imágenes del portapapeles, con la API asíncrona. Para cuando el evento `paste` no las trae:
 * WebKitGTK (la app de escritorio en Linux) solo pone texto en `clipboardData`. Llamala desde el
 * `paste`, que cuenta como gesto del usuario y no pide permiso. Si no se puede leer, devuelve [].
 */
export async function clipboardImages(): Promise<File[]> {
  if (!navigator.clipboard?.read) return []
  try {
    const files: File[] = []
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => VISION_TYPES.has(t))
      if (!type) continue
      const blob = await item.getType(type)
      files.push(new File([blob], `pegado.${EXT[type]}`, { type }))
    }
    return files
  } catch {
    return []
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`
}

/** Nombre legible del modelo que está usando una sesión (el CLI informa el id completo). */
export function modelLabel(models: ModelOption[], current: string | null, configured: string | null): string {
  const byResolved = current ? models.find((m) => m.resolved === current || m.value === current) : undefined
  if (byResolved && byResolved.value !== "default") return byResolved.label.replace(/ \(.*\)$/, "")
  const byValue = configured ? models.find((m) => m.value === configured) : undefined
  if (byValue) return byValue.label.replace(/ \(.*\)$/, "")
  if (current) return current.replace(/^claude-/, "").replace(/-\d{8}$/, "")
  if (configured) return configured
  return "Modelo por defecto"
}
