import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveClaudeBin } from "./claude/bin.ts"
import { resolveRemotePort } from "./remote/listener.ts"
import pkg from "../package.json" with { type: "json" }
import rootPkg from "../../package.json" with { type: "json" }

const here = path.dirname(fileURLToPath(import.meta.url))

/** Lo define scripts/bundle.mjs: en el bundle, la web y el hook quedan al lado de server.mjs. */
declare const __CONTROL_PLANE_BUNDLE__: boolean | undefined
const bundled = typeof __CONTROL_PLANE_BUNDLE__ !== "undefined" && __CONTROL_PLANE_BUNDLE__

const mainPort = Number(process.env.CONTROL_PLANE_PORT ?? 4700)

export const config = {
  host: process.env.CONTROL_PLANE_HOST ?? "127.0.0.1",
  port: mainPort,
  /** El puerto de loopback del acceso remoto (Tailscale serve apunta acá). Solo se abre mientras el acceso está activo. */
  remotePort: resolveRemotePort(process.env.CONTROL_PLANE_REMOTE_PORT, mainPort),
  /** Carpeta con la base de datos y el estado local de esta máquina. */
  home: process.env.CONTROL_PLANE_HOME ?? path.join(os.homedir(), ".control-plane"),
  /** Binario de Claude Code (el que ya tenés instalado y logueado). En Windows se resuelve al claude.exe. */
  claudeBin: resolveClaudeBin(process.env.CLAUDE_BIN ?? "claude"),
  /** Build de la web que sirve el server en producción. */
  webDist: process.env.CONTROL_PLANE_WEB_DIST
    ? path.resolve(process.env.CONTROL_PLANE_WEB_DIST)
    : path.resolve(here, bundled ? "web" : "../../web/dist"),
  /** Orígenes permitidos para la API (además del propio server). */
  devOrigins: ["http://localhost:4701", "http://127.0.0.1:4701"],
  production: process.env.NODE_ENV === "production",
  /** Script del hook de compactación que corren las sesiones (se puede mover al empaquetar el server). */
  compactHook: process.env.CONTROL_PLANE_COMPACT_HOOK
    ? path.resolve(process.env.CONTROL_PLANE_COMPACT_HOOK)
    : path.resolve(here, bundled ? "compact-hook.mjs" : "claude/compact-hook.mjs"),
  /** Lo pone la app de escritorio al lanzar el server, para reconocer al que lanzó ella. */
  launchId: process.env.CONTROL_PLANE_LAUNCH_ID || null,
  /** Secreto con el que la app de escritorio pide apagar el server (en Windows no hay SIGTERM). Sin él, no hay ruta. */
  shutdownToken: takeShutdownToken(process.env),
}

/** Lee el token de apagado y lo borra del entorno, para que las sesiones de claude no lo hereden. */
export function takeShutdownToken(env: Record<string, string | undefined>): string | null {
  const token = env.CONTROL_PLANE_SHUTDOWN_TOKEN || null
  delete env.CONTROL_PLANE_SHUTDOWN_TOKEN
  return token
}

/** La de server/package.json (la pone `npm run version:set`). */
export const version: string = pkg.version

/** El repo del proyecto, del campo `repository` del package.json raíz (un fork lo cambia ahí). */
export const repoUrl: string | null = repoOf((rootPkg as { repository?: unknown }).repository)

export function repoOf(field: unknown): string | null {
  const raw = typeof field === "string" ? field : (field as { url?: unknown } | null)?.url
  if (typeof raw !== "string" || !raw) return null
  const url = raw.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^github:/, "https://github.com/")
  return /^https?:\/\//.test(url) ? url : null
}
