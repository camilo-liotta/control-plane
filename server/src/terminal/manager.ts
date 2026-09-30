// Las terminales del dashboard: una por sesión, del server (no de la pestaña). Sigue viva al
// navegar o recargar (al volver se reenvía lo último que mostró) y se cierra al tocar "Cerrar", al
// archivar o borrar la sesión, al apagar el server o después de un rato sin nadie mirándola.
import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import os from "node:os"

import { childEnv } from "../claude/env.ts"
import { spawnPty, type Pty } from "./pty.ts"

/** Lo que se guarda para reenviar al reconectar. */
const SCROLLBACK = 256 * 1024
/** Sin ninguna pestaña conectada durante esto, se cierra. */
export const IDLE_MS = 60 * 60 * 1000

export interface TerminalClient {
  send(msg: TerminalServerMessage): void
}

/** Del server a la web: salida de la terminal, o que la shell terminó. */
export type TerminalServerMessage = { t: "o"; d: string } | { t: "x"; code: number | null }
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
    const term: Terminal = { sessionId, token: randomBytes(24).toString("base64url"), pty, buffer: "", clients: new Set(), idleSince: Date.now(), exited: false }
    pty.onData((d) => {
      term.buffer = (term.buffer + d).slice(-SCROLLBACK)
      for (const c of term.clients) c.send({ t: "o", d })
    })
    pty.onExit((code) => {
      term.exited = true
      for (const c of term.clients) c.send({ t: "x", code })
      if (this.terms.get(sessionId) === term) this.terms.delete(sessionId)
    })
    this.terms.set(sessionId, term)
    return { token: term.token, created: true }
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
    return {
      receive: (raw) => {
        const msg = raw as TerminalClientMessage
        if (msg?.t === "i" && typeof msg.d === "string") term.pty.write(msg.d)
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

function sameToken(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
