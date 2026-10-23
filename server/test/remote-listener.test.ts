import assert from "node:assert/strict"
import net from "node:net"
import { afterEach, beforeEach, describe, it } from "node:test"

import { WebSocket } from "ws"

import { MAX_CONNECTIONS, resolveRemotePort } from "../src/remote/listener.ts"
import { freePort, harness, ORIGIN, type Harness } from "./remote-harness.ts"

let h: Harness
beforeEach(async () => {
  h = await harness()
})
afterEach(async () => h.close())

const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1")
    s.once("connect", () => {
      s.destroy()
      resolve(false)
    })
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED"))
  })

describe("el listener remoto (R2.2, R2.3)", () => {
  it("solo escucha en 127.0.0.1, aunque CONTROL_PLANE_HOST sea 0.0.0.0", async () => {
    const before = process.env.CONTROL_PLANE_HOST
    process.env.CONTROL_PLANE_HOST = "0.0.0.0"
    try {
      await h.remote.listener.start(0)
      const addr = h.remote.listener.address()
      assert.ok(addr)
      assert.equal(addr.address, "127.0.0.1")
      assert.equal(addr.family, "IPv4")
    } finally {
      if (before === undefined) delete process.env.CONTROL_PLANE_HOST
      else process.env.CONTROL_PLANE_HOST = before
    }
  })

  it("apagado: no hay listener y conectarse al puerto es rechazado", async () => {
    const port = await freePort()
    assert.equal(h.remote.listener.running, false)
    assert.equal(await refused(port), true)
    await h.remote.listener.start(port)
    assert.equal(h.remote.listener.running, true)
    assert.equal(await refused(port), false)
    await h.remote.listener.stop()
    assert.equal(h.remote.listener.running, false)
    assert.equal(await refused(port), true)
  })

  it("de fábrica no hay nada escuchando en el puerto remoto", async () => {
    assert.equal(await refused(h.remotePort), true)
    assert.equal(h.remote.listener.running, false)
  })

  it("el puerto tiene que ser distinto del principal", async () => {
    await assert.rejects(() => h.remote.listener.start(h.mainPort), /puerto/)
    assert.equal(h.remote.listener.running, false)
  })

  it("no se puede abrir dos veces", async () => {
    await h.remote.listener.start(0)
    await assert.rejects(() => h.remote.listener.start(0))
  })

  it("plazos del server remoto: 10 s para los encabezados y 30 s para el pedido", async () => {
    await h.remote.listener.start(0)
    assert.equal(h.remote.listener.timeouts().headersTimeout, 10_000)
    assert.equal(h.remote.listener.timeouts().requestTimeout, 30_000)
  })

  it("F6: el server remoto tiene un tope de conexiones", async () => {
    await h.remote.listener.start(0)
    assert.equal(h.remote.listener.timeouts().maxConnections, MAX_CONNECTIONS)
    assert.ok(MAX_CONNECTIONS > 0 && MAX_CONNECTIONS <= 256)
  })

  it("F6: CONTROL_PLANE_REMOTE_PORT se valida (1024..65535, nunca el principal ni 443)", () => {
    assert.equal(resolveRemotePort(undefined, 4700), 4710)
    assert.equal(resolveRemotePort("", 4700), 4710)
    assert.equal(resolveRemotePort("4800", 4700), 4800)
    assert.equal(resolveRemotePort("1024", 4700), 1024)
    assert.equal(resolveRemotePort("65535", 4700), 65535)
    for (const bad of ["0", "443", "1023", "65536", "-1", "abc", "NaN", "4700.5", "80", "99999999"]) {
      assert.equal(resolveRemotePort(bad, 4700), 4710, `valor ${bad}`)
    }
    // El principal tampoco: cae al de fábrica, y si el de fábrica es el principal, al siguiente.
    assert.equal(resolveRemotePort("4700", 4700), 4710)
    assert.equal(resolveRemotePort("4710", 4710), 4711)
    assert.equal(resolveRemotePort(undefined, 4710), 4711)
  })

  it("un pedido al listener remoto con Host del puerto principal sigue siendo remoto: pasa por la puerta", async () => {
    await h.remote.listener.start(0)
    const port = h.remote.listener.address()!.port
    const snap = await h.request(port, { path: "/api/snapshot", host: `127.0.0.1:${h.mainPort}` })
    assert.equal(snap.status, 401)
    assert.equal(JSON.parse(snap.body).code, "remote_unpaired")
    const term = await h.request(port, { method: "POST", path: "/api/sessions/x/terminal", host: `127.0.0.1:${h.mainPort}`, headers: { "content-length": "0" } })
    assert.equal(term.status, 403)
    assert.equal(JSON.parse(term.body).code, "remote_forbidden")
  })

  it("el puerto principal sigue igual: Host ajeno 403 como siempre, y el propio funciona", async () => {
    const bad = await h.request(h.mainPort, { path: "/api/health", host: "example-host.tailnet-name.ts.net:8443" })
    assert.equal(bad.status, 403)
    assert.deepEqual(JSON.parse(bad.body), { error: "host no permitido" })
    const ok = await h.request(h.mainPort, { path: "/api/health" })
    assert.equal(ok.status, 200)
    // Y el principal no pone los encabezados de la puerta remota.
    assert.equal(ok.headers["x-frame-options"], undefined)
  })

  it("la web estática es pública y sale con los encabezados de seguridad", async () => {
    await h.remote.listener.start(0)
    const res = await h.request(h.remote.listener.address()!.port, { path: "/index.html" })
    assert.equal(res.status, 200)
    assert.match(res.body, /panel/)
    assert.equal(res.headers["x-frame-options"], "DENY")
    assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'")
    assert.equal(res.headers["referrer-policy"], "no-referrer")
    assert.equal(res.headers["x-content-type-options"], "nosniff")
    assert.equal(res.headers["access-control-allow-origin"], undefined)
  })

  it("en /api los errores también llevan los encabezados, el no-store y el cuerpo {error, code}", async () => {
    await h.remote.listener.start(0)
    const res = await h.request(h.remote.listener.address()!.port, { path: "/api/snapshot" })
    assert.equal(res.status, 401)
    assert.equal(res.headers["cache-control"], "no-store")
    assert.equal(res.headers["x-frame-options"], "DENY")
    const body = JSON.parse(res.body)
    assert.equal(typeof body.error, "string")
    assert.equal(body.code, "remote_unpaired")
  })

  it("una ruta que no existe en /api es 403 (no se filtra qué existe), igual que una prohibida", async () => {
    await h.remote.listener.start(0)
    const port = h.remote.listener.address()!.port
    const unknown = await h.request(port, { path: "/api/lo-que-sea" })
    const known = await h.request(port, { path: "/api/credentials/x/secret" })
    assert.equal(unknown.status, 403)
    assert.equal(known.status, 403)
    assert.equal(unknown.body, known.body)
  })

  it("un POST con Origin ajeno es 403 antes de llegar al handler", async () => {
    await h.enable()
    const res = await h.remoteRequest("POST", "/api/remote/pair", { body: {}, origin: "https://evil.example" })
    assert.equal(res.status, 403)
    assert.equal(JSON.parse(res.body).code, "remote_origin")
  })

  it("isRemote falla cerrado: el puerto local alcanza aunque el socket no esté en el conjunto", async () => {
    await h.remote.listener.start(0)
    const port = h.remote.listener.address()!.port
    assert.equal(h.remote.listener.isRemote({ localPort: port } as net.Socket), true)
    assert.equal(h.remote.listener.isRemote({ localPort: h.mainPort } as net.Socket), false)
  })

  it("stopNow corta ya: destruye las conexiones abiertas y rechaza las nuevas, sin esperar", async () => {
    await h.remote.listener.start(0)
    const port = h.remote.listener.address()!.port
    const sock = net.connect(port, "127.0.0.1")
    await new Promise((r) => sock.once("connect", r))
    const closed = new Promise<void>((r) => sock.once("close", () => r()))
    h.remote.listener.stopNow()
    assert.equal(h.remote.listener.running, false)
    await closed
    assert.equal(await refused(port), true)
  })
})

describe("websockets por el listener remoto (R2.13)", () => {
  const open = (port: number, path: string, headers: Record<string, string>) =>
    new Promise<{ ws?: WebSocket; messages: string[]; status?: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
      const messages: string[] = []
      ws.on("message", (m) => messages.push(String(m)))
      ws.once("unexpected-response", (_req, res) => resolve({ messages, status: res.statusCode }))
      ws.once("error", () => {})
      ws.once("open", () => setTimeout(() => resolve({ ws, messages }), 150))
    })

  it("recibe el hello, es siempre de la web (aunque pida client=desktop) y el upgrade llega al mismo plugin", async () => {
    await h.enable()
    const { cookie } = await h.pairDevice()
    const r = await open(h.remotePort, "/ws?client=desktop", { origin: ORIGIN, cookie })
    assert.ok(r.ws, `no abrió: ${r.status}`)
    const kinds = r.messages.map((m) => (JSON.parse(m) as { type: string }).type)
    assert.ok(kinds.includes("hello"), `mensajes: ${kinds}`)
    assert.ok(!kinds.includes("desktop_summary"))
    assert.equal(h.hub.size, 1)
    r.ws.close()
  })

  it("sin dispositivo o sin Origin exacto, el upgrade se rechaza (401 / 403)", async () => {
    await h.enable()
    const { cookie } = await h.pairDevice()
    assert.equal((await open(h.remotePort, "/ws", { origin: ORIGIN })).status, 401)
    assert.equal((await open(h.remotePort, "/ws", { origin: "https://evil.example", cookie })).status, 403)
    assert.equal((await open(h.remotePort, "/ws", { cookie })).status, 403)
    assert.equal(h.hub.size, 0)
  })

  it("/ws/terminal nunca abre desde el listener remoto", async () => {
    await h.enable()
    const { cookie } = await h.pairDevice()
    const r = await open(h.remotePort, "/ws/terminal?session=x&token=y", { origin: ORIGIN, cookie })
    assert.equal(r.status, 403)
  })

  it("stopNow cierra también los websockets abiertos", async () => {
    await h.enable()
    const { cookie } = await h.pairDevice()
    const r = await open(h.remotePort, "/ws", { origin: ORIGIN, cookie })
    assert.ok(r.ws)
    const closed = new Promise<void>((res) => r.ws!.once("close", () => res()))
    h.remote.listener.stopNow()
    await closed
    await new Promise((res) => setTimeout(res, 100))
    assert.equal(h.hub.size, 0)
  })

  it("en el puerto principal, client=desktop sigue siendo de escritorio", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.mainPort}/ws?client=desktop`, { headers: { origin: `http://127.0.0.1:${h.mainPort}` } })
    const msgs: string[] = []
    ws.on("message", (m) => msgs.push(String(m)))
    await new Promise((r) => ws.once("open", r))
    await new Promise((r) => setTimeout(r, 150))
    // Sin resumen configurado, el hub no manda nada a un cliente de escritorio, pero tampoco el hello.
    assert.ok(!msgs.some((m) => (JSON.parse(m) as { type: string }).type === "hello"))
    ws.close()
  })
})
