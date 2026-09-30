import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { which, type WhichOptions } from "../which.ts"

export interface ResolveOptions extends WhichOptions {
  homedir?: string
}

const isFile = (f: string) => fs.statSync(f, { throwIfNoEntry: false })?.isFile() ?? false

/**
 * En Windows, `claude` no es un ejecutable que se pueda lanzar sin shell: el PATH trae un shim `.cmd`
 * (npm) o el `claude.exe` nativo. Devuelve el `.exe` (nunca un `.cmd`) o `bin` tal cual si no lo encuentra.
 * Fuera de win32, o con una ruta explícita, no toca nada.
 */
export function resolveClaudeBin(bin: string, opts: ResolveOptions = {}): string {
  const platform = opts.platform ?? process.platform
  if (platform !== "win32" || path.win32.isAbsolute(bin) || /[\\/]/.test(bin)) return bin

  const exists = opts.exists ?? isFile
  const hits = which(bin, { ...opts, platform, exists })
  const exe = hits.find((f) => f.toLowerCase().endsWith(".exe"))
  if (exe) return exe

  // Shim de `npm i -g @anthropic-ai/claude-code`: el claude.exe real queda en node_modules, al lado.
  for (const shim of hits) {
    const sibling = path.win32.join(path.win32.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
    if (exists(sibling)) return sibling
  }

  const native = path.win32.join(opts.homedir ?? os.homedir(), ".local", "bin", "claude.exe")
  return exists(native) ? native : bin
}

/** Como `resolveClaudeBin`, pero recuerda lo que resolvió; lo que no encuentra se reintenta (quizás se instaló después). */
export function cachedResolver(opts: ResolveOptions = {}): (bin: string) => string {
  const cache = new Map<string, string>()
  return (bin) => {
    const hit = cache.get(bin)
    if (hit) return hit
    const resolved = resolveClaudeBin(bin, opts)
    if (resolved !== bin) cache.set(bin, resolved)
    return resolved
  }
}

/** El error de arranque cuando no anda `claude --version`. */
export function missingClaudeMessage(bin: string, platform: NodeJS.Platform = process.platform): string {
  const base = `No encontré el binario de Claude Code ("${bin}"). Instalalo o definí CLAUDE_BIN.`
  return platform === "win32" ? `${base} En Windows, definí CLAUDE_BIN con la ruta a claude.exe.` : base
}
