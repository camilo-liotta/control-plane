import assert from "node:assert/strict"
import { describe, it } from "node:test"

import Fastify from "fastify"

import { registerRemoteStatus } from "../src/remote/routes.ts"
import type { RemoteStatus } from "../src/shared/types.ts"
import { Tailscale, type Runner } from "../src/tailscale.ts"

const READY = JSON.stringify({
  Version: "1.76.1",
  BackendState: "Running",
  Self: { DNSName: "example-host.tailnet-name.ts.net.", TailscaleIPs: ["100.64.0.10"] },
  CurrentTailnet: { Name: "tailnet-name.ts.net" },
  CertDomains: ["example-host.tailnet-name.ts.net"],
})

async function setup(o: { enabled?: boolean; stdout?: string; locate?: boolean } = {}) {
  const calls: string[][] = []
  const run: Runner = async (_f, args) => {
    calls.push(args)
    return { code: 0, stdout: o.stdout ?? READY, stderr: "", timedOut: false }
  }
  const tailscale = new Tailscale({ run, locate: () => (o.locate === false ? null : { bin: "/fake/tailscale" }), mainPort: 4700 })
  const app = Fastify({ logger: false })
  registerRemoteStatus(app, { tailscale, enabled: () => o.enabled ?? false, httpsPort: () => 8443 })
  await app.ready()
  return { app, calls }
}

describe("GET /api/remote/status (R1.5)", () => {
  it("listo y apagado: estado, tailnet, IPs y host, pero sin URL", async () => {
    const { app } = await setup({ enabled: false })
    const res = await app.inject({ method: "GET", url: "/api/remote/status" })
    assert.equal(res.statusCode, 200)
    const body = res.json() as RemoteStatus
    assert.equal(body.state, "ready")
    assert.equal(body.enabled, false)
    assert.equal(body.tailnet, "tailnet-name.ts.net")
    assert.deepEqual(body.ips, ["100.64.0.10"])
    assert.equal(body.host, "example-host.tailnet-name.ts.net")
    assert.equal(body.url, null)
    await app.close()
  })

  it("listo y prendido: la URL para compartir", async () => {
    const { app } = await setup({ enabled: true })
    const body = (await app.inject({ method: "GET", url: "/api/remote/status" })).json() as RemoteStatus
    assert.equal(body.url, "https://example-host.tailnet-name.ts.net:8443/")
    await app.close()
  })

  it("no listo: el mensaje y sin URL aunque esté prendido", async () => {
    const { app } = await setup({ enabled: true, locate: false })
    const body = (await app.inject({ method: "GET", url: "/api/remote/status" })).json() as RemoteStatus
    assert.equal(body.state, "not_installed")
    assert.equal(body.message, "No se pudo encontrar Tailscale en este equipo.")
    assert.equal(body.url, null)
    assert.equal(body.host, null)
    assert.deepEqual(body.ips, [])
    await app.close()
  })

  it("solo corre `status --json`: ningún comando que cambie algo", async () => {
    const { app, calls } = await setup({ enabled: true })
    await app.inject({ method: "GET", url: "/api/remote/status" })
    await app.inject({ method: "GET", url: "/api/remote/status" })
    assert.ok(calls.length >= 1)
    for (const c of calls) assert.deepEqual(c, ["status", "--json"])
    await app.close()
  })
})
