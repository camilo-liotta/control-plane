import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, afterEach, before, beforeEach, describe, it } from "node:test"

import Fastify from "fastify"

import { appDir, Apps, commandArgs, normalizeApp, suggestApps } from "../src/apps.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import type { Hub } from "../src/hub.ts"
import { registerMcp } from "../src/mcp.ts"
import type { Orchestration } from "../src/orchestration.ts"
import { Restart, RESUME_FILE } from "../src/restart.ts"
import type { SessionManager } from "../src/sessions.ts"
import type { AppStatus, ServerMessage } from "../src/shared/types.ts"

/** Puertos libres que elige el sistema, distintos entre sí (abiertos a la vez y cerrados juntos). */
async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: n }, () => new Promise<net.Server>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => resolve(s)) }))
  )
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port)
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  return ports
}
// Así no chocan con lo que tengan levantado otras sesiones o bancos de prueba.
const [PORT_A, PORT_B, PORT_C, PORT_D] = await freePorts(4)

const until = async (check: () => boolean | Promise<boolean>, what = "no llegó a tiempo", ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(what)
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port })
    s.once("connect", () => (s.destroy(), resolve(true)))
    s.once("error", () => resolve(false))
  })
/** Una app de prueba: un `node -e` que escucha en `port` y responde "ok". */
const server = (port: number, extra = "") =>
  `node -e "${extra}require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1');console.log('escuchando en ${port}')"`

describe("apps levantables", () => {
  let dir: string
  let project: string
  let db: Db
  let messages: ServerMessage[]
  let hub: Hub
  let apps: Apps
  const make = () => new Apps({ db, hub, home: dir, repos: async () => [], startTimeoutMs: 4_000, healthEveryMs: 200, stopGraceMs: 700 })
  const status = (id: string, a = apps): AppStatus => a.list("p1").find((x) => x.id === id)!.state.status

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-apps-")))
    project = path.join(dir, "proj")
    fs.mkdirSync(path.join(project, "web"), { recursive: true })
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: project, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    db.insertProject({ id: "p2", name: "Q", repoPath: project, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    messages = []
    hub = { broadcast: (m: ServerMessage) => void messages.push(m), size: 1 } as unknown as Hub
    apps = make()
  })
  afterEach(async () => {
    await apps.shutdown()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("levanta, espera la salud, avisa por WS y baja (SIGTERM al grupo)", async () => {
    const a = await apps.create("p1", { name: "backend", command: server(PORT_A), health: { kind: "http", url: `http://127.0.0.1:${PORT_A}/` } }, null)
    assert.equal(a.url, `http://127.0.0.1:${PORT_A}/`, "la URL para abrir sale de la salud")
    const started = await apps.start(a.id)
    assert.equal(started.state.status, "starting")
    await until(() => status(a.id) === "up", "no quedó levantada")
    const pid = apps.list("p1")[0]!.state.pid!
    assert.ok(alive(pid))
    assert.ok(messages.some((m) => m.type === "apps" && m.projectId === "p1" && m.apps[0]!.state.status === "up"))
    assert.ok(apps.log(a.id).some((l) => l.includes(`escuchando en ${PORT_A}`)), "el log tiene la salida")
    await apps.stop(a.id)
    assert.equal(status(a.id), "stopped")
    assert.equal(alive(pid), false)
    assert.equal(await portOpen(PORT_A), false)
    // El log queda en disco después de bajarla.
    assert.ok(apps.log(a.id).some((l) => l.includes("terminó")))
  })

  it("sin responder: el proceso vive pero la salud no contesta", async () => {
    const a = await apps.create("p1", { name: "mudo", command: `node -e "setInterval(()=>{},1000)"`, health: { kind: "tcp", port: PORT_B } }, null)
    await apps.start(a.id)
    await until(() => status(a.id) === "unresponsive", "no quedó sin responder", 8_000)
    await apps.stop(a.id)
  })

  it("se cayó: con el código de salida y las últimas líneas", async () => {
    const a = await apps.create("p1", { name: "frágil", command: `node -e "console.log('arrancando');console.error('boom: falta DATABASE_URL');process.exit(3)"`, health: { kind: "tcp", port: PORT_B } }, null)
    await apps.start(a.id)
    await until(() => status(a.id) === "crashed", "no se marcó caída")
    const st = apps.list("p1")[0]!.state
    assert.equal(st.exitCode, 3)
    assert.ok(st.tail.some((l) => l.includes("boom: falta DATABASE_URL")))
  })

  it("un comando que no existe: se cayó, con el motivo", async () => {
    const a = await apps.create("p1", { name: "nada", command: "no-existe-este-binario --x" }, null)
    await apps.start(a.id).catch(() => {})
    await until(() => status(a.id) === "crashed")
    assert.match(apps.list("p1")[0]!.state.error ?? "", /`no-existe-este-binario` no está en el PATH/)
  })

  it("levantada afuera: se muestra así, no se lanza de nuevo ni se baja", async () => {
    const outside = http.createServer((_q, r) => r.end("ok"))
    await new Promise<void>((r) => outside.listen(PORT_C, "127.0.0.1", r))
    try {
      const a = await apps.create("p1", { name: "ajena", command: server(PORT_C), health: { kind: "tcp", port: PORT_C } }, null)
      apps.watch("p1")
      await until(() => status(a.id) === "external", "no la vio levantada afuera")
      await assert.rejects(apps.start(a.id), /levantada afuera/)
      await assert.rejects(apps.stop(a.id), /la levantó otro programa/)
      assert.equal(apps.runningIds().length, 0)
    } finally {
      await new Promise((r) => outside.close(r))
    }
    // Cuando la de afuera se baja, vuelve a detenida (mientras alguien mira el proyecto).
    await until(() => status(apps.list("p1")[0]!.id) === "stopped", "no volvió a detenida")
  })

  it("al apagar: baja todas, con su comando de bajar, y SIGKILL a la que ignora SIGTERM; mata también a los hijos", async () => {
    const marker = path.join(dir, "bajada.txt")
    const childPid = path.join(dir, "hijo.pid")
    const terca = await apps.create("p1", { name: "terca", command: `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"` }, null)
    const compose = await apps.create(
      "p1",
      { name: "compose", command: server(PORT_D), health: { kind: "tcp", port: PORT_D }, stopCommand: `node -e "require('fs').writeFileSync('${marker}','x')"` },
      null
    )
    const shell = await apps.create("p1", { name: "con-shell", shell: true, command: `node -e "setInterval(()=>{},1000)" & echo $! > ${childPid}; wait` }, null)
    for (const a of [terca, compose, shell]) await apps.start(a.id)
    await until(() => [terca, compose, shell].every((a) => status(a.id) === "up"), "no levantaron las tres")
    await until(() => fs.existsSync(childPid) && fs.readFileSync(childPid, "utf8").trim() !== "")
    const pids = apps.list("p1").map((a) => a.state.pid!)
    const grandchild = Number(fs.readFileSync(childPid, "utf8"))
    assert.ok(alive(grandchild))
    await apps.shutdown()
    assert.ok(fs.existsSync(marker), "corrió el comando de bajar")
    for (const pid of pids) assert.equal(alive(pid), false, `quedó vivo ${pid}`)
    assert.equal(alive(grandchild), false, "quedó vivo el hijo de la shell")
    assert.ok(apps.log(terca.id).some((l) => l.includes("SIGKILL")))
  })

  it("después de un reinicio para actualizar, vuelve a levantar las que estaban arriba (antes que las sesiones)", async () => {
    const a = await apps.create("p1", { name: "backend", command: server(PORT_A), health: { kind: "tcp", port: PORT_A } }, null)
    const b = await apps.create("p1", { name: "quieta", command: server(PORT_B), health: { kind: "tcp", port: PORT_B } }, null)
    await apps.start(a.id)
    await until(() => status(a.id) === "up")
    const sessions = { liveSessions: () => [] } as unknown as SessionManager
    const before = new Restart({ home: dir, version: "1", sessions, hub, apps, clientWaitMs: 0 })
    before.prepare("update")
    const saved = before.onShutdown()
    assert.deepEqual(saved?.apps, [a.id])
    await apps.shutdown()
    assert.equal(await portOpen(PORT_A), false)
    assert.ok(fs.existsSync(path.join(dir, RESUME_FILE)))

    // El server nuevo.
    apps = make()
    const after = new Restart({ home: dir, version: "2", sessions, hub, apps, clientWaitMs: 0 })
    const out = await after.resumePending()
    assert.deepEqual(out.apps, { resumed: 1, failed: [] })
    await until(() => status(a.id) === "up", "no volvió a levantarla")
    assert.equal(status(b.id), "stopped", "la que estaba bajada sigue bajada")
  })

  it("una app que no vuelve a levantar no frena el resto: queda en un aviso", async () => {
    const sessions = { liveSessions: () => [] } as unknown as SessionManager
    fs.writeFileSync(path.join(dir, RESUME_FILE), JSON.stringify({ version: "1", reason: "update", at: Date.now(), sessions: [], apps: ["a_no"] }))
    const fakeApps = { runningIds: () => [], resume: async () => [{ name: "backend", error: "No existe la carpeta web" }] }
    const out = await new Restart({ home: dir, version: "2", sessions, hub, apps: fakeApps, clientWaitMs: 0 }).resumePending()
    assert.deepEqual(out.apps?.failed, [{ name: "backend", error: "No existe la carpeta web" }])
    assert.ok(messages.some((m) => m.type === "toast" && m.title.includes("No se pudo volver a levantar backend")))
  })

  it("la carpeta: adentro del proyecto o de sus worktrees, nada de .. ni symlinks que salgan", async () => {
    const outside = path.join(dir, "afuera")
    const wt = path.join(dir, "proj--wt")
    fs.mkdirSync(outside)
    fs.mkdirSync(wt)
    fs.symlinkSync(outside, path.join(project, "link"))
    assert.equal(appDir(project, ""), project)
    assert.equal(appDir(project, "web"), path.join(project, "web"))
    assert.throws(() => appDir(project, "../afuera"), /fuera del proyecto/)
    assert.throws(() => appDir(project, outside), /fuera del proyecto/)
    assert.throws(() => appDir(project, "link"), /fuera del proyecto/)
    assert.throws(() => appDir(project, "no-existe"), /No existe la carpeta/)
    assert.equal(appDir(project, "../proj--wt", [wt]), wt, "un worktree del proyecto vale")
    await assert.rejects(apps.create("p1", { name: "x", command: "npm run dev", cwd: "../afuera" }, null), /fuera del proyecto/)
    const withWt = new Apps({ db, hub, home: dir, repos: async () => [wt] })
    const a = await withWt.create("p1", { name: "en-wt", command: "npm run dev", cwd: "../proj--wt" }, null)
    assert.equal(a.cwd, "../proj--wt")
  })

  it("valida la definición: sin shell, nada de && ni pipes; salud y URL bien formadas; nombres únicos", async () => {
    assert.deepEqual(commandArgs(`node -e "console.log('a b')" --x`, false), ["node", "-e", "console.log('a b')", "--x"])
    assert.deepEqual(commandArgs("npm i && npm run dev", true), ["/bin/sh", "-c", "npm i && npm run dev"])
    for (const bad of ["npm i && npm run dev", "cat x | grep y", "node a.js > out.log", "a ; b"]) assert.throws(() => commandArgs(bad, false), /shell: true/, bad)
    assert.throws(() => normalizeApp({ name: "x", command: "a", health: { kind: "http", url: "ftp://x" } }), /http/)
    assert.throws(() => normalizeApp({ name: "x", command: "a", health: { kind: "tcp", port: 70000 } }), /puerto/)
    assert.throws(() => normalizeApp({ name: "x", command: "a", env: { "MAL-NOMBRE": "1" } }), /variable/)
    assert.throws(() => normalizeApp({ name: "x", command: "a", url: "javascript:alert(1)" }), /URL/)
    await apps.create("p1", { name: "Backend", command: "npm run dev" }, null)
    await assert.rejects(apps.create("p1", { name: "backend", command: "npm start" }, null), /Ya hay una app/)
    await apps.create("p2", { name: "backend", command: "npm start" }, null) // en otro proyecto, sí
  })

  it("sugerencias del repo: scripts de package.json, docker compose y Procfile (sin las ya registradas)", async () => {
    fs.writeFileSync(path.join(project, "web", "package.json"), JSON.stringify({ name: "@acme/web", scripts: { dev: "vite --port 5174", build: "vite build" } }))
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "api", scripts: { start: "node server.js" } }))
    fs.writeFileSync(path.join(project, "compose.yaml"), "services: {}\n")
    fs.writeFileSync(path.join(project, "Procfile"), "worker: node worker.js --queue x\n")
    const s = suggestApps(project)
    const by = Object.fromEntries(s.map((x) => [x.source, x]))
    assert.deepEqual(by["web/package.json: dev"], { name: "web", command: "npm run dev", cwd: "web", health: { kind: "tcp", port: 5174 }, source: "web/package.json: dev" })
    assert.equal(by["package.json: start"]!.command, "npm run start")
    assert.equal(by["compose.yaml"]!.stopCommand, "docker compose down")
    assert.equal(by["Procfile: worker"]!.shell, true)
    await apps.create("p1", { name: "web", command: "npm run dev", cwd: "web" }, null)
    assert.ok(!(await apps.suggest("p1")).some((x) => x.cwd === "web" && x.command === "npm run dev"))
  })
})

describe("herramientas MCP de las apps, por proyecto", () => {
  let dir: string
  let db: Db
  let apps: Apps
  const fastify = Fastify()
  const session = (id: string, projectId: string, token: string): SessionRecord => ({
    id, projectId, kind: "worker", name: id.toUpperCase(), role: "", claudeSessionId: `c-${id}`, startedOnce: false, mcpToken: token, model: null, effort: null,
    worktree: false, cwd: dir, status: "idle", taskTitle: null, taskState: "none", lastActivity: null, lastActivityAt: null, costUsd: 0, tokens: null,
    context: null, createdAt: 1, archivedAt: null,
  })
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await fastify.inject({
      method: "POST",
      url: `/mcp/${token}`,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    })
    const body = JSON.parse(res.body) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } }
    if (body.error) throw new Error(body.error.message)
    return { text: body.result!.content.map((c) => c.text).join("\n"), isError: !!body.result!.isError }
  }

  before(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-apps-mcp-")))
    db = new Db(path.join(dir, "t.db"))
    for (const p of ["p1", "p2"]) db.insertProject({ id: p, name: p, repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    db.insertSession(session("s1", "p1", "tok-1"))
    db.insertSession(session("s2", "p2", "tok-2"))
    const hub = { broadcast: () => {}, size: 0 } as unknown as Hub
    apps = new Apps({ db, hub, home: dir, repos: async () => [], startTimeoutMs: 4_000, stopGraceMs: 700 })
    const sessions = { statusOf: () => "idle", contextOf: () => null } as unknown as SessionManager
    registerMcp(fastify, { db, sessions, orchestration: {} as Orchestration, apps })
    await fastify.ready()
  })
  after(async () => {
    await apps.shutdown()
    await fastify.close()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("registra, lista, levanta, baja, cambia y quita; cada sesión ve solo las de su proyecto", async () => {
    const reg = await call("tok-1", "register_app", { name: "backend", command: server(PORT_C), health: { kind: "tcp", port: PORT_C } })
    assert.match(reg.text, /App backend registrada/)
    assert.equal(db.listApps("p1")[0]!.createdBy, "s1")
    assert.match((await call("tok-2", "list_apps")).text, /no tiene apps/, "la del otro proyecto no se ve")
    assert.equal((await call("tok-2", "start_app", { app: "backend" })).isError, true)

    const up = await call("tok-1", "start_app", { app: "backend" })
    assert.match(up.text, /backend .* levantada/)
    assert.match((await call("tok-1", "list_apps")).text, new RegExp(`puerto ${PORT_C}`))
    const down = await call("tok-1", "stop_app", { app: "backend" })
    assert.match(down.text, /detenida/)
    assert.match((await call("tok-1", "update_app", { app: "backend", url: `http://127.0.0.1:${PORT_C}/docs` })).text, /actualizada/)
    assert.equal(db.listApps("p1")[0]!.url, `http://127.0.0.1:${PORT_C}/docs`)
    const bad = await call("tok-1", "register_app", { name: "otra", command: "npm i && npm run dev" })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /shell: true/)
    assert.match((await call("tok-1", "remove_app", { app: "backend" })).text, /quitada/)
    assert.equal(db.listApps("p1").length, 0)
  })
})
