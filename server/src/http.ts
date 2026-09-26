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

/** /ws para la web y /ws?client=desktop para la app de escritorio. */
export function registerWs(app: FastifyInstance, hub: Hub, hello: () => ServerMessage) {
  app.get<{ Querystring: { client?: string } }>("/ws", { websocket: true }, (socket, req) => {
    const kind: ClientKind = req.query.client === "desktop" ? "desktop" : "web"
    hub.add(socket, hello, kind)
  })
}
