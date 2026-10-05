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
  /** Las apps del proyecto que el dashboard tenía levantadas (ver apps.ts): se relanzan antes que las sesiones. */
  apps?: string[]
}

/** Lo que necesita el reinicio de las apps levantadas: cuáles corren y cómo relanzarlas. */
export interface RestartApps {
  runningIds(): string[]
  resume(ids: string[]): Promise<{ name: string; error: string }[]>
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
  /** Las esperas antes de cada reintento de las que no arrancaron. */
  retryDelaysMs?: number[]
  apps?: RestartApps
}

/** Esperas entre reintentos: en total ~17 s, lo que tardan en irse los procesos del server viejo. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000]

export class Restart {
  private file: string
  private version: string
  private sessions: SessionManager
  private hub: Hub
  private clock: () => number
  private clientWaitMs: number
  private retryDelaysMs: number[]
  private apps: RestartApps | null
  private armed: { until: number; reason: RestartReason } | null = null
  /** Retomando las sesiones de un reinicio (lo muestra /api/health). */
  resuming = false

  constructor({ home, version, sessions, hub, clock = now, clientWaitMs = 20_000, retryDelaysMs = RETRY_DELAYS_MS, apps }: Deps) {
    this.apps = apps ?? null
    this.clientWaitMs = clientWaitMs
    this.retryDelaysMs = retryDelaysMs
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
      ...(this.apps ? { apps: this.apps.runningIds() } : {}),
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

  /**
   * Retoma las sesiones del último reinicio para actualizar. Las que no arrancan se reintentan con
   * espera (los procesos del server viejo pueden tardar en soltar la conversación); si igual no
   * arrancan, quedan en el log, en un toast y en su chat con el motivo, y no frenan a las demás.
   */
  async resumePending(): Promise<ResumeOutcome> {
    const pending = this.takePending()
    const out: ResumeOutcome = { resumed: [], failed: [] }
    if (!pending) return out
    const toasts: Parameters<Hub["broadcast"]>[0][] = []
    // Primero las apps: así las sesiones que trabajaban encuentran su backend levantado. Una que no
    // levanta no frena a las demás ni a las sesiones; queda en un aviso.
    if (pending.apps?.length && this.apps) {
      const failed = await this.apps.resume(pending.apps).catch((err: unknown) => [{ name: "las apps", error: errorMessage(err) }])
      out.apps = { resumed: pending.apps.length - failed.length, failed }
      for (const f of failed)
        toasts.push({ type: "toast", level: "error", title: `No se pudo volver a levantar ${f.name}`, body: `Después de reiniciar para actualizar: ${f.error}` })
    }
    if (!pending.sessions.length) {
      await this.sendToasts(toasts)
      return out
    }
    this.resuming = true
    try {
      let todo = pending.sessions.filter(({ id }) => {
        const rec = this.sessions.get(id)
        return rec && !rec.archivedAt
      })
      const errors = new Map<string, string>()
      for (let round = 0; todo.length && round <= this.retryDelaysMs.length; round++) {
        if (round > 0) {
          const wait = this.retryDelaysMs[round - 1]!
          const names = todo.map(({ id }) => `${this.sessions.get(id)?.name ?? id} (${errors.get(id)})`).join(", ")
          console.log(`No arrancaron ${names}: reintento en ${Math.round(wait / 1000)} s.`)
          await new Promise((r) => setTimeout(r, wait))
        }
        const again: typeof todo = []
        for (const entry of todo) {
          const res = await this.resumeOne(entry.id, entry.status)
          if (res.ok) {
            out.resumed.push(entry.id)
            if (res.toast) toasts.push(res.toast)
          } else if (res.final) {
            this.giveUp(entry.id, res.error, out, toasts)
          } else {
            errors.set(entry.id, res.error)
            again.push(entry)
          }
        }
        todo = again
      }
      for (const { id } of todo) this.giveUp(id, errors.get(id) ?? "no arrancó", out, toasts)
    } finally {
      this.resuming = false
    }
    await this.sendToasts(toasts)
    return out
  }

  /** Los avisos van cuando hay alguien mirando: el server recién arranca y la web se conecta después. */
  private async sendToasts(toasts: Parameters<Hub["broadcast"]>[0][]) {
    if (!toasts.length) return
    const until = Date.now() + this.clientWaitMs
    while (this.hub.size === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
    for (const t of toasts) this.hub.broadcast(t)
  }

  /** Un intento de retomar una sesión. `final`: no tiene sentido reintentar. */
  private async resumeOne(
    id: string,
    status: LiveStatus
  ): Promise<{ ok: true; toast?: Parameters<Hub["broadcast"]>[0] } | { ok: false; final: boolean; error: string }> {
    const rec = this.sessions.get(id)
    if (!rec || rec.archivedAt) return { ok: false, final: true, error: "la sesión ya no existe" }
    try {
      await this.sessions.start(id)
    } catch (err) {
      const lost = this.sessions.lostConversation(id)
      if (lost) return { ok: false, final: true, error: lostMessage(lost) }
      return { ok: false, final: false, error: errorMessage(err) }
    }
    // Arrancó, pero sin su conversación: pedirle que siga no sirve de nada.
    const lost = this.sessions.lostConversation(id)
    if (lost) return { ok: false, final: true, error: lostMessage(lost) }
    try {
      if (status === "working") {
        await this.sessions.send(id, CONTINUE_PROMPT, {
          origin: "control",
          event: {
            kind: "notice",
            level: "info",
            text: "control-plane se reinició para actualizarse y cortó el turno: se le pidió que revise lo que quedó a medias y siga.",
          },
        })
      } else {
        this.sessions.addEvent(id, {
          kind: "notice",
          level: status === "needs_input" ? "warn" : "info",
          text:
            status === "needs_input"
              ? "control-plane se reinició para actualizarse. Te estaba preguntando algo: esa pregunta se cortó con el proceso, así que contestale acá en el chat."
              : "control-plane se reinició para actualizarse: la sesión volvió a arrancar.",
        })
      }
    } catch (err) {
      return { ok: false, final: false, error: errorMessage(err) }
    }
    if (status !== "needs_input") return { ok: true }
    return {
      ok: true,
      toast: {
        type: "toast",
        level: "warn",
        event: "needs_you",
        title: `${rec.name} te estaba preguntando algo: mirá el chat`,
        body: "control-plane se reinició para actualizarse y la pregunta se cortó. La sesión ya está andando de nuevo.",
        projectId: rec.projectId,
        sessionId: id,
      },
    }
  }

  private giveUp(id: string, error: string, out: ResumeOutcome, toasts: Parameters<Hub["broadcast"]>[0][]) {
    const rec = this.sessions.get(id)
    const name = rec?.name ?? id
    out.failed.push({ id, name, error })
    if (!rec) return
    this.sessions.addEvent(id, {
      kind: "notice",
      level: "error",
      text: `control-plane se reinició para actualizarse y no se pudo retomar esta sesión: ${error}. Si estaba trabajando en algo, pedile que siga desde acá.`,
    })
    toasts.push({
      type: "toast",
      level: "error",
      event: "error",
      title: `No se pudo retomar ${name} después de reiniciar`,
      body: error,
      projectId: rec.projectId,
      sessionId: id,
    })
  }
}

export interface ResumeOutcome {
  resumed: string[]
  failed: { id: string; name: string; error: string }[]
  /** Las apps que se volvieron a levantar (si había). */
  apps?: { resumed: number; failed: { name: string; error: string }[] }
}

const lostMessage = (claudeId: string) =>
  `Claude Code no encontró su conversación (${claudeId}) y arrancó una nueva, sin el contexto de antes`

/** La línea del log al terminar de retomar: cuántas volvieron y cuáles no, con el motivo. */
export function resumeSummary({ resumed, failed, apps }: ResumeOutcome): string | null {
  const appsLine = apps
    ? `Volví a levantar ${apps.resumed} ${apps.resumed === 1 ? "app" : "apps"}${apps.failed.length ? `; no pude con ${apps.failed.map((f) => `${f.name} (${f.error})`).join("; ")}` : ""}.`
    : null
  if (!resumed.length && !failed.length) return appsLine
  const head = `Retomé ${resumed.length} ${resumed.length === 1 ? "sesión" : "sesiones"}`
  const line = !failed.length ? `${head}.` : `${head}; ${failed.length} no ${failed.length === 1 ? "arrancó" : "arrancaron"}: ${failed.map((f) => `${f.name} (${f.error})`).join("; ")}.`
  return appsLine ? `${appsLine} ${line}` : line
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
