import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { effectiveTier } from "../src/remote/gate.ts"
import { DANGEROUS_TOOLS, isDangerousTool } from "../src/remote/rules.ts"
import { fakeApi } from "./remote-fakes.ts"
import { harness, type Harness, type Res } from "./remote-harness.ts"

let h: Harness
afterEach(async () => {
  const done = h
  h = undefined as never
  await done?.close()
})

const json = (r: Res) => JSON.parse(r.body) as Record<string, any>

type TierName = "read" | "respond" | "control"

/** Prende el acceso, sube el techo si hace falta y vincula un dispositivo del nivel pedido. */
async function setup(device: TierName, ceiling: TierName = device) {
  const api = fakeApi()
  h = await harness({ deps: api.deps })
  await h.enable()
  if (ceiling !== "read") {
    const res = await h.local("PATCH", "/api/remote/config", { tier: ceiling, ...(ceiling === "control" ? { confirm: "control" } : {}) })
    assert.equal(res.status, 200, res.body)
  }
  const dev = await h.pairDevice({ name: "Celu", tier: device })
  return { api, cookie: dev.cookie, deviceId: dev.deviceId }
}

describe("nivel efectivo: el menor entre el techo y el del dispositivo (R4.7)", () => {
  it("la cuenta, en todas las combinaciones", () => {
    assert.equal(effectiveTier("respond", "control"), "respond")
    assert.equal(effectiveTier("control", "respond"), "respond")
    assert.equal(effectiveTier("control", "control"), "control")
    assert.equal(effectiveTier("read", "control"), "read")
    assert.equal(effectiveTier("control", "read"), "read")
    assert.equal(effectiveTier("respond", "respond"), "respond")
  })

  it("techo respond y dispositivo control: las rutas de control dan 403 remote_tier y capabilities dice respond", async () => {
    const { api, cookie } = await setup("control", "respond")
    const res = await h.remoteRequest("POST", "/api/sessions/s1/start", { cookie, body: {} })
    assert.equal(res.status, 403)
    assert.equal(json(res).code, "remote_tier")
    assert.equal(api.calls.length, 0)
    assert.equal(json(await h.remoteRequest("GET", "/api/remote/capabilities", { cookie })).mode, "remote-respond")
  })

  it("subir el techo después sube lo que puede el dispositivo; bajarlo lo recorta", async () => {
    const { cookie } = await setup("control", "respond")
    assert.equal((await h.local("PATCH", "/api/remote/config", { tier: "control", confirm: "control" })).status, 200)
    assert.equal((await h.remoteRequest("POST", "/api/sessions/s1/start", { cookie, body: {} })).status, 200)
    assert.equal((await h.local("PATCH", "/api/remote/config", { tier: "read" })).status, 200)
    assert.equal(json(await h.remoteRequest("POST", "/api/sessions/s1/start", { cookie, body: {} })).code, "remote_tier")
  })
})

describe("subir a control exige la confirmación local (R4.7)", () => {
  const patch = (body: unknown) => h.local("PATCH", "/api/remote/config", body)

  it("el techo: sin confirm o con otro valor es 400 y no cambia; con confirm:\"control\" cambia; respond no la necesita", async () => {
    h = await harness()
    assert.equal((await patch({ tier: "control" })).status, 400)
    assert.equal((await patch({ tier: "control", confirm: "si" })).status, 400)
    assert.equal((await patch({ tier: "control", confirm: true })).status, 400)
    assert.equal(h.db.getRemoteConfig().tier, "read")
    assert.equal((await patch({ tier: "respond" })).status, 200)
    assert.equal(h.db.getRemoteConfig().tier, "respond")
    assert.equal((await patch({ tier: "control", confirm: "control" })).status, 200)
    assert.equal(h.db.getRemoteConfig().tier, "control")
  })

  it("un nivel que no existe sigue siendo 400", async () => {
    h = await harness()
    assert.equal((await patch({ tier: "root", confirm: "control" })).status, 400)
    assert.equal(h.db.getRemoteConfig().tier, "read")
  })

  it("el enlace de vinculación con nivel control también exige la confirmación", async () => {
    h = await harness()
    await h.enable()
    assert.equal((await h.local("POST", "/api/remote/pairings", { tier: "control" })).status, 400)
    assert.equal((await h.local("POST", "/api/remote/pairings", { tier: "control", confirm: "control" })).status, 200)
    assert.equal((await h.local("POST", "/api/remote/pairings", { tier: "respond" })).status, 200)
  })

  it("PATCH /api/remote/devices/:id cambia el nivel de un dispositivo (control con confirmación); inexistente 404; claves de más 400", async () => {
    h = await harness()
    await h.enable()
    const { deviceId } = await h.pairDevice({ name: "Celu" })
    const set = (id: string, body: unknown) => h.local("PATCH", `/api/remote/devices/${id}`, body)
    assert.equal((await set(deviceId, { tier: "control" })).status, 400)
    assert.equal(h.remote.pairing.list()[0]!.tier, "read")
    assert.equal((await set(deviceId, { tier: "respond" })).status, 200)
    assert.equal(h.remote.pairing.list()[0]!.tier, "respond")
    assert.equal((await set(deviceId, { tier: "control", confirm: "control" })).status, 200)
    assert.equal(h.remote.pairing.list()[0]!.tier, "control")
    assert.equal((await set(deviceId, { tier: "root" })).status, 400)
    assert.equal((await set(deviceId, { tier: "read", nope: 1 })).status, 400)
    assert.equal((await set(deviceId, {})).status, 400)
    assert.equal((await set("no-existe", { tier: "read" })).status, 404)
    assert.equal((await set(deviceId, { tier: "read" })).status, 200)
    assert.equal(h.remote.pairing.list()[0]!.tier, "read")
  })

  it("desde el listener remoto ni la configuración ni el nivel de un dispositivo se tocan (403 remote_forbidden)", async () => {
    const { cookie, deviceId } = await setup("control")
    for (const [m, p] of [
      ["PATCH", "/api/remote/config"],
      ["PATCH", `/api/remote/devices/${deviceId}`],
    ] as const) {
      const res = await h.remoteRequest(m, p, { cookie, body: { tier: "control", confirm: "control" } })
      assert.equal(res.status, 403, p)
      assert.equal(json(res).code, "remote_forbidden", p)
    }
  })
})

describe("control: aprobar permisos (R6.1, R6.4)", () => {
  const allow = (cookie: string, body: Record<string, unknown> = { requestId: "r1", allow: true }) => h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body })

  it("una herramienta que no ejecuta comandos se aprueba con control (200) y la CLI recibe el pedido guardado", async () => {
    const { api, cookie } = await setup("control")
    api.pending.set("s1:r1", { toolName: "Edit", input: { file: "a.ts" } })
    const res = await allow(cookie)
    assert.equal(res.status, 200)
    assert.deepEqual(api.last("sessions.respondPermission"), ["s1", "r1", true, undefined])
  })

  it("Bash y PowerShell (también con otra capitalización) con la confirmación local prendida: 403 remote_needs_local y no se aprueba", async () => {
    const { api, cookie } = await setup("control")
    for (const tool of ["Bash", "PowerShell", "bash", " POWERSHELL "]) {
      api.pending.set("s1:r1", { toolName: tool, input: { command: "rm -rf x" } })
      const res = await allow(cookie)
      assert.equal(res.status, 403, tool)
      assert.equal(json(res).code, "remote_needs_local", tool)
    }
    assert.equal(api.count("sessions.respondPermission"), 0)
  })

  it("la confirmación local viene prendida de fábrica y apagarla es solo local", async () => {
    const { api, cookie } = await setup("control")
    assert.equal(h.db.getRemoteConfig().requireLocalForDangerous, true)
    api.pending.set("s1:r1", { toolName: "Bash", input: { command: "ls" } })
    const off = await h.remoteRequest("PATCH", "/api/remote/config", { cookie, body: { requireLocalForDangerous: false } })
    assert.equal(off.status, 403)
    assert.equal(h.db.getRemoteConfig().requireLocalForDangerous, true)
    assert.equal((await allow(cookie)).status, 403)
    assert.equal((await h.local("PATCH", "/api/remote/config", { requireLocalForDangerous: false })).status, 200)
    assert.equal((await allow(cookie)).status, 200)
  })

  it("rechazar Bash sí se puede con respond (allow:false no pasa por la confirmación local)", async () => {
    const { api, cookie } = await setup("respond")
    api.pending.set("s1:r1", { toolName: "Bash", input: { command: "ls" } })
    assert.equal((await allow(cookie, { requestId: "r1", allow: false })).status, 200)
  })

  it("las herramientas de MCP no están en la lista de peligrosas: con control se aprueban (decisión explícita, ver M6)", async () => {
    assert.deepEqual([...DANGEROUS_TOOLS], ["Bash", "PowerShell"])
    assert.equal(isDangerousTool("mcp__github__create_issue"), false)
    assert.equal(isDangerousTool("Read"), false)
    assert.equal(isDangerousTool(""), true, "sin nombre no se sabe: se trata como peligrosa")
    assert.equal(isDangerousTool(undefined), true)
    const { api, cookie } = await setup("control")
    api.pending.set("s1:r1", { toolName: "mcp__github__create_issue", input: {} })
    assert.equal((await allow(cookie)).status, 200)
  })

  it("un requestId desconocido no aprueba nada (400) y no se llama a respondPermission", async () => {
    const { api, cookie } = await setup("control")
    const res = await allow(cookie, { requestId: "otro", allow: true })
    assert.equal(res.status, 400)
    assert.equal(api.count("sessions.respondPermission"), 0)
  })

  it("el cliente no puede traer la herramienta ni el input: esas claves son 400", async () => {
    const { api, cookie } = await setup("control")
    api.pending.set("s1:r1", { toolName: "Bash", input: { command: "ls" } })
    for (const extra of [{ toolName: "Read" }, { tool: "Read" }, { input: { command: "echo hola" } }, { updatedInput: {} }, { message: "ok" }]) {
      assert.equal((await allow(cookie, { requestId: "r1", allow: true, ...extra })).status, 400, JSON.stringify(extra))
    }
    assert.equal(api.count("sessions.respondPermission"), 0)
  })

  it("30 respuestas a permisos por minuto también con control", async () => {
    const { api, cookie } = await setup("control")
    api.pending.set("s1:r1", { toolName: "Edit", input: {} })
    for (let i = 0; i < 30; i++) assert.equal((await allow(cookie)).status, 200, `permiso ${i + 1}`)
    assert.equal((await allow(cookie)).status, 429)
  })
})

describe("control: iniciar y detener sesiones, AFK, reanudar planes (R6.2)", () => {
  const CONTROL: { method: string; path: string; body: unknown; fn: string }[] = [
    { method: "POST", path: "/api/sessions/s1/start", body: {}, fn: "sessions.start" },
    { method: "POST", path: "/api/sessions/s1/stop", body: {}, fn: "sessions.stop" },
    { method: "POST", path: "/api/projects/p1/afk", body: { until: Date.now() + 3_600_000, budgetUsd: 5 }, fn: "afk.start" },
    { method: "POST", path: "/api/drafts/d1/plan/resume", body: { mode: "retry" }, fn: "plans.resume" },
  ]

  it("con respond, cada ruta de control es 403 remote_tier y no se ejecuta", async () => {
    const { api, cookie } = await setup("respond")
    for (const r of CONTROL) {
      const res = await h.remoteRequest(r.method, r.path, { cookie, body: r.body })
      assert.equal(res.status, 403, r.path)
      assert.equal(json(res).code, "remote_tier", r.path)
    }
    assert.equal(api.calls.length, 0)
  })

  it("con control, cada una funciona y llega a su handler", async () => {
    const { api, cookie } = await setup("control")
    for (const r of CONTROL) {
      const res = await h.remoteRequest(r.method, r.path, { cookie, body: r.body })
      assert.equal(res.status, 200, `${r.path}: ${res.body}`)
      assert.equal(api.count(r.fn), 1, r.path)
    }
  })

  it("AFK: las mismas validaciones que en local (until y budgetUsd opcionales, numéricos o null); claves de más 400", async () => {
    const { api, cookie } = await setup("control")
    const afk = (body: unknown) => h.remoteRequest("POST", "/api/projects/p1/afk", { cookie, body })
    assert.equal((await afk({})).status, 200)
    assert.equal((await afk({ until: null, budgetUsd: null })).status, 200)
    for (const bad of [{ until: "mañana" }, { budgetUsd: "5" }, { until: {} }, { limit: 5 }]) assert.equal((await afk(bad)).status, 400, JSON.stringify(bad))
    assert.equal(api.count("afk.start"), 2)
    assert.deepEqual(api.last("afk.start"), ["p1", { until: null, budgetUsd: null }])
  })

  it("reanudar un plan: mode retry o next; otra cosa 400", async () => {
    const { cookie } = await setup("control")
    const resume = (body: unknown) => h.remoteRequest("POST", "/api/drafts/d1/plan/resume", { cookie, body })
    assert.equal((await resume({})).status, 200)
    assert.equal((await resume({ mode: "next" })).status, 200)
    assert.equal((await resume({ mode: "skip" })).status, 400)
    assert.equal((await resume({ other: 1 })).status, 400)
  })

  it("AFK apagado y pausar o cancelar un plan siguen siendo de respond", async () => {
    const { api, cookie } = await setup("respond")
    assert.equal((await h.remoteRequest("DELETE", "/api/projects/p1/afk", { cookie, body: {} })).status, 200)
    assert.equal((await h.remoteRequest("POST", "/api/drafts/d1/plan/pause", { cookie, body: {} })).status, 200)
    assert.equal((await h.remoteRequest("POST", "/api/drafts/d1/plan/cancel", { cookie, body: {} })).status, 200)
    assert.equal(api.calls.length, 3)
  })

  it("acciones de control: 10 por minuto por dispositivo; la 11 es 429 con Retry-After; otro dispositivo no se ve afectado", async () => {
    const { cookie } = await setup("control")
    const other = await h.pairDevice({ name: "Otro", tier: "control" })
    const start = (c: string) => h.remoteRequest("POST", "/api/sessions/s1/start", { cookie: c, body: {} })
    for (let i = 0; i < 10; i++) assert.equal((await start(cookie)).status, 200, `acción ${i + 1}`)
    const over = await start(cookie)
    assert.equal(over.status, 429)
    assert.ok(Number(over.headers["retry-after"]) >= 1)
    assert.equal((await start(other.cookie)).status, 200)
    h.clock.now += 61_000
    assert.equal((await start(cookie)).status, 200)
  })
})
