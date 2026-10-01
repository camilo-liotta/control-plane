import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import Fastify, { type FastifyInstance } from "fastify"

import { snapshot } from "../src/api.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { desktopSummary } from "../src/desktop.ts"
import { Environments } from "../src/environments.ts"
import type { Hub } from "../src/hub.ts"
import { registerMcp } from "../src/mcp.ts"
import { HIDDEN, hidesResult, redactInput } from "../src/secrets.ts"
import { AttachmentStore } from "../src/attachments.ts"
import { Hub as RealHub } from "../src/hub.ts"
import { SessionManager } from "../src/sessions.ts"
import { writeFakeClaude } from "./fake-claude.ts"
import type { ServerMessage, TimelineEvent } from "../src/shared/types.ts"

function session(name: string, projectId: string): SessionRecord {
  return {
    id: `s_${name.toLowerCase()}`, projectId, kind: "worker", name, role: "", claudeSessionId: `c-${name}`, startedOnce: true,
    mcpToken: `tok-${name}`, model: null, effort: null, worktree: false, cwd: "/tmp", status: "idle", taskTitle: null, taskState: "none",
    lastActivity: null, lastActivityAt: null, costUsd: 0, tokens: null, context: null, createdAt: 1, archivedAt: null,
  }
}

const SECRET = "Pr0ba-s3cr3ta-1"
const SECRET2 = "Otra-Clave-2"

describe("entornos y credenciales", () => {
  let dir: string
  let db: Db
  let envs: Environments
  let app: FastifyInstance
  const messages: ServerMessage[] = []
  const events: { id: string; event: TimelineEvent }[] = []
  const logs: string[] = []
  const original = { log: console.log, error: console.error, warn: console.warn }
  const alfa = session("ALFA", "p1")
  const gamma = session("GAMMA", "p2")

  /** Llama una herramienta MCP como la llamaría la sesión (por su token). */
  async function call(who: SessionRecord, name: string, args: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/mcp/${who.mcpToken}`,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    })
    const body = JSON.parse(res.body) as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown }
    assert.ok(body.result, `respuesta MCP: ${res.body}`)
    return { text: body.result.content.map((c) => c.text).join("\n"), isError: Boolean(body.result.isError) }
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-envs-"))
    for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "))
    db = new Db(path.join(dir, "home", "t.db"))
    for (const id of ["p1", "p2"]) db.insertProject({ id, name: id.toUpperCase(), repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    db.insertSession(alfa)
    db.insertSession(gamma)
    const hub = { broadcast: (m: ServerMessage) => messages.push(m), size: 1 } as unknown as Hub
    const sessions = {
      addEvent: (id: string, event: TimelineEvent) => events.push({ id, event }),
      statusOf: () => "idle",
      contextOf: () => null,
      list: () => [],
      isRunning: () => false,
      turns: () => [],
      usageFor: () => null,
      meta: {},
    } as unknown as SessionManager
    envs = new Environments({ db, hub, sessions })
    app = Fastify()
    registerMcp(app, { db, sessions, orchestration: {} as never, environments: envs })
    await app.ready()
  })
  after(async () => {
    Object.assign(console, original)
    await app.close()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("la base solo la lee tu usuario: carpeta 0700 y archivo 0600, también si ya existía abierta", () => {
    if (process.platform === "win32") return
    const home = path.join(dir, "home")
    assert.equal(fs.statSync(home).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(home, "t.db")).mode & 0o777, 0o600)
    const old = path.join(dir, "vieja")
    fs.mkdirSync(old, { mode: 0o775 })
    fs.writeFileSync(path.join(old, "v.db"), "")
    fs.chmodSync(path.join(old, "v.db"), 0o644)
    new Db(path.join(old, "v.db")).close()
    assert.equal(fs.statSync(old).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(old, "v.db")).mode & 0o777, 0o600)
  })

  it("las sesiones crean entornos y dejan credenciales por MCP; con el mismo nombre se actualizan", async () => {
    let r = await call(alfa, "set_environment", { name: "Local", url: "http://localhost:3000" })
    assert.match(r.text, /Entorno "Local" creado/)
    r = await call(alfa, "set_environment", { name: "local", url: "http://localhost:3001", notes: "npm run dev" })
    assert.match(r.text, /actualizado/)
    assert.equal(db.listEnvironments("p1").length, 1, "el mismo entorno, sin distinguir mayúsculas")
    assert.equal(db.listEnvironments("p1")[0]!.url, "http://localhost:3001")

    r = await call(alfa, "add_credential", { environment: "Local", name: "Inquilino", username: "inq@test.com", secret: SECRET })
    assert.match(r.text, /guardada en "Local"/)
    r = await call(alfa, "add_credential", { environment: "Local", name: "inquilino", secret: SECRET2 })
    assert.match(r.text, /actualizada/)
    const creds = db.listCredentials(db.listEnvironments("p1")[0]!.id)
    assert.equal(creds.length, 1, "no se duplica")
    assert.equal(creds[0]!.secret, SECRET2)
    assert.equal(creds[0]!.username, "inq@test.com", "lo que no se pasa queda")
    assert.equal(creds[0]!.createdBy, alfa.id)

    // Un entorno que no existe se crea al dejar la primera credencial.
    await call(alfa, "add_credential", { environment: "Staging", name: "Usuario admin", username: "admin", secret: SECRET })
    assert.deepEqual(db.listEnvironments("p1").map((e) => e.name), ["Local", "Staging"])

    // list_environments trae los secretos: la sesión los necesita.
    r = await call(alfa, "list_environments")
    assert.ok(r.text.includes(SECRET2) && r.text.includes(SECRET) && r.text.includes("http://localhost:3001"))

    r = await call(alfa, "update_credential", { environment: "Staging", name: "Usuario admin", newName: "Admin", username: "root" })
    assert.match(r.text, /"Admin" actualizada/)
    assert.equal(db.findCredential(db.findEnvironment("p1", "Staging")!.id, "Admin")!.secret, SECRET, "el secreto queda si no se pasa")
  })

  it("solo las del mismo proyecto: otra sesión no las ve ni las toca", async () => {
    const r = await call(gamma, "list_environments")
    assert.ok(!r.text.includes(SECRET) && !r.text.includes("Local"), "no ve las del otro proyecto")
    const cred = db.listCredentials(db.findEnvironment("p1", "Local")!.id)[0]!
    for (const [tool, args] of [
      ["update_credential", { id: cred.id, secret: "robada" }],
      ["remove_credential", { id: cred.id }],
      ["add_credential", { environment: db.findEnvironment("p1", "Local")!.id, name: "Intrusa" }],
    ] as const) {
      const res = await call(gamma, tool, args)
      assert.ok(res.isError, `${tool} desde otro proyecto falla`)
      assert.match(res.text, /otro proyecto/)
    }
    assert.equal(db.getCredential(cred.id)!.secret, SECRET2)
    // Por nombre, GAMMA solo encuentra los suyos: "Local" para ella no existe.
    const byName = await call(gamma, "remove_credential", { environment: "Local", name: "Inquilino" })
    assert.ok(byName.isError)
  })

  it("el secreto no sale en el snapshot, los avisos, el chat, el resumen de escritorio ni los logs", async () => {
    const deps = {
      db,
      sessions: { list: () => [], turns: () => [], usageFor: () => null, meta: {}, isRunning: () => false },
      orchestration: { projectView: (p: unknown) => p, reportView: (r: unknown) => r },
      accounts: { list: () => [], view: () => null },
      compaction: { list: () => [] },
      tasks: { list: () => [] },
      apps: { all: () => [] },
      environments: envs,
    } as unknown as Parameters<typeof snapshot>[0]
    const snap = JSON.stringify(snapshot(deps))
    assert.ok(snap.includes("Inquilino") && snap.includes(`"hasSecret":true`), `el snapshot trae las credenciales: ${snap.slice(0, 600)}`)
    for (const [what, text] of [
      ["snapshot", snap],
      ["mensajes del WS (avisos incluidos)", JSON.stringify(messages)],
      ["chat de la sesión", JSON.stringify(events)],
      ["resumen de la app de escritorio", JSON.stringify(desktopSummary({ db, sessions: { list: () => [], isRunning: () => false } }))],
      ["logs", logs.join("\n")],
    ] as const) {
      assert.ok(!text.includes(SECRET) && !text.includes(SECRET2), `sin el secreto en ${what}`)
    }
    assert.ok(messages.some((m) => m.type === "toast" && m.title === "ALFA dejó una credencial" && m.body === "Inquilino · Local"))
    // La web lo pide aparte, solo al mostrarlo o copiarlo.
    const id = db.listCredentials(db.findEnvironment("p1", "Local")!.id)[0]!.id
    assert.equal(envs.secret(id), SECRET2)
  })

  it("en el chat, las llamadas con secretos se guardan tapadas", () => {
    assert.deepEqual(redactInput("mcp__control-plane__add_credential", { environment: "Local", name: "X", secret: SECRET }), { environment: "Local", name: "X", secret: HIDDEN })
    assert.deepEqual(redactInput("mcp__control-plane__update_credential", { id: "k_1", secret: SECRET }), { id: "k_1", secret: HIDDEN })
    assert.deepEqual(redactInput("Bash", { command: "echo hola" }), { command: "echo hola" })
    assert.equal(hidesResult("mcp__control-plane__list_environments"), true)
    assert.equal(hidesResult("mcp__control-plane__list_user_tasks"), false)
  })

  it("el usuario también los maneja a mano, y borrar el proyecto borra sus entornos y credenciales", () => {
    const { environment } = envs.setEnvironment("p2", { name: "Local", url: "http://127.0.0.1:8080" }, "user")
    const { credential } = envs.addCredential("p2", environment.id, { name: "Tester", username: "t", secret: "x" }, "user")
    assert.equal(credential.createdBy, null)
    envs.updateCredential("p2", { id: credential.id }, { secret: "" }, "user")
    assert.equal(db.getCredential(credential.id)!.secret, null, "un secreto vacío lo borra")
    assert.throws(() => envs.updateEnvironment(db.findEnvironment("p1", "Staging")!.id, { name: "local" }, "user"), /Ya hay un entorno/)

    const p1 = db.listEnvironments("p1").map((e) => e.id)
    assert.ok(p1.length && db.listCredentials(p1[0]!).length)
    db.purgeProject("p1")
    assert.equal(db.listEnvironments("p1").length, 0)
    for (const id of p1) assert.equal(db.listCredentials(id).length, 0)
    assert.equal(db.listEnvironments("p2").length, 1, "las del otro proyecto quedan")
    assert.equal(db.listCredentials(environment.id).length, 1)
    envs.removeEnvironment(environment.id, "user")
    assert.equal(db.getCredential(credential.id), null, "borrar el entorno borra sus credenciales")
  })
})

describe("el chat de una sesión que deja credenciales", () => {
  it("guarda la llamada con el secreto tapado y no guarda el resultado de list_environments", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-envs-chat-"))
    const db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    const sent: ServerMessage[] = []
    const hub = new (class extends RealHub {
      override broadcast(m: ServerMessage) {
        sent.push(m)
      }
    })()
    const bin = writeFakeClaude(dir)
    const sessions = new SessionManager({
      db,
      hub,
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    try {
      const s = sessions.create({ projectId: "p1", kind: "worker", name: "ALFA", role: "", cwd: dir })
      await sessions.send(s.id, `SECRETO ${SECRET}`, { origin: "control", event: { kind: "notice", level: "info", text: "prueba" } })
      for (let i = 0; i < 100 && !db.listEvents(s.id).some((e) => e.event.kind === "turn_end"); i++) await new Promise((r) => setTimeout(r, 50))
      const events = db.listEvents(s.id).map((e) => e.event)
      const use = events.find((e) => e.kind === "tool_use" && e.name.endsWith("add_credential"))
      assert.ok(use && use.kind === "tool_use")
      assert.deepEqual((use.input as Record<string, unknown>).secret, HIDDEN)
      assert.ok(events.some((e) => e.kind === "tool_result" && e.content.startsWith("Entornos y credenciales del proyecto")))
      assert.ok(!JSON.stringify(events).includes(SECRET), "el secreto no queda en el chat")
      assert.ok(!JSON.stringify(sent).includes(SECRET), "ni viaja por el WS")
    } finally {
      await sessions.shutdown()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
