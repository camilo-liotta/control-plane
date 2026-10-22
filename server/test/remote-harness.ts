import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import fastifyStatic from "@fastify/static"
import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyInstance } from "fastify"

import { Db } from "../src/db.ts"
import { localOnly } from "../src/http.ts"
import { Hub } from "../src/hub.ts"
import { registerRemoteHeaders } from "../src/remote/gate.ts"
import { applyPolicy } from "../src/remote/policy.ts"
import { createRemote, type Remote } from "../src/remote/setup.ts"
import { registerRoutes, type RoutesDeps } from "../src/routes.ts"
import type { Snapshot } from "../src/shared/types.ts"
import type { TailscaleState } from "../src/tailscale.ts"
import { stubDeps } from "./remote-stub.ts"

export const HOST = "example-host.tailnet-name.ts.net"
export const ORIGIN = `https://${HOST}:8443`
export const READY: TailscaleState = { kind: "ready", version: "1.76.1", tailnet: "tailnet-name.ts.net", host: HOST, ips: ["100.64.0.10"] }

/** Un Tailscale falso con entradas en memoria; con `hang`, ninguna llamada vuelve. */
export function fakeTailscale() {
  const f = {
    state: READY as TailscaleState,
    entries: new Map<number, string>(),
    hang: false,
    calls: [] as string[],
    async status() {
      f.calls.push("status")
      if (f.hang) return new Promise<never>(() => {})
      return f.state
    },
    async serveEntry(p: number) {
      f.calls.push("serveEntry")
      if (f.hang) return new Promise<never>(() => {})
      return { ok: true as const, target: f.entries.get(p) ?? null }
    },
    async serveOn(p: number, t: string) {
      f.calls.push("serveOn")
      if (f.hang) return new Promise<never>(() => {})
      f.entries.set(p, t)
      return { ok: true as const }
    },
    async serveOff(p: number) {
      f.calls.push("serveOff")
      if (f.hang) return new Promise<never>(() => {})
      f.entries.delete(p)
      return { ok: true as const }
    },
  }
  return f
}

/** Un puerto libre (se abre y se cierra enseguida; alcanza para los tests). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

export const emptySnapshot = (): Snapshot => ({ projects: [], sessions: [], drafts: [], reports: [], accounts: [], compactions: [], turns: [], tasks: [], environments: [], apps: [], meta: { version: "0", claudeVersion: null, models: [], account: null, homeDir: "" } })

export interface Res {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

export interface RequestOptions {
  method?: string
  path?: string
  host?: string
  headers?: Record<string, string>
  body?: string
}

export interface Harness {
  app: FastifyInstance
  hub: Hub
  db: Db
  remote: Remote
  fake: ReturnType<typeof fakeTailscale>
  mainPort: number
  /** El puerto de loopback del acceso remoto, una vez prendido. */
  remotePort: number
  dir: string
  /** Un reloj que se puede adelantar (lo usan el pareo y los límites). */
  clock: { now: number }
  request(port: number, o: RequestOptions): Promise<Res>
  /** Una petición al puerto principal (con el Host de siempre). */
  local(method: string, path: string, body?: unknown): Promise<Res>
  /** Prende el acceso remoto por la API local. */
  enable(): Promise<Res>
  /** Crea un enlace de pareo (local) y lo canjea por el listener remoto: devuelve la cookie lista para mandar. */
  pairDevice(o?: { name?: string; headers?: Record<string, string>; tier?: "read" | "respond" | "control" }): Promise<{ cookie: string; setCookie: string; deviceId: string; res: Res }>
  /** Una petición por el listener remoto, con Origin y, si se pasa, la cookie. */
  remoteRequest(method: string, path: string, o?: { cookie?: string; body?: unknown; headers?: Record<string, string>; origin?: string | null }): Promise<Res>
  close(): Promise<void>
}

export interface HarnessOptions {
  tailscale?: ReturnType<typeof fakeTailscale>
  deps?: Partial<RoutesDeps>
  /** El snapshot completo (sin redactar) que usa el hello de los clientes remotos. */
  snapshot?: () => Snapshot
}

export async function harness(o: HarnessOptions = {}): Promise<Harness> {
  const mainPort = await freePort()
  const remotePort = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-remote-"))
  // La web estática va en su propia carpeta: la base de datos está en la de al lado.
  fs.mkdirSync(path.join(dir, "web"))
  fs.writeFileSync(path.join(dir, "web", "index.html"), "<html>panel</html>")
  const hub = new Hub()
  const db = new Db(path.join(dir, "control-plane.db"))
  const fake = o.tailscale ?? fakeTailscale()
  const clock = { now: 1_700_000_000_000 }
  let handler: http.RequestListener | null = null
  const app = Fastify({
    logger: false,
    serverFactory: (h) => {
      handler = h as http.RequestListener
      return http.createServer(h as http.RequestListener)
    },
  })
  const remote = createRemote({
    app,
    handler: () => handler!,
    db,
    hub,
    tailscale: fake as never,
    mainPort,
    localPort: remotePort,
    now: () => clock.now,
    snapshot: o.snapshot ?? (() => emptySnapshot()),
    // El permiso pendiente lo busca en las sesiones falsas del test (si las hay).
    pendingPermission: (sid, rid) => (o.deps?.sessions as { pendingPermission?: (a: string, b: string) => { toolName: string; input: Record<string, unknown> } | null } | undefined)?.pendingPermission?.(sid, rid) ?? null,
  })
  localOnly(app, mainPort, [], { isRemote: remote.isRemote, gate: remote.gate })
  registerRemoteHeaders(app, remote.isRemote)
  applyPolicy(app)
  await app.register(fastifyWebsocket)
  registerRoutes(
    app,
    stubDeps({
      hub,
      port: mainPort,
      health: { version: "0.0.0", port: mainPort, startedAt: 0, launchId: null },
      hello: () => ({ type: "hello", snapshot: {} as never }),
      remote: remote.routes,
      ws: remote.ws,
      isRemote: remote.isRemote,
      ...o.deps,
    }),
  )
  await app.register(fastifyStatic, { root: path.join(dir, "web") })
  await app.listen({ host: "127.0.0.1", port: mainPort })

  const request: Harness["request"] = (port, r) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: r.method ?? "GET", path: r.path ?? "/", headers: { host: r.host ?? `127.0.0.1:${port}`, ...r.headers }, agent: false }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (body += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      req.on("error", reject)
      req.end(r.body)
    })

  const local: Harness["local"] = (method, p, body) =>
    request(mainPort, {
      method,
      path: p,
      headers: body === undefined ? (method === "GET" ? {} : { "content-length": "0" }) : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  const remoteRequest: Harness["remoteRequest"] = (method, p, r = {}) => {
    const body = r.body === undefined ? undefined : JSON.stringify(r.body)
    const headers: Record<string, string> = { ...r.headers }
    if (r.cookie) headers.cookie = r.cookie
    if (r.origin !== null && method !== "GET") headers.origin = r.origin ?? ORIGIN
    if (method !== "GET") {
      headers["content-length"] = String(Buffer.byteLength(body ?? ""))
      if (body !== undefined) headers["content-type"] = "application/json"
    }
    return request(remotePort, { method, path: p, headers, body })
  }

  return {
    app,
    hub,
    db,
    remote,
    fake,
    mainPort,
    remotePort,
    dir,
    clock,
    request,
    local,
    remoteRequest,
    enable: () => local("POST", "/api/remote/enable", {}),
    async pairDevice(p = {}) {
      const created = await local("POST", "/api/remote/pairings", { name: p.name, ...(p.tier ? { tier: p.tier } : {}), ...(p.tier === "control" ? { confirm: "control" } : {}) })
      if (created.status !== 200) throw new Error(`pairings ${created.status}: ${created.body}`)
      const token = new URL((JSON.parse(created.body) as { url: string }).url).hash.replace("#pair=", "")
      const res = await remoteRequest("POST", "/api/remote/pair", { body: { token, name: p.name }, headers: p.headers })
      const setCookie = String(res.headers["set-cookie"] ?? "")
      const cookie = setCookie.split(";")[0] ?? ""
      const deviceId = remote.pairing.authenticate(cookie.slice(cookie.indexOf("=") + 1), p.headers?.["tailscale-user-login"] ?? null)?.id ?? ""
      return { cookie, setCookie, deviceId, res }
    },
    async close() {
      remote.control.kill()
      remote.listener.stopNow()
      hub.dispose()
      await app.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
