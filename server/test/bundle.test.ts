import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { writeFakeClaude } from "./fake-claude.ts"

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Primer puerto libre del rango de pruebas del bundle. */
async function freePort(): Promise<number> {
  for (let port = 4720; port <= 4729; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer()
      srv.once("error", () => resolve(false))
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error("No hay puertos libres entre 4720 y 4729")
}

describe("el server empaquetado", () => {
  // Fuera del repo: así Node no puede resolver nada desde el node_modules del repo.
  let dir: string
  let app: string
  let port: number
  let child: ChildProcess
  let base: string
  let log = ""

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-bundle-"))
    const web = path.join(dir, "web-dist")
    fs.mkdirSync(web)
    fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>web de prueba del bundle</title>")
    app = path.join(dir, "app")
    await promisify(execFile)(process.execPath, ["scripts/bundle.mjs", "--out", app, "--web", web], { cwd: serverDir })

    const bin = writeFakeClaude(dir)
    fs.mkdirSync(path.join(dir, "claude"))
    port = await freePort()
    base = `http://127.0.0.1:${port}`
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", CONTROL_PLANE_HOME: path.join(dir, "home"), CONTROL_PLANE_PORT: String(port), CLAUDE_BIN: bin, CLAUDE_CONFIG_DIR: path.join(dir, "claude"), CONTROL_PLANE_LAUNCH_ID: "smoke" }
    // Sin rutas: el bundle tiene que encontrar la web y el hook al lado de server.mjs.
    delete env.CONTROL_PLANE_WEB_DIST
    delete env.CONTROL_PLANE_COMPACT_HOOK
    child = spawn(process.execPath, [path.join(app, "server.mjs")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout!.on("data", (d) => (log += d))
    child.stderr!.on("data", (d) => (log += d))
    const until = Date.now() + 15_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`El bundle salió con ${child.exitCode}:\n${log}`)
      const ok = await fetch(`${base}/api/health`).then((r) => r.ok, () => false)
      if (ok) break
      if (Date.now() > until) throw new Error(`El bundle no respondió:\n${log}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  })

  after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r))
      child.kill("SIGTERM")
      let timer: NodeJS.Timeout | undefined
      await Promise.race([exited, new Promise((r) => (timer = setTimeout(r, 10_000)))])
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("trae lo que necesita la app", () => {
    assert.deepEqual(fs.readdirSync(app).sort(), [".control-plane-bundle", "THIRD_PARTY_LICENSES", "compact-hook.mjs", "server.mjs", "web"])
    const licenses = fs.readFileSync(path.join(app, "THIRD_PARTY_LICENSES"), "utf8")
    for (const name of ["fastify@", "@modelcontextprotocol/sdk@", "zod@", "ws@"]) assert.ok(licenses.includes(`\n${name}`), name)
  })

  it("responde el health", async () => {
    const res = await fetch(`${base}/api/health`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { app: string; pid: number; port: number; launchId: string }
    assert.equal(body.app, "control-plane")
    assert.equal(body.pid, child.pid)
    assert.equal(body.port, port)
    assert.equal(body.launchId, "smoke")
  })

  it("sirve la web que está al lado", async () => {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /web de prueba del bundle/)
    const deep = await fetch(`${base}/p/algo/s/otra`)
    assert.match(await deep.text(), /web de prueba del bundle/)
  })

  it("manda el hello por /ws", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as { type: string })
      ws.onerror = () => reject(new Error("no conectó"))
    })
    ws.close()
    assert.equal(first.type, "hello")
  })

  it("carga el MCP de las sesiones", async () => {
    const repo = path.join(dir, "repo")
    fs.mkdirSync(repo)
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: repo, name: "Bundle" }),
    })
    assert.equal(created.status, 200)
    const db = new DatabaseSync(path.join(dir, "home", "control-plane.db"), { readOnly: true })
    const { mcp_token: token } = db.prepare("SELECT mcp_token FROM sessions LIMIT 1").get() as { mcp_token: string }
    db.close()
    const res = await fetch(`${base}/mcp/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    assert.ok(body.result.tools.length > 0)
  })
})
