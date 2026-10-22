import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { which, type WhichOptions } from "./which.ts"

/**
 * Acceso a la CLI de Tailscale: ubicar el binario, leer el estado y prender o apagar `tailscale serve`.
 * Solo corre argumentos fijos (sin shell) y nunca emite `reset`, `funnel` ni sudo.
 */

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunOptions {
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  maxBytes?: number
}

export type Runner = (file: string, args: string[], o: RunOptions) => Promise<RunResult>

/** La versión mínima de Tailscale que se admite. */
export const MIN_VERSION = [1, 52] as const

const STATUS_TIMEOUT_MS = 5_000
const SERVE_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const STDERR_MAX = 200

export type TailscaleState =
  | {
      kind: "not_installed" | "timeout" | "stopped" | "needs_login" | "needs_machine_auth" | "https_disabled" | "serve_denied" | "port_in_use" | "error"
      message: string
      version?: string
    }
  | { kind: "outdated"; version: string; message: string }
  | { kind: "ready"; version: string; tailnet: string | null; host: string; ips: string[]; message?: undefined }

export interface ParsedStatus {
  version: string | null
  backendState: string
  dnsName: string | null
  ips: string[]
  tailnet: string | null
  certDomains: string[]
}

// ---------------------------------------------------------------- binario

/** Dónde suele estar la CLI de Tailscale en cada sistema (después de PATH). */
export function tailscaleCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") {
    const root = env.ProgramFiles || "C:\\Program Files"
    return [path.win32.join(root, "Tailscale", "tailscale.exe")]
  }
  if (platform === "darwin") return ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
  return ["/usr/bin/tailscale", "/usr/sbin/tailscale"]
}

export interface Located {
  bin: string
  env?: NodeJS.ProcessEnv
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

const isMacBundle =(bin: string) => bin.endsWith("Tailscale.app/Contents/MacOS/Tailscale")

/** Orden: CONTROL_PLANE_TAILSCALE_BIN, el PATH y las carpetas propias de cada sistema. */
export function locateTailscale(o: WhichOptions = {}): Located | null {
  const platform = o.platform ?? process.platform
  const env = o.env ?? process.env
  const exists = o.exists ?? isFile
  const wrap = (bin: string): Located => (platform === "darwin" && isMacBundle(bin) ? { bin, env: { TAILSCALE_BE_CLI: "1" } } : { bin })

  const fromEnv = env.CONTROL_PLANE_TAILSCALE_BIN
  if (fromEnv && exists(fromEnv)) return wrap(fromEnv)
  const onPath = which("tailscale", { platform, env, exists: o.exists })[0]
  if (onPath) return wrap(onPath)
  for (const c of tailscaleCandidates(platform, env)) if (exists(c)) return wrap(c)
  return null
}

// ---------------------------------------------------------------- estado

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const strOrNull = (v: unknown) => (typeof v === "string" ? v : null)
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/** Lee `status --json` sin lanzar nunca: o el estado, o un error tipado. */
export function parseStatus(stdout: string): ParsedStatus | { error: string } {
  const text = stdout.trim()
  if (!text) return { error: "salida vacía" }
  // Si la CLI antepone un aviso, el JSON empieza en la primera llave.
  const start = text.indexOf("{")
  if (start < 0) return { error: "sin JSON" }
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start))
  } catch {
    return { error: "JSON inválido" }
  }
  if (!isObj(raw)) return { error: "JSON inesperado" }
  const self = isObj(raw.Self) ? raw.Self : {}
  const current = isObj(raw.CurrentTailnet) ? raw.CurrentTailnet : {}
  return {
    version: strOrNull(raw.Version),
    backendState: strOrNull(raw.BackendState) ?? "",
    dnsName: strOrNull(self.DNSName),
    ips: strList(self.TailscaleIPs),
    tailnet: strOrNull(current.Name) ?? strOrNull(current.MagicDNSSuffix) ?? strOrNull(raw.MagicDNSSuffix),
    certDomains: strList(raw.CertDomains),
  }
}

function versionOf(v: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2])] : null
}

const atLeastMin = (v: [number, number]) => v[0] > MIN_VERSION[0] || (v[0] === MIN_VERSION[0] && v[1] >= MIN_VERSION[1])

/** Saca caracteres de control y recorta: lo que dice la CLI se muestra, no se interpreta. */
export function cleanStderr(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\u001b/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, STDERR_MAX)
}

/** Del estado que informa Tailscale al que se muestra. */
export function classify(p: ParsedStatus | { error: string }): TailscaleState {
  if ("error" in p) return { kind: "error", message: "No se pudo leer el estado de Tailscale. Revisá que esté instalado y abierto." }
  const version = p.version ?? ""
  const parsed = versionOf(version)
  if (!parsed) return { kind: "error", message: "No se pudo leer la versión de Tailscale. Revisá que esté instalado y abierto." }
  if (!atLeastMin(parsed)) {
    return { kind: "outdated", version, message: `No se pudo usar Tailscale: se necesita la versión ${MIN_VERSION[0]}.${MIN_VERSION[1]} o superior.` }
  }
  switch (p.backendState) {
    case "Stopped":
      return { kind: "stopped", version, message: "No se pudo usar Tailscale: está apagado. Activalo desde la aplicación o con `tailscale up`." }
    case "NeedsLogin":
      return { kind: "needs_login", version, message: "No se pudo usar Tailscale: falta iniciar sesión. Iniciá sesión desde la aplicación o con `tailscale up`." }
    case "NeedsMachineAuth":
      return { kind: "needs_machine_auth", version, message: "No se pudo usar Tailscale: este equipo espera la aprobación de un administrador de la tailnet." }
    case "Running":
      break
    default:
      return { kind: "error", version, message: "No se pudo usar Tailscale: todavía no terminó de conectarse. Probá de nuevo en un momento." }
  }
  if (!p.certDomains.length || !p.dnsName) {
    return { kind: "https_disabled", version, message: "No se pudo usar Tailscale: falta activar HTTPS y MagicDNS en la tailnet (consola de administración, sección DNS)." }
  }
  return { kind: "ready", version, tailnet: p.tailnet, host: p.dnsName.replace(/\.$/, ""), ips: p.ips }
}

// ---------------------------------------------------------------- serve

const PORT_MSG = (port: unknown) => `No se pudo usar el puerto ${String(port)} para el acceso remoto.`
const TARGET_RE = /^http:\/\/127\.0\.0\.1:\d+$/

function checkPort(port: unknown, mainPort?: unknown): asserts port is number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 443) throw new Error(PORT_MSG(port))
  if (mainPort !== undefined && port === mainPort) throw new Error(PORT_MSG(port))
}

/** El motivo por el que ese puerto no sirve para el acceso remoto, o null si sirve. */
export function httpsPortError(port: unknown, mainPort?: number): string | null {
  try {
    checkPort(port, mainPort)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : PORT_MSG(port)
  }
}

/** `serve --bg --https=<P> <destino>`: el puerto, entre 1024 y 65535, nunca el 443 ni el del server. */
export function serveArgs(httpsPort: number, target: string, mainPort: number): string[] {
  checkPort(httpsPort, mainPort)
  if (typeof target !== "string" || !TARGET_RE.test(target)) throw new Error("No se pudo usar ese destino para el acceso remoto.")
  return ["serve", "--bg", `--https=${httpsPort}`, target]
}

export function serveOffArgs(httpsPort: number): string[] {
  checkPort(httpsPort)
  return ["serve", `--https=${httpsPort}`, "off"]
}

const UNKNOWN_TARGET = "(destino desconocido)"

/** null si la salida no es un `serve status --json` legible. */
function parseServeStrict(stdout: string): Map<number, string> | null {
  const text = stdout.trim()
  if (!text) return new Map()
  const start = text.indexOf("{")
  if (start < 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start))
  } catch {
    return null
  }
  if (!isObj(raw)) return null
  const out = new Map<number, string>()
  const tcp = isObj(raw.TCP) ? raw.TCP : {}
  for (const key of Object.keys(tcp)) {
    const port = Number(key)
    if (Number.isInteger(port)) out.set(port, UNKNOWN_TARGET)
  }
  const web = isObj(raw.Web) ? raw.Web : {}
  for (const [hostPort, entry] of Object.entries(web)) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1))
    if (!Number.isInteger(port) || !isObj(entry)) continue
    const handlers = isObj(entry.Handlers) ? entry.Handlers : {}
    const root = isObj(handlers["/"]) ? handlers["/"] : Object.values(handlers).find(isObj)
    const proxy = root && typeof root.Proxy === "string" ? root.Proxy : null
    out.set(port, proxy ?? UNKNOWN_TARGET)
  }
  return out
}

/** Puerto -> destino de lo que hay publicado con serve. Una salida ilegible da un mapa vacío. */
export function parseServeStatus(stdout: string): Map<number, string> {
  return parseServeStrict(stdout) ?? new Map()
}

// ---------------------------------------------------------------- runner

/** Sin shell, stdin cerrado, tope de salida y el hijo muerto al vencer el plazo. */
export const defaultRunner: Runner = (file, args, o) =>
  new Promise<RunResult>((resolve) => {
    const cap = o.maxBytes ?? MAX_OUTPUT_BYTES
    let stdout = ""
    let stderr = ""
    let bytes = 0
    let timedOut = false
    let settled = false
    let child: ReturnType<typeof spawn>
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child?.kill("SIGKILL")
      } catch {
        // ya había terminado
      }
      // No se espera al cierre de las tuberías: un nieto podría tenerlas abiertas.
      setTimeout(() => finish(null), 100)
    }, o.timeoutMs)
    try {
      child = spawn(file, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: o.env ? { ...process.env, ...o.env } : process.env })
    } catch (err) {
      stderr = cleanStderr(err instanceof Error ? err.message : String(err))
      finish(null)
      return
    }
    const take = (which: "out" | "err") => (chunk: Buffer) => {
      const room = cap - bytes
      if (room <= 0) return
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk
      bytes += piece.length
      if (which === "out") stdout += piece.toString("utf8")
      else stderr += piece.toString("utf8")
      if (bytes >= cap) child.kill("SIGKILL")
    }
    child.stdout?.on("data", take("out"))
    child.stderr?.on("data", take("err"))
    child.on("error", (err) => {
      stderr = cleanStderr(err.message)
      finish(null)
    })
    child.on("close", (code) => finish(timedOut ? null : code))
  })

// ---------------------------------------------------------------- la clase

type Failure = { ok: false; state: TailscaleState }

export interface TailscaleOptions {
  run: Runner
  locate: () => Located | null
  /** El puerto principal del server: serve nunca puede usarlo. */
  mainPort: number
}

/** Lo que falló un comando de serve, en un estado que se pueda mostrar. */
function serveFailure(r: RunResult): TailscaleState {
  if (r.timedOut) return { kind: "timeout", message: "No se pudo hablar con Tailscale: tardó demasiado en responder." }
  const err = cleanStderr(r.stderr)
  const low = err.toLowerCase()
  if (/https|certificate/.test(low) && /not enabled|disabled|enable/.test(low)) {
    return { kind: "https_disabled", message: "No se pudo usar Tailscale: falta activar HTTPS en la tailnet (consola de administración, sección DNS)." }
  }
  if (/denied|permission|operator|sudo|not allowed/.test(low)) {
    return { kind: "serve_denied", message: "No se pudo publicar con Tailscale: este usuario no tiene permiso para administrarlo (probá `tailscale set --operator=<usuario>` una vez)." }
  }
  if (/in use|already|conflict/.test(low)) {
    return { kind: "port_in_use", message: "No se pudo usar ese puerto: ya lo usa otra cosa." }
  }
  return { kind: "error", message: `No se pudo publicar con Tailscale${err ? `: ${err}` : "."}` }
}

export class Tailscale {
  private run: Runner
  private locate: () => Located | null
  private mainPort: number

  constructor(o: TailscaleOptions) {
    this.run = o.run
    this.locate = o.locate
    this.mainPort = o.mainPort
  }

  private notInstalled(): Failure {
    return { ok: false, state: { kind: "not_installed", message: "No se pudo encontrar Tailscale en este equipo." } }
  }

  async status(): Promise<TailscaleState> {
    const found = this.locate()
    if (!found) return this.notInstalled().state
    const r = await this.run(found.bin, ["status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS, env: found.env })
    if (r.timedOut) return { kind: "timeout", message: "No se pudo hablar con Tailscale: tardó demasiado en responder." }
    if (r.code !== 0) {
      const err = cleanStderr(r.stderr)
      if (/daemon|tailscaled|connect|not running/i.test(err)) {
        return { kind: "stopped", message: "No se pudo usar Tailscale: no está corriendo. Abrí la aplicación o iniciá el servicio." }
      }
      return { kind: "error", message: `No se pudo leer el estado de Tailscale${err ? `: ${err}` : "."}` }
    }
    return classify(parseStatus(r.stdout))
  }

  /** El destino publicado en el puerto (null si no hay nada). Una salida ilegible es un error, no "libre". */
  async serveEntry(port: number): Promise<{ ok: true; target: string | null } | Failure> {
    const found = this.locate()
    if (!found) return this.notInstalled()
    const r = await this.run(found.bin, ["serve", "status", "--json"], { timeoutMs: SERVE_TIMEOUT_MS, env: found.env })
    if (r.timedOut || r.code !== 0) return { ok: false, state: serveFailure(r) }
    const map = parseServeStrict(r.stdout)
    if (!map) return { ok: false, state: { kind: "error", message: "No se pudo leer lo que Tailscale tiene publicado." } }
    return { ok: true, target: map.get(port) ?? null }
  }

  async serveOn(port: number, target: string): Promise<{ ok: true } | Failure> {
    let args: string[]
    try {
      args = serveArgs(port, target, this.mainPort)
    } catch (err) {
      return { ok: false, state: { kind: "error", message: err instanceof Error ? err.message : "No se pudo usar ese puerto." } }
    }
    return this.mutate(args)
  }

  async serveOff(port: number): Promise<{ ok: true } | Failure> {
    let args: string[]
    try {
      args = serveOffArgs(port)
    } catch (err) {
      return { ok: false, state: { kind: "error", message: err instanceof Error ? err.message : "No se pudo usar ese puerto." } }
    }
    return this.mutate(args)
  }

  private async mutate(args: string[]): Promise<{ ok: true } | Failure> {
    const found = this.locate()
    if (!found) return this.notInstalled()
    const r = await this.run(found.bin, args, { timeoutMs: SERVE_TIMEOUT_MS, env: found.env })
    if (!r.timedOut && r.code === 0) return { ok: true }
    return { ok: false, state: serveFailure(r) }
  }
}
