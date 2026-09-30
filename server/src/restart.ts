import fs from "node:fs"
import path from "node:path"

import type { FastifyInstance } from "fastify"

import type { Hub } from "./hub.ts"
import type { SessionManager } from "./sessions.ts"
import type { SessionStatus } from "./shared/types.ts"
import { errorMessage, now } from "./util.ts"

/**
 * Reiniciar para actualizar sin perder el hilo: la app pide `prepare`, apaga el server como siempre
 * (SIGTERM) y, en ese apagado, el server anota qué sesiones tenían el proceso vivo y en qué estado.
 * Al volver a arrancar las retoma: las relanza con --resume, a las que estaban trabajando les pide
 * que sigan y te avisa de las que te estaban preguntando algo. Un "Detener" normal no anota nada.
 */

/** Cuánto dura armado el pedido: si el apagado no llega en ese lapso, se desarma solo. */
export const ARM_MS = 120_000
/** Una lista más vieja que esto no se retoma (algo salió mal y el usuario ya siguió por otro lado). */
export const MAX_AGE_MS = 60 * 60 * 1000
export const RESUME_FILE = "resume.json"

export type RestartReason = "update" | "server-update"
type LiveStatus = Extract<SessionStatus, "idle" | "working" | "needs_input" | "starting">

export interface LiveSession {
  id: string
  name: string
  projectId: string
  projectName: string
  status: LiveStatus
}

export interface RestartPreview {
  version: string
  sessions: LiveSession[]
  working: number
  needsInput: number
}

export interface ResumeFile {
  version: string
  reason: RestartReason
  at: number
  sessions: { id: string; status: LiveStatus }[]
}

/** El mensaje que reciben las que estaban trabajando (Claude lo lee; en el chat se ve el aviso de abajo). */
export const CONTINUE_PROMPT =
  "control-plane se reinició para actualizarse y cortó tu turno. Revisá si quedó algo a medias y seguí con lo que estabas haciendo."

interface Deps {
  home: string
  version: string
  sessions: SessionManager
  hub: Hub
  clock?: () => number
  /** Cuánto esperar a que se conecte la web (o la app) para mandar los avisos: recién arrancó. */
  clientWaitMs?: number
}

export class Restart {
  private file: string
  private version: string
  private sessions: SessionManager
  private hub: Hub
  private clock: () => number
  private clientWaitMs: number
  private armed: { until: number; reason: RestartReason } | null = null
  /** Retomando las sesiones de un reinicio (lo muestra /api/health). */
  resuming = false

  constructor({ home, version, sessions, hub, clock = now, clientWaitMs = 20_000 }: Deps) {
    this.clientWaitMs = clientWaitMs
    this.file = path.join(home, RESUME_FILE)
    this.version = version
    this.sessions = sessions
    this.hub = hub
    this.clock = clock
  }

  preview(): RestartPreview {
    const sessions = this.sessions.liveSessions()
    return {
      version: this.version,
      sessions,
      working: sessions.filter((s) => s.status === "working").length,
      needsInput: sessions.filter((s) => s.status === "needs_input").length,
    }
  }

  prepare(reason: unknown): RestartPreview & { armedUntil: number } {
    const until = this.clock() + ARM_MS
    this.armed = { until, reason: reason === "server-update" ? "server-update" : "update" }
    return { ...this.preview(), armedUntil: until }
  }

  cancel() {
    this.armed = null
  }

  /** En el apagado ordenado, antes de cerrar las sesiones: si hay un pedido vigente, anota cuáles retomar. */
  onShutdown(): ResumeFile | null {
    const armed = this.armed
    this.armed = null
    if (!armed || this.clock() > armed.until) return null
    const data: ResumeFile = {
      version: this.version,
      reason: armed.reason,
      at: this.clock(),
      sessions: this.sessions.liveSessions().map((s) => ({ id: s.id, status: s.status })),
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file + ".tmp", JSON.stringify(data, null, 2))
      fs.renameSync(this.file + ".tmp", this.file)
    } catch (err) {
      console.error(`No pude guardar las sesiones para retomarlas: ${errorMessage(err)}`)
      return null
    }
    return data
  }

  /** Lee y borra la lista pendiente: se toma una sola vez, así un reinicio posterior no la repite. */
  takePending(): ResumeFile | null {
    let data: ResumeFile | null = null
    try {
      data = JSON.parse(fs.readFileSync(this.file, "utf8")) as ResumeFile
    } catch {
      data = null
    }
    fs.rmSync(this.file, { force: true })
    if (!data || !Array.isArray(data.sessions) || typeof data.at !== "number") return null
    if (this.clock() - data.at > MAX_AGE_MS) return null
    return data
  }

  /** Retoma las sesiones del último reinicio para actualizar. Si una no arranca, avisa y sigue. */
  async resumePending(): Promise<{ resumed: string[]; failed: string[] }> {
    const pending = this.takePending()
    const out = { resumed: [] as string[], failed: [] as string[] }
    if (!pending?.sessions.length) return out
    this.resuming = true
    const toasts: Parameters<Hub["broadcast"]>[0][] = []
    try {
      for (const { id, status } of pending.sessions) {
        const rec = this.sessions.get(id)
        if (!rec || rec.archivedAt) continue
        try {
          if (status === "working") {
            await this.sessions.send(id, CONTINUE_PROMPT, {
              origin: "control",
              event: {
                kind: "notice",
                level: "info",
                text: "control-plane se reinició para actualizarse y cortó el turno: le pedí que revise lo que quedó a medias y siga.",
              },
            })
          } else {
            await this.sessions.start(id)
            this.sessions.addEvent(id, {
              kind: "notice",
              level: status === "needs_input" ? "warn" : "info",
              text:
                status === "needs_input"
                  ? "control-plane se reinició para actualizarse. Te estaba preguntando algo: esa pregunta se cortó con el proceso, así que contestale acá en el chat."
                  : "control-plane se reinició para actualizarse: la sesión volvió a arrancar.",
            })
          }
          if (status === "needs_input")
            toasts.push({
              type: "toast",
              level: "warn",
              event: "needs_you",
              title: `${rec.name} te estaba preguntando algo: mirá el chat`,
              body: "control-plane se reinició para actualizarse y la pregunta se cortó. La sesión ya está andando de nuevo.",
              projectId: rec.projectId,
              sessionId: id,
            })
          out.resumed.push(id)
        } catch (err) {
          out.failed.push(id)
          toasts.push({
            type: "toast",
            level: "error",
            event: "error",
            title: `No pude retomar ${rec.name} después de reiniciar`,
            body: errorMessage(err),
            projectId: rec.projectId,
            sessionId: id,
          })
        }
      }
    } finally {
      this.resuming = false
    }
    // Los avisos van cuando hay alguien mirando: el server recién arranca y la web se conecta después.
    if (toasts.length) {
      const until = Date.now() + this.clientWaitMs
      while (this.hub.size === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
      for (const t of toasts) this.hub.broadcast(t)
    }
    return out
  }
}

/** Las rutas del reinicio (pasan por el mismo chequeo de Host y Origin que el resto de la API). */
export function registerRestart(app: FastifyInstance, restart: Restart) {
  app.get("/api/restart/preview", async () => restart.preview())
  app.post<{ Body: { reason?: string } | undefined }>("/api/restart/prepare", async (req) => restart.prepare(req.body?.reason))
  app.post("/api/restart/cancel", async () => {
    restart.cancel()
    return { ok: true }
  })
}
