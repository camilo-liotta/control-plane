import { POLICY } from "./policy.ts"

/**
 * Las reglas de cuerpo de las rutas que se abren desde el listener remoto (respond y control). Funciones puras:
 * cada ruta tiene una lista cerrada de claves y cualquier clave de más es un 400, así que un dispositivo remoto
 * nunca puede cambiar lo que una acción ejecuta (modelo, esfuerzo, `fresh`, pasos, carpeta, herramientas, el input de un permiso).
 * El contrato (test/remote-tiers.test.ts) exige una regla por cada ruta de respond y de control.
 */

/** Con qué contador de uso cuenta cada pedido (ver rate-limit.ts). */
export type LimitClass = "messages" | "draft" | "permission" | "control" | "other"

export type RuleResult =
  | {
      ok: true
      /** El nivel que pide este cuerpo en particular: un permiso con allow:true es control aunque la ruta sea respond. */
      needs: "respond" | "control"
      limit: LimitClass
      /** Solo en la ruta de permisos: lo que se va a responder. */
      permission?: { requestId: string; allow: boolean }
    }
  | { ok: false }

type Check = (v: unknown) => boolean

interface Rule {
  limit: LimitClass
  needs: "respond" | "control"
  /** Las únicas claves que acepta, cada una con su validación. */
  keys: Record<string, Check>
  required?: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const text = (min: number, max: number): Check => (v) => typeof v === "string" && v.length >= min && v.length <= max
const finiteOrNull: Check = (v) => v === null || (typeof v === "number" && Number.isFinite(v))
const answers: Check = (v) => isObject(v) && Object.keys(v).length <= 50 && Object.values(v).every((x) => typeof x === "string")

const TITLE = text(0, 500)
const PROMPT = text(0, 200_000)

const NONE: Rule["keys"] = {}

/** "MÉTODO /patrón" -> regla. */
const RULES: Readonly<Record<string, Rule>> = {
  // ---- respond
  "POST /api/sessions/:id/messages": {
    limit: "messages",
    needs: "respond",
    // Sin adjuntos: subir archivos no está abierto, así que la lista, si viene, va vacía.
    keys: { text: text(1, 20_000), clientId: text(0, 100), attachmentIds: (v) => Array.isArray(v) && v.length === 0 },
    required: ["text"],
  },
  "POST /api/sessions/:id/answer": { limit: "other", needs: "respond", keys: { requestId: text(1, 200), answers }, required: ["requestId", "answers"] },
  // El permiso lo clasifica su cuerpo (ver checkBody): allow:false es respond y allow:true es control.
  "POST /api/sessions/:id/permission": {
    limit: "permission",
    needs: "respond",
    keys: { requestId: text(1, 200), allow: (v) => typeof v === "boolean", message: text(0, 500) },
    required: ["requestId", "allow"],
  },
  "POST /api/sessions/:id/interrupt": { limit: "other", needs: "respond", keys: NONE },
  "POST /api/sessions/:id/scheduled/:itemId/cancel": { limit: "other", needs: "respond", keys: { clientId: text(0, 100) } },
  // Solo el título y el prompt: el resto de un borrador (modelo, esfuerzo, fresh, subagentes, pasos, nombre, rol) no se toca desde afuera.
  "POST /api/drafts/:id/send": { limit: "messages", needs: "respond", keys: { title: TITLE, prompt: PROMPT } },
  "PATCH /api/drafts/:id": { limit: "draft", needs: "respond", keys: { title: TITLE, prompt: PROMPT } },
  "POST /api/drafts/:id/discard": { limit: "draft", needs: "respond", keys: NONE },
  "POST /api/drafts/:id/plan/pause": { limit: "other", needs: "respond", keys: NONE },
  "POST /api/drafts/:id/plan/cancel": { limit: "other", needs: "respond", keys: NONE },
  "DELETE /api/projects/:id/afk": { limit: "other", needs: "respond", keys: NONE },
  "POST /api/remote/logout": { limit: "other", needs: "respond", keys: NONE },

  // ---- control
  "POST /api/sessions/:id/start": { limit: "control", needs: "control", keys: NONE },
  "POST /api/sessions/:id/stop": { limit: "control", needs: "control", keys: NONE },
  // Los mismos valores que acepta el AFK local; el resto de la validación (fecha futura, monto mayor que 0) es la de siempre.
  "POST /api/projects/:id/afk": { limit: "control", needs: "control", keys: { until: finiteOrNull, budgetUsd: finiteOrNull } },
  "POST /api/drafts/:id/plan/resume": { limit: "control", needs: "control", keys: { mode: (v) => v === "retry" || v === "next" } },
}

/** Las rutas que tienen regla (el contrato las compara con las que la tabla de niveles abre). */
export const RULE_KEYS: readonly string[] = Object.keys(RULES)

/** Si hay regla para esta ruta. Una ruta de respond o control sin regla se rechaza. */
export const hasRule = (method: string, pattern: string): boolean => Object.hasOwn(RULES, `${method.toUpperCase()} ${pattern}`)

/** Las rutas de la tabla de niveles que exigen regla de cuerpo. */
export const RULED_ROUTES: readonly string[] = Object.entries(POLICY)
  .filter(([, tier]) => tier === "respond" || tier === "control")
  .map(([key]) => key)

/** Valida el cuerpo de un pedido remoto contra la regla de su ruta. Nunca lanza. */
export function checkBody(method: string, pattern: string, body: unknown): RuleResult {
  const key = `${method.toUpperCase()} ${pattern}`
  if (!Object.hasOwn(RULES, key)) return { ok: false }
  const rule = RULES[key]!
  const b = body === undefined || body === null ? {} : body
  if (!isObject(b)) return { ok: false }
  for (const k of Object.keys(b)) {
    if (!Object.hasOwn(rule.keys, k) || !rule.keys[k]!(b[k])) return { ok: false }
  }
  for (const k of rule.required ?? []) if (!Object.hasOwn(b, k)) return { ok: false }
  if (key === "POST /api/sessions/:id/permission") {
    const allow = b.allow === true
    // El mensaje es del rechazo: aprobar con un mensaje no tiene sentido y no se acepta.
    if (allow && Object.hasOwn(b, "message")) return { ok: false }
    return { ok: true, needs: allow ? "control" : "respond", limit: "permission", permission: { requestId: String(b.requestId), allow } }
  }
  return { ok: true, needs: rule.needs, limit: rule.limit }
}

/**
 * Las herramientas que, con "pedir confirmación en esta máquina" prendido (lo normal), solo se aprueban desde la máquina del server.
 * Son las que ejecutan comandos del sistema. Las herramientas de MCP (`mcp__<servidor>__<herramienta>`) NO están en la lista a propósito:
 * no se pueden clasificar por nombre (dependen del servidor MCP que las exponga), así que se aprueban con el nivel Control como cualquier otra.
 * Una herramienta sin nombre se trata como peligrosa: ante la duda, se aprueba en la máquina.
 */
export const DANGEROUS_TOOLS: readonly string[] = ["Bash", "PowerShell"]

export function isDangerousTool(name: unknown): boolean {
  if (typeof name !== "string" || !name.trim()) return true
  const n = name.trim().toLowerCase()
  return DANGEROUS_TOOLS.some((t) => t.toLowerCase() === n)
}
