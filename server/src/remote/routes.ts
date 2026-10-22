import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { RemoteCapabilities, RemoteStatus } from "../shared/types.ts"
import type { Tailscale, TailscaleState } from "../tailscale.ts"
import type { RemoteControl } from "./control.ts"
import type { RemoteAudit } from "./audit.ts"
import { effectiveTier, MESSAGES, remoteInfo } from "./gate.ts"
import { COOKIE_MAX_AGE_S, COOKIE_NAME, type Device, type PairingService } from "./pairing.ts"
import type { WindowLimiter } from "./rate-limit.ts"
import type { WsRegistry } from "./ws-registry.ts"

export interface RemoteStatusDeps {
  tailscale: Pick<Tailscale, "status">
  enabled: () => boolean
  httpsPort: () => number
  /** Prendido y con el listener abierto. */
  active?: () => boolean
  /** Por qué está prendido pero sin exposición. */
  problem?: () => TailscaleState | null
  /** Si el pedido entró por el listener remoto (segunda barrera: la puerta ya los frena). */
  isRemote?: (req: FastifyRequest) => boolean
}

/** El estado de Tailscale para el diálogo "Acceso remoto". Solo lee: nunca corre un comando que cambie algo. */
export async function remoteStatus({ tailscale, enabled, httpsPort, active, problem }: RemoteStatusDeps): Promise<RemoteStatus> {
  const s = await tailscale.status()
  const on = enabled()
  const p = on ? (problem?.() ?? null) : null
  const base = { enabled: on, active: active?.() ?? false, problem: p ? { state: p.kind, message: p.message ?? "" } : null }
  if (s.kind !== "ready") {
    return { ...base, state: s.kind, message: s.message, tailnet: null, ips: [], host: null, version: s.version ?? null, url: null }
  }
  return { ...base, state: "ready", message: null, tailnet: s.tailnet, ips: s.ips, host: s.host, version: s.version, url: on ? `https://${s.host}:${httpsPort()}/` : null }
}

const NEEDS_CONFIRM = "No se pudo subir el nivel a Control: falta la confirmación en esta máquina."

const forbidden = { error: MESSAGES.forbidden, code: "remote_forbidden" }

/** Un handler que solo corre para pedidos de esta máquina. */
function localOnlyHandler(deps: RemoteStatusDeps, fn: (req: FastifyRequest, reply: FastifyReply) => unknown) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (deps.isRemote?.(req)) return reply.code(403).send(forbidden)
    return fn(req, reply)
  }
}

/** GET /api/remote/status. En el puerto principal nada más: la puerta remota la trata como "never". */
export function registerRemoteStatus(app: FastifyInstance, deps: RemoteStatusDeps) {
  app.get("/api/remote/status", localOnlyHandler(deps, () => remoteStatus(deps)))
}

export interface RemoteRoutesDeps extends RemoteStatusDeps {
  control: RemoteControl
  pairing: PairingService
  registry: WsRegistry
  /** El dispositivo de la cookie del pedido (null si no hay o no sirve). */
  authenticate: (req: FastifyRequest) => Device | null
  /** Los pareos fallidos: 5 cada 10 minutos, en total. */
  pairFailures: WindowLimiter
  /** La auditoría (ver audit.ts). Opcional: los tests de rutas sueltas no la arman. */
  audit?: RemoteAudit
}

/** Los niveles que la puerta sabe aplicar hoy (rules.ts tiene la regla de cada ruta de esos niveles). Subirlo va junto con GATE_MAX_TIER (gate.ts). */
export const SUPPORTED_TIERS: readonly string[] = ["read", "respond", "control"]

/** Lo que hay que mandar desde esta máquina para subir un techo o un dispositivo a control (el diálogo lo pide con un AlertDialog). */
export const CONTROL_CONFIRM = "control"

/**
 * Las rutas de gestión del acceso remoto. Solo desde esta máquina (puerto principal): en el listener remoto
 * son `never`, y cada handler lo vuelve a chequear por el socket (una segunda barrera).
 */
export function registerRemoteRoutes(app: FastifyInstance, deps: RemoteRoutesDeps) {
  const { control } = deps
  const local = (fn: (req: FastifyRequest, reply: FastifyReply) => unknown) => localOnlyHandler(deps, fn)

  registerRemoteStatus(app, deps)

  app.post<{ Body: { httpsPort?: unknown } | null }>(
    "/api/remote/enable",
    local(async (req, reply) => {
      const body = (req.body ?? {}) as { httpsPort?: unknown }
      const httpsPort = body.httpsPort === undefined ? undefined : Number(body.httpsPort)
      const r = await control.enable({ httpsPort })
      deps.audit?.record({ kind: "enable", method: "POST", route: "/api/remote/enable", status: r.ok ? 200 : 409, outcome: r.ok ? "ok" : "error", reason: r.ok ? null : r.state.kind })
      if (r.ok) return remoteStatus(deps)
      return reply.code(409).send({ error: r.state.message, code: r.state.kind })
    }),
  )

  app.post(
    "/api/remote/disable",
    local(async () => {
      const r = await control.disable()
      deps.audit?.record({ kind: "disable", method: "POST", route: "/api/remote/disable", status: 200, outcome: "ok" })
      return { ok: true, ...r }
    }),
  )

  // El corte no espera a Tailscale: responde apenas el listener y los websockets están cerrados.
  app.post(
    "/api/remote/kill",
    local(() => {
      control.kill()
      deps.audit?.record({ kind: "kill", method: "POST", route: "/api/remote/kill", status: 200, outcome: "ok" })
      return { ok: true }
    }),
  )

  // ---- desde el listener remoto

  app.get("/api/remote/capabilities", async (req): Promise<RemoteCapabilities> => {
    if (!deps.isRemote?.(req)) return { mode: "local" }
    const device = deps.authenticate(req)
    if (!device) return { mode: "remote-read", paired: false }
    const tier = effectiveTier(control.config().tier, device.tier)
    const shown = tier === "respond" || tier === "control" ? tier : "read"
    return { mode: `remote-${shown}`, paired: true, device: { name: device.name, tier: shown } }
  })

  const PAIR_KEYS = new Set(["token", "name"])
  app.post<{ Body: { token?: unknown; name?: unknown } | null }>("/api/remote/pair", async (req, reply) => {
    // Solo existe en el listener remoto: en el principal no hay nada que canjear.
    if (!deps.isRemote?.(req)) return reply.code(403).send(forbidden)
    const wait = deps.pairFailures.peek()
    if (wait !== null) return reply.header("retry-after", String(wait)).code(429).send({ error: MESSAGES.rateLimited, code: "remote_rate_limited" })
    const body = req.body && typeof req.body === "object" ? req.body : {}
    if (Object.keys(body).some((k) => !PAIR_KEYS.has(k)) || typeof body.token !== "string") {
      return reply.code(400).send({ error: "No se pudo vincular: el pedido no es válido.", code: "invalid" })
    }
    const login = req.headers["tailscale-user-login"]
    const paired = deps.pairing.redeem(body.token, { name: body.name, tsLogin: typeof login === "string" ? login : null })
    if (!paired) {
      deps.pairFailures.record()
      return reply.code(401).send({ error: "No se pudo vincular: el enlace no es válido o venció.", code: "remote_pair_invalid" })
    }
    // Secure siempre: el navegador ve https aunque acá llegue http (y X-Forwarded-Proto no se lee).
    reply.header("set-cookie", `${COOKIE_NAME}=${paired.secret}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`)
    const info = remoteInfo(req)
    if (info) info.device = { id: paired.device.id, tier: paired.device.tier, name: paired.device.name }
    control.notify()
    return { ok: true, name: paired.device.name, tier: paired.device.tier }
  })

  // ---- desde esta máquina: enlaces y dispositivos

  app.post<{ Body: { name?: unknown; tier?: unknown } | null }>(
    "/api/remote/pairings",
    local((req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; tier?: unknown; confirm?: unknown }
      if (Object.keys(body).some((k) => k !== "name" && k !== "tier" && k !== "confirm")) return reply.code(400).send({ error: "No se pudo crear el enlace: el pedido no es válido.", code: "invalid" })
      const tier = body.tier === undefined ? "read" : body.tier
      if (typeof tier !== "string" || !SUPPORTED_TIERS.includes(tier)) return reply.code(400).send({ error: "No se pudo crear el enlace: ese nivel todavía no está disponible.", code: "invalid" })
      if (tier === "control" && body.confirm !== CONTROL_CONFIRM) return reply.code(400).send({ error: NEEDS_CONFIRM, code: "confirm_required" })
      const cfg = control.config()
      if (!cfg.enabled || !cfg.origin) return reply.code(409).send({ error: "No se pudo crear el enlace: el acceso remoto está apagado.", code: "remote_off" })
      const p = deps.pairing.create({ tier: tier as "read" | "respond" | "control", name: typeof body.name === "string" ? body.name : undefined })
      deps.audit?.record({ kind: "pair", method: "POST", route: "/api/remote/pairings", status: 200, outcome: "ok", reason: "link_created" })
      return { url: `${cfg.origin}/#pair=${p.token}`, expiresAt: p.expiresAt }
    }),
  )

  app.get("/api/remote/devices", local(() => deps.pairing.list()))

  // El nivel de un dispositivo: control exige la confirmación local igual que el techo.
  app.patch<{ Params: { id: string }; Body: { tier?: unknown; confirm?: unknown } | null }>(
    "/api/remote/devices/:id",
    local((req, reply) => {
      const { id } = req.params as { id: string }
      const body = (req.body ?? {}) as { tier?: unknown; confirm?: unknown }
      if (Object.keys(body).some((k) => k !== "tier" && k !== "confirm") || typeof body.tier !== "string" || !SUPPORTED_TIERS.includes(body.tier)) {
        return reply.code(400).send({ error: "No se pudo cambiar el nivel: el pedido no es válido.", code: "invalid" })
      }
      if (body.tier === "control" && body.confirm !== CONTROL_CONFIRM) return reply.code(400).send({ error: NEEDS_CONFIRM, code: "confirm_required" })
      if (!deps.pairing.setTier(id, body.tier as "read" | "respond" | "control")) return reply.code(404).send({ error: "No se pudo cambiar el nivel: ese dispositivo no existe.", code: "not_found" })
      deps.audit?.record({ deviceId: id, kind: "tier", method: "PATCH", route: "/api/remote/devices/:id", targetId: id, status: 200, outcome: "ok", reason: body.tier as string })
      control.notify()
      return deps.pairing.list().find((d) => d.id === id) ?? { ok: true }
    }),
  )

  app.delete<{ Params: { id: string } }>(
    "/api/remote/devices/:id",
    local((req, reply) => {
      const { id } = req.params as { id: string }
      if (!deps.pairing.revoke(id)) return reply.code(404).send({ error: "No se pudo revocar: ese dispositivo no existe.", code: "not_found" })
      // Revocar corta también sus websockets abiertos.
      deps.registry.closeDevice(id)
      deps.audit?.record({ deviceId: id, kind: "revoke", method: "DELETE", route: "/api/remote/devices/:id", targetId: id, status: 200, outcome: "ok" })
      control.notify()
      return { ok: true }
    }),
  )

  // Revoca todos los dispositivos de una vez y corta sus websockets.
  app.post(
    "/api/remote/devices/revoke-all",
    local(() => {
      const ids = deps.pairing.revokeAll()
      for (const id of ids) deps.registry.closeDevice(id)
      deps.audit?.record({ kind: "revoke", method: "POST", route: "/api/remote/devices/revoke-all", status: 200, outcome: "ok", reason: "all" })
      control.notify()
      return { ok: true, revoked: ids.length }
    }),
  )

  // La auditoría (sin contenido): lo que pasó, quién y con qué resultado. Solo desde esta máquina.
  app.get<{ Querystring: { limit?: string } }>(
    "/api/remote/audit",
    local((req) => ({ rows: deps.audit?.list(Number((req.query as { limit?: string }).limit) || 200) ?? [], counters: deps.audit?.counters() ?? { reads: 0 } })),
  )

  // Cierra la sesión de este dispositivo: lo revoca (hay que vincularlo de nuevo), corta sus websockets y borra la cookie.
  app.post("/api/remote/logout", async (req, reply) => {
    if (!deps.isRemote?.(req)) return reply.code(403).send(forbidden)
    const device = deps.authenticate(req)
    if (!device) return reply.code(401).send({ error: MESSAGES.unpaired, code: "remote_unpaired" })
    deps.pairing.revoke(device.id)
    deps.registry.closeDevice(device.id)
    reply.header("set-cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`)
    control.notify()
    return { ok: true }
  })

  const configView = () => {
    const c = control.config()
    return { enabled: c.enabled, tier: c.tier, requireLocalForDangerous: c.requireLocalForDangerous, httpsPort: c.httpsPort, localPort: c.localPort }
  }
  app.get("/api/remote/config", local(() => configView()))
  app.patch<{ Body: { tier?: unknown; requireLocalForDangerous?: unknown; confirm?: unknown } | null }>(
    "/api/remote/config",
    local((req, reply) => {
      const body = (req.body ?? {}) as { tier?: unknown; requireLocalForDangerous?: unknown; confirm?: unknown }
      const known = new Set(["tier", "requireLocalForDangerous", "confirm"])
      if (Object.keys(body).some((k) => !known.has(k))) return reply.code(400).send({ error: "No se pudo guardar: hay ajustes que no existen.", code: "invalid" })
      if (body.tier !== undefined) {
        if (typeof body.tier !== "string" || !SUPPORTED_TIERS.includes(body.tier)) {
          return reply.code(400).send({ error: "No se pudo cambiar el nivel: ese nivel todavía no está disponible.", code: "invalid" })
        }
        if (body.tier === "control" && body.confirm !== CONTROL_CONFIRM) return reply.code(400).send({ error: NEEDS_CONFIRM, code: "confirm_required" })
        control.setConfig({ tier: body.tier as "read" | "respond" | "control" })
        deps.audit?.record({ kind: "tier", method: "PATCH", route: "/api/remote/config", status: 200, outcome: "ok", reason: body.tier as string })
      }
      if (body.requireLocalForDangerous !== undefined) {
        if (typeof body.requireLocalForDangerous !== "boolean") return reply.code(400).send({ error: "No se pudo guardar: valor inválido.", code: "invalid" })
        control.setConfig({ requireLocalForDangerous: body.requireLocalForDangerous })
      }
      return configView()
    }),
  )
}
