import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { EngramInstallResult, EngramStatus } from "./shared/types.ts"
import { which } from "./which.ts"

const run = promisify(execFile)

const PLUGIN_ID = "engram@engram"
const RELEASES = "https://github.com/Gentleman-Programming/engram/releases"

export interface EngramDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homedir?: string
  exists?: (file: string) => boolean
  /** El contenido del archivo, o null si no está o no se puede leer. */
  readFile?: (file: string) => string | null
}

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

/** Lee un JSON sin tirar: ausente, ilegible o roto es null. */
function readJson(file: string, deps: EngramDeps): Record<string, unknown> | null {
  try {
    const text = (deps.readFile ?? readText)(file)
    const value: unknown = text === null ? null : JSON.parse(text)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v) && (typeof v !== "object" || Object.keys(v as object).length > 0))

/** El programa `engram` (es global a la máquina, no de la cuenta). En Windows, solo un .exe. */
export function engramBinary(deps: EngramDeps = {}): string | null {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const home = deps.homedir ?? os.homedir()
  const win = platform === "win32"
  const p = win ? path.win32 : path.posix
  const extraDirs = win
    ? [p.join(home, "go", "bin"), p.join(env.LOCALAPPDATA ?? p.join(home, "AppData", "Local"), "engram", "bin")]
    : [p.join(home, "go", "bin"), p.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
  const hits = which("engram", { platform, env, exists: deps.exists, extraDirs })
  return (win ? hits.find((f) => f.toLowerCase().endsWith(".exe")) : hits[0]) ?? null
}

/** Qué le falta a esta cuenta para tener Engram, mirando solo sus archivos de configuración. */
export function detectEngram(files: { configDir: string; globalConfig: string }, deps: EngramDeps = {}): EngramStatus {
  const p = (deps.platform ?? process.platform) === "win32" ? path.win32 : path.posix
  const json = (...parts: string[]) => readJson(p.join(files.configDir, ...parts), deps)

  const list = json("plugins", "installed_plugins.json")
  const entry = (list?.plugins as Record<string, unknown> | undefined)?.[PLUGIN_ID] ?? list?.[PLUGIN_ID]
  const enabled = (json("settings.json")?.enabledPlugins as Record<string, unknown> | undefined)?.[PLUGIN_ID]
  const plugin = !nonEmpty(entry) ? "missing" : enabled === false ? "disabled" : "ok"

  const manual = (readJson(files.globalConfig, deps)?.mcpServers as Record<string, unknown> | undefined)?.engram
  const mcp = json("mcp", "engram.json") !== null || Boolean(manual)

  const binary = engramBinary(deps)
  const state =
    plugin === "ok" && mcp ? (binary ? "ready" : "no-binary") : plugin === "missing" && !mcp ? "missing" : "partial"
  const win = (deps.platform ?? process.platform) === "win32"
  const binaryHint = binary
    ? undefined
    : { command: win ? "go install github.com/Gentleman-Programming/engram/cmd/engram@latest" : "brew install gentleman-programming/tap/engram", url: RELEASES }
  return { state, plugin, mcp, binary, ...(binaryHint ? { binaryHint } : {}) }
}

export interface EngramSteps {
  addMarketplace(): Promise<void>
  plugin(action: "install" | "enable"): Promise<EngramInstallResult>
  setup(binary: string): Promise<void>
}

/** Marketplace, plugin y MCP, en ese orden. El programa no se instala solo: si falta, se avisa. */
export async function installEngram(status: EngramStatus, steps: EngramSteps): Promise<EngramInstallResult> {
  if (status.plugin !== "ok") {
    if (status.plugin === "missing") {
      // Si ya estaba agregado, el CLI se queja: no importa.
      await steps.addMarketplace().catch((err: unknown) => {
        if (!/already/i.test(err instanceof Error ? err.message : String(err))) throw err
      })
    }
    const result = await steps.plugin(status.plugin === "missing" ? "install" : "enable")
    if ("needsConfirm" in result) return result
  }
  if (!status.binary) return { ok: true, message: "Plugin listo; falta instalar el programa engram" }
  await steps.setup(status.binary)
  return { ok: true, message: "Engram instalado" }
}

/** `engram setup claude-code --mcp-only` con el entorno de la cuenta: registra el MCP con la ruta actual del programa. */
export async function runEngramSetup(binary: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const pending = run(binary, ["setup", "claude-code", "--mcp-only"], { env, cwd, timeout: 60_000 })
  pending.child.stdin?.end()
  try {
    await pending
  } catch (err) {
    const { stderr } = err as { stderr?: string }
    throw new Error(stderr?.trim().split("\n").pop() || (err instanceof Error ? err.message : String(err)))
  }
}
