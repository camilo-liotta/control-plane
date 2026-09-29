import { execFile } from "node:child_process"

/** Un git que falló, con lo que dijo por stderr (o por qué no arrancó). */
export class GitError extends Error {
  readonly missing: boolean
  constructor(message: string, missing = false) {
    super(message)
    this.missing = missing
  }
}

const OPTS = {
  timeout: 10_000,
  maxBuffer: 16 * 1024 * 1024,
}

const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" })

/**
 * Git de solo lectura, sin shell y con timeout. `--no-optional-locks` evita que `git status` tome el
 * lock del índice: en un checkout donde trabajan varias sesiones, un lock ajeno les haría fallar un commit.
 * Si falla, tira un `GitError` con el mensaje de git.
 */
export function gitStrict(dir: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-optional-locks", "-C", dir, ...args], { ...OPTS, env: env(), encoding: "buffer" }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") return reject(new GitError("No encontré git en esta máquina", true))
      if (err.killed) return reject(new GitError(`git ${args[0]} tardó demasiado`))
      const msg = stderr.toString("utf8").trim().split("\n").filter(Boolean).pop()
      reject(new GitError(msg ? msg.replace(/^(fatal|error): /, "") : `git ${args[0]} falló`))
    })
  })
}

/** Lo mismo, como texto y sin espacios alrededor; null si git falla. */
export async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    return (await gitStrict(dir, args)).toString("utf8").trim()
  } catch {
    return null
  }
}
