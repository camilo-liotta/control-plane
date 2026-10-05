// Dónde vive todo lo del banco de UX: fuera de /tmp, para que sobreviva a un reinicio.
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const CACHE = process.env.CP_UX_HOME ?? path.join(os.homedir(), ".cache", "cp-ux")
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const SRV = path.join(CACHE, "srv") // datos del server sembrado (CONTROL_PLANE_HOME)
export const FAKE_HOME = path.join(CACHE, "home") // HOME del server: sin ~/.claude ni ~/.bashrc reales
export const BIN = path.join(CACHE, "bin") // PATH del server: sin los CLIs reales de la máquina
export const REPOS = path.join(CACHE, "repos") // repos de mentira de los proyectos sembrados
export const PIDS = path.join(CACHE, "pids")
export const LOGS = path.join(CACHE, "logs")
export const FAKE_CLAUDE = path.join(CACHE, "claude.mjs")
export const SERVER_PORT = 4720
export const CDP_PORT = 9340
