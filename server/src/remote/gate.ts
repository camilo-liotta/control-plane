import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { TIER_RANK, type Tier } from "./policy.ts"
import { redactJsonPaths } from "./redact.ts"

/**
 * La puerta del listener remoto. `decide` es una función pura: recibe lo que se sabe del pedido y dice si pasa.
 * Nunca mira el Host (ni ningún encabezado que mande el cliente) para autorizar.
 */

/** Más que esto en el cuerpo, 413. */
export const MAX_BODY_BYTES = 256 * 1024

/** El nivel más alto que la puerta deja pasar. Subirlo exige que cada ruta de ese nivel tenga su regla de cuerpo (rules.ts) y sus límites. */
export const GATE_MAX_TIER: Exclude<Tier, "never"> = "control"

export interface GateDevice {
  id: string
  tier: Tier
  name?: string
}

export interface GateRequest {
  method: string
  /** El nivel que dejó onRoute en config.remote (undefined si la ruta no existe). */
  tier: Tier | undefined
  /** El patrón de la ruta (`/api/sessions/:id/events`), o null si no hubo ruta. */
  pattern: string | null
  /** La ruta pedida, sin la query. */
  path: string
  contentLength: string | undefined
  transferEncoding: string | undefined
  origin: string | undefined
  contentType: string | undefined
  upgrade: boolean
}

export interface GateContext {
  /** El dispositivo de la cookie. Solo se consulta cuando hace falta (después de public). */
  authenticate: () => GateDevice | null
  /** `https://<dns>:<P>`, o null si el acceso no está activo. */
  expectedOrigin: string | null
  /** El techo global de nivel. */
  ceiling: Exclude<Tier, "never">
}

export type Decision =
  | { allow: true; device: GateDevice | null }
  | { allow: false; status: number; code: string; error: string; retryAfterSec?: number }

const deny = (status: number, code: string, error: string): Decision => ({ allow: false, status, code, error })

export const MESSAGES = {
  forbidden: "No se puede hacer desde un dispositivo remoto",
  unpaired: "Este dispositivo no está vinculado",
  tier: "Este dispositivo no tiene el nivel de acceso necesario",
  origin: "Origen no permitido",
  json: "Solo se acepta JSON",
  tooLarge: "No se pudo enviar: el pedido es demasiado grande",
  lengthRequired: "No se pudo enviar: falta el largo del pedido",
  rateLimited: "Demasiados pedidos: probá de nuevo en un rato.",
  body: "No se pudo enviar: el pedido no es válido.",
  needsLocal: "Esta herramienta se aprueba desde la máquina del server",
  notPending: "El pedido ya no está pendiente",
} as const

const RESERVED = /^\/(api|mcp|hooks|ws)(\/|$)/i

const rank = (t: Exclude<Tier, "never">) => TIER_RANK[t]

/** El nivel que de verdad tiene el dispositivo: el menor entre el techo, el suyo y lo que la puerta soporta. */
export function effectiveTier(ceiling: Exclude<Tier, "never">, device: Tier): Exclude<Tier, "never"> {
  const order = ["public", "read", "respond", "control"] as const
  const own = device === "never" ? "public" : device
  const lowest = [ceiling, own, GATE_MAX_TIER].sort((a, b) => rank(a) - rank(b))[0]!
  return order.find((t) => t === lowest) ?? "public"
}

/** El orden de la puerta: tamaño, nivel, public, dispositivo, nivel del dispositivo, Origin y JSON. */
export function decide(r: GateRequest, ctx: GateContext): Decision {
  const method = r.method.toUpperCase()
  const readOnly = method === "GET" || method === "HEAD"

  // 1. Tamaño.
  const length = r.contentLength === undefined ? null : Number(r.contentLength)
  if (length !== null && (!Number.isFinite(length) || length < 0)) return deny(400, "remote_bad_length", MESSAGES.lengthRequired)
  if (length !== null && length > MAX_BODY_BYTES) return deny(413, "remote_too_large", MESSAGES.tooLarge)
  if (!readOnly && (length === null || r.transferEncoding !== undefined)) return deny(411, "remote_length_required", MESSAGES.lengthRequired)

  // 2. Nivel. Sin ruta, o never: 403 antes de cualquier handler. El comodín de la web no abre la API.
  let tier = r.tier
  if (tier === "public" && r.pattern === "/*" && RESERVED.test(r.path)) tier = "never"
  if (tier === undefined || tier === "never") return deny(403, "remote_forbidden", MESSAGES.forbidden)

  // 6 (para lo público que cambia algo, como el pareo): Origin exacto y JSON.
  const guarded = (device: GateDevice | null): Decision => {
    if (!readOnly || r.upgrade) {
      if (!ctx.expectedOrigin || r.origin !== ctx.expectedOrigin) return deny(403, "remote_origin", MESSAGES.origin)
      if (!readOnly && length! > 0 && !/^application\/json\s*(;|$)/i.test(r.contentType ?? "")) return deny(415, "remote_json", MESSAGES.json)
    }
    return { allow: true, device }
  }

  // 3. Public pasa, sin dispositivo.
  if (tier === "public") return guarded(null)

  // 4. Dispositivo.
  const device = ctx.authenticate()
  if (!device) return deny(401, "remote_unpaired", MESSAGES.unpaired)

  // 5. Nivel del dispositivo.
  if (rank(tier) > rank(effectiveTier(ctx.ceiling, device.tier))) return deny(403, "remote_tier", MESSAGES.tier)

  // 6. Origin y JSON.
  return guarded(device)
}

/** Encabezados de toda respuesta remota. Nunca CORS. */
export function securityHeaders(path: string): Record<string, string> {
  const h: Record<string, string> = {
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  }
  if (/^\/api(\/|$)/i.test(path)) h["cache-control"] = "no-store"
  return h
}

const pathOf = (url: string) => {
  const q = url.indexOf("?")
  return q < 0 ? url : url.slice(0, q)
}

export interface GateOptions {
  authenticate: (req: FastifyRequest) => GateDevice | null
  expectedOrigin: () => string | null
  ceiling: () => Exclude<Tier, "never">
  /** Límites de tráfico: devuelven los segundos de espera cuando se pasó, o null. Cuentan lo que pasó por la puerta. */
  limits?: {
    /** Pedidos sin dispositivo válido (los 401), en total. */
    unauthenticated: () => number | null
    /** Pedidos de un dispositivo ya autenticado. */
    device: (device: GateDevice, method: string) => number | null
  }
  /** Se llama con lo que decidió la puerta (para la auditoría). */
  onDecision?: (req: FastifyRequest, decision: Decision) => void
}

/** Lo que se sabe de un pedido remoto después de la puerta: quién es y, si hubo un permiso, de qué herramienta (para la auditoría). */
export interface RemoteRequestInfo {
  device: GateDevice | null
  toolName?: string
  inputHash?: string
  /** El código del error con que terminó (para la auditoría). */
  reason?: string
}

const infos = new WeakMap<object, RemoteRequestInfo>()

/** Lo que la puerta decidió de este pedido (undefined si no pasó por ella). */
export const remoteInfo = (req: object): RemoteRequestInfo | undefined => infos.get(req)

const rateLimited = (retryAfterSec: number): Decision => ({ allow: false, status: 429, code: "remote_rate_limited", error: MESSAGES.rateLimited, retryAfterSec })

/** El hook de la puerta, listo para el despachador de `localOnly`. */
export function createGate(o: GateOptions) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const config = req.routeOptions?.config as { remote?: Tier } | undefined
    let decision = decide(
      {
        method: req.method,
        tier: config?.remote,
        pattern: req.routeOptions?.url ?? null,
        path: pathOf(req.url),
        contentLength: req.headers["content-length"],
        transferEncoding: req.headers["transfer-encoding"],
        origin: req.headers.origin,
        contentType: req.headers["content-type"],
        upgrade: String(req.headers.upgrade ?? "").toLowerCase() === "websocket",
      },
      { authenticate: () => o.authenticate(req), expectedOrigin: o.expectedOrigin(), ceiling: o.ceiling() },
    )
    if (!decision.allow && decision.status === 401) {
      const wait = o.limits?.unauthenticated()
      if (wait) decision = rateLimited(wait)
    } else if (decision.allow && decision.device) {
      const wait = o.limits?.device(decision.device, req.method)
      if (wait) decision = rateLimited(wait)
    }
    infos.set(req, { device: decision.allow ? decision.device : null })
    o.onDecision?.(req, decision)
    if (decision.allow) return
    if (decision.retryAfterSec) reply.header("retry-after", String(decision.retryAfterSec))
    return reply.code(decision.status).send({ error: decision.error, code: decision.code })
  }
}

/** Pone los encabezados de seguridad en todo lo que sale por el listener remoto (errores incluidos). */
export function registerRemoteHeaders(app: FastifyInstance, isRemote: (req: FastifyRequest) => boolean) {
  app.addHook("onSend", async (req, reply, payload) => {
    if (!isRemote(req)) return payload
    for (const [k, v] of Object.entries(securityHeaders(pathOf(req.url)))) reply.header(k, v)
    // Red de seguridad: ninguna respuesta JSON remota lleva rutas absolutas de esta máquina.
    if (typeof payload === "string" && String(reply.getHeader("content-type") ?? "").includes("json")) return redactJsonPaths(payload, pathOf(req.url))
    return payload
  })
}
