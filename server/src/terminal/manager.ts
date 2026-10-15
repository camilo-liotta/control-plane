// Las terminales del dashboard: una por sesión, del server (no de la pestaña). Sigue viva al
// navegar o recargar (al volver se reenvía lo último que mostró) y se cierra al tocar "Cerrar", al
// archivar o borrar la sesión, al apagar el server o después de un rato sin nadie mirándola.
import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import os from "node:os"

import { childEnv } from "../claude/env.ts"
import { hiddenInput, spawnPty, type Pty } from "./pty.ts"

/** Lo que se guarda para reenviar al reconectar. */
const SCROLLBACK = 256 * 1024
/** Sin ninguna pestaña conectada durante esto, se cierra. */
export const IDLE_MS = 60 * 60 * 1000
/**
 * Cuándo mirar si la entrada está oculta: un rato después de que la salida se quedó quieta (justo
 * cuando aparece un "Password:") y después de cada Enter (una segunda vez, por si el programa
 * tarda en apagar el eco). Sin actividad o sin nadie mirando, no se consulta.
 */
export const PROBE_QUIET_MS = 150
export const PROBE_ENTER_MS = [150, 600]

export interface TerminalClient {
  send(msg: TerminalServerMessage): void
}

/** Del server a la web: salida de la terminal, o que la shell terminó. */
/** Del server a la web: salida de la terminal, que la shell terminó, o si lo que tipeás no se
 * muestra (entrada oculta: una contraseña o un secreto). */
export type TerminalServerMessage = { t: "o"; d: string } | { t: "x"; code: number | null } | { t: "secure"; on: boolean }
/** De la web al server: lo que tipeás, o el tamaño nuevo. */
export type TerminalClientMessage = { t: "i"; d: string } | { t: "r"; c: number; r: number }

interface Terminal {
  sessionId: string
  token: string
  pty: Pty
  buffer: string
  clients: Set<TerminalClient>
  /** Desde cuándo no hay nadie conectado (null: hay alguien). */
  idleSince: number | null
  exited: boolean
  /** Si la entrada está oculta (lo último que se les mandó a las pestañas). */
  secure: boolean
  probe: Prober
}

export interface TerminalsOptions {
  /** La shell de login del usuario. */
  shell?: string
  /** El entorno base (el del server); se le sacan las variables internas. */
  env?: NodeJS.ProcessEnv
  /** Si la sesión sigue existiendo y sin archivar (si no, su terminal se cierra). */
  sessionAlive: (sessionId: string) => boolean
  idleMs?: number
  spawn?: typeof spawnPty
  /** Para los tests: los tiempos de las consultas del modo. */
  probeQuietMs?: number
  probeEnterMs?: number[]
}

export function userShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const s = env.SHELL
  if (s && s.startsWith("/") && fs.existsSync(s)) return s
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash"
}

/** El entorno de la shell: el del usuario, sin lo interno del server, y una terminal a color. */
export function terminalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "control-plane" }, base)
  // Las de otra terminal (la que lanzó el server en desarrollo) no describen esta.
  for (const k of ["TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "ITERM_SESSION_ID", "VTE_VERSION", "TMUX", "TMUX_PANE", "STY", "WINDOWID"]) delete env[k]
  return env
}

export class Terminals {
  private terms = new Map<string, Terminal>()
  private timer: NodeJS.Timeout
  private readonly idleMs: number

  private readonly opts: TerminalsOptions

  constructor(opts: TerminalsOptions) {
    this.opts = opts
    this.idleMs = opts.idleMs ?? IDLE_MS
    this.timer = setInterval(() => this.sweep(), Math.min(30_000, this.idleMs))
    this.timer.unref()
  }

  /** Abre la terminal de la sesión (o devuelve la que ya está) y el token para conectarse. */
  open(sessionId: string, cwd: string, cols = 100, rows = 30): { token: string; created: boolean } {
    const cur = this.terms.get(sessionId)
    if (cur && !cur.exited) return { token: cur.token, created: false }
    const dir = fs.existsSync(cwd) ? cwd : os.homedir()
    const pty = (this.opts.spawn ?? spawnPty)({ shell: this.opts.shell ?? userShell(this.opts.env), cwd: dir, env: terminalEnv(this.opts.env), cols, rows })
    const term: Terminal = {
      sessionId,
      token: randomBytes(24).toString("base64url"),
      pty,
      buffer: "",
      clients: new Set(),
      idleSince: Date.now(),
      exited: false,
      secure: false,
      probe: new Prober(async () => {
        if (term.exited || term.clients.size === 0) return
        const on = hiddenInput(await pty.mode())
        if (on === term.secure || term.exited) return
        term.secure = on
        for (const c of term.clients) c.send({ t: "secure", on })
      }),
    }
    const quiet = this.opts.probeQuietMs ?? PROBE_QUIET_MS
    pty.onData((d) => {
      term.buffer = (term.buffer + d).slice(-SCROLLBACK)
      for (const c of term.clients) c.send({ t: "o", d })
      if (term.clients.size) term.probe.debounce(quiet)
    })
    pty.onExit((code) => {
      term.exited = true
      term.probe.stop()
      for (const c of term.clients) c.send({ t: "x", code })
      if (this.terms.get(sessionId) === term) this.terms.delete(sessionId)
    })
    this.terms.set(sessionId, term)
    return { token: term.token, created: true }
  }

  /** Lo que corre adentro de la shell de la sesión (vacío si no hay terminal o si espera un comando). */
  async running(sessionId: string): Promise<string[]> {
    const term = this.terms.get(sessionId)
    if (!term || term.exited || !term.pty.running) return []
    return term.pty.running().catch(() => [])
  }

  has(sessionId: string) {
    const t = this.terms.get(sessionId)
    return !!t && !t.exited
  }

  /** Conecta una pestaña. Devuelve null si el token no es el de la terminal de esa sesión. */
  attach(sessionId: string, token: string, client: TerminalClient): { receive: (msg: unknown) => void; detach: () => void } | null {
    const term = this.terms.get(sessionId)
    if (!term || term.exited || !sameToken(term.token, token)) return null
    term.clients.add(client)
    term.idleSince = null
    if (term.buffer) client.send({ t: "o", d: term.buffer })
    if (term.secure) client.send({ t: "secure", on: true })
    term.probe.debounce(0)
    const enter = this.opts.probeEnterMs ?? PROBE_ENTER_MS
    return {
      receive: (raw) => {
        const msg = raw as TerminalClientMessage
        if (msg?.t === "i" && typeof msg.d === "string") {
          term.pty.write(msg.d)
          if (/[\r\n]/.test(msg.d)) for (const ms of enter) term.probe.later(ms)
        }
        else if (msg?.t === "r" && Number.isFinite(msg.c) && Number.isFinite(msg.r)) void term.pty.resize(msg.c, msg.r)
      },
      detach: () => {
        term.clients.delete(client)
        if (term.clients.size === 0) term.idleSince = Date.now()
      },
    }
  }

  async close(sessionId: string) {
    const term = this.terms.get(sessionId)
    if (!term) return
    this.terms.delete(sessionId)
    term.probe.stop()
    await term.pty.kill()
  }

  async closeAll() {
    clearInterval(this.timer)
    await Promise.all([...this.terms.keys()].map((id) => this.close(id)))
  }

  /** Cierra las de sesiones archivadas o borradas y las que nadie mira hace rato. */
  sweep(at = Date.now()) {
    for (const [id, t] of this.terms) {
      if (!this.opts.sessionAlive(id) || (t.idleSince !== null && at - t.idleSince >= this.idleMs)) void this.close(id)
    }
  }
}

/**
 * Corre una consulta cuando se le pide, sin superponerlas: si llega un pedido mientras hay una
 * corriendo, se repite una vez al terminar.
 */
class Prober {
  private quiet: NodeJS.Timeout | null = null
  private timers = new Set<NodeJS.Timeout>()
  private running = false
  private again = false
  private stopped = false
  private readonly check: () => Promise<void>
  constructor(check: () => Promise<void>) {
    this.check = check
  }

  /** Consulta cuando pasen `ms` sin otro pedido igual (se reinicia con cada uno). */
  debounce(ms: number) {
    if (this.stopped) return
    if (this.quiet) clearTimeout(this.quiet)
    this.quiet = setTimeout(() => ((this.quiet = null), this.run()), ms)
    this.quiet.unref()
  }

  /** Consulta dentro de `ms`, pase lo que pase en el medio. */
  later(ms: number) {
    if (this.stopped) return
    const t = setTimeout(() => (this.timers.delete(t), this.run()), ms)
    t.unref()
    this.timers.add(t)
  }

  stop() {
    this.stopped = true
    if (this.quiet) clearTimeout(this.quiet)
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private run() {
    if (this.stopped) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    void this.check()
      .catch(() => {})
      .finally(() => {
        this.running = false
        if (this.again && !this.stopped) {
          this.again = false
          this.run()
        }
      })
  }
}

function sameToken(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
