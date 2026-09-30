import fs from "node:fs"
import path from "node:path"

export interface WhichOptions {
  platform?: NodeJS.Platform
  /** PATH (en win32, la clave `Path` también vale) y PATHEXT. */
  env?: NodeJS.ProcessEnv
  exists?: (file: string) => boolean
  /** Carpetas que se recorren después de las del PATH, en orden. */
  extraDirs?: string[]
}

/** Es un archivo (y, fuera de win32, ejecutable). */
function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Busca un ejecutable en el PATH (sin shell) y devuelve los candidatos en orden, sin repetir.
 * En win32 prueba cada extensión de PATHEXT y nunca devuelve un shim sin extensión.
 */
export function which(name: string, opts: WhichOptions = {}): string[] {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const win = platform === "win32"
  const p = win ? path.win32 : path.posix
  const exists = opts.exists ?? ((f: string) => isExecutable(f, platform))

  const pathKey = win ? (Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH") : "PATH"
  const dirs = [...(env[pathKey] ?? "").split(win ? ";" : ":"), ...(opts.extraDirs ?? [])]
    .map((d) => (win ? d.replace(/"/g, "") : d))
    .filter(Boolean)

  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())
  const names = !win ? [name] : exts.some((e) => name.toLowerCase().endsWith(e)) ? [name] : exts.map((e) => name + e)

  const found = new Set<string>()
  for (const dir of dirs) {
    for (const n of names) {
      const file = p.join(dir, n)
      if (exists(file)) found.add(file)
    }
  }
  return [...found]
}
