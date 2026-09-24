import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { config } from "../config.ts"
import type { TimelineEvent, TokenUsage } from "../shared/types.ts"
import { oneLine } from "../util.ts"
import { sessionTokens, StreamNormalizer } from "./normalize.ts"

const run = promisify(execFile)

export interface LiveSession {
  pid?: number
  id?: string
  sessionId?: string
  name?: string
  cwd: string
  kind: "interactive" | "background"
  status?: string
  state?: string
}

/** Cómo invocar Claude Code con una cuenta (su binario y su CLAUDE_CONFIG_DIR). */
export interface ClaudeTarget {
  bin: string
  env: Record<string, string>
  configDir: string
}

/** Sesiones de Claude Code vivas de una cuenta (las del dashboard y las de tus terminales). */
export async function listLiveSessions(target?: ClaudeTarget): Promise<LiveSession[]> {
  try {
    const { stdout } = await run(target?.bin ?? config.claudeBin, ["agents", "--json"], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...(target?.env ?? {}) },
    })
    const list = JSON.parse(stdout) as LiveSession[]
    return Array.isArray(list) ? list.filter((s) => s.pid) : []
  } catch {
    return []
  }
}

/** Carpeta donde Claude Code guarda los transcripts de un directorio de trabajo (dentro de la cuenta). */
export function transcriptDir(cwd: string, configDir?: string): string {
  const base = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  return path.join(base, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"))
}

export interface TranscriptSummary {
  sessionId: string
  name: string | null
  updatedAt: number
  preview: string | null
  sizeKb: number
}

function scanHead(file: string): { name: string | null; preview: string | null } {
  let name: string | null = null
  let preview: string | null = null
  // Alcanza con leer el comienzo y el final del archivo para el nombre y el último prompt.
  const fd = fs.openSync(file, "r")
  try {
    const size = fs.fstatSync(fd).size
    const chunk = Buffer.alloc(Math.min(size, 256 * 1024))
    fs.readSync(fd, chunk, 0, chunk.length, Math.max(0, size - chunk.length))
    for (const line of chunk.toString("utf8").split("\n").reverse()) {
      if (!line.startsWith("{")) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (!name && obj.type === "agent-name" && typeof obj.agentName === "string") name = obj.agentName
        if (!name && obj.type === "custom-title" && typeof obj.customTitle === "string") name = obj.customTitle
        if (!preview && obj.type === "last-prompt" && typeof obj.lastPrompt === "string") preview = oneLine(obj.lastPrompt, 140)
        if (name && preview) break
      } catch {
        // línea cortada al leer desde la mitad
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return { name, preview }
}

/** Conversaciones guardadas para un directorio, las más recientes primero. */
export function listTranscripts(cwd: string, configDir?: string, limit = 40): TranscriptSummary[] {
  const dir = transcriptDir(cwd, configDir)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const file = path.join(dir, f)
      const stat = fs.statSync(file)
      return { file, sessionId: f.replace(/\.jsonl$/, ""), stat }
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, limit)
    .map(({ file, sessionId, stat }) => ({
      sessionId,
      updatedAt: stat.mtimeMs,
      sizeKb: Math.round(stat.size / 1024),
      ...scanHead(file),
    }))
}

export interface RestoredSpend {
  usd: number
  tokens: TokenUsage | null
}

/**
 * Lo que Claude Code va a restaurar al reanudar esta conversación: guarda el costo acumulado en el
 * transcript (entradas "cost-state") y sigue sumando desde ahí. Se busca la última, leyendo desde
 * el final de a pedazos para no cargar transcripts enormes.
 */
export function lastCostState(cwd: string, sessionId: string, configDir?: string): RestoredSpend | null {
  const file = path.join(transcriptDir(cwd, configDir), `${sessionId}.jsonl`)
  let fd: number
  try {
    fd = fs.openSync(file, "r")
  } catch {
    return null
  }
  try {
    const CHUNK = 1024 * 1024
    let end = fs.fstatSync(fd).size
    let carry = ""
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const buf = Buffer.alloc(end - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      const lines = (buf.toString("utf8") + carry).split("\n")
      // La primera línea puede estar cortada: se completa con el pedazo anterior.
      carry = start > 0 ? (lines.shift() ?? "") : ""
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (!line.includes('"cost-state"')) continue
        try {
          const obj = JSON.parse(line) as { type?: string; sessionId?: string; totalCostUSD?: unknown; modelUsage?: unknown }
          if (obj.type !== "cost-state" || (obj.sessionId && obj.sessionId !== sessionId)) continue
          const usd = Number(obj.totalCostUSD)
          return { usd: Number.isFinite(usd) && usd > 0 ? usd : 0, tokens: sessionTokens(obj.modelUsage) }
        } catch {
          // línea incompleta
        }
      }
      end = start
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

const PEER = /<cross-session-message[^>]*from-name="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/

/**
 * Convierte un transcript de Claude Code en eventos de timeline, para ver el historial
 * de una sesión que empezaste fuera del dashboard.
 */
export function readTranscript(
  cwd: string,
  sessionId: string,
  configDir?: string,
  maxEvents = 600
): { events: { ts: number; event: TimelineEvent }[]; name: string | null } {
  const file = path.join(transcriptDir(cwd, configDir), `${sessionId}.jsonl`)
  if (!fs.existsSync(file)) return { events: [], name: null }
  const normalizer = new StreamNormalizer(() => false)
  const events: { ts: number; event: TimelineEvent }[] = []
  let name: string | null = null
  let ts = Date.now()
  const push = (event: TimelineEvent) => events.push({ ts, event })
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type === "agent-name" && typeof obj.agentName === "string") name = obj.agentName
    if (typeof obj.timestamp === "string") ts = Date.parse(obj.timestamp) || ts
    if (obj.isSidechain) continue
    const message = obj.message as { content?: unknown } | undefined
    if (obj.type === "user" && message) {
      const content = message.content
      if (typeof content === "string" || (Array.isArray(content) && content.every((b: { type?: string }) => b.type === "text"))) {
        const text = typeof content === "string" ? content : content.map((b: { text?: string }) => b.text ?? "").join("\n")
        if (obj.turnOrigin === "peer") {
          const m = PEER.exec(text)
          if (m) push({ kind: "peer", from: m[1] || "otra sesión", body: m[2] ?? "" })
          continue
        }
        if (obj.isMeta || !text.trim() || text.startsWith("<")) continue
        push({ kind: "user", text, origin: "external", uuid: String(obj.uuid ?? "") })
        continue
      }
      for (const action of normalizer.handle({ type: "user", message, tool_use_result: obj.toolUseResult, parent_tool_use_id: null })) {
        if (action.type === "event") push(action.event)
      }
      continue
    }
    if (obj.type === "assistant" && message) {
      for (const action of normalizer.handle({ type: "assistant", message, parent_tool_use_id: null })) {
        if (action.type === "event") push(action.event)
      }
    }
  }
  return { events: events.slice(-maxEvents), name }
}
