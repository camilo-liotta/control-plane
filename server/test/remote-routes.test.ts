import assert from "node:assert/strict"
import net from "node:net"
import { afterEach, describe, it } from "node:test"

import { WebSocket } from "ws"

import type { RemoteStatus } from "../src/shared/types.ts"
import { fakeTailscale, harness, HOST, ORIGIN, type Harness, type Res } from "./remote-harness.ts"

let h: Harness
afterEach(async () => h?.close())

const json = (r: Res) => JSON.parse(r.body) as Record<string, unknown>

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1")
    s.once("connect", () => {
      s.destroy()
      resolve(false)
    })
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED"))
  })

describe("GET /api/remote/status (con control)", () => {
  it("apagado de fábrica: listo, sin URL ni exposición", async () => {
    h = await harness()
    const res = await h.local("GET", "/api/remote/status")
    assert.equal(res.status, 200)
    const body = json(res) as unknown as RemoteStatus
    assert.equal(body.enabled, false)
    assert.equal(body.active, false)
    assert.equal(body.url, null)
    assert.deepEqual(h.fake.calls, ["status"])
    assert.equal(h.remote.listener.running, false)
  })
})

describe("prender y apagar por la API local", () => {
  it("enable: abre el listener, deja la URL y la web estática se ve por el puerto remoto", async () => {
    h = await harness()
    const res = await h.enable()
    assert.equal(res.status, 200)
    const body = json(res) as unknown as RemoteStatus
    assert.equal(body.enabled, true)
    assert.equal(body.active, true)
    assert.equal(body.url, `https://${HOST}:8443/`)
    const page = await h.request(h.remotePort, { path: "/index.html" })
    assert.equal(page.status, 200)
    assert.equal(h.fake.entries.get(8443), `http://127.0.0.1:${h.remotePort}`)
  })

  it("enable con Tailscale sin estar listo: 409 con el motivo y nada abierto", async () => {
    const ts = fakeTailscale()
    ts.state = { kind: "stopped", message: "No se pudo usar Tailscale: está apagado." }
    h = await harness({ tailscale: ts })
    const res = await h.enable()
    assert.equal(res.status, 409)
    assert.equal(json(res).code, "stopped")
    assert.match(String(json(res).error), /^No se pudo/)
    assert.equal(h.remote.listener.running, false)
    assert.equal(h.db.getRemoteConfig().enabled, false)
  })

  it("enable con el 443 o el puerto principal: rechazado", async () => {
    h = await harness()
    assert.equal((await h.local("POST", "/api/remote/enable", { httpsPort: 443 })).status, 409)
    assert.equal((await h.local("POST", "/api/remote/enable", { httpsPort: h.mainPort })).status, 409)
  })

  it("disable: saca lo nuestro y cierra el listener", async () => {
    h = await harness()
    await h.enable()
    const res = await h.local("POST", "/api/remote/disable")
    assert.equal(res.status, 200)
    assert.equal(json(res).removed, true)
    assert.equal(h.fake.entries.size, 0)
    assert.equal(await refused(h.remotePort), true)
  })
})

describe("kill con Tailscale colgado (R2.12)", () => {
  it("responde enseguida, el listener y los websockets quedan cerrados y el próximo pedido remoto se rechaza", { timeout: 15_000 }, async () => {
    h = await harness()
    await h.enable()
    const { cookie } = await h.pairDevice()
    // Un websocket remoto abierto.
    const ws = new WebSocket(`ws://127.0.0.1:${h.remotePort}/ws`, { headers: { origin: ORIGIN, cookie } })
    await new Promise((r) => ws.once("open", r))
    const closed = new Promise<void>((r) => ws.once("close", () => r()))
    assert.equal(h.hub.size, 1)

    h.fake.hang = true
    const t0 = Date.now()
    const res = await h.local("POST", "/api/remote/kill")
    assert.equal(res.status, 200)
    assert.ok(Date.now() - t0 < 2000, `tardó ${Date.now() - t0} ms`)
    assert.equal(h.db.getRemoteConfig().enabled, false)
    assert.equal(h.remote.listener.running, false)
    await closed
    assert.equal(await refused(h.remotePort), true)
    // Los dispositivos se conservan (R3.6).
    assert.equal(h.remote.pairing.list().length, 1)
  })
})

describe("/api/remote/config", () => {
  it("lee los valores y cambia la confirmación local de comandos", async () => {
    h = await harness()
    const before = json(await h.local("GET", "/api/remote/config"))
    assert.equal(before.tier, "read")
    assert.equal(before.requireLocalForDangerous, true)
    const res = await h.local("PATCH", "/api/remote/config", { requireLocalForDangerous: false })
    assert.equal(res.status, 200)
    assert.equal(h.db.getRemoteConfig().requireLocalForDangerous, false)
  })

  it("un nivel que no existe y los ajustes que no existen son 400 (la confirmación de control se prueba en remote-control-tier)", async () => {
    h = await harness()
    const patch = (body: unknown) => h.local("PATCH", "/api/remote/config", body)
    assert.equal((await patch({ tier: "root" })).status, 400)
    assert.equal((await patch({ nope: 1 })).status, 400)
    assert.equal(h.db.getRemoteConfig().tier, "read")
    assert.equal((await patch({ tier: "read" })).status, 200)
  })
})

describe("la gestión no se abre desde el listener remoto (R3.4)", () => {
  it("todas las rutas de /api/remote que gestionan dan 403 en el remoto, incluso con un dispositivo válido", async () => {
    h = await harness()
    await h.enable()
    const { cookie } = await h.pairDevice()
    const id = h.remote.pairing.list()[0]!.id
    for (const [m, p] of [
      ["GET", "/api/remote/status"],
      ["POST", "/api/remote/enable"],
      ["POST", "/api/remote/disable"],
      ["POST", "/api/remote/kill"],
      ["GET", "/api/remote/config"],
      ["PATCH", "/api/remote/config"],
      ["POST", "/api/remote/pairings"],
      ["GET", "/api/remote/devices"],
      ["DELETE", `/api/remote/devices/${id}`],
    ] as const) {
      const res = await h.remoteRequest(m, p, { cookie, body: m === "GET" ? undefined : {} })
      assert.equal(res.status, 403, `${m} ${p}`)
      assert.equal(json(res).code, "remote_forbidden", `${m} ${p}`)
    }
    // Y nada de eso cambió el estado.
    assert.equal(h.db.getRemoteConfig().enabled, true)
    assert.equal(h.remote.pairing.list().length, 1)
  })
})
