import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

/** Lo define scripts/bundle.mjs: en el bundle, la web y el hook quedan al lado de server.mjs. */
declare const __CONTROL_PLANE_BUNDLE__: boolean | undefined
const bundled = typeof __CONTROL_PLANE_BUNDLE__ !== "undefined" && __CONTROL_PLANE_BUNDLE__

export const config = {
  host: process.env.CONTROL_PLANE_HOST ?? "127.0.0.1",
  port: Number(process.env.CONTROL_PLANE_PORT ?? 4700),
  /** Carpeta con la base de datos y el estado local de esta máquina. */
  home: process.env.CONTROL_PLANE_HOME ?? path.join(os.homedir(), ".control-plane"),
  /** Binario de Claude Code (el que ya tenés instalado y logueado). */
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
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
}

export const version = "0.1.0"
