import type { Account, AppView, Credential, Environment, Meta, Project, ServerMessage, Session, Snapshot } from "../shared/types.ts"

/**
 * Lo que se le saca a lo que sale por el listener remoto: comandos de las apps, carpetas de configuración de las cuentas,
 * usuarios y notas de los entornos, y las rutas absolutas de esta máquina. El snapshot local no cambia.
 */

/** Solo el último tramo de una ruta (sin carpeta de usuario ni raíz). */
function leaf(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? ""
}

export function redactAccount(a: Account): Account {
  return { ...a, configDir: "", bin: null, auth: null }
}

export function redactApp(a: AppView): AppView {
  return { ...a, command: "", stopCommand: null, cwd: "", env: {}, state: { ...a.state, tail: [], error: null } }
}

function redactCredential(c: Credential): Credential {
  return { ...c, username: null, loginUrl: null, notes: null }
}

export function redactEnvironment(e: Environment): Environment {
  return { ...e, notes: null, credentials: e.credentials.map(redactCredential) }
}

export function redactMeta(m: Meta): Meta {
  return { ...m, homeDir: "", account: null }
}

/**
 * Red de seguridad en la frontera de serialización: en toda respuesta JSON que sale por el listener remoto, las claves
 * `repoPath` y `cwd` (y `path` en el overview) quedan en su último tramo. Así una ruta nueva con Project/Session no filtra rutas absolutas.
 */
const PATH_KEYS = new Set(["repoPath", "cwd"])

function walkPaths(v: unknown, keys: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => walkPaths(x, keys))
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = keys.has(k) && typeof x === "string" ? leaf(x) : walkPaths(x, keys)
    return out
  }
  return v
}

/** El cuerpo JSON ya serializado, con las rutas absolutas recortadas. Si no es JSON, queda igual. */
export function redactJsonPaths(body: string, urlPath: string): string {
  // Los eventos son contenido de la conversación (herramientas, diffs): se leen tal cual en el nivel de lectura.
  if (/\/events$/.test(urlPath)) return body
  const keys = /\/overview$/.test(urlPath) ? new Set([...PATH_KEYS, "path"]) : PATH_KEYS
  try {
    return JSON.stringify(walkPaths(JSON.parse(body), keys))
  } catch {
    return body
  }
}

const redactProject = (p: Project): Project => ({ ...p, repoPath: leaf(p.repoPath) })
const redactSession = (s: Session): Session => ({ ...s, cwd: leaf(s.cwd) })

export function redactSnapshot(s: Snapshot): Snapshot {
  return {
    ...s,
    projects: s.projects.map(redactProject),
    sessions: s.sessions.map(redactSession),
    accounts: s.accounts.map(redactAccount),
    environments: s.environments.map(redactEnvironment),
    apps: s.apps.map(redactApp),
    meta: redactMeta(s.meta),
  }
}

/**
 * Lista de permitidos: solo estos tipos llegan a un cliente remoto. Todo lo demás (los de la app de escritorio, la gestión
 * local y cualquier tipo nuevo que se agregue sin revisar acá) se descarta. Los que llevan datos de esta máquina se redactan abajo.
 */
const ALLOWED = new Set<string>([
  "hello",
  "project",
  "project_removed",
  "session",
  "event",
  "event_update",
  "partial",
  "partial_clear",
  "draft",
  "report",
  "usage",
  "account",
  "account_removed",
  "meta",
  "compaction",
  "turn",
  "remote",
  "task",
  "environment",
  "environment_removed",
  "apps",
])

/** El mensaje como lo ve un cliente remoto, o null si no le llega. */
export function redactMessage(m: ServerMessage): ServerMessage | null {
  if (!ALLOWED.has(m?.type)) return null
  switch (m.type) {
    case "hello":
      return { ...m, snapshot: redactSnapshot(m.snapshot) }
    case "project":
      return { ...m, project: redactProject(m.project) }
    case "session":
      return { ...m, session: redactSession(m.session) }
    case "account":
      return { ...m, account: redactAccount(m.account) }
    case "meta":
      return { ...m, meta: redactMeta(m.meta) }
    case "environment":
      return { ...m, environment: redactEnvironment(m.environment) }
    case "apps":
      return { ...m, apps: m.apps.map(redactApp) }
    default:
      return m
  }
}
