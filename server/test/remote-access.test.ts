import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { WebSocket } from "ws"

import { DEVICE_TTL_MS } from "../src/remote/pairing.ts"
import type { RoutesDeps } from "../src/routes.ts"
import type { Snapshot } from "../src/shared/types.ts"
import { emptySnapshot, harness, ORIGIN, type Harness, type Res } from "./remote-harness.ts"

let h: Harness
afterEach(async () => h?.close())

const json = (r: Res) => JSON.parse(r.body) as Record<string, any>

const COOKIE_RE = /^__Host-cp_device=[A-Za-z0-9_-]{43,}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/

// Cosas que NO tienen que salir nunca por el listener remoto.
const SECRET_COMMAND = "docker run -e API_KEY=SECRETFIX123 app"
const SECRET_DIR = "/home/example-user/.claude-work"
const SECRET_USER = "admin-fixture-user"
const SECRET_HOME = "/home/example-user"
const SECRET_NOTES = "pass en notas: NOTASFIX999"
const SECRET_REPO = "/home/example-user/code/proyecto-fixture"
const SECRET_EMAIL = "ana-fixture@example.com"

function fixtureSnapshot(): Snapshot {
  const s = emptySnapshot()
  s.accounts = [{ id: "a1", name: "Trabajo", configDir: SECRET_DIR, isDefault: true, bin: "/usr/local/bin/claude-fixture", auth: { loggedIn: true, email: SECRET_EMAIL } as never, usage: null, projects: 1, engram: { state: "missing", plugin: "missing", mcp: false, binary: null } }]
  s.apps = [
    {
      id: "app1", projectId: "p1", name: "web", command: SECRET_COMMAND, shell: false, cwd: "services/web", env: { TOKEN: "ENVFIX42" }, health: null, url: null, stopCommand: "docker compose down --secret=STOPFIX7",
      createdBy: null, createdAt: 0, updatedAt: 0, definedUrl: null,
      state: { status: "up", pid: 1, startedAt: 0, exitCode: null, signal: null, error: null, tail: ["linea con TAILFIX55"], checkedAt: 0 },
    },
  ]
  s.environments = [
    { id: "e1", projectId: "p1", name: "Local", url: "http://localhost:3000", appId: null, notes: SECRET_NOTES, createdBy: null, createdAt: 0, updatedAt: 0, credentials: [{ id: "c1", environmentId: "e1", name: "Admin", username: SECRET_USER, hasSecret: true, loginUrl: null, notes: null, createdBy: null, createdAt: 0, updatedAt: 0 }] },
  ]
  s.meta.homeDir = SECRET_HOME
  s.meta.account = { email: SECRET_EMAIL }
  s.projects = [{ id: "p1", name: "Proyecto", repoPath: SECRET_REPO, settings: {} as never, afk: null, accountId: "a1", createdAt: 0, archivedAt: null, review: {} as never }]
  s.sessions = [{ id: "s1", projectId: "p1", name: "orq", cwd: SECRET_REPO } as never]
  return s
}

/** Las dependencias mínimas para que GET /api/snapshot corra de verdad con el snapshot de arriba. */
function snapshotDeps(s: Snapshot): Partial<RoutesDeps> {
  return {
    db: { listProjects: () => s.projects, listRecentDrafts: () => s.drafts, listRecentReports: () => s.reports, listArchivedProjects: () => [] },
    orchestration: { projectView: (p: unknown) => p, reportView: (r: unknown) => r },
    sessions: { list: () => s.sessions, usageFor: () => null, turns: () => s.turns, meta: s.meta },
    accounts: { list: () => s.accounts, view: (a: unknown) => a },
    compaction: { list: () => [] },
    tasks: { list: () => [] },
    environments: { list: () => s.environments },
    apps: { all: () => s.apps },
  } as never
}

describe("canje del enlace: POST /api/remote/pair (R3.3)", () => {
  it("pone la cookie exacta, siempre Secure, aunque no haya X-Forwarded-Proto, y devuelve el nivel elegido (read por defecto)", async () => {
    h = await harness()
    await h.enable()
    const { setCookie, res } = await h.pairDevice({ name: "Celu de prueba" })
    assert.equal(res.status, 200)
    assert.match(setCookie, COOKIE_RE)
    const body = json(res)
    assert.deepEqual(body, { ok: true, name: "Celu de prueba", tier: "read" })
    assert.ok(!res.body.includes(setCookie.split("=")[1]!.split(";")[0]!), "la cookie no va en el cuerpo")
    // Con X-Forwarded-Proto: http tampoco cambia (no se lee).
    const second = await h.pairDevice({ headers: { "x-forwarded-proto": "http" } })
    assert.match(second.setCookie, COOKIE_RE)
  })

  it("solo existe en el listener remoto: en el principal es 403", async () => {
    h = await harness()
    await h.enable()
    const res = await h.local("POST", "/api/remote/pair", { token: "x".repeat(43) })
    assert.equal(res.status, 403)
    assert.equal(json(res).code, "remote_forbidden")
  })

  it("token inválido, repetido o vencido: 401 sin pistas; cuerpo mal formado: 400", async () => {
    h = await harness()
    await h.enable()
    const bad = await h.remoteRequest("POST", "/api/remote/pair", { body: { token: "a".repeat(43) } })
    assert.equal(bad.status, 401)
    const created = json(await h.local("POST", "/api/remote/pairings", {}))
    const token = new URL(created.url).hash.replace("#pair=", "")
    assert.equal((await h.remoteRequest("POST", "/api/remote/pair", { body: { token } })).status, 200)
    assert.equal((await h.remoteRequest("POST", "/api/remote/pair", { body: { token } })).status, 401)
    assert.equal((await h.remoteRequest("POST", "/api/remote/pair", { body: {} })).status, 400)
    assert.equal((await h.remoteRequest("POST", "/api/remote/pair", { body: { token, extra: 1 } })).status, 400)
    // Vencido a los 5 minutos.
    const old = json(await h.local("POST", "/api/remote/pairings", {}))
    h.clock.now += 5 * 60_000 + 1
    assert.equal((await h.remoteRequest("POST", "/api/remote/pair", { body: { token: new URL(old.url).hash.replace("#pair=", "") } })).status, 401)
  })

  it("5 pareos fallidos en 10 minutos: el 6.º es 429 con Retry-After, aunque el token sea bueno", async () => {
    h = await harness()
    await h.enable()
    for (let i = 0; i < 5; i++) assert.equal((await h.remoteRequest("POST", "/api/remote/pair", { body: { token: "b".repeat(43) } })).status, 401)
    const created = json(await h.local("POST", "/api/remote/pairings", {}))
    const sixth = await h.remoteRequest("POST", "/api/remote/pair", { body: { token: new URL(created.url).hash.replace("#pair=", "") } })
    assert.equal(sixth.status, 429)
    assert.ok(Number(sixth.headers["retry-after"]) >= 1)
    assert.equal(json(sixth).code, "remote_rate_limited")
    h.clock.now += 10 * 60_000 + 1
    const fresh = json(await h.local("POST", "/api/remote/pairings", {}))
    assert.equal((await h.remoteRequest("POST", "/api/remote/pair", { body: { token: new URL(fresh.url).hash.replace("#pair=", "") } })).status, 200)
  })

  it("el token y la cookie no se loguean", async () => {
    const lines: string[] = []
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error }
    for (const k of Object.keys(originals) as (keyof typeof originals)[]) console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "))
    try {
      h = await harness()
      await h.enable()
      const created = json(await h.local("POST", "/api/remote/pairings", {}))
      const token = new URL(created.url).hash.replace("#pair=", "")
      const { cookie } = await h.pairDevice()
      assert.ok(cookie)
      assert.ok(!lines.join("\n").includes(token))
      assert.ok(!lines.join("\n").includes(cookie.split("=")[1]!))
    } finally {
      Object.assign(console, originals)
    }
  })
})

describe("autenticación de dispositivo (R3.4, R3.5)", () => {
  it("sin cookie, con una inventada o revocada: 401; con la buena: pasa", async () => {
    h = await harness({ deps: snapshotDeps(fixtureSnapshot()) })
    await h.enable()
    const { cookie, deviceId } = await h.pairDevice()
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived")).status, 401)
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie: "__Host-cp_device=" + "z".repeat(43) })).status, 401)
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie: "otra=1; " + cookie })).status, 200)
    assert.equal((await h.local("DELETE", `/api/remote/devices/${deviceId}`)).status, 200)
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie })).status, 401)
  })

  it("vence a los 30 días", async () => {
    h = await harness({ deps: snapshotDeps(fixtureSnapshot()) })
    await h.enable()
    const { cookie } = await h.pairDevice()
    h.clock.now += DEVICE_TTL_MS + 1
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie })).status, 401)
  })

  it("atado al usuario de Tailscale cuando se registró al emparejar", async () => {
    h = await harness({ deps: snapshotDeps(fixtureSnapshot()) })
    await h.enable()
    const { cookie } = await h.pairDevice({ headers: { "tailscale-user-login": "ana@example.com" } })
    const ok = await h.remoteRequest("GET", "/api/projects/archived", { cookie, headers: { "tailscale-user-login": "ana@example.com" } })
    const other = await h.remoteRequest("GET", "/api/projects/archived", { cookie, headers: { "tailscale-user-login": "otro@example.com" } })
    assert.equal(ok.status, 200)
    assert.equal(other.status, 401)
  })

  it("last_seen se escribe como mucho una vez por minuto", async () => {
    h = await harness({ deps: snapshotDeps(fixtureSnapshot()) })
    await h.enable()
    const { cookie, deviceId } = await h.pairDevice()
    const seen = () => h.db.getRemoteDevice(deviceId)!.lastSeenAt
    const first = seen()
    for (let i = 0; i < 5; i++) await h.remoteRequest("GET", "/api/projects/archived", { cookie })
    assert.equal(seen(), first)
    h.clock.now += 60_000
    await h.remoteRequest("GET", "/api/projects/archived", { cookie })
    assert.equal(seen(), h.clock.now)
  })

  it("solo capabilities y pair son alcanzables sin cookie; el resto de /api/remote es 403 con cookie válida", async () => {
    h = await harness()
    await h.enable()
    const { cookie } = await h.pairDevice()
    assert.equal((await h.remoteRequest("GET", "/api/remote/capabilities")).status, 200)
    assert.equal((await h.remoteRequest("GET", "/api/remote/status", { cookie })).status, 403)
    assert.equal((await h.remoteRequest("GET", "/api/remote/devices", { cookie })).status, 403)
  })
})

describe("límites de tráfico (R3.5, R5.5)", () => {
  it("sin autenticar: 30 por minuto en total; el 31 es 429 con Retry-After, y a los 61 s vuelve a 401", async () => {
    h = await harness()
    await h.enable()
    for (let i = 0; i < 30; i++) assert.equal((await h.remoteRequest("GET", "/api/snapshot")).status, 401)
    const over = await h.remoteRequest("GET", "/api/snapshot")
    assert.equal(over.status, 429)
    assert.ok(Number(over.headers["retry-after"]) >= 1)
    assert.equal(json(over).code, "remote_rate_limited")
    h.clock.now += 61_000
    assert.equal((await h.remoteRequest("GET", "/api/snapshot")).status, 401)
  })

  it("lecturas: 600 por minuto por dispositivo; el 601 es 429 y otro dispositivo no se ve afectado", { timeout: 60_000 }, async () => {
    h = await harness({ deps: snapshotDeps(fixtureSnapshot()) })
    await h.enable()
    const a = await h.pairDevice({ name: "A" })
    const b = await h.pairDevice({ name: "B" })
    for (let i = 0; i < 600; i++) {
      const r = await h.remoteRequest("GET", "/api/projects/archived", { cookie: a.cookie })
      assert.equal(r.status, 200, `pedido ${i + 1}`)
    }
    const over = await h.remoteRequest("GET", "/api/projects/archived", { cookie: a.cookie })
    assert.equal(over.status, 429)
    assert.ok(Number(over.headers["retry-after"]) >= 1)
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie: b.cookie })).status, 200)
  })
})

describe("gestión local de enlaces y dispositivos (R3.6)", () => {
  it("POST /api/remote/pairings: con el acceso apagado es 409; prendido devuelve {url, expiresAt}; nivel inválido 400", async () => {
    h = await harness()
    assert.equal((await h.local("POST", "/api/remote/pairings", {})).status, 409)
    await h.enable()
    const res = await h.local("POST", "/api/remote/pairings", { tier: "read" })
    assert.equal(res.status, 200)
    const body = json(res)
    assert.match(body.url, new RegExp(`^${ORIGIN.replaceAll(".", "\\.")}/#pair=[A-Za-z0-9_-]{43,}$`))
    assert.equal(body.expiresAt, h.clock.now + 5 * 60_000)
    assert.equal((await h.local("POST", "/api/remote/pairings", { tier: "root" })).status, 400)
    assert.equal((await h.local("POST", "/api/remote/pairings", { tier: "respond" })).status, 200)
    assert.equal((await h.local("POST", "/api/remote/pairings", { nope: 1 })).status, 400)
  })

  it("GET /api/remote/devices lista nombre, nivel y fechas, nunca hashes ni cookies", async () => {
    h = await harness()
    await h.enable()
    const { cookie } = await h.pairDevice({ name: "Mi celu" })
    const res = await h.local("GET", "/api/remote/devices")
    assert.equal(res.status, 200)
    const list = JSON.parse(res.body) as Record<string, unknown>[]
    assert.equal(list.length, 1)
    assert.equal(list[0]!.name, "Mi celu")
    assert.equal(list[0]!.tier, "read")
    assert.ok(!res.body.includes(cookie.split("=")[1]!))
    assert.ok(!/hash/i.test(res.body))
  })

  it("DELETE /api/remote/devices/:id: el próximo pedido es 401 y sus websockets se cierran; uno inexistente es 404", async () => {
    h = await harness()
    await h.enable()
    const { cookie, deviceId } = await h.pairDevice()
    const ws = new WebSocket(`ws://127.0.0.1:${h.remotePort}/ws`, { headers: { origin: ORIGIN, cookie } })
    await new Promise((r) => ws.once("open", r))
    const closed = new Promise<void>((r) => ws.once("close", () => r()))
    assert.equal((await h.local("DELETE", `/api/remote/devices/${deviceId}`)).status, 200)
    await closed
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie })).status, 401)
    assert.equal((await h.local("DELETE", "/api/remote/devices/no-existe")).status, 404)
    assert.equal((await h.local("GET", "/api/remote/devices")).body, "[]")
  })

  it("apagar el acceso conserva los dispositivos, y al volver a prender siguen valiendo", async () => {
    h = await harness({ deps: snapshotDeps(fixtureSnapshot()) })
    await h.enable()
    const { cookie } = await h.pairDevice()
    await h.local("POST", "/api/remote/disable")
    assert.equal((await h.local("GET", "/api/remote/devices")).body.includes("Dispositivo"), true)
    await h.enable()
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie })).status, 200)
  })
})

describe("nivel read: qué se ve y qué no (R4.4, R4.6)", () => {
  it("las rutas de lectura devuelven 200 con cookie; las de respond y control, 403 remote_tier; las never, 403 remote_forbidden", async () => {
    h = await harness({ deps: snapshotDeps(fixtureSnapshot()) })
    await h.enable()
    const { cookie } = await h.pairDevice()
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie })).status, 200)
    const respond = await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} })
    assert.equal(respond.status, 403)
    assert.equal(json(respond).code, "remote_tier")
    const control = await h.remoteRequest("POST", "/api/sessions/s1/start", { cookie, body: {} })
    assert.equal(control.status, 403)
    assert.equal(json(control).code, "remote_tier")
    const never = await h.remoteRequest("POST", "/api/projects/p1/apps/start-all", { cookie, body: {} })
    assert.equal(never.status, 403)
    assert.equal(json(never).code, "remote_forbidden")
  })

  it("aunque el techo guardado sea control, un dispositivo de lectura no pasa a las rutas de respond (gana el menor)", async () => {
    h = await harness()
    await h.enable()
    const { cookie } = await h.pairDevice()
    h.db.updateRemoteConfig({ tier: "control" })
    const res = await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} })
    assert.equal(res.status, 403)
    assert.equal(json(res).code, "remote_tier")
  })

  it("GET /api/remote/capabilities: local, remoto sin vincular y remoto vinculado", async () => {
    h = await harness()
    await h.enable()
    assert.deepEqual(json(await h.local("GET", "/api/remote/capabilities")), { mode: "local" })
    assert.deepEqual(json(await h.remoteRequest("GET", "/api/remote/capabilities")), { mode: "remote-read", paired: false })
    const { cookie } = await h.pairDevice({ name: "Celu" })
    assert.deepEqual(json(await h.remoteRequest("GET", "/api/remote/capabilities", { cookie })), { mode: "remote-read", paired: true, device: { name: "Celu", tier: "read" } })
  })

  it("la respuesta de capabilities no lleva ningún secreto", async () => {
    h = await harness()
    await h.enable()
    const { cookie } = await h.pairDevice()
    const res = await h.remoteRequest("GET", "/api/remote/capabilities", { cookie })
    assert.ok(!res.body.includes(cookie.split("=")[1]!))
    assert.ok(!/token|hash|secret/i.test(res.body))
  })
})

describe("snapshot redactado (R5.8)", () => {
  it("por el remoto no salen comandos de apps, carpetas de cuentas, usuarios, notas ni rutas absolutas; por el principal todo sigue igual", async () => {
    const snap = fixtureSnapshot()
    h = await harness({ deps: snapshotDeps(snap) })
    await h.enable()
    const { cookie } = await h.pairDevice()
    const remote = await h.remoteRequest("GET", "/api/snapshot", { cookie })
    assert.equal(remote.status, 200)
    for (const secret of [SECRET_COMMAND, "SECRETFIX123", "STOPFIX7", "ENVFIX42", "TAILFIX55", SECRET_DIR, SECRET_USER, SECRET_HOME, SECRET_NOTES, SECRET_REPO, SECRET_EMAIL, "claude-fixture"]) {
      assert.ok(!remote.body.includes(secret), `el snapshot remoto trae ${secret}`)
    }
    const body = JSON.parse(remote.body) as Snapshot
    assert.equal(body.apps[0]!.name, "web", "lo demás de las apps se conserva")
    assert.equal(body.accounts[0]!.name, "Trabajo")
    assert.equal(body.projects[0]!.name, "Proyecto")

    const local = await h.local("GET", "/api/snapshot")
    assert.equal(local.status, 200)
    for (const visible of [SECRET_COMMAND, SECRET_DIR, SECRET_USER, SECRET_HOME]) assert.ok(local.body.includes(visible), `el snapshot local debería traer ${visible}`)
  })

  it("el hello de un websocket remoto también viene redactado; el principal no", async () => {
    const snap = fixtureSnapshot()
    h = await harness({ snapshot: () => snap, deps: { hello: () => ({ type: "hello", snapshot: snap }) } })
    await h.enable()
    const { cookie } = await h.pairDevice()
    const remoteMsgs: string[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${h.remotePort}/ws`, { headers: { origin: ORIGIN, cookie } })
    ws.on("message", (m) => remoteMsgs.push(String(m)))
    await new Promise((r) => ws.once("open", r))
    const localMsgs: string[] = []
    const lws = new WebSocket(`ws://127.0.0.1:${h.mainPort}/ws`, { headers: { origin: `http://127.0.0.1:${h.mainPort}` } })
    lws.on("message", (m) => localMsgs.push(String(m)))
    await new Promise((r) => lws.once("open", r))
    await new Promise((r) => setTimeout(r, 150))
    const remoteText = remoteMsgs.join("\n")
    assert.ok(remoteText.includes('"type":"hello"'))
    for (const secret of [SECRET_COMMAND, SECRET_DIR, SECRET_USER, SECRET_HOME, SECRET_REPO]) assert.ok(!remoteText.includes(secret), `el hello remoto trae ${secret}`)
    assert.ok(localMsgs.join("\n").includes(SECRET_COMMAND))
    ws.close()
    lws.close()
  })

  it("lo que se difunde después también se redacta para los remotos, y lo de escritorio o de gestión no les llega", async () => {
    const snap = fixtureSnapshot()
    h = await harness()
    await h.enable()
    const { cookie } = await h.pairDevice()
    const msgs: string[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${h.remotePort}/ws`, { headers: { origin: ORIGIN, cookie } })
    ws.on("message", (m) => msgs.push(String(m)))
    await new Promise((r) => ws.once("open", r))
    await new Promise((r) => setTimeout(r, 100))
    msgs.length = 0
    h.hub.broadcast({ type: "apps", projectId: "p1", apps: snap.apps })
    h.hub.broadcast({ type: "account", account: snap.accounts[0]! })
    h.hub.broadcast({ type: "toast", level: "info", title: "hola" })
    h.hub.broadcast({ type: "clis_changed" })
    h.hub.broadcast({ type: "session", session: snap.sessions[0]! })
    await new Promise((r) => setTimeout(r, 150))
    const text = msgs.join("\n")
    const types = msgs.map((m) => (JSON.parse(m) as { type: string }).type)
    assert.deepEqual(types, ["apps", "account", "session"])
    for (const secret of [SECRET_COMMAND, "STOPFIX7", SECRET_DIR, SECRET_EMAIL, SECRET_REPO]) assert.ok(!text.includes(secret), `la difusión remota trae ${secret}`)
    ws.close()
  })
})

describe("websockets remotos: tope por dispositivo", () => {
  it("como mucho 4 abiertos por dispositivo", async () => {
    h = await harness()
    await h.enable()
    const { cookie } = await h.pairDevice()
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${h.remotePort}/ws`, { headers: { origin: ORIGIN, cookie } })
      await new Promise((r) => ws.once("open", r))
      return ws
    }
    const sockets = [] as WebSocket[]
    for (let i = 0; i < 4; i++) sockets.push(await open())
    const fifth = await open()
    const closed = await new Promise<number>((r) => fifth.once("close", (code) => r(code)))
    assert.equal(closed, 1013)
    for (const s of sockets) s.close()
  })
})
