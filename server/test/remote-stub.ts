import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import fastifyStatic from "@fastify/static"
import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyInstance } from "fastify"

import { applyPolicy } from "../src/remote/policy.ts"
import { registerRoutes, type RoutesDeps } from "../src/routes.ts"

/**
 * Dependencias vacías: alcanzan para REGISTRAR todas las rutas (ningún handler corre) y así
 * enumerarlas con `onRoute`, que es como el contrato de rutas se asegura de que ninguna quede sin clasificar.
 */
export function stubDeps(over: Partial<RoutesDeps> = {}): RoutesDeps {
  const tailscale = { status: async () => ({ kind: "not_installed" as const, message: "x" }) }
  return {
    db: {},
    hub: {},
    sessions: {},
    orchestration: {},
    afk: {},
    attachments: {},
    accounts: {},
    compaction: {},
    tools: {},
    overview: {},
    skillMarket: {},
    clis: {},
    tasks: {},
    environments: {},
    editor: {},
    apps: {},
    health: { version: "0.0.0", port: 4700, startedAt: 0, launchId: null },
    resuming: () => false,
    restart: {},
    shutdownToken: "t".repeat(40),
    onShutdown: () => {},
    terminals: {},
    port: 4700,
    devOrigins: [],
    hello: () => ({ type: "desktop", connected: false }),
    remote: { tailscale, enabled: () => false, httpsPort: () => 8443, control: {} },
    ...over,
  } as unknown as RoutesDeps
}

export interface CollectedRoute {
  method: string
  url: string
  /** Lo que dejó onRoute en config.remote. */
  remote: unknown
}

/** Un Fastify con todas las rutas registradas (más la web estática), y la lista de las que se registraron. */
export async function collectRoutes(over: Partial<RoutesDeps> = {}): Promise<{ app: FastifyInstance; routes: CollectedRoute[]; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-routes-"))
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>")
  const app = Fastify({ logger: false })
  const routes: CollectedRoute[] = []
  applyPolicy(app)
  // Va después de applyPolicy: ve el config ya completado.
  app.addHook("onRoute", (r) => {
    for (const method of Array.isArray(r.method) ? r.method : [r.method]) routes.push({ method, url: r.url, remote: (r.config as { remote?: unknown } | undefined)?.remote })
  })
  await app.register(fastifyWebsocket)
  registerRoutes(app, stubDeps(over))
  await app.register(fastifyStatic, { root: dir })
  await app.ready()
  return { app, routes, dir }
}
