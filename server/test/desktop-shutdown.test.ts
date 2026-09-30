import assert from "node:assert/strict"
import { describe, it } from "node:test"

import Fastify from "fastify"

import { takeShutdownToken } from "../src/config.ts"
import { localOnly, registerDesktopShutdown } from "../src/http.ts"

const PORT = 4700
const HOST = `127.0.0.1:${PORT}`
const TOKEN = "a1".repeat(32)

/** Un server mínimo con el guard local y la ruta, más un registro de en qué orden pasó cada cosa. */
async function setup(token: string | null) {
  const events: string[] = []
  const app = Fastify({ logger: false })
  localOnly(app, PORT)
  app.addHook("onResponse", async () => {
    events.push("response")
  })
  const registered = registerDesktopShutdown(app, token, () => {
    events.push("shutdown")
  })
  await app.ready()
  return { app, events, registered }
}

const post = (app: Awaited<ReturnType<typeof setup>>["app"], headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/desktop/shutdown", headers: { host: HOST, ...headers } })

/** Deja correr el setImmediate con el que la ruta difiere el apagado. */
const tick = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))

describe("takeShutdownToken", () => {
  it("devuelve el token y lo borra del entorno para que las sesiones no lo hereden", () => {
    const env: Record<string, string | undefined> = { CONTROL_PLANE_SHUTDOWN_TOKEN: TOKEN, OTRA: "x" }
    assert.equal(takeShutdownToken(env), TOKEN)
    assert.equal("CONTROL_PLANE_SHUTDOWN_TOKEN" in env, false)
    assert.equal(env.OTRA, "x")
  })

  it("sin variable, o vacía, no hay token", () => {
    assert.equal(takeShutdownToken({}), null)
    const env: Record<string, string | undefined> = { CONTROL_PLANE_SHUTDOWN_TOKEN: "" }
    assert.equal(takeShutdownToken(env), null)
    assert.equal("CONTROL_PLANE_SHUTDOWN_TOKEN" in env, false)
  })
})

describe("POST /api/desktop/shutdown", () => {
  it("sin token configurado la ruta no existe (404)", async () => {
    const { app, registered, events } = await setup(null)
    assert.equal(registered, false)
    const res = await post(app, { "x-control-plane-token": TOKEN })
    assert.equal(res.statusCode, 404)
    await tick()
    assert.equal(events.includes("shutdown"), false)
    await app.close()
  })

  it("un token de menos de 32 caracteres no registra la ruta", async () => {
    const short = "a1".repeat(15)
    const { app, registered, events } = await setup(short)
    assert.equal(registered, false)
    const res = await post(app, { "x-control-plane-token": short })
    assert.equal(res.statusCode, 404)
    await tick()
    assert.equal(events.includes("shutdown"), false)
    await app.close()
  })

  it("con 32 caracteres justos la ruta sí existe", async () => {
    const { app, registered } = await setup("b2".repeat(16))
    assert.equal(registered, true)
    await app.close()
  })

  it("token equivocado, vacío o ausente: 401 y el server sigue", async () => {
    const { app, events } = await setup(TOKEN)
    const wrong = await post(app, { "x-control-plane-token": "c3".repeat(32) })
    const prefix = await post(app, { "x-control-plane-token": TOKEN.slice(0, 40) })
    const empty = await post(app, { "x-control-plane-token": "" })
    const missing = await post(app)
    for (const res of [wrong, prefix, empty, missing]) {
      assert.equal(res.statusCode, 401)
      assert.deepEqual(res.json(), { error: "token inválido" })
    }
    await tick()
    assert.equal(events.includes("shutdown"), false)
    await app.close()
  })

  it("el launchId, que es público en /api/health, no autentica", async () => {
    const launchId = "d4".repeat(16)
    const { app, events } = await setup(TOKEN)
    const res = await post(app, { "x-control-plane-token": launchId })
    assert.equal(res.statusCode, 401)
    await tick()
    assert.equal(events.includes("shutdown"), false)
    await app.close()
  })

  it("con Origin (aunque sea el propio) responde 403 y no apaga", async () => {
    const { app, events } = await setup(TOKEN)
    const own = await post(app, { "x-control-plane-token": TOKEN, origin: `http://${HOST}` })
    const foreign = await post(app, { "x-control-plane-token": TOKEN, origin: "http://evil.example" })
    assert.equal(own.statusCode, 403)
    assert.equal(foreign.statusCode, 403)
    await tick()
    assert.equal(events.includes("shutdown"), false)
    await app.close()
  })

  it("con un Host ajeno lo rechaza el guard local (403)", async () => {
    const { app, events } = await setup(TOKEN)
    const res = await post(app, { host: "evil.example", "x-control-plane-token": TOKEN })
    assert.equal(res.statusCode, 403)
    await tick()
    assert.equal(events.includes("shutdown"), false)
    await app.close()
  })

  it("token válido: 202 y el apagado corre una vez, después de responder", async () => {
    const { app, events } = await setup(TOKEN)
    const res = await post(app, { "x-control-plane-token": TOKEN })
    assert.equal(res.statusCode, 202)
    assert.deepEqual(res.json(), { ok: true })
    await tick()
    assert.deepEqual(events, ["response", "shutdown"])
    await app.close()
  })

  it("un segundo pedido válido no vuelve a apagar", async () => {
    const { app, events } = await setup(TOKEN)
    const first = await post(app, { "x-control-plane-token": TOKEN })
    const second = await post(app, { "x-control-plane-token": TOKEN })
    assert.equal(first.statusCode, 202)
    assert.equal(second.statusCode, 202)
    await tick()
    assert.equal(events.filter((e) => e === "shutdown").length, 1)
    await app.close()
  })
})
