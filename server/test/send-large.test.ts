import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { ClaudeProcess } from "../src/claude/process.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { SessionManager } from "../src/sessions.ts"
import { writeFakeClaude } from "./fake-claude.ts"

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
  assert.ok(check(), `no llegó a tiempo: ${what}`)
}

describe("un mensaje más grande que el buffer de stdin (una imagen adjunta)", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  let attachments: AttachmentStore
  let rec: SessionRecord

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-send-large-"))
    const bin = writeFakeClaude(dir)
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    attachments = new AttachmentStore(db, path.join(dir, "attachments"))
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments,
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    rec = sessions.create({ projectId: "p1", kind: "worker", name: "ALFA", role: "", cwd: dir, claudeSessionId: "c-1" })
  })

  after(async () => {
    await sessions.shutdown()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("se envía sin error aunque stdin avise que se llenó su buffer", async () => {
    // 300 KB en base64 son ~400 KB: bastante más que los 64 KB del buffer de stdin.
    const img = attachments.save(rec.id, { name: "captura.png", mime: "image/png", data: randomBytes(300_000), source: "user" })
    const stored = await sessions.send(rec.id, "mirá esta captura", { origin: "user", attachments: [img] })
    assert.equal(stored.event.kind, "user")
    // Y la sesión lo recibió: contesta como a cualquier mensaje.
    await until(() => db.listEvents(rec.id).some((e) => e.event.kind === "text" && e.event.text.includes("respuesta a: mirá esta captura")), "la respuesta")
  })

  it("con varias imágenes seguidas, también", async () => {
    const files = [1, 2, 3].map((i) => attachments.save(rec.id, { name: `c${i}.png`, mime: "image/png", data: randomBytes(200_000), source: "user" }))
    await sessions.send(rec.id, "tres capturas", { origin: "user", attachments: files })
    await sessions.send(rec.id, "y otro mensaje", { origin: "user" })
    await until(() => db.listEvents(rec.id).some((e) => e.event.kind === "text" && e.event.text.includes("respuesta a: y otro mensaje")), "la respuesta")
  })
})

describe("el mismo envío dos veces (la web reintentó porque se cortó la respuesta)", () => {
  it("sale una sola vez y devuelve el mismo evento", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-send-twice-"))
    const bin = writeFakeClaude(dir)
    const db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    const sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db, path.join(dir, "attachments")),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    try {
      const rec = sessions.create({ projectId: "p1", kind: "worker", name: "ALFA", role: "", cwd: dir, claudeSessionId: "c-2" })
      // Los dos a la vez: el segundo llega mientras la sesión todavía está arrancando.
      const [a, b] = await Promise.all([
        sessions.send(rec.id, "hola", { origin: "user", clientId: "c-1" }),
        sessions.send(rec.id, "hola", { origin: "user", clientId: "c-1" }),
      ])
      const c = await sessions.send(rec.id, "hola", { origin: "user", clientId: "c-1" })
      assert.equal(a.id, b.id)
      assert.equal(a.id, c.id)
      assert.equal(a.event.kind === "user" && a.event.clientId, "c-1")
      await sessions.send(rec.id, "chau", { origin: "user", clientId: "c-2" })
      await until(() => db.listEvents(rec.id).some((e) => e.event.kind === "text" && e.event.text.includes("respuesta a: chau")), "la respuesta")
      const users = db.listEvents(rec.id).filter((e) => e.event.kind === "user")
      assert.deepEqual(users.map((e) => e.event.kind === "user" && e.event.text), ["hola", "chau"])
      const answers = db.listEvents(rec.id).filter((e) => e.event.kind === "text" && e.event.text.includes("respuesta a: hola"))
      assert.equal(answers.length, 1, "Claude recibió el mensaje una sola vez")
    } finally {
      await sessions.shutdown()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ClaudeProcess.send", () => {
  it("solo dice que no salió si el proceso ya no puede recibir", async () => {
    const proc = new ClaudeProcess(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"], os.tmpdir(), { PATH: process.env.PATH })
    proc.start()
    assert.equal(proc.send({ big: "x".repeat(500_000) }), true, "backpressure no es un error: el dato queda en el buffer y sale")
    await proc.close(2000)
    assert.equal(proc.send({ hola: 1 }), false, "con el proceso cerrado, no sale")
  })
})
