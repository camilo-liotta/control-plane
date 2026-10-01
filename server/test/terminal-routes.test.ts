import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import fastifyWebsocket from "@fastify/websocket"
import Fastify, { type FastifyInstance } from "fastify"

import type { Db } from "../src/db.ts"
import { localOnly } from "../src/http.ts"
import { Terminals, terminalEnv } from "../src/terminal/manager.ts"
import { registerTerminal } from "../src/terminal/routes.ts"

const PORT = 4715
const SELF = `http://127.0.0.1:${PORT}`
const HOST = `127.0.0.1:${PORT}`

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Tope por test: si una terminal se traba, falla rápido en vez de colgar el job.
const TERM_TEST = { timeout: 30_000 }

describe("la terminal del dashboard", () => {
  let app: FastifyInstance
  let terminals: Terminals
  let home: string
  const sessions = new Map<string, { id: string; cwd: string; archivedAt: number | null }>()

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-term-routes-"))
    fs.writeFileSync(path.join(home, ".bash_profile"), "PS1='LISTO$ '\n")
    sessions.set("s1", { id: "s1", cwd: home, archivedAt: null })
    sessions.set("s2", { id: "s2", cwd: home, archivedAt: null })
    sessions.set("vieja", { id: "vieja", cwd: home, archivedAt: 1 })
    const db = { getSession: (id: string) => sessions.get(id) ?? null } as unknown as Db
    terminals = new Terminals({
      shell: "/bin/bash",
      env: { PATH: process.env.PATH, HOME: home, CONTROL_PLANE_LAUNCH_ID: "x", NODE_ENV: "production" },
      sessionAlive: (id) => !!sessions.get(id) && !sessions.get(id)!.archivedAt,
    })
    app = Fastify()
    localOnly(app, PORT)
    await app.register(fastifyWebsocket)
    registerTerminal(app, { db, terminals, port: PORT })
    await app.ready()
  })
  after(async () => {
    await terminals.closeAll()
    // Los que el server cerró con 4403 esperan 30 s un cierre ordenado que el cliente de prueba
    // no manda: se cortan, así el proceso de tests termina al toque.
    for (const c of app.websocketServer.clients) c.terminate()
    await app.close()
  })

  const openTerminal = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/api/sessions/${id}/terminal`, headers: { host: HOST, origin: SELF, "content-type": "application/json", ...headers }, payload: { cols: 90, rows: 25 } })

  it("abrirla pide el Origin del dashboard, JSON y una sesión viva", TERM_TEST, async () => {
    assert.equal((await openTerminal("s1", { origin: "https://malo.example" })).statusCode, 403)
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/s1/terminal", headers: { host: HOST, "content-type": "application/json" }, payload: {} })).statusCode, 403, "sin Origin")
    assert.equal((await openTerminal("s1", { host: `malo.example:${PORT}` })).statusCode, 403, "DNS rebinding")
    assert.equal((await app.inject({ method: "POST", url: "/api/sessions/s1/terminal", headers: { host: HOST, origin: SELF, "content-type": "text/plain" }, payload: "{}" })).statusCode, 415)
    assert.equal((await openTerminal("vieja")).statusCode, 400)
    assert.equal((await openTerminal("no-existe")).statusCode, 400)
    assert.equal(terminals.has("s1"), false, "nada de lo anterior abrió una terminal")
    // Un GET no abre nada.
    assert.equal((await app.inject({ method: "GET", url: "/api/sessions/s1/terminal", headers: { host: HOST, origin: SELF } })).statusCode, 404)
  })

  it("el WebSocket rechaza otros orígenes, la falta de Origin y un token ajeno", TERM_TEST, async () => {
    const { token } = (await openTerminal("s1")).json() as { token: string }
    const url = `/ws/terminal?session=s1&token=${token}`
    await assert.rejects(app.injectWS(url, { headers: { host: HOST, origin: "https://malo.example" } }), /403/)
    await assert.rejects(app.injectWS(url, { headers: { host: HOST } }), /403/)
    await assert.rejects(app.injectWS(url, { headers: { host: "evil.test", origin: SELF } }), /403/)
    // Con el origen bien pero el token de otra terminal (o ninguno): se cierra sin conectar.
    const { token: other } = (await openTerminal("s2")).json() as { token: string }
    for (const q of [`session=s1&token=${other}`, "session=s1&token=", `session=s2&token=${token}`]) {
      const ws = await app.injectWS(`/ws/terminal?${q}`, { headers: { host: HOST, origin: SELF } })
      const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)))
      assert.equal(code, 4403, q)
    }
    await terminals.close("s2")
  })

  it("con el token y el origen bien anda, y cerrarla mata la shell y lo que lanzó", TERM_TEST, async (t) => {
    const { token } = (await openTerminal("s1")).json() as { token: string }
    const ws = await app.injectWS(`/ws/terminal?session=s1&token=${token}`, { headers: { host: HOST, origin: SELF } })
    t.after(() => ws.terminate())
    let out = ""
    ws.on("message", (m: Buffer) => {
      const msg = JSON.parse(m.toString())
      if (msg.t === "o") out += msg.d
    })
    const until = async (re: RegExp) => {
      const end = Date.now() + 8000
      while (!re.test(out) && Date.now() < end) await wait(30)
      assert.match(out, re)
    }
    // Lo que ya había (el primer prompt) llega apenas conecta, antes de este listener: un Enter
    // trae otro.
    ws.send(JSON.stringify({ t: "i", d: "\r" }))
    await until(/LISTO\$ /)
    // El entorno: sin lo interno del server, con TERM de color.
    ws.send(JSON.stringify({ t: "i", d: 'echo "id=[${CONTROL_PLANE_LAUNCH_ID:-no}] env=[${NODE_ENV:-no}] term=[$TERM]"; sleep 300 & echo bg=$!\r' }))
    await until(/id=\[no\] env=\[no\] term=\[xterm-256color\]/)
    await until(/bg=(\d+)/)
    const bg = Number(/bg=(\d+)/.exec(out)![1])
    assert.ok(alive(bg))
    ws.send(JSON.stringify({ t: "r", c: 120, r: 40 }))
    await wait(300)
    ws.send(JSON.stringify({ t: "i", d: "stty size\r" }))
    await until(/40 120/)

    const res = await app.inject({ method: "DELETE", url: "/api/sessions/s1/terminal", headers: { host: HOST, origin: SELF } })
    assert.equal(res.statusCode, 200)
    assert.equal(terminals.has("s1"), false)
    assert.ok(!alive(bg), "el job de fondo murió")
  })

  it("al archivar la sesión, la terminal se cierra", TERM_TEST, async () => {
    await openTerminal("s2")
    assert.ok(terminals.has("s2"))
    sessions.get("s2")!.archivedAt = Date.now()
    terminals.sweep()
    await wait(1600)
    assert.equal(terminals.has("s2"), false)
  })

  it("el entorno saca las variables del server y las de otra terminal", TERM_TEST, () => {
    const env = terminalEnv({ PATH: "/usr/bin", CONTROL_PLANE_LAUNCH_ID: "x", CONTROL_PLANE_WEB_DIST: "/w", NODE_ENV: "production", TMUX: "/tmp/t", TERM: "dumb", CONTROL_PLANE_PORT: "4700" })
    assert.equal(env.CONTROL_PLANE_LAUNCH_ID, undefined)
    assert.equal(env.CONTROL_PLANE_WEB_DIST, undefined)
    assert.equal(env.NODE_ENV, undefined)
    assert.equal(env.TMUX, undefined)
    assert.equal(env.TERM, "xterm-256color")
    assert.equal(env.CONTROL_PLANE_PORT, "4700")
  })
})
