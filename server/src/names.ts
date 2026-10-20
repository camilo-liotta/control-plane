import type { SessionRecord } from "./db.ts"
import { sanitizeSessionName } from "./util.ts"

/**
 * Nombres de sesión.
 *
 * El nombre que se ve (`name`) es único dentro de cada proyecto, sin distinguir mayúsculas. Claude Code, en cambio,
 * identifica cada proceso por su --name en toda la máquina, y SendMessage/ListAgents resuelven por ese nombre: el
 * `processName` es el --name con que se lanza, y tiene que ser único entre las sesiones del dashboard.
 *
 * Casi siempre es igual a `name`. Si otro proyecto ya tiene una sesión no archivada con ese nombre, se califica con el
 * proyecto: `INFRA·inmos`. El separador es «·» porque los nombres de sesión solo llevan letras, números, «_» y «-»
 * (ver sanitizeSessionName): un nombre calificado nunca puede coincidir con uno común. Lo aceptan --name y SendMessage
 * (probado con el binario real de Claude Code). No sirve «@»: Claude Code lo usa para direccionar equipos (nombre@equipo).
 */
export const QUALIFIER = "·"

/** Nombres que Claude Code reserva para sus propios agentes: no puede llamarse así ninguna sesión (sin distinguir mayúsculas). */
export const RESERVED_NAMES = ["main", "team-lead", "user", "system"]

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.includes(name.trim().toLowerCase())
}

/** Corta si el nombre es uno de los reservados. Solo para sesiones nuevas o renombradas: las que ya existen siguen como están. */
export function assertNotReserved(name: string): void {
  if (isReservedName(name)) throw new Error(`${name.trim().toUpperCase()} es un nombre reservado de Claude Code: elegí otro.`)
}

const lower = (s: string) => s.trim().toLowerCase()

/** ¿Ya hay en el proyecto otra sesión no archivada con ese nombre? (`sessions` son las no archivadas). */
export function nameTaken(sessions: SessionRecord[], projectId: string, name: string, exceptId?: string): boolean {
  const n = lower(name)
  return sessions.some((s) => s.id !== exceptId && s.projectId === projectId && !s.archivedAt && lower(s.name) === n)
}

/** El sufijo que identifica a un proyecto en un nombre calificado: su nombre, como lo acepta un nombre de sesión. */
export function projectQualifier(projectName: string): string {
  return sanitizeSessionName(projectName).toLowerCase() || "proyecto"
}

/**
 * El --name que le toca a una sesión: su nombre, o el calificado si otra sesión de otro proyecto ya lo usa.
 * `sessions` son las no archivadas. El que ya tiene el nombre se queda con él: nunca se le quita a una sesión
 * que existe para dárselo a otra. Es determinista: la misma sesión con las mismas otras da el mismo nombre.
 */
export function pickProcessName(sessions: SessionRecord[], rec: Pick<SessionRecord, "id" | "projectId" | "name">, projectName: string): string {
  const used = new Set(sessions.filter((s) => s.id !== rec.id && !s.archivedAt).map((s) => lower(s.processName)))
  const base = rec.name.trim()
  if (!used.has(lower(base))) return base
  const q = `${base}${QUALIFIER}${projectQualifier(projectName)}`
  if (!used.has(lower(q))) return q
  for (let i = 2; ; i++) if (!used.has(lower(`${q}${QUALIFIER}${i}`))) return `${q}${QUALIFIER}${i}`
}

/** El nombre corto de un nombre de proceso: sin el proyecto que lo califica (`INFRA·inmos` → `INFRA`). */
export function shortName(processName: string): string {
  const i = processName.indexOf(QUALIFIER)
  return i > 0 ? processName.slice(0, i) : processName
}

/** De un nombre de proceso al nombre que se muestra (p. ej. el `from-name` de un mensaje recibido). */
export function displayName(sessions: SessionRecord[], processName: string): string {
  const p = lower(processName)
  return sessions.find((s) => lower(s.processName) === p)?.name ?? shortName(processName)
}
