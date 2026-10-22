import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import { WebSocket } from "ws"

import { registerWs } from "../src/http.ts"
import { Hub } from "../src/hub.ts"
import { registerRemoteStatus } from "../src/remote/routes.ts"
import type { ServerMessage } from "../src/shared/types.ts"

let app: FastifyInstance | undefined
let hub: Hub | undefined
afterEach(async () => {
  hub?.dispose()
  await app?.close()
  app = undefined
  hub = undefined
})

describe("segundas barreras (defensa en profundidad)", () => {
  it("http.ts: un websocket remoto sin hello remoto se cierra (falla cerrado) y nunca recibe el snapshot completo", async () => {
    hub = new Hub()
    app = Fastify({ logger: false })
    await app.register(fastifyWebsocket)
    const full: ServerMessage = { type: "hello", snapshot: { secreto: "SNAPSHOTFIX" } as never }
    registerWs(app, hub, () => full, { isRemote: () => true })
    await app.listen({ host: "127.0.0.1", port: 0 })
    const port = (app.server.address() as { port: number }).port
    const messages: string[] = []
    const closed = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on("message", (d) => messages.push(String(d)))
      ws.on("close", (code) => resolve(code))
      ws.on("error", reject)
    })
    assert.equal(closed, 1011)
    assert.deepEqual(messages, [])
  })

  it("remote/routes.ts: el handler de GET /api/remote/status se niega a un pedido remoto aunque la puerta no lo haya frenado", async () => {
    let handler: ((req: FastifyRequest, reply: FastifyReply) => unknown) | undefined
    const fakeApp = { get: (_path: string, h: typeof handler) => void (handler = h) } as unknown as FastifyInstance
    let statusCalls = 0
    registerRemoteStatus(fakeApp, {
      tailscale: { status: async () => (statusCalls++, { kind: "not_installed", message: "x" }) } as never,
      enabled: () => false,
      httpsPort: () => 8443,
      isRemote: (req) => (req as unknown as { remote: boolean }).remote,
    })
    const sent: { code?: number; body?: unknown } = {}
    const reply = { code: (c: number) => ((sent.code = c), reply), send: (b: unknown) => ((sent.body = b), reply) } as unknown as FastifyReply
    await handler!({ remote: true } as never, reply)
    assert.equal(sent.code, 403)
    assert.equal((sent.body as { code: string }).code, "remote_forbidden")
    assert.equal(statusCalls, 0, "no llegó a correr el handler")
    // Local: sí corre.
    const local = (await handler!({ remote: false } as never, reply)) as { state: string }
    assert.equal(statusCalls, 1)
    assert.equal(local.state, "not_installed")
  })
})
