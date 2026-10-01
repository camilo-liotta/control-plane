import fs from "node:fs"
import path from "node:path"

/**
 * Antes de 0.4.3, después de un /clear el server guardaba el new_conversation_id del
 * conversation_reset, que no es el id con que Claude Code escribe el transcript. Esas sesiones
 * apuntan a una conversación que no existe y, al relanzarlas, arrancan de cero. La conversación de
 * verdad es el transcript que nació en el momento del /clear, con el nombre de la sesión (--name).
 */

/** Cuánto antes y después del aviso del /clear puede empezar el transcript nuevo. */
const BEFORE_MS = 5_000
const AFTER_MS = 120_000

export interface LostConversationQuery {
  /** Carpeta de transcripts del cwd de la sesión, en su cuenta. */
  dir: string
  /** Nombre de la sesión: Claude Code lo guarda como custom-title / agent-name. */
  name: string
  /** Cuándo vio el server cada /clear de la sesión (los avisos de su chat). */
  resets: number[]
  /** Ids que ya usa otra sesión: no se adoptan. */
  taken: Set<string>
}

/** El transcript de la conversación perdida, si hay uno que encaje (el del /clear más reciente). */
export function findLostConversation({ dir, name, resets, taken }: LostConversationQuery): string | null {
  if (!resets.length || !fs.existsSync(dir)) return null
  let best: { id: string; reset: number; mtime: number } | null = null
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue
    const id = f.slice(0, -".jsonl".length)
    if (taken.has(id)) continue
    const file = path.join(dir, f)
    const head = readHead(file)
    if (head.start === null || (head.title !== null && head.title !== name)) continue
    const reset = Math.max(...resets.filter((t) => head.start! >= t - BEFORE_MS && head.start! <= t + AFTER_MS), -Infinity)
    if (reset === -Infinity) continue
    const mtime = fs.statSync(file).mtimeMs
    if (!best || reset > best.reset || (reset === best.reset && mtime > best.mtime)) best = { id, reset, mtime }
  }
  return best?.id ?? null
}

/** Cuándo empieza el transcript y con qué nombre (alcanza con el comienzo del archivo). */
function readHead(file: string): { start: number | null; title: string | null } {
  let start: number | null = null
  let title: string | null = null
  const fd = fs.openSync(file, "r")
  try {
    const chunk = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 128 * 1024))
    fs.readSync(fd, chunk, 0, chunk.length, 0)
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.startsWith("{")) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (start === null && typeof obj.timestamp === "string") {
          const t = Date.parse(obj.timestamp)
          if (Number.isFinite(t)) start = t
        }
        if (title === null && obj.type === "custom-title" && typeof obj.customTitle === "string") title = obj.customTitle
        if (title === null && obj.type === "agent-name" && typeof obj.agentName === "string") title = obj.agentName
        if (start !== null && title !== null) break
      } catch {
        // la última línea puede quedar cortada
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return { start, title }
}
