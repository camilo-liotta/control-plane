import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, afterEach, before, beforeEach, describe, it } from "node:test"

import Fastify, { type FastifyInstance } from "fastify"

import { localOnly, registerHealth } from "../src/http.ts"
import { acquireLock, LockError, pidAlive } from "../src/lock.ts"

async function freePort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  const port = (srv.address() as net.AddressInfo).port
  await new Promise((r) => srv.close(r))
  return port
}

/** Un proceso vivo que no es un control-plane. */
function otherProcess() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" })
  return child
}

describe("lock de la carpeta de datos", () => {
  let home: string
  let file: string
  const old = Date.now() - 10 * 60_000
  const write = (info: object) => fs.writeFileSync(file, JSON.stringify(info))
  const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; port: number; startedAt: number }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-lock-"))
    file = path.join(home, "server.lock")
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("libre: lo toma y lo suelta", async () => {
    const lock = await acquireLock(path.join(home, "nueva"), { pid: process.pid, port: 4710, startedAt: 1 })
    assert.deepEqual(JSON.parse(fs.readFileSync(lock.file, "utf8")), { pid: process.pid, port: 4710, startedAt: 1 })
    lock.release()
    assert.equal(fs.existsSync(lock.file), false)
    assert.deepEqual(fs.readdirSync(path.join(home, "nueva")), [])
  })

  describe("con un server vivo", () => {
    let app: FastifyInstance
    let port: number

    before(async () => {
      port = await freePort()
      app = Fastify()
      localOnly(app, port)
      registerHealth(app, { version: "test", port, startedAt: old, launchId: null })
      await app.listen({ host: "127.0.0.1", port })
    })
    after(() => app.close())

    it("no lo toma y explica qué hacer", async () => {
      write({ pid: process.pid, port, startedAt: old })
      await assert.rejects(acquireLock(home, { pid: 1234567, port: 4711, startedAt: Date.now() }), (err: unknown) => {
        assert.ok(err instanceof LockError)
        assert.equal(
          err.message,
          `Ya hay un control-plane usando esta carpeta de datos en el puerto ${port} (pid ${process.pid}). Detenelo o usá otro CONTROL_PLANE_HOME.`
        )
        return true
      })
      assert.equal(read().pid, process.pid)
    })

    it("si el health responde con otro pid, el lock es viejo", async () => {
      const child = otherProcess()
      try {
        write({ pid: child.pid, port, startedAt: old })
        const lock = await acquireLock(home, { pid: process.pid, port: 4711, startedAt: 2 })
        assert.equal(read().pid, process.pid)
        lock.release()
      } finally {
        child.kill()
      }
    })

    it("espera a un server que recién arranca", async () => {
      write({ pid: process.pid, port: await freePort(), startedAt: Date.now() })
      let probes = 0
      const probe = async () => (++probes >= 3 ? process.pid : null)
      await assert.rejects(acquireLock(home, { pid: 1234567, port: 4711, startedAt: Date.now() }, { probe }), LockError)
      assert.equal(probes, 3)
    })
  })

  it("viejo, con el pid muerto: lo toma", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    await new Promise((r) => child.on("exit", r))
    assert.equal(pidAlive(child.pid!), false)
    write({ pid: child.pid, port: await freePort(), startedAt: Date.now() })
    const lock = await acquireLock(home, { pid: process.pid, port: 4711, startedAt: 3 })
    assert.deepEqual(read(), { pid: process.pid, port: 4711, startedAt: 3 })
    lock.release()
  })

  it("viejo, con un pid vivo que no es control-plane: lo toma", async () => {
    const child = otherProcess()
    try {
      write({ pid: child.pid, port: await freePort(), startedAt: old })
      const started = Date.now()
      const lock = await acquireLock(home, { pid: process.pid, port: 4711, startedAt: 4 })
      assert.ok(Date.now() - started < 3000, "no espera el arranque de un lock viejo")
      assert.equal(read().pid, process.pid)
      lock.release()
    } finally {
      child.kill()
    }
  })

  it("recién escrito por un pid vivo que nunca responde: lo toma al vencer la espera", async () => {
    const child = otherProcess()
    try {
      write({ pid: child.pid, port: await freePort(), startedAt: Date.now() })
      const lock = await acquireLock(home, { pid: process.pid, port: 4711, startedAt: 5 }, { graceMs: 600 })
      assert.equal(read().pid, process.pid)
      lock.release()
    } finally {
      child.kill()
    }
  })

  it("roto o vacío: lo toma", async () => {
    fs.writeFileSync(file, "{no es json")
    const lock = await acquireLock(home, { pid: process.pid, port: 4711, startedAt: 6 })
    assert.equal(read().pid, process.pid)
    lock.release()
  })

  it("soltar no borra el lock de otro", async () => {
    const lock = await acquireLock(home, { pid: process.pid, port: 4711, startedAt: 7 })
    write({ pid: 1234567, port: 4712, startedAt: 8 })
    lock.release()
    assert.equal(read().pid, 1234567)
  })

  it("dos que arrancan a la vez sobre un lock viejo: lo toma uno solo", async () => {
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    await new Promise((r) => dead.on("exit", r))
    write({ pid: dead.pid, port: await freePort(), startedAt: old })
    const a = otherProcess()
    const b = otherProcess()
    try {
      // Cada uno "responde" su health apenas tiene el lock, como un server que ya arrancó.
      const byPort = new Map([
        [4711, a.pid!],
        [4712, b.pid!],
      ])
      const probe = async (port: number) => byPort.get(port) ?? null
      const results = await Promise.allSettled([
        acquireLock(home, { pid: a.pid!, port: 4711, startedAt: Date.now() }, { probe }),
        acquireLock(home, { pid: b.pid!, port: 4712, startedAt: Date.now() }, { probe }),
      ])
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
      const lost = results.find((r) => r.status === "rejected")
      assert.ok(lost && lost.reason instanceof LockError)
      assert.ok([a.pid, b.pid].includes(read().pid))
      assert.deepEqual(fs.readdirSync(home), ["server.lock"])
    } finally {
      a.kill()
      b.kill()
    }
  })
})
