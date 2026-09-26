import fs from "node:fs"
import path from "node:path"

/** Lo que queda escrito en CONTROL_PLANE_HOME/server.lock mientras corre un server. */
export interface LockInfo {
  pid: number
  port: number
  startedAt: number
}

export class LockError extends Error {}

/** Un server recién lanzado tarda un poco en responder el health: mientras tanto se lo espera. */
const STARTUP_GRACE_MS = 30_000

export interface ServerLock {
  file: string
  release(): void
}

/**
 * Toma la carpeta de datos para este server, así no quedan dos sobre la misma base.
 * Si el lock es de un server vivo (el pid existe y el health de su puerto responde con ese pid)
 * falla con LockError; si no, quedó viejo y se toma.
 */
export async function acquireLock(
  home: string,
  info: LockInfo,
  opts: { graceMs?: number; probe?: (port: number) => Promise<number | null> } = {}
): Promise<ServerLock> {
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(home, "server.lock")
  const probe = opts.probe ?? healthPid
  const grace = opts.graceMs ?? STARTUP_GRACE_MS
  const data = JSON.stringify(info)

  for (let attempt = 0; attempt < 5; attempt++) {
    if (create(file, data)) return { file, release: () => releaseLock(file, info.pid) }
    const raw = readRaw(file)
    if (raw === null) continue // lo soltaron recién: se vuelve a intentar
    const held = parse(raw)
    if (held && (await isAlive(held, probe, grace))) {
      throw new LockError(
        `Ya hay un control-plane usando esta carpeta de datos en el puerto ${held.port} (pid ${held.pid}). Detenelo o usá otro CONTROL_PLANE_HOME.`
      )
    }
    removeIfSame(file, raw)
  }
  throw new LockError(`No pude tomar ${file}: otro server lo está tomando al mismo tiempo. Probá de nuevo.`)
}

/**
 * Crea el lock de forma atómica y ya completo: se escribe aparte (wx) y se enlaza con link,
 * que falla si ya existe. Así nadie llega a leer un lock a medio escribir.
 */
function create(file: string, data: string): boolean {
  const tmp = `${file}.${process.pid}.new`
  fs.writeFileSync(tmp, data)
  try {
    fs.linkSync(tmp, file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    return false
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** Suelta el lock solo si sigue siendo de este proceso (sincrónico: sirve en el evento "exit"). */
export function releaseLock(file: string, pid: number) {
  const held = parse(readRaw(file))
  if (held?.pid !== pid) return
  try {
    fs.unlinkSync(file)
  } catch {
    // ya no estaba
  }
}

async function isAlive(held: LockInfo, probe: (port: number) => Promise<number | null>, grace: number) {
  // Si el server recién arranca todavía no escucha: se espera un rato mientras su pid siga vivo.
  const until = held.startedAt + grace
  for (;;) {
    if (!pidAlive(held.pid)) return false
    if ((await probe(held.port)) === held.pid) return true
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

export function pidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: existe, pero es de otro usuario.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** El pid que informa el control-plane de ese puerto, o null si no hay uno. */
async function healthPid(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const body = (await res.json()) as { app?: unknown; pid?: unknown }
    return body.app === "control-plane" && typeof body.pid === "number" ? body.pid : null
  } catch {
    return null
  }
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

function parse(raw: string | null): LockInfo | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<LockInfo>
    return typeof v.pid === "number" && typeof v.port === "number" ? { pid: v.pid, port: v.port, startedAt: Number(v.startedAt) || 0 } : null
  } catch {
    return null
  }
}

/**
 * Borra el lock viejo solo si sigue siendo el que se miró: si otro server lo tomó mientras tanto,
 * lo devuelve a su lugar (link falla si ya hay uno) y el próximo intento lo evalúa de nuevo.
 */
function removeIfSame(file: string, raw: string) {
  const aside = `${file}.${process.pid}.old`
  try {
    fs.renameSync(file, aside)
  } catch {
    return
  }
  if (readRaw(aside) !== raw) {
    try {
      fs.linkSync(aside, file)
    } catch {
      // ya hay otro: que lo evalúe el próximo intento
    }
  }
  try {
    fs.unlinkSync(aside)
  } catch {
    // no es grave
  }
}
