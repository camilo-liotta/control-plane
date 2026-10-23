import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

import { WebSocket } from "ws"

import { Db } from "../src/db.ts"
import { canonicalJson, inputHash, MAX_ROWS, outcomeOf, PRUNE_EVERY, RemoteAudit, RETENTION_MS } from "../src/remote/audit.ts"
import { fakeApi } from "./remote-fakes.ts"
import { harness, ORIGIN, type Harness, type Res } from "./remote-harness.ts"

let h: Harness
afterEach(async () => {
  const done = h
  h = undefined as never
  await done?.close()
})

const json = (r: Res) => JSON.parse(r.body) as Record<string, any>

interface Row {
  id: number
  at: number
  device_id: string | null
  kind: string
  method: string | null
  route: string | null
  target_id: string | null
  tool_name: string | null
  input_hash: string | null
  status: number | null
  outcome: string
  reason: string | null
}

const raw = () => (h.db as unknown as { db: { prepare(sql: string): { all(...a: unknown[]): unknown[] }; exec(sql: string): void } }).db
const rows = (where = "1=1") => raw().prepare(`SELECT * FROM remote_audit WHERE ${where} ORDER BY id`).all() as Row[]

async function setup(tier: "read" | "respond" | "control" = "control") {
  const api = fakeApi()
  h = await harness({ deps: api.deps })
  await h.enable()
  if (tier === "control") await h.local("PATCH", "/api/remote/config", { tier: "control", confirm: "control" })
  else if (tier === "respond") await h.local("PATCH", "/api/remote/config", { tier: "respond" })
  const dev = await h.pairDevice({ name: "Celu", tier })
  return { api, cookie: dev.cookie, deviceId: dev.deviceId }
}

describe("esquema de remote_audit (R5.4)", () => {
  it("las columnas son exactamente las del diseño, en orden, con el índice por fecha", async () => {
    h = await harness()
    const cols = raw().prepare("PRAGMA table_info(remote_audit)").all() as { name: string }[]
    assert.deepEqual(cols.map((c) => c.name), ["id", "at", "device_id", "kind", "method", "route", "target_id", "tool_name", "input_hash", "status", "outcome", "reason"])
    const idx = raw().prepare("PRAGMA index_list(remote_audit)").all() as { name: string }[]
    assert.ok(idx.some((i) => i.name === "remote_audit_at"))
  })
})

describe("qué queda anotado (R5.4)", () => {
  it("un mensaje remoto deja una fila con el dispositivo y la sesión, el patrón de la ruta y el resultado", async () => {
    const { cookie, deviceId } = await setup("respond")
    assert.equal((await h.remoteRequest("POST", "/api/sessions/s1/messages?x=1", { cookie, body: { text: "hola" } })).status, 200)
    const row = rows("route = '/api/sessions/:id/messages'")[0]!
    assert.equal(row.kind, "request")
    assert.equal(row.method, "POST")
    assert.equal(row.device_id, deviceId)
    assert.equal(row.target_id, "s1")
    assert.equal(row.status, 200)
    assert.equal(row.outcome, "ok")
    assert.equal(row.tool_name, null)
    assert.equal(row.input_hash, null)
    assert.equal(row.at, h.clock.now)
    assert.ok(!JSON.stringify(rows()).includes("x=1"), "la ruta no lleva la query")
  })

  it("el target_id sale solo de id e itemId, y solo si parece un id", async () => {
    const { cookie } = await setup("respond")
    await h.remoteRequest("POST", "/api/sessions/s1/scheduled/item-9/cancel", { cookie, body: {} })
    await h.remoteRequest("POST", "/api/sessions/un%20id%20con%20espacios/interrupt", { cookie, body: {} })
    const rs = rows()
    assert.equal(rs.find((r) => r.route === "/api/sessions/:id/scheduled/:itemId/cancel")!.target_id, "item-9")
    assert.equal(rs.find((r) => r.route === "/api/sessions/:id/interrupt")!.target_id, null)
  })

  it("los resultados: ok, denied, unauthenticated, rate_limited, invalid, error", () => {
    assert.equal(outcomeOf(200), "ok")
    assert.equal(outcomeOf(204), "ok")
    assert.equal(outcomeOf(401), "unauthenticated")
    assert.equal(outcomeOf(403), "denied")
    assert.equal(outcomeOf(429), "rate_limited")
    for (const s of [400, 404, 409, 411, 413, 415]) assert.equal(outcomeOf(s), "invalid", String(s))
    assert.equal(outcomeOf(500), "error")
    assert.equal(outcomeOf(0), "error")
  })

  it("cada resultado queda anotado según lo que pasó con el pedido (incluido el 429)", async () => {
    const { cookie } = await setup("respond")
    await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} })
    await h.remoteRequest("POST", "/api/sessions/s1/messages", { cookie, body: { text: "" } })
    await h.remoteRequest("POST", "/api/sessions/s1/start", { cookie, body: {} })
    await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { body: {} })
    for (let i = 0; i < 59; i++) await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} })
    const last = await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} })
    assert.equal(last.status, 429)
    const byOutcome = (o: string) => rows(`outcome = '${o}' AND kind = 'request'`)
    assert.ok(byOutcome("ok").length >= 1)
    assert.equal(byOutcome("invalid").length, 1)
    assert.equal(byOutcome("denied").length, 1)
    assert.equal(byOutcome("unauthenticated").length, 1)
    assert.equal(byOutcome("rate_limited").length, 1)
    assert.equal(byOutcome("denied")[0]!.reason, "remote_tier")
    assert.equal(byOutcome("rate_limited")[0]!.status, 429)
    assert.equal(byOutcome("unauthenticated")[0]!.device_id, null)
  })

  it("una ruta que no existe o que nunca se abre queda anotada sin la URL pedida", async () => {
    const { cookie } = await setup("respond")
    await h.remoteRequest("POST", "/api/accounts/SECRETACCOUNT/skills", { cookie, body: {} })
    await h.remoteRequest("POST", "/api/no-existe-SECRETPATH", { cookie, body: {} })
    const all = JSON.stringify(rows())
    assert.ok(!all.includes("SECRETACCOUNT"))
    assert.ok(!all.includes("SECRETPATH"))
    assert.equal(rows("outcome = 'denied'").length >= 2, true)
  })

  it("las lecturas no dejan filas, solo contadores; el websocket sí deja la conexión", async () => {
    const { cookie, deviceId } = await setup("read")
    for (let i = 0; i < 3; i++) await h.remoteRequest("GET", "/api/projects/archived", { cookie })
    assert.equal(rows("method = 'GET'").length, 0)
    assert.ok(h.remote.audit.counters().reads >= 3)
    const ws = new WebSocket(`ws://127.0.0.1:${h.remotePort}/ws`, { headers: { origin: ORIGIN, cookie } })
    await new Promise((r) => ws.once("open", r))
    await new Promise((r) => setTimeout(r, 50))
    ws.close()
    const w = rows("kind = 'ws'")
    assert.equal(w.length, 1)
    assert.equal(w[0]!.device_id, deviceId)
    assert.equal(w[0]!.outcome, "ok")
  })

  it("el vínculo, el cierre de sesión, el cambio de nivel, revocar, prender, apagar y cortar tienen su tipo", async () => {
    const api = fakeApi()
    h = await harness({ deps: api.deps })
    await h.enable()
    const a = await h.pairDevice({ name: "A", tier: "respond" })
    await h.local("PATCH", `/api/remote/devices/${a.deviceId}`, { tier: "read" })
    await h.local("PATCH", "/api/remote/config", { tier: "respond" })
    const b = await h.pairDevice({ name: "B" })
    await h.local("DELETE", `/api/remote/devices/${b.deviceId}`)
    await h.local("POST", "/api/remote/disable")
    await h.enable()
    await h.local("POST", "/api/remote/kill")
    const kinds = rows().map((r) => r.kind)
    for (const k of ["enable", "pair", "tier", "revoke", "disable", "kill"]) assert.ok(kinds.includes(k), `falta ${k}: ${kinds.join(",")}`)
    assert.equal(rows("kind = 'pair' AND device_id IS NOT NULL")[0]!.device_id, a.deviceId)
    assert.equal(rows("kind = 'revoke'")[0]!.device_id, b.deviceId)
    assert.equal(rows("kind = 'tier'").some((r) => r.device_id === a.deviceId), true)
  })

  it("un vínculo fallido queda como pair con el resultado, sin el token", async () => {
    h = await harness()
    await h.enable()
    const res = await h.remoteRequest("POST", "/api/remote/pair", { body: { token: "TOKENINVALIDO-9999999999" } })
    assert.equal(res.status, 401)
    const r = rows("kind = 'pair'")[0]!
    assert.equal(r.outcome, "unauthenticated")
    assert.ok(!JSON.stringify(rows()).includes("TOKENINVALIDO"))
  })

  it("cerrar sesión desde el dispositivo queda como revoke", async () => {
    const { cookie, deviceId } = await setup("respond")
    await h.remoteRequest("POST", "/api/remote/logout", { cookie, body: {} })
    const r = rows("kind = 'revoke'")[0]!
    assert.equal(r.device_id, deviceId)
    assert.equal(r.route, "/api/remote/logout")
  })
})

describe("permisos: herramienta y huella, nunca el input (R5.4)", () => {
  const SECRET_INPUT = "SECRETINPUT-rm-rf-4242"

  it("aprobar y rechazar guardan tool_name y un input_hash de 16 hex (los mismos para el mismo input, sin importar el orden de claves)", async () => {
    const { api, cookie } = await setup("control")
    api.pending.set("s1:r1", { toolName: "Edit", input: { file: "a.ts", note: SECRET_INPUT } })
    api.pending.set("s1:r2", { toolName: "Edit", input: { note: SECRET_INPUT, file: "a.ts" } })
    assert.equal((await h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body: { requestId: "r1", allow: true } })).status, 200)
    assert.equal((await h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body: { requestId: "r2", allow: false, message: "no" } })).status, 200)
    const rs = rows("route = '/api/sessions/:id/permission'")
    assert.equal(rs.length, 2)
    for (const r of rs) {
      assert.equal(r.tool_name, "Edit")
      assert.match(r.input_hash ?? "", /^[0-9a-f]{16}$/)
    }
    assert.equal(rs[0]!.input_hash, rs[1]!.input_hash)
    assert.equal(rs[0]!.input_hash, inputHash({ file: "a.ts", note: SECRET_INPUT }))
  })

  it("un Bash negado por la confirmación local también queda anotado, con su herramienta", async () => {
    const { api, cookie } = await setup("control")
    api.pending.set("s1:r1", { toolName: "Bash", input: { command: SECRET_INPUT } })
    assert.equal((await h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body: { requestId: "r1", allow: true } })).status, 403)
    const r = rows("route = '/api/sessions/:id/permission'")[0]!
    assert.equal(r.tool_name, "Bash")
    assert.equal(r.outcome, "denied")
    assert.equal(r.reason, "remote_needs_local")
  })

  it("canonicalJson ordena las claves a cualquier profundidad", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}')
    assert.equal(inputHash({ a: 1, b: 2 }), inputHash({ b: 2, a: 1 }))
    assert.notEqual(inputHash({ a: 1 }), inputHash({ a: 2 }))
  })
})

describe("la base nunca guarda mensajes, inputs, cookies ni tokens (R5.4)", () => {
  it("escaneo del archivo SQLite crudo: ninguno de los secretos del ejemplo aparece", async () => {
    const { api, cookie } = await setup("control")
    const SECRETS = { msg: "SECRETMSG-7731", prompt: "SECRETPROMPT-8842", input: "SECRETINPUT-9953", answer: "SECRETANSWER-1164", deny: "SECRETDENY-2275" }
    api.pending.set("s1:r1", { toolName: "Edit", input: { v: SECRETS.input } })
    await h.remoteRequest("POST", "/api/sessions/s1/messages", { cookie, body: { text: SECRETS.msg, clientId: "c1" } })
    await h.remoteRequest("PATCH", "/api/drafts/d1", { cookie, body: { title: "t", prompt: SECRETS.prompt } })
    await h.remoteRequest("POST", "/api/sessions/s1/answer", { cookie, body: { requestId: "q1", answers: { p: SECRETS.answer } } })
    await h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body: { requestId: "r1", allow: false, message: SECRETS.deny } })
    await h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body: { requestId: "r1", allow: true } })
    const token = (await h.local("POST", "/api/remote/pairings", {})).body
    await h.remoteRequest("POST", "/api/remote/pair", { body: { token: "TOKENPLANO-aaaaaaaaaaaaaaaaaaaa" } })
    raw().exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const secretValue = cookie.slice(cookie.indexOf("=") + 1)
    const needles = [...Object.values(SECRETS), secretValue, "TOKENPLANO", new URL(JSON.parse(token).url).hash.slice(6), "cp_device"]
    const files = [path.join(h.dir, "control-plane.db"), path.join(h.dir, "control-plane.db-wal")].filter((f) => fs.existsSync(f))
    // Los secretos de pareo/mensajes pueden vivir en otras tablas (drafts falsos no, pairings solo hash): se escanea la tabla de auditoría entera y el archivo.
    const dump = JSON.stringify(rows())
    for (const n of needles) assert.ok(!dump.includes(n), `la tabla de auditoría trae ${n}`)
    const bytes = files.map((f) => fs.readFileSync(f))
    for (const n of Object.values(SECRETS)) for (const b of bytes) assert.ok(!b.includes(Buffer.from(n)), `el archivo SQLite trae ${n}`)
    for (const b of bytes) assert.ok(!b.includes(Buffer.from(secretValue)), "el archivo SQLite trae la cookie")
    assert.ok(rows().length >= 5)
  })
})

describe("retención acotada: 30 días o 10.000 filas, podada cada 100 inserciones (R5.4)", () => {
  const withDb = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-audit-"))
    const db = new Db(path.join(dir, "a.db"))
    const clock = { now: 1_700_000_000_000 }
    const audit = new RemoteAudit({ db, now: () => clock.now })
    const count = () => (db as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db.prepare("SELECT COUNT(*) AS n FROM remote_audit").get().n
    return { dir, db, clock, audit, count, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) }
  }

  it("las constantes del diseño", () => {
    assert.equal(MAX_ROWS, 10_000)
    assert.equal(PRUNE_EVERY, 100)
    assert.equal(RETENTION_MS, 30 * 24 * 3600 * 1000)
  })

  it("poda solo cada 100 inserciones y deja las más nuevas", { timeout: 60_000 }, () => {
    const t = withDb()
    try {
      for (let i = 0; i < 10_099; i++) t.audit.record({ kind: "request", method: "POST", route: "/x", outcome: "ok", status: 200 })
      assert.equal(t.count(), 10_099, "todavía no tocó podar")
      t.audit.record({ kind: "request", method: "POST", route: "/x", outcome: "ok", status: 200 })
      assert.equal(t.count(), 10_000)
      const first = t.audit.list(1)[0]!
      assert.equal(first.id, 10_100, "queda la más nueva")
      const oldest = (t.db as unknown as { db: { prepare(s: string): { get(): { m: number } } } }).db.prepare("SELECT MIN(id) AS m FROM remote_audit").get().m
      assert.equal(oldest, 101, "se fueron las más viejas")
    } finally {
      t.done()
    }
  })

  it("las de más de 30 días se van en la próxima poda", () => {
    const t = withDb()
    try {
      for (let i = 0; i < 50; i++) t.audit.record({ kind: "request", outcome: "ok" })
      t.clock.now += RETENTION_MS + 1000
      for (let i = 0; i < 50; i++) t.audit.record({ kind: "request", outcome: "ok" })
      assert.equal(t.count(), 50)
      assert.ok(t.audit.list(100).every((r) => r.at === t.clock.now))
    } finally {
      t.done()
    }
  })

  it("al arrancar también poda lo vencido", () => {
    const t = withDb()
    try {
      t.audit.record({ kind: "request", outcome: "ok" })
      t.clock.now += RETENTION_MS + 1000
      const again = new RemoteAudit({ db: t.db, now: () => t.clock.now })
      assert.equal(t.count(), 0)
      assert.equal(again.list(10).length, 0)
    } finally {
      t.done()
    }
  })

  it("los campos libres se limpian: método, ruta, id, herramienta y motivo con forma válida o null", () => {
    const t = withDb()
    try {
      t.audit.record({ kind: "request", method: "post; DROP", route: "no-empieza-con-barra", targetId: "con espacios", toolName: "x".repeat(300), reason: "Texto Libre con espacios", outcome: "ok" })
      const r = t.audit.list(1)[0]!
      assert.equal(r.method, null)
      assert.equal(r.route, null)
      assert.equal(r.targetId, null)
      assert.equal(r.toolName, null)
      assert.equal(r.reason, null)
    } finally {
      t.done()
    }
  })
})

describe("vista local y revocar todo (R5.4, R3.6)", () => {
  it("GET /api/remote/audit solo desde esta máquina; desde el remoto 403 remote_forbidden", async () => {
    const { cookie } = await setup("respond")
    await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} })
    const local = await h.local("GET", "/api/remote/audit")
    assert.equal(local.status, 200)
    const body = json(local)
    assert.ok(Array.isArray(body.rows) && body.rows.length >= 1)
    assert.ok(body.counters && typeof body.counters.reads === "number")
    assert.ok(body.rows.every((r: Record<string, unknown>) => !("cookie" in r)))
    const remote = await h.remoteRequest("GET", "/api/remote/audit", { cookie })
    assert.equal(remote.status, 403)
    assert.equal(json(remote).code, "remote_forbidden")
  })

  it("el límite de la vista tiene tope y valor por defecto", async () => {
    await setup("respond")
    const r = json(await h.local("GET", "/api/remote/audit?limit=1"))
    assert.equal(r.rows.length, 1)
    assert.equal((await h.local("GET", "/api/remote/audit?limit=abc")).status, 200)
  })

  it("POST /api/remote/devices/revoke-all revoca todos, corta sus websockets, avisa a la web y queda anotado", async () => {
    const { cookie } = await setup("respond")
    const other = await h.pairDevice({ name: "Otro" })
    const ws = new WebSocket(`ws://127.0.0.1:${h.remotePort}/ws`, { headers: { origin: ORIGIN, cookie } })
    await new Promise((r) => ws.once("open", r))
    const closed = new Promise<void>((r) => ws.once("close", () => r()))
    let notified = 0
    const orig = h.remote.control.notify.bind(h.remote.control)
    h.remote.control.notify = () => {
      notified++
      orig()
    }
    const res = await h.local("POST", "/api/remote/devices/revoke-all", {})
    assert.equal(res.status, 200)
    assert.equal(json(res).revoked, 2)
    await closed
    assert.equal(notified >= 1, true)
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie })).status, 401)
    assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie: other.cookie })).status, 401)
    assert.equal(h.remote.pairing.list().length, 0)
    assert.equal(rows("kind = 'revoke' AND reason = 'all'").length, 1)
  })

  it("revocar todo es solo local, y sin dispositivos devuelve 0", async () => {
    const { cookie } = await setup("respond")
    const remote = await h.remoteRequest("POST", "/api/remote/devices/revoke-all", { cookie, body: {} })
    assert.equal(remote.status, 403)
    assert.equal(json(remote).code, "remote_forbidden")
    await h.local("POST", "/api/remote/devices/revoke-all", {})
    assert.equal(json(await h.local("POST", "/api/remote/devices/revoke-all", {})).revoked, 0)
  })
})
