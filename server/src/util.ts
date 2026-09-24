import { randomBytes, randomUUID } from "node:crypto"

export const now = () => Date.now()

/** Id corto y legible para URLs (no hace falta que sea un UUID). */
export function shortId(prefix = ""): string {
  return prefix + randomBytes(6).toString("base64url").replace(/[-_]/g, "x")
}

export const uuid = () => randomUUID()

export const token = () => randomBytes(24).toString("base64url")

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/** Nombre apto para direccionar sesiones: letras, dígitos, guiones y guiones bajos. */
export function sanitizeSessionName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 40)
}

export function slug(raw: string): string {
  return sanitizeSessionName(raw).toUpperCase() || "PROYECTO"
}

/** Recorta un JSON arbitrario para guardarlo sin inflar la base. */
export function clampJson(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return undefined
  }
  if (json.length <= maxChars) return value
  return { _truncated: true, preview: json.slice(0, maxChars) }
}

/** Texto plano a partir de markdown (para resúmenes de una línea en tarjetas). */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])\*(?=\S)([^*]+?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
}

export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
