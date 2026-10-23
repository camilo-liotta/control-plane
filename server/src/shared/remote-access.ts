import type { RemoteAuditEntry, RemoteCapabilities } from "./types.ts"

/**
 * Lo puro del acceso remoto en la web (sin React ni fetch): qué se puede hacer según el modo,
 * el token del enlace de vinculación, los mensajes de error y los textos fijos.
 * Vive en shared para probarse desde node:test (la web no tiene corredor de tests).
 */

export type Capability = "view" | "respond" | "control" | "manage"
export type Tier = "read" | "respond" | "control"

/** Los modos desde los que se puede ver cada capacidad. `manage` es solo de esta máquina. */
const GRANTS: Record<RemoteCapabilities["mode"], readonly Capability[]> = {
  local: ["view", "respond", "control", "manage"],
  "remote-read": ["view"],
  "remote-respond": ["view", "respond"],
  "remote-control": ["view", "respond", "control"],
}

/** Si el modo actual permite la capacidad. Sin cargar, o remoto sin vincular: nada. Solo ayuda de uso: el server decide. */
export function canDo(caps: RemoteCapabilities | null, cap: Capability): boolean {
  if (!caps) return false
  if (caps.mode !== "local" && caps.paired === false) return false
  return GRANTS[caps.mode].includes(cap)
}

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

/** El token de `#pair=TOKEN` (con o sin la almohadilla), o null si no hay o no tiene forma de token. */
export function parsePairHash(hash: string): string | null {
  const m = /^#?pair=(.*)$/.exec(hash)
  if (!m) return null
  return TOKEN.test(m[1]) ? m[1] : null
}

export const isRemoteCode = (code: string | undefined): code is string => typeof code === "string" && code.startsWith("remote_")

const REMOTE_MESSAGES: Record<string, string> = {
  remote_forbidden: "No se puede hacer desde un dispositivo remoto.",
  remote_tier: "No se pudo: este dispositivo no tiene permiso para esa acción.",
  remote_origin: "No se pudo: el pedido no vino desde la página de este dispositivo. Recargala y probá de nuevo.",
  remote_unpaired: "Este dispositivo no está vinculado.",
  remote_length_required: "No se pudo enviar: el pedido no es válido.",
  remote_too_large: "No se pudo enviar: es demasiado grande.",
  remote_json: "No se pudo enviar: el pedido no es válido.",
  remote_needs_local: "Esta herramienta se aprueba desde la máquina del server.",
  remote_body: "No se pudo enviar: el pedido no es válido.",
}

/** Los que la pantalla explica en su lugar (no suman un aviso): sin vincular lleva a la vinculación y la herramienta se aprueba en la máquina. */
const SILENT = new Set(["remote_unpaired", "remote_needs_local"])

/** El texto de un error del server: los `remote_*` en castellano (con cuánto esperar si lo limitaron); el resto, el del server. */
export function remoteErrorMessage(code: string | undefined, serverMessage: string, retryAfterSeconds?: number, status?: number): string {
  if (code === "remote_rate_limited") {
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      const s = Math.ceil(retryAfterSeconds)
      return `Demasiados pedidos: probá de nuevo en ${s} ${s === 1 ? "segundo" : "segundos"}.`
    }
    return "Demasiados pedidos: probá de nuevo en un rato."
  }
  if (code && Object.hasOwn(REMOTE_MESSAGES, code)) return REMOTE_MESSAGES[code]
  if (serverMessage) return serverMessage
  if (isRemoteCode(code)) return "No se pudo: el acceso remoto no lo permite."
  return `Error ${status ?? ""}`.trim()
}

/** Si el error merece un aviso propio. Sin vincular lleva a la pantalla de vinculación; un enlace inválido lo explica esa pantalla; "se aprueba en la máquina" lo explica la tarjeta del permiso. */
export const toastsRemoteError = (code: string | undefined): boolean =>
  code === "remote_rate_limited" || (code !== undefined && !SILENT.has(code) && Object.hasOwn(REMOTE_MESSAGES, code))

/** Los adjuntos se suben solo desde esta máquina: la subida de archivos no se abre a ningún dispositivo remoto. */
export const canAttachFiles = (caps: RemoteCapabilities | null): boolean => canDo(caps, "manage")

/** Desde un dispositivo remoto un borrador o un plan solo se edita en título y prompt; el editor completo es de esta máquina. */
export const draftEditMode = (caps: RemoteCapabilities | null): "full" | "basic" => (canDo(caps, "manage") ? "full" : "basic")

/** Las opciones del selector de nivel (del menor al mayor). */
export const TIER_OPTIONS: readonly { value: Tier; label: string; hint: string }[] = [
  { value: "read", label: "Ver", hint: "Solo mirar proyectos, sesiones y conversaciones." },
  { value: "respond", label: "Ver y responder", hint: "Además: mensajes, respuestas, rechazar permisos, interrumpir, borradores (título y prompt) y salir de AFK." },
  { value: "control", label: "Control (todo menos la terminal)", hint: "Además: iniciar y detener sesiones, aprobar permisos, poner AFK y reanudar planes." },
]

/** Subir a Control exige confirmarlo en esta máquina (el server lo vuelve a exigir). */
export const tierNeedsConfirm = (tier: Tier): boolean => tier === "control"

const AUDIT_KINDS: Record<string, string> = {
  request: "Pedido",
  pair: "Vinculación",
  revoke: "Revocación",
  tier: "Nivel",
  enable: "Prendido",
  disable: "Apagado",
  kill: "Corte",
  ws: "Conexión",
}
const AUDIT_OUTCOMES: Record<string, string> = {
  ok: "Hecho",
  denied: "Denegado",
  unauthenticated: "Sin vincular",
  rate_limited: "Limitado",
  invalid: "No válido",
  error: "Error",
}
export const auditKindLabel = (kind: string): string => AUDIT_KINDS[kind] ?? kind
export const auditOutcomeLabel = (outcome: string): string => AUDIT_OUTCOMES[outcome] ?? outcome

/** Lo que pasó, en una línea: método y ruta, sobre qué id y, de un permiso, la herramienta con su huella. Nunca hay contenido. */
export function describeAudit(r: RemoteAuditEntry): string {
  const parts: string[] = []
  if (r.method && r.route) parts.push(`${r.method} ${r.route}`)
  else if (r.route) parts.push(r.route)
  if (r.targetId && parts.length) parts.push(r.targetId)
  if (r.toolName) parts.push(r.inputHash ? `${r.toolName} (${r.inputHash})` : r.toolName)
  return parts.join(" · ")
}

const TIER_LABELS: Record<Tier, string> = { read: "Ver", respond: "Ver y responder", control: "Control (todo menos la terminal)" }
export const tierLabel = (tier: Tier): string => TIER_LABELS[tier]

/** El aviso permanente: desde esta máquina, que hay acceso abierto; desde otro dispositivo, quién sos y con qué nivel. */
export function accessIndicator(caps: RemoteCapabilities | null, local: { active: boolean; devices: number } | null): string | null {
  if (!caps) return null
  if (caps.mode === "local") {
    if (!local?.active) return null
    const n = local.devices
    return `Acceso remoto activo · ${n === 0 ? "sin dispositivos" : n === 1 ? "1 dispositivo" : `${n} dispositivos`}`
  }
  if (caps.paired === false || !caps.device) return null
  return `Desde ${caps.device.name} · ${tierShort(caps.device.tier)}`
}

/** El nivel en pocas palabras, para el aviso. */
function tierShort(tier: Tier): string {
  return tier === "control" ? "Control" : tier === "respond" ? "Ver y responder" : "Ver"
}

/** Lo que dice la confirmación al prender el acceso remoto (R4.7/R6.5): qué se comparte y que las sesiones no piden permisos. */
export const ENABLE_CONFIRM_TITLE = "¿Permitir el acceso desde tu tailnet?"
export const ENABLE_CONFIRM_PARAGRAPHS: readonly string[] = [
  "Los dispositivos que vincules van a poder ver el dashboard (proyectos, sesiones y conversaciones) desde tu tailnet de Tailscale. No se expone a internet ni a la red local, y la terminal nunca está disponible de forma remota.",
  "Las sesiones corren con --dangerously-skip-permissions: cualquier mensaje que llegue a una sesión puede terminar ejecutando comandos en esta máquina sin pedir confirmación. Por eso, permitir que otro dispositivo responda o controle equivale a ejecutar comandos desde ahí. Por defecto el acceso es solo de lectura; subir el nivel es una decisión aparte, desde esta máquina.",
  "Podés cortarlo cuando quieras con «Cortar acceso ahora».",
]

/** La confirmación de subir el nivel a Control (la usa el diálogo cuando el nivel Control esté disponible). */
export const CONTROL_CONFIRM_COPY =
  "El nivel Control permite iniciar sesiones, aprobar permisos y poner un proyecto en AFK desde otro dispositivo. Como las sesiones corren con --dangerously-skip-permissions, responder o controlar equivale a ejecutar comandos en esta máquina."
