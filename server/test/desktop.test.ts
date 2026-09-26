import assert from "node:assert/strict"
import net from "node:net"
import { after, before, describe, it } from "node:test"

import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyInstance } from "fastify"

import { desktopSummary } from "../src/desktop.ts"
import { localOnly, registerHealth, registerWs } from "../src/http.ts"
import { Hub } from "../src/hub.ts"
import type { Draft, DesktopSummary, ServerMessage, Session, StoredEvent } from "../src/shared/types.ts"

async function freePort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  const port = (srv.address() as net.AddressInfo).port
  await new Promise((r) => srv.close(r))
  return port
}

const session = (id: string, projectId: string, status: Session["status"]) => ({ id, projectId, status }) as Session
const draft = (id: string, projectId: string, state: Draft["state"]) => ({ id, projectId, state }) as Draft

describe("health", () => {
  let app: FastifyInstance
  const port = 4799

  before(async () => {
    app = Fastify()
    localOnly(app, port)
    registerHealth(app, { version: "9.9.9", port, startedAt: 123, launchId: "lanzado-por-la-app" })
    await app.ready()
  })
  after(() => app.close())

  it("responde quién es, sin rutas de la máquina", async () => {
    const res = await app.inject({ url: "/api/health", headers: { host: `127.0.0.1:${port}` } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { app: "control-plane", version: "9.9.9", pid: process.pid, port, startedAt: 123, launchId: "lanzado-por-la-app" })
  })

  it("pasa por el mismo chequeo de host y origen", async () => {
    const ajeno = await app.inject({ url: "/api/health", headers: { host: `evil.example:${port}` } })
    assert.equal(ajeno.statusCode, 403)
    const otroPuerto = await app.inject({ url: "/api/health", headers: { host: `127.0.0.1:${port + 1}` } })
    assert.equal(otroPuerto.statusCode, 403)
    const origen = await app.inject({ url: "/api/health", headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example" } })
    assert.equal(origen.statusCode, 403)
  })
})

describe("resumen de escritorio", () => {
  it("cuenta como la bandeja de entrada de la web, por proyecto", () => {
    const summary = desktopSummary({
      db: {
        listProjects: () => [{ id: "p1", name: "Uno" }, { id: "p2", name: "Dos" }] as never,
        listDrafts: (opts) => {
          assert.deepEqual(opts?.states, ["ready"])
          return [draft("d1", "p1", "ready"), draft("d2", "p3", "ready")]
        },
      },
      sessions: {
        list: () => [
          session("a", "p1", "needs_input"),
          session("b", "p1", "working"),
          session("c", "p2", "starting"),
          session("d", "p2", "idle"),
          session("e", "p2", "stopped"),
          // de un proyecto archivado: suma al total, como en la web
          session("f", "p3", "needs_input"),
        ],
      },
    })
    assert.deepEqual(summary, {
      needs: 4,
      working: 2,
      projects: [
        { id: "p1", name: "Uno", needs: 2, working: 1 },
        { id: "p2", name: "Dos", needs: 0, working: 1 },
      ],
    })
  })
})

/** Cliente de WS que junta lo que le llega. */
function client(url: string) {
  const ws = new WebSocket(url)
  const got: ServerMessage[] = []
  const waiters: (() => void)[] = []
  ws.addEventListener("message", (e) => {
    got.push(JSON.parse(String(e.data)) as ServerMessage)
    for (const w of waiters.splice(0)) w()
  })
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error("no conectó")))
  })
  const waitFor = async (pred: (m: ServerMessage) => boolean, ms = 2000): Promise<ServerMessage> => {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = got.find(pred)
      if (hit) return hit
      const left = deadline - Date.now()
      if (left <= 0) throw new Error("no llegó el mensaje esperado")
      await new Promise<void>((r) => {
        const t = setTimeout(r, left)
        waiters.push(() => {
          clearTimeout(t)
          r()
        })
      })
    }
  }
  return { ws, got, opened, waitFor, close: () => ws.close() }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("WS de escritorio", () => {
  let app: FastifyInstance
  let hub: Hub
  let base: string
  let summary: DesktopSummary

  before(async () => {
    const port = await freePort()
    base = `ws://127.0.0.1:${port}/ws`
    summary = { needs: 0, working: 0, projects: [] }
    hub = new Hub()
    hub.setSummary(() => structuredClone(summary))
    app = Fastify()
    localOnly(app, port)
    await app.register(fastifyWebsocket)
    registerWs(app, hub, () => ({ type: "hello", snapshot: { projects: [] } as never }))
    await app.listen({ host: "127.0.0.1", port })
  })
  after(async () => {
    hub.dispose()
    await app.close()
  })

  it("la app recibe el resumen y los avisos; la web, el estado de la app", async () => {
    const web = client(base)
    await web.opened
    await web.waitFor((m) => m.type === "hello")
    assert.deepEqual(await web.waitFor((m) => m.type === "desktop"), { type: "desktop", connected: false })

    const desk = client(`${base}?client=desktop`)
    await desk.opened
    assert.deepEqual(await desk.waitFor((m) => m.type === "desktop_summary"), { type: "desktop_summary", summary })
    await web.waitFor((m) => m.type === "desktop" && m.connected)

    // Una web que se conecta después se entera de que la app ya está.
    const late = client(base)
    await late.opened
    await late.waitFor((m) => m.type === "desktop" && m.connected)
    late.close()

    // Lo pesado no le llega a la app: ni streaming, ni eventos, ni el snapshot.
    hub.broadcast({ type: "partial", sessionId: "s", messageId: "m", index: 0, block: "text", delta: "hola" })
    hub.broadcast({ type: "event", event: { id: 1 } as StoredEvent })
    hub.broadcast({ type: "toast", level: "warn", title: "ALFA te necesita", sessionId: "s" })
    await desk.waitFor((m) => m.type === "toast")
    await web.waitFor((m) => m.type === "toast")
    assert.ok(web.got.some((m) => m.type === "partial") && web.got.some((m) => m.type === "event"))
    assert.deepEqual(
      desk.got.map((m) => m.type),
      ["desktop_summary", "toast"]
    )

    // Varios cambios seguidos: un solo resumen, con el último estado.
    summary.needs = 1
    hub.broadcast({ type: "session", session: session("s", "p1", "needs_input") })
    summary.working = 2
    hub.broadcast({ type: "draft", draft: draft("d", "p1", "ready") })
    summary.needs = 3
    hub.broadcast({ type: "project", project: { id: "p1" } as never })
    const next = await desk.waitFor((m) => m.type === "desktop_summary" && m.summary.needs > 0)
    assert.deepEqual(next, { type: "desktop_summary", summary: { needs: 3, working: 2, projects: [] } })
    await sleep(450)
    assert.equal(desk.got.filter((m) => m.type === "desktop_summary").length, 2)
    assert.ok(!web.got.some((m) => m.type === "desktop_summary"))

    // Un cambio después del debounce vuelve a mandar.
    summary.needs = 0
    hub.broadcast({ type: "session", session: session("s", "p1", "idle") })
    await desk.waitFor((m) => m.type === "desktop_summary" && m.summary.needs === 0 && m.summary.working === 2)

    desk.close()
    await web.waitFor((m) => m.type === "desktop" && !m.connected)
    web.close()
  })

  it("a la web le llega todo como antes", async () => {
    const web = client(`${base}?client=otra-cosa`)
    await web.opened
    await web.waitFor((m) => m.type === "hello")
    hub.broadcast({ type: "partial", sessionId: "s", messageId: "m", index: 0, block: "text", delta: "x" })
    await web.waitFor((m) => m.type === "partial")
    web.close()
  })
})
