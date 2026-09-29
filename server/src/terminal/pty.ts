// Un pseudo-terminal sin módulos nativos: `script(1)` (util-linux en Linux, BSD en la Mac) abre el
// PTY y corre la shell adentro; nosotros le hablamos por stdin/stdout. El tamaño se cambia desde
// afuera con `stty` sobre el lado esclavo del PTY: el kernel le manda SIGWINCH a la shell.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

export interface PtyOptions {
  /** La shell del usuario (se abre como shell de login). */
  shell: string
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
}

export interface Pty {
  /** El pid de la shell (adentro del PTY), cuando ya arrancó. */
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): Promise<void>
  /** Corta la shell y todo lo que lanzó. Resuelve cuando no queda nada. */
  kill(): Promise<void>
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number | null) => void): void
}

/** Comillas simples de sh: el texto no se interpreta. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n) || lo))

/**
 * Lo que corre adentro del PTY: fija el tamaño inicial y reemplaza el proceso por la shell de
 * login. Va por `/bin/sh` para no depender de la sintaxis de la shell del usuario (fish, etc.).
 */
export function innerScript(shell: string, cols: number, rows: number) {
  return `stty rows ${rows} cols ${cols} 2>/dev/null; SHELL=${shQuote(shell)}; export SHELL; exec "$SHELL" -l`
}

/** El comando de `script` para cada sistema. */
export function scriptCommand(platform: NodeJS.Platform, inner: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (platform === "darwin") {
    // BSD: script [-q] archivo comando…, que lo ejecuta directo. En la Mac, el stdin que le da Node
    // a un hijo es un socket, y ahí el script de BSD corta ("tcgetattr/ioctl: Operation not
    // supported on socket"): con `cat |` delante, su stdin es un pipe de verdad.
    return { file: "/bin/sh", args: ["-c", 'cat | /usr/bin/script -q /dev/null /bin/sh -c "$1"', "sh", inner], env: {} }
  }
  // util-linux: -c pasa por $SHELL -c; -f escribe cada salida al toque. El ECHO del esclavo queda
  // prendido (stdin es un pipe), así lo que tipeás se ve también en programas que no son la shell.
  return { file: "script", args: ["-q", "-f", "-c", inner, "/dev/null"], env: { SHELL: "/bin/sh" } }
}

export function spawnPty(opts: PtyOptions, platform: NodeJS.Platform = process.platform): Pty {
  const cols = clamp(opts.cols, 2, 1000)
  const rows = clamp(opts.rows, 1, 1000)
  const cmd = scriptCommand(platform, innerScript(opts.shell, cols, rows))
  const child: ChildProcessWithoutNullStreams = spawn(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env: { ...opts.env, ...cmd.env },
    stdio: "pipe",
    // Grupo propio: al cerrar se lo corta entero, sin tocar al server.
    detached: true,
  })
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdin.on("error", () => {})

  let shellPid = 0
  let tty: string | null = null
  let exited = false
  const exitCbs: ((code: number | null) => void)[] = []
  child.on("exit", (code) => {
    exited = true
    for (const cb of exitCbs) cb(code)
  })
  child.on("error", () => {
    exited = true
    for (const cb of exitCbs) cb(null)
  })

  /** El pid de la shell y su tty (`/dev/pts/N` o `/dev/ttysNNN`), sin /proc: anda igual en la Mac. */
  const locate = async () => {
    if (shellPid && tty) return { pid: shellPid, tty }
    for (let i = 0; i < 20 && !exited; i++) {
      // La shell es el primer descendiente con terminal (en la Mac cuelga de sh → script).
      const tree = await processTree()
      const mine = new Set(descendants(tree, child.pid!))
      const kid = tree.find((p) => mine.has(p.pid) && p.tty && p.tty !== "??" && p.tty !== "?")
      if (kid) {
        shellPid = kid.pid
        tty = kid.tty.startsWith("/dev/") ? kid.tty : `/dev/${kid.tty}`
        return { pid: shellPid, tty }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }
  void locate()

  return {
    get pid() {
      return shellPid
    },
    write: (data) => {
      if (!exited) child.stdin.write(data)
    },
    resize: async (c, r) => {
      const where = await locate()
      if (!where) return
      const flag = platform === "darwin" ? "-f" : "-F"
      await run("stty", [flag, where.tty, "rows", String(clamp(r, 1, 1000)), "cols", String(clamp(c, 2, 1000))]).catch(() => {})
    },
    kill: async () => {
      if (exited) return
      // Todo lo que cuelga de script: la shell, lo que corre en primer plano y los jobs de fondo
      // (cada uno en su grupo). Primero SIGHUP, como al cerrar una terminal; lo que quede, SIGKILL.
      const tree = await processTree()
      const pids = descendants(tree, child.pid!)
      for (const pid of [...pids, child.pid!]) signal(pid, "SIGHUP")
      await waitFor(() => exited && pids.every((p) => !alive(p)), 1500)
      for (const pid of [...pids, child.pid!]) if (alive(pid)) signal(pid, "SIGKILL")
      // Hasta que los cosechen (un zombi todavía responde a kill 0).
      await waitFor(() => exited && pids.every((p) => !alive(p)), 3000)
    },
    onData: (cb) => {
      child.stdout.on("data", cb)
      child.stderr.on("data", cb)
    },
    onExit: (cb) => {
      if (exited) cb(child.exitCode)
      else exitCbs.push(cb)
    },
  }
}

interface Proc {
  pid: number
  ppid: number
  tty: string
}

/** Todos los procesos, con `ps` (el mismo formato en Linux y en la Mac). */
async function processTree(): Promise<Proc[]> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "tty="]).catch(() => ({ stdout: "" }))
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 2)
    .map(([pid, ppid, tty]) => ({ pid: Number(pid), ppid: Number(ppid), tty: tty ?? "" }))
}

export function descendants(tree: { pid: number; ppid: number }[], root: number): number[] {
  const out: number[] = []
  const queue = [root]
  while (queue.length) {
    const p = queue.shift()!
    for (const c of tree) if (c.ppid === p && !out.includes(c.pid)) (out.push(c.pid), queue.push(c.pid))
  }
  return out
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig)
  } catch {
    // ya no está
  }
}
async function waitFor(ok: () => boolean, ms: number) {
  const until = Date.now() + ms
  while (!ok() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
}
