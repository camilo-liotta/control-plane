import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"

import { shortId } from "../util.ts"

export type CliMessage = { type: string; [key: string]: unknown }

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  expected: boolean
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Un proceso `claude -p` en modo stream-json: una sesión viva que recibe mensajes por stdin
 * y emite eventos por stdout, línea a línea.
 */
export class ClaudeProcess extends EventEmitter<{
  message: [CliMessage]
  control_request: [CliMessage]
  exit: [ExitInfo]
}> {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ""
  private stderrLines: string[] = []
  private pending = new Map<string, PendingRequest>()
  private closing = false
  private bin: string
  private args: string[]
  private cwd: string
  private env: NodeJS.ProcessEnv
  exited = false

  constructor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    super()
    this.bin = bin
    this.args = args
    this.cwd = cwd
    this.env = env
  }

  get pid() {
    return this.child?.pid ?? null
  }

  start() {
    const child = spawn(this.bin, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue
        this.stderrLines.push(line)
        if (this.stderrLines.length > 60) this.stderrLines.shift()
      }
    })
    child.stdin.on("error", () => {
      // EPIPE si el proceso murió: lo reporta el evento exit.
    })
    child.on("error", (err) => {
      this.stderrLines.push(String(err.message))
      this.finish(null, null)
    })
    child.on("exit", (code, signal) => this.finish(code, signal))
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exited) return
    this.exited = true
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error("La sesión terminó"))
      this.pending.delete(id)
    }
    this.emit("exit", {
      code,
      signal,
      stderr: this.stderrLines.slice(-20).join("\n"),
      expected: this.closing,
    })
  }

  private onStdout(chunk: string) {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: CliMessage
      try {
        msg = JSON.parse(line) as CliMessage
      } catch {
        continue
      }
      if (msg.type === "control_response") {
        this.onControlResponse(msg)
        continue
      }
      if (msg.type === "control_request") {
        this.emit("control_request", msg)
        continue
      }
      if (msg.type === "keep_alive") continue
      this.emit("message", msg)
    }
  }

  private onControlResponse(msg: CliMessage) {
    const response = msg.response as
      | { subtype: string; request_id: string; response?: Record<string, unknown>; error?: string }
      | undefined
    if (!response) return
    const pending = this.pending.get(response.request_id)
    if (!pending) return
    this.pending.delete(response.request_id)
    clearTimeout(pending.timer)
    if (response.subtype === "success") pending.resolve(response.response ?? {})
    else pending.reject(new Error(response.error ?? "control request failed"))
  }

  send(obj: unknown): boolean {
    if (!this.child || this.exited || this.child.stdin.destroyed) return false
    return this.child.stdin.write(JSON.stringify(obj) + "\n")
  }

  sendUser(text: string, uuid: string, sessionId: string): boolean {
    return this.send({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid,
    })
  }

  /** Pedido de control al CLI (initialize, interrupt, rename_session, ...). */
  request(subtype: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000) {
    const requestId = shortId("req_")
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Timeout esperando respuesta a ${subtype}`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      const ok = this.send({
        type: "control_request",
        request_id: requestId,
        request: { subtype, ...payload },
      })
      if (!ok) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error("La sesión no está corriendo"))
      }
    })
  }

  /** Respuesta a un pedido de control que hizo el CLI (can_use_tool, ...). */
  respond(requestId: string, response: Record<string, unknown>) {
    this.send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    })
  }

  respondError(requestId: string, error: string) {
    this.send({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error },
    })
  }

  /** Cierra stdin para que el CLI termine prolijo; si no, lo mata. */
  close(graceMs = 4000): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child || this.exited) return resolve()
      this.closing = true
      const child = this.child
      const done = () => resolve()
      this.once("exit", done)
      child.stdin.end()
      setTimeout(() => {
        if (!this.exited) child.kill("SIGTERM")
      }, graceMs).unref()
      setTimeout(() => {
        if (!this.exited) child.kill("SIGKILL")
      }, graceMs * 2).unref()
    })
  }
}
