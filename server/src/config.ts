import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

export const config = {
  host: process.env.CONTROL_PLANE_HOST ?? "127.0.0.1",
  port: Number(process.env.CONTROL_PLANE_PORT ?? 4700),
  /** Carpeta con la base de datos y el estado local de esta máquina. */
  home: process.env.CONTROL_PLANE_HOME ?? path.join(os.homedir(), ".control-plane"),
  /** Binario de Claude Code (el que ya tenés instalado y logueado). */
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  /** Build de la web que sirve el server en producción. */
  webDist: path.resolve(here, "../../web/dist"),
  /** Orígenes permitidos para la API (además del propio server). */
  devOrigins: ["http://localhost:4701", "http://127.0.0.1:4701"],
  production: process.env.NODE_ENV === "production",
}

export const version = "0.1.0"
