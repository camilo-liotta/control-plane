import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

import { childEnv } from "./claude/env.ts"
import type { Db } from "./db.ts"
import { splitCommand } from "./editor.ts"
import type { Hub } from "./hub.ts"
import { readRepos } from "./overview.ts"
import type { AppDef, AppHealth, AppInput, AppState, AppSuggestion, AppView } from "./shared/types.ts"
import { errorMessage, now, shortId } from "./util.ts"

/**
 * Las apps del proyecto que se levantan localmente (un backend, un frontend, un worker). Las definen
 * las sesiones del proyecto (por MCP) o el usuario; el server las lanza como procesos propios, cada
 * una en su grupo, con su salida a un log, y sabe si están levantadas mirando su salud (una URL o un
 * puerto). La salud se mira al levantar, después cada tanto mientras la app corre, y de las que no
 * corren solo mientras alguien mira el proyecto (para ver si están "levantadas afuera").
 */

/** Hasta cuánto se espera a que la salud responda al levantar; después queda "sin responder". */
export const START_TIMEOUT_MS = 90_000
/** Cada cuánto se mira la salud de las que corren, y de las demás mientras alguien mira el proyecto. */
export const HEALTH_EVERY_MS = 15_000
/** Cuánto dura "alguien mira el proyecto" desde el último pedido de la web. */
export const WATCH_MS = 45_000
/** Cuánto se espera después del SIGTERM (o del comando de bajar) antes del SIGKILL. */
export const STOP_GRACE_MS = 8_000
/** El log de cada app rota al pasar este tamaño (queda una copia anterior). */
export const LOG_MAX_BYTES = 1024 * 1024
const TAIL_LINES = 200

const stopped = (): AppState => ({ status: "stopped", pid: null, startedAt: null, exitCode: null, signal: null, error: null, tail: [], checkedAt: null })

/** Lo que va en el log y en la cola de líneas en memoria de una app que corre. */
class AppLog {
  readonly file: string
  private fd: number | null = null
  private size = 0
  private lines: string[] = []
  private partial = ""

  constructor(file: string) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.open()
  }

  private open() {
    try {
      this.size = fs.statSync(this.file).size
    } catch {
      this.size = 0
    }
    this.fd = fs.openSync(this.file, "a")
  }

  /** Pasado el tope, el log actual pasa a `.1` (se pisa el anterior) y se empieza uno nuevo. */
  private rotate() {
    if (this.fd !== null) fs.closeSync(this.fd)
    try {
      fs.renameSync(this.file, this.file + ".1")
    } catch {}
    this.size = 0
    this.fd = fs.openSync(this.file, "a")
  }

  write(chunk: Buffer | string) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    if (this.fd === null) return
    if (this.size + buf.length > LOG_MAX_BYTES) this.rotate()
    try {
      fs.writeSync(this.fd!, buf)
      this.size += buf.length
    } catch {}
    const text = this.partial + buf.toString("utf8")
    const parts = text.split(/\r?\n/)
    this.partial = parts.pop() ?? ""
    this.lines.push(...parts)
    if (this.lines.length > TAIL_LINES) this.lines.splice(0, this.lines.length - TAIL_LINES)
  }

  tail(n = TAIL_LINES): string[] {
    const all = this.partial ? [...this.lines, this.partial] : this.lines
    return all.slice(-n)
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd)
    this.fd = null
  }
}

/** Las últimas líneas de un log en disco (para una app que no corre). */
export function readTail(file: string, n = TAIL_LINES): string[] {
  try {
    const fd = fs.openSync(file, "r")
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(size, 64 * 1024)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      const lines = buf.toString("utf8").split(/\r?\n/)
      if (lines.at(-1) === "") lines.pop()
      if (len < size) lines.shift() // la primera puede estar cortada
      return lines.slice(-n)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
}

/** Si la salud responde: la URL contesta (cualquier respuesta menor a 500) o el puerto acepta conexiones. */
export async function checkHealth(h: AppHealth, timeoutMs = 2_000): Promise<boolean> {
  if (h.kind === "http") {
    try {
      const res = await fetch(h.url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" })
      await res.body?.cancel().catch(() => {})
      return res.status < 500
    } catch {
      return false
    }
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host: h.host || "127.0.0.1", port: h.port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}

/** Los argumentos de un comando sin shell; rechaza lo que solo tiene sentido con una (&&, pipes, redirecciones). */
export function commandArgs(command: string, shell: boolean): string[] {
  if (shell) return ["/bin/sh", "-c", command]
  const args = splitCommand(command)
  if (!args.length) throw new Error("Falta el comando")
  if (args.some((a) => /^(&&|\|\||\||;|&)$/.test(a) || /^\d?>>?/.test(a) || a.startsWith("<")))
    throw new Error("El comando usa && , pipes o redirecciones: marcalo con shell: true para que corra en una shell")
  return args
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}
const inside = (root: string, p: string) => {
  const rel = path.relative(root, p)
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * La carpeta real donde corre una app: `cwd` relativa a la del proyecto (o absoluta), que tiene que
 * existir y caer, por realpath, dentro de la carpeta del proyecto o de uno de sus repos o worktrees.
 */
export function appDir(projectRoot: string, cwd: string, roots: string[] = []): string {
  if (typeof cwd !== "string" || cwd.includes("\0")) throw new Error("Carpeta inválida")
  const target = real(path.resolve(projectRoot, cwd || "."))
  if (!target || !fs.statSync(target).isDirectory()) throw new Error(`No existe la carpeta ${cwd || "."} en el proyecto`)
  const allowed = [projectRoot, ...roots].map(real).filter((r): r is string => r !== null)
  if (!allowed.some((r) => inside(r, target))) throw new Error("La carpeta de la app está fuera del proyecto (y de sus worktrees)")
  return target
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Valida y completa una definición (nueva o un cambio sobre `cur`). */
export function normalizeApp(input: AppInput, cur?: AppDef): Omit<AppDef, "id" | "projectId" | "createdBy" | "createdAt" | "updatedAt"> {
  const pick = <K extends keyof AppInput>(k: K) => (input[k] !== undefined ? input[k] : cur?.[k as keyof AppDef]) as AppInput[K]
  const name = String(pick("name") ?? "").trim()
  if (!name) throw new Error("Falta el nombre de la app")
  if (name.length > 60) throw new Error("El nombre es muy largo")
  const command = String(pick("command") ?? "").trim()
  if (!command) throw new Error("Falta el comando")
  if (command.length > 4000) throw new Error("El comando es muy largo")
  const shell = !!pick("shell")
  commandArgs(command, shell)
  const cwd = String(pick("cwd") ?? "").trim()
  if (cwd.length > 500) throw new Error("La carpeta es muy larga")
  const envIn = pick("env") ?? {}
  if (typeof envIn !== "object" || Array.isArray(envIn)) throw new Error("Las variables van como un objeto { NOMBRE: valor }")
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(envIn)) {
    if (!ENV_KEY.test(k)) throw new Error(`Nombre de variable inválido: ${k}`)
    env[k] = String(v)
  }
  if (Object.keys(env).length > 50) throw new Error("Demasiadas variables")
  const h = pick("health") ?? null
  let health: AppHealth | null = null
  if (h) {
    if (h.kind === "http") {
      if (!/^https?:\/\/\S+$/i.test(String(h.url ?? ""))) throw new Error("La URL de salud tiene que ser http:// o https://")
      health = { kind: "http", url: String(h.url) }
    } else if (h.kind === "tcp") {
      const port = Number(h.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("El puerto tiene que ser un número entre 1 y 65535")
      health = { kind: "tcp", port, ...(h.host ? { host: String(h.host) } : {}) }
    } else throw new Error('La salud es { kind: "http", url } o { kind: "tcp", port }')
  }
  const urlIn = pick("url")
  const url = urlIn ? String(urlIn).trim() : null
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error("La URL tiene que ser http:// o https://")
  const stopIn = pick("stopCommand")
  const stopCommand = stopIn ? String(stopIn).trim() || null : null
  if (stopCommand) commandArgs(stopCommand, shell)
  return { name, command, shell, cwd, env, health, url, stopCommand }
}

interface Running {
  child: ChildProcess
  log: AppLog
  stopping: boolean
  exited: Promise<void>
}

export interface AppsDeps {
  db: Db
  hub: Hub
  home: string
  /** Los demás repos y worktrees del proyecto (donde también puede correr una app). */
  repos?: (projectRoot: string) => Promise<string[]>
  startTimeoutMs?: number
  healthEveryMs?: number
  stopGraceMs?: number
}

export class Apps {
  private db: Db
  private hub: Hub
  private logDir: string
  private repos: (root: string) => Promise<string[]>
  private startTimeoutMs: number
  private healthEveryMs: number
  private stopGraceMs: number
  private states = new Map<string, AppState>()
  private running = new Map<string, Running>()
  private watched = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private probing = new Set<string>()
  private disposed = false

  constructor({ db, hub, home, repos, startTimeoutMs = START_TIMEOUT_MS, healthEveryMs = HEALTH_EVERY_MS, stopGraceMs = STOP_GRACE_MS }: AppsDeps) {
    this.db = db
    this.hub = hub
    this.logDir = path.join(home, "apps")
    this.repos = repos ?? (async (root) => (await readRepos(root).catch(() => [])).map((r) => r.path))
    this.startTimeoutMs = startTimeoutMs
    this.healthEveryMs = healthEveryMs
    this.stopGraceMs = stopGraceMs
  }

  private logFile(id: string) {
    return path.join(this.logDir, `${id}.log`)
  }

  private projectRoot(projectId: string): string {
    const p = this.db.getProject(projectId)
    if (!p) throw new Error("No existe el proyecto")
    return p.repoPath
  }

  private require(id: string): AppDef {
    const a = this.db.getApp(id)
    if (!a) throw new Error("No existe esa app")
    return a
  }

  /** Por id o por nombre (sin distinguir mayúsculas) dentro del proyecto. */
  find(projectId: string, ref: string): AppDef {
    const list = this.db.listApps(projectId)
    const a = list.find((x) => x.id === ref) ?? list.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase())
    if (!a) throw new Error(`No hay una app "${ref}" en el proyecto. Las que hay: ${list.map((x) => x.name).join(", ") || "ninguna"}`)
    return a
  }

  view(a: AppDef): AppView {
    const state = this.states.get(a.id) ?? stopped()
    const fromHealth = a.health ? (a.health.kind === "http" ? a.health.url : `http://${a.health.host || "127.0.0.1"}:${a.health.port}`) : null
    return { ...a, url: a.url ?? fromHealth, definedUrl: a.url, state }
  }

  list(projectId: string): AppView[] {
    return this.db.listApps(projectId).map((a) => this.view(a))
  }

  all(): AppView[] {
    return this.db.listApps().map((a) => this.view(a))
  }

  private broadcast(projectId: string) {
    if (!this.disposed) this.hub.broadcast({ type: "apps", projectId, apps: this.list(projectId) })
  }

  private setState(a: AppDef, patch: Partial<AppState>) {
    const cur = this.states.get(a.id) ?? stopped()
    const next = { ...cur, ...patch }
    this.states.set(a.id, next)
    if (cur.status !== next.status || cur.pid !== next.pid || patch.tail || patch.error !== undefined) this.broadcast(a.projectId)
  }

  private async validDir(projectId: string, cwd: string): Promise<string> {
    const root = this.projectRoot(projectId)
    try {
      return appDir(root, cwd)
    } catch (err) {
      // Afuera de la carpeta del proyecto, puede estar en uno de sus worktrees.
      if (!/fuera del proyecto/.test(errorMessage(err))) throw err
      return appDir(root, cwd, await this.repos(root))
    }
  }

  async create(projectId: string, input: AppInput, createdBy: string | null): Promise<AppView> {
    this.projectRoot(projectId)
    const def = normalizeApp(input)
    if (this.db.listApps(projectId).some((a) => a.name.toLowerCase() === def.name.toLowerCase()))
      throw new Error(`Ya hay una app "${def.name}" en el proyecto: cambiala con update_app o elegí otro nombre`)
    await this.validDir(projectId, def.cwd)
    const t = now()
    const app: AppDef = { id: shortId("a_"), projectId, ...def, createdBy, createdAt: t, updatedAt: t }
    this.db.insertApp(app)
    this.broadcast(projectId)
    void this.probe(app)
    return this.view(app)
  }

  /** Cambia la definición; si la app corre, lo nuevo vale desde el próximo levantar. */
  async update(id: string, input: AppInput): Promise<AppView> {
    const cur = this.require(id)
    const def = normalizeApp(input, cur)
    if (this.db.listApps(cur.projectId).some((a) => a.id !== id && a.name.toLowerCase() === def.name.toLowerCase())) throw new Error(`Ya hay otra app "${def.name}"`)
    await this.validDir(cur.projectId, def.cwd)
    const next: AppDef = { ...cur, ...def, updatedAt: now() }
    this.db.updateApp(next)
    this.broadcast(cur.projectId)
    return this.view(next)
  }

  async remove(id: string): Promise<void> {
    const a = this.require(id)
    if (this.running.has(id)) await this.stop(id)
    this.db.deleteApp(id)
    this.states.delete(id)
    for (const f of [this.logFile(id), this.logFile(id) + ".1"]) fs.rmSync(f, { force: true })
    this.broadcast(a.projectId)
  }

  /** Baja y borra las apps de un proyecto que se va a borrar. */
  async removeProject(projectId: string): Promise<void> {
    for (const a of this.db.listApps(projectId)) await this.remove(a.id).catch(() => {})
  }

  /** Las que lanzó el dashboard y siguen corriendo (para retomarlas después de reiniciar). */
  runningIds(): string[] {
    return [...this.running.entries()].filter(([, r]) => !r.stopping).map(([id]) => id)
  }

  /** El log: las últimas líneas (de memoria si corre, del archivo si no). */
  log(id: string, n = TAIL_LINES): string[] {
    this.require(id)
    return this.running.get(id)?.log.tail(n) ?? readTail(this.logFile(id), n)
  }

  async start(id: string): Promise<AppView> {
    const a = this.require(id)
    if (this.running.has(id)) return this.view(a)
    // Si ya responde y no la lanzamos nosotros, la levantó otro: no se lanza de nuevo.
    if (a.health && (await checkHealth(a.health))) {
      this.setState(a, { ...stopped(), status: "external", checkedAt: now() })
      throw new Error(`${a.name} ya está levantada afuera del dashboard (su salud responde): no la lanzo de nuevo`)
    }
    const cwd = await this.validDir(a.projectId, a.cwd)
    const args = commandArgs(a.command, a.shell)
    const log = new AppLog(this.logFile(id))
    log.write(`\n--- ${new Date().toISOString()} · levantando: ${a.command} (en ${cwd}) ---\n`)
    let child: ChildProcess
    try {
      child = spawn(args[0]!, args.slice(1), { cwd, env: childEnv(a.env), detached: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      log.close()
      this.setState(a, { ...stopped(), status: "crashed", error: errorMessage(err), tail: log.tail(20) })
      throw err
    }
    let resolveExit!: () => void
    const entry: Running = { child, log, stopping: false, exited: new Promise((r) => (resolveExit = r)) }
    this.running.set(id, entry)
    child.stdout?.on("data", (d: Buffer) => log.write(d))
    child.stderr?.on("data", (d: Buffer) => log.write(d))
    let spawnError: string | null = null
    child.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code
      spawnError = code === "ENOENT" ? `No encontré \`${args[0]}\` en el PATH` : errorMessage(err)
      log.write(`--- ${spawnError} ---\n`)
      if (child.pid === undefined) finish(null, null)
    })
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.running.get(id) !== entry) return
      this.running.delete(id)
      // Lo que escribió la app (sin las marcas del dashboard), para ver por qué se cayó.
      const tail = log.tail(60).filter((l) => !l.startsWith("--- ")).slice(-40)
      while (tail.length && !tail[0]!.trim()) tail.shift()
      log.write(`--- ${new Date().toISOString()} · terminó${code !== null ? ` con código ${code}` : signal ? ` por ${signal}` : ""} ---\n`)
      log.close()
      const def = this.db.getApp(id) ?? a
      if (entry.stopping) this.setState(def, { ...stopped(), checkedAt: now() })
      else this.setState(def, { status: "crashed", pid: null, exitCode: code, signal, error: spawnError, tail })
      resolveExit()
      this.schedule()
    }
    child.once("exit", (code, signal) => finish(code, signal))
    this.setState(a, { ...stopped(), status: "starting", pid: child.pid ?? null, startedAt: now() })
    this.schedule()
    void this.waitUp(a, entry)
    return this.view(a)
  }

  /** Al levantar: mira la salud seguido hasta que responde o pasa el tope. */
  private async waitUp(a: AppDef, entry: Running) {
    const deadline = now() + this.startTimeoutMs
    let delay = 300
    while (this.running.get(a.id) === entry && !entry.stopping) {
      if (!a.health) {
        // Sin salud: levantada si el proceso sigue vivo un momento después de arrancar.
        await new Promise((r) => setTimeout(r, 1_000))
        if (this.running.get(a.id) === entry && !entry.stopping) this.setState(a, { status: "up", checkedAt: now() })
        return
      }
      if (await checkHealth(a.health, 1_500)) {
        if (this.running.get(a.id) === entry && !entry.stopping) this.setState(a, { status: "up", checkedAt: now() })
        return
      }
      if (now() > deadline) {
        if (this.running.get(a.id) === entry && !entry.stopping) this.setState(a, { status: "unresponsive", checkedAt: now() })
        return
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 2_000)
    }
  }

  private killGroup(entry: Running, signal: NodeJS.Signals) {
    const pid = entry.child.pid
    if (!pid) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        entry.child.kill(signal)
      } catch {}
    }
  }

  private waitExit(entry: Running, ms: number): Promise<boolean> {
    return Promise.race([entry.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
  }

  /** Corre el comando de bajar en la carpeta de la app (con el mismo entorno). */
  private async runStopCommand(a: AppDef): Promise<void> {
    if (!a.stopCommand) return
    const cwd = await this.validDir(a.projectId, a.cwd)
    const args = commandArgs(a.stopCommand, a.shell)
    const log = this.running.get(a.id)?.log
    log?.write(`--- bajando con: ${a.stopCommand} ---\n`)
    await new Promise<void>((resolve) => {
      const child = spawn(args[0]!, args.slice(1), { cwd, env: childEnv(a.env), stdio: ["ignore", "pipe", "pipe"] })
      child.stdout?.on("data", (d: Buffer) => log?.write(d))
      child.stderr?.on("data", (d: Buffer) => log?.write(d))
      const t = setTimeout(() => child.kill("SIGKILL"), 60_000)
      child.once("error", () => {
        clearTimeout(t)
        resolve()
      })
      child.once("exit", () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  /** Baja una app que lanzó el dashboard: su comando de bajar si tiene; si no, SIGTERM al grupo, espera y SIGKILL. */
  async stop(id: string): Promise<AppView> {
    const a = this.require(id)
    const entry = this.running.get(id)
    if (!entry) {
      if (this.states.get(id)?.status === "external") throw new Error(`${a.name} la levantó otro programa, no el dashboard: no la bajo`)
      this.setState(a, { ...stopped(), checkedAt: now() })
      return this.view(a)
    }
    entry.stopping = true
    if (a.stopCommand) {
      await this.runStopCommand(a).catch((err) => entry.log.write(`--- no pude correr el comando de bajar: ${errorMessage(err)} ---\n`))
      if (await this.waitExit(entry, this.stopGraceMs)) return this.view(this.db.getApp(id) ?? a)
    }
    this.killGroup(entry, "SIGTERM")
    if (!(await this.waitExit(entry, this.stopGraceMs))) {
      entry.log.write("--- no terminó con SIGTERM: SIGKILL ---\n")
      this.killGroup(entry, "SIGKILL")
      await this.waitExit(entry, 3_000)
    }
    return this.view(this.db.getApp(id) ?? a)
  }

  async restart(id: string): Promise<AppView> {
    await this.stop(id)
    return this.start(id)
  }

  async startAll(projectId: string): Promise<{ started: string[]; failed: { name: string; error: string }[] }> {
    const out = { started: [] as string[], failed: [] as { name: string; error: string }[] }
    for (const a of this.db.listApps(projectId)) {
      if (this.running.has(a.id) || this.states.get(a.id)?.status === "external") continue
      try {
        await this.start(a.id)
        out.started.push(a.name)
      } catch (err) {
        out.failed.push({ name: a.name, error: errorMessage(err) })
      }
    }
    return out
  }

  async stopAll(projectId?: string): Promise<void> {
    const ids = [...this.running.keys()].filter((id) => !projectId || this.db.getApp(id)?.projectId === projectId)
    await Promise.all(ids.map((id) => this.stop(id).catch(() => {})))
  }

  /** Vuelve a levantar las que estaban arriba antes de reiniciar. Devuelve las que no pudo. */
  async resume(ids: string[]): Promise<{ name: string; error: string }[]> {
    const failed: { name: string; error: string }[] = []
    for (const id of ids) {
      const a = this.db.getApp(id)
      if (!a) continue
      try {
        await this.start(id)
      } catch (err) {
        failed.push({ name: a.name, error: errorMessage(err) })
      }
    }
    return failed
  }

  /** La web avisa que alguien mira el proyecto: mientras dure, se mira la salud de las que no corren. */
  watch(projectId: string) {
    const first = !this.watched.has(projectId) || now() - this.watched.get(projectId)! > WATCH_MS
    this.watched.set(projectId, now())
    if (first) for (const a of this.db.listApps(projectId)) void this.probe(a)
    this.schedule()
  }

  /** Mira la salud de una app: las que corren pasan entre levantada y sin responder; las demás, entre detenida y levantada afuera. */
  private async probe(a: AppDef) {
    if (!a.health || this.probing.has(a.id)) return
    const st = this.states.get(a.id)
    if (st?.status === "starting") return
    this.probing.add(a.id)
    try {
      const ok = await checkHealth(a.health)
      const def = this.db.getApp(a.id)
      if (!def) return
      const cur = this.states.get(a.id) ?? stopped()
      if (this.running.has(a.id)) {
        if (cur.status === "up" || cur.status === "unresponsive") this.setState(def, { status: ok ? "up" : "unresponsive", checkedAt: now() })
      } else if (ok && (cur.status === "stopped" || cur.status === "crashed")) this.setState(def, { ...stopped(), status: "external", checkedAt: now() })
      else if (!ok && cur.status === "external") this.setState(def, { ...stopped(), checkedAt: now() })
      else this.states.set(a.id, { ...cur, checkedAt: now() })
    } finally {
      this.probing.delete(a.id)
    }
  }

  /** Un solo timer, prendido solo si hay apps corriendo o un proyecto mirado hace poco. */
  private schedule() {
    const busy = () => this.running.size > 0 || [...this.watched.values()].some((t) => now() - t < WATCH_MS)
    if (this.disposed || !busy()) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    if (this.timer) return
    this.timer = setInterval(() => {
      if (!busy()) return this.schedule()
      const watched = new Set([...this.watched.entries()].filter(([, t]) => now() - t < WATCH_MS).map(([p]) => p))
      for (const a of this.db.listApps()) if (this.running.has(a.id) || watched.has(a.projectId)) void this.probe(a)
    }, this.healthEveryMs)
    this.timer.unref()
  }

  /** Al apagar el server: baja todas, ordenadas (en paralelo, cada una con su espera). */
  async shutdown(): Promise<void> {
    await this.stopAll()
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Lo que parece haber en el repo para levantar. Solo sugerencias: el usuario las confirma. */
  async suggest(projectId: string): Promise<AppSuggestion[]> {
    const root = this.projectRoot(projectId)
    const have = new Set(this.db.listApps(projectId).map((a) => `${a.cwd}\0${a.command}`))
    return suggestApps(root).filter((s) => !have.has(`${s.cwd ?? ""}\0${s.command}`))
  }
}

/** Un puerto que aparece en un script (`--port 5173`, `-p 3000`, `PORT=8080`) o el de la herramienta conocida. */
function guessPort(script: string): number | null {
  const m = /(?:--port[= ]|-p |PORT=)(\d{2,5})/.exec(script)
  if (m) return Number(m[1])
  if (/\bvite\b/.test(script)) return 5173
  if (/\bnext\b/.test(script) || /\breact-scripts\b/.test(script) || /\bremix\b/.test(script)) return 3000
  if (/\bastro\b/.test(script)) return 4321
  return null
}

/** Sugerencias a partir de package.json (dev/start), docker compose y Procfile, en la raíz y un nivel abajo. */
export function suggestApps(root: string): AppSuggestion[] {
  const out: AppSuggestion[] = []
  const dirs = [""]
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") dirs.push(e.name)
    }
  } catch {}
  for (const rel of dirs) {
    const dir = path.join(root, rel)
    const label = (what: string) => (rel ? `${rel}/${what}` : what)
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string>; workspaces?: unknown }
      const script = pkg.scripts?.dev ? "dev" : pkg.scripts?.start ? "start" : null
      if (script) {
        const port = guessPort(pkg.scripts![script]!)
        out.push({
          name: (pkg.name?.replace(/^@[^/]+\//, "") || rel || path.basename(root)).slice(0, 60),
          command: `npm run ${script}`,
          cwd: rel,
          ...(port ? { health: { kind: "tcp" as const, port } } : {}),
          source: `${label("package.json")}: ${script}`,
        })
      }
    } catch {}
    for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      if (!fs.existsSync(path.join(dir, f))) continue
      out.push({ name: rel ? `${rel} (compose)` : "docker compose", command: "docker compose up", stopCommand: "docker compose down", cwd: rel, source: label(f) })
      break
    }
    try {
      for (const line of fs.readFileSync(path.join(dir, "Procfile"), "utf8").split("\n")) {
        const m = /^([\w-]+):\s*(.+)$/.exec(line.trim())
        if (m) out.push({ name: rel ? `${rel} ${m[1]}` : m[1]!, command: m[2]!, shell: true, cwd: rel, source: `${label("Procfile")}: ${m[1]}` })
      }
    } catch {}
  }
  return out
}
