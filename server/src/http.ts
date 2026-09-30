import { createHash, timingSafeEqual } from "node:crypto"

import type { FastifyInstance } from "fastify"

import type { ClientKind, Hub } from "./hub.ts"
import type { Health, ServerMessage } from "./shared/types.ts"

/** Solo para esta máquina: rechaza otros hosts (DNS rebinding) y orígenes ajenos. Cubre todo, health y /ws incluidos. */
export function localOnly(app: FastifyInstance, port: number, extraOrigins: string[] = []) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins])
  app.addHook("onRequest", async (req, reply) => {
    if (!allowedHosts.has(String(req.headers.host ?? ""))) {
      return reply.code(403).send({ error: "host no permitido" })
    }
    const origin = req.headers.origin
    if (origin && !allowedOrigins.has(origin) && !req.url.startsWith("/mcp/")) {
      return reply.code(403).send({ error: "origen no permitido" })
    }
  })
}

/** Para que la app de escritorio reconozca al server (sin rutas ni datos de la máquina). */
export function registerHealth(app: FastifyInstance, info: Omit<Health, "app" | "pid">) {
  const body: Health = { app: "control-plane", version: info.version, pid: process.pid, port: info.port, startedAt: info.startedAt, launchId: info.launchId }
  app.get("/api/health", async () => body)
}

const MIN_SHUTDOWN_TOKEN = 32

const sha256 = (s: string) => createHash("sha256").update(s).digest()

/**
 * POST /api/desktop/shutdown: la app de escritorio apaga el server con el token que le pasó al lanzarlo.
 * Solo existe si hay un token de al menos 32 caracteres; devuelve si registró la ruta.
 * El launchId no sirve: /api/health lo publica. Con Origin siempre 403 (no es un pedido de un navegador).
 */
export function registerDesktopShutdown(app: FastifyInstance, token: string | null, onShutdown: () => void): boolean {
  if (!token || token.length < MIN_SHUTDOWN_TOKEN) return false
  const expected = sha256(token)
  let requested = false
  app.post("/api/desktop/shutdown", async (req, reply) => {
    if (req.headers.origin) return reply.code(403).send({ error: "origen no permitido" })
    const given = req.headers["x-control-plane-token"]
    if (typeof given !== "string" || !timingSafeEqual(sha256(given), expected)) {
      return reply.code(401).send({ error: "token inválido" })
    }
    if (!requested) {
      requested = true
      // Primero sale la respuesta: el apagado cierra el server y no puede cortarla.
      reply.raw.once("finish", () => setImmediate(onShutdown))
    }
    return reply.code(202).send({ ok: true })
  })
  return true
}

/** /ws para la web y /ws?client=desktop para la app de escritorio. */
export function registerWs(app: FastifyInstance, hub: Hub, hello: () => ServerMessage) {
  app.get<{ Querystring: { client?: string } }>("/ws", { websocket: true }, (socket, req) => {
    const kind: ClientKind = req.query.client === "desktop" ? "desktop" : "web"
    hub.add(socket, hello, kind)
  })
}
