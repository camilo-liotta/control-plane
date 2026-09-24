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

/** Achica imágenes muy grandes antes de subirlas (Claude las ve igual de bien y viajan más rápido). */
async function shrinkImage(file: File): Promise<Blob> {
  if (!VISION_TYPES.has(file.type) || file.type === "image/gif") return file
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return file
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) {
    bitmap.close()
    return file
  }
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const type = file.type === "image/png" && file.size <= MAX_IMAGE_BYTES * 2 ? "image/png" : "image/jpeg"
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), type, 0.9))
}

export async function prepareUpload(file: File): Promise<{ name: string; mime: string; data: string; size: number }> {
  const blob = await shrinkImage(file)
  const mime = blob.type || file.type || "application/octet-stream"
  let name = file.name || "pegado"
  if (mime === "image/jpeg" && file.type !== "image/jpeg") name = name.replace(/\.\w+$/, "") + ".jpg"
  return { name, mime, data: await readAsBase64(blob), size: blob.size }
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
