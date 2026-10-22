import type http from "node:http"

import type { FastifyInstance, FastifyRequest } from "fastify"

import type { Db } from "../db.ts"
import type { WsOptions } from "../http.ts"
import type { Hub } from "../hub.ts"
import type { Snapshot } from "../shared/types.ts"
import type { Tailscale } from "../tailscale.ts"
import { RemoteControl } from "./control.ts"
import { RemoteAudit, registerRemoteAudit } from "./audit.ts"
import { registerRemoteEnforcement } from "./enforce.ts"
import { createGate } from "./gate.ts"
import { RemoteListener } from "./listener.ts"
import { COOKIE_NAME, PairingService, type Device } from "./pairing.ts"
import { WindowLimiter, WriteLimiter } from "./rate-limit.ts"
import { redactMessage, redactSnapshot } from "./redact.ts"
import type { RemoteRoutesDeps } from "./routes.ts"
import { WsRegistry } from "./ws-registry.ts"

export interface RemoteSetupOptions {
  app: FastifyInstance
  /** El handler de Fastify (lo captura `serverFactory`). */
  handler: () => http.RequestListener
  db: Db
  hub: Hub
  tailscale: Pick<Tailscale, "status" | "serveEntry" | "serveOn" | "serveOff">
  mainPort: number
  /** El puerto de loopback del listener remoto. */
  localPort: number
  now?: () => number
  /** El snapshot completo: a los remotos se les manda redactado. */
  snapshot: () => Snapshot
  /** El permiso que la CLI dejó pendiente en una sesión (la herramienta se lee de acá, nunca del cliente). */
  pendingPermission: (sessionId: string, requestId: string) => { toolName: string; input: Record<string, unknown> } | null
}

export interface Remote {
  audit: RemoteAudit
  listener: RemoteListener
  control: RemoteControl
  pairing: PairingService
  registry: WsRegistry
  isRemote: (req: { raw: { socket: import("node:net").Socket } }) => boolean
  gate: ReturnType<typeof createGate>
  ws: WsOptions
  routes: RemoteRoutesDeps
}

const MINUTE = 60_000

/** La cookie del dispositivo dentro del encabezado Cookie. */
function cookieOf(req: FastifyRequest): string | null {
  const header = req.headers.cookie
  if (typeof header !== "string") return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim()
  }
  return null
}

/** Arma todo lo del acceso remoto en un solo lugar: lo usan index.ts y los tests de integración. */
export function createRemote(o: RemoteSetupOptions): Remote {
  const listener = new RemoteListener({ app: o.app, handler: o.handler, mainPort: o.mainPort })
  const registry = new WsRegistry()
  const audit = new RemoteAudit({ db: o.db, now: o.now })
  registerRemoteAudit(o.app, { audit, isRemote: (req) => listener.isRemote(req.raw.socket) })
  const pairing = new PairingService({ db: o.db, now: o.now })
  const isRemote = (req: { raw: { socket: import("node:net").Socket } }) => listener.isRemote(req.raw.socket)

  const control = new RemoteControl({
    db: o.db,
    tailscale: o.tailscale,
    listener,
    localPort: o.localPort,
    mainPort: o.mainPort,
    now: o.now,
    onCut: () => registry.closeAll(),
    onChange: () => o.hub.broadcast({ type: "remote" }),
  })

  const authenticate = (req: FastifyRequest): Device | null => {
    const cookie = cookieOf(req)
    if (!cookie) return null
    const login = req.headers["tailscale-user-login"]
    return pairing.authenticate(cookie, typeof login === "string" ? login : null)
  }

  // Todo el tráfico remoto llega desde 127.0.0.1: los límites son del listener o del dispositivo, no de una IP.
  const unauthenticated = new WindowLimiter({ limit: 30, windowMs: MINUTE, now: o.now })
  const reads = new WindowLimiter({ limit: 600, windowMs: MINUTE, now: o.now })
  const pairFailures = new WindowLimiter({ limit: 5, windowMs: 10 * MINUTE, now: o.now })

  const gate = createGate({
    authenticate,
    // El Origin válido existe solo mientras el acceso remoto está prendido.
    expectedOrigin: () => {
      const c = o.db.getRemoteConfig()
      return c.enabled ? c.origin : null
    },
    ceiling: () => o.db.getRemoteConfig().tier,
    limits: {
      unauthenticated: () => unauthenticated.take(),
      device: (device) => reads.take(device.id),
    },
  })

  // Reglas de cuerpo, nivel del permiso, herramientas peligrosas y topes de las escrituras (respond y control).
  registerRemoteEnforcement(o.app, {
    isRemote: (req) => isRemote(req),
    ceiling: () => o.db.getRemoteConfig().tier,
    requireLocalForDangerous: () => o.db.getRemoteConfig().requireLocalForDangerous,
    pendingPermission: o.pendingPermission,
    writes: new WriteLimiter({ now: o.now }),
  })

  o.hub.setRemoteFilter(redactMessage)

  const ws: WsOptions = {
    isRemote: (req) => isRemote(req),
    helloRemote: () => ({ type: "hello", snapshot: redactSnapshot(o.snapshot()) }),
    onSocket: (socket, req) => {
      const device = authenticate(req)
      if (!device) return void socket.close(1008, "dispositivo no vinculado")
      if (registry.add(device.id, socket)) audit.record({ deviceId: device.id, kind: "ws", method: "GET", route: "/ws", status: 101, outcome: "ok" })
    },
  }

  const routes: RemoteRoutesDeps = {
    tailscale: o.tailscale,
    enabled: () => o.db.getRemoteConfig().enabled,
    httpsPort: () => o.db.getRemoteConfig().httpsPort,
    active: () => control.active,
    problem: () => control.problem(),
    isRemote,
    control,
    pairing,
    registry,
    authenticate,
    pairFailures,
    audit,
  }

  return { audit, listener, control, pairing, registry, isRemote, gate, ws, routes }
}
