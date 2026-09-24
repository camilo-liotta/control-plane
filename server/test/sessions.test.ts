import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, afterEach, before, beforeEach, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { SessionManager } from "../src/sessions.ts"
import type { ExternalSession } from "../src/shared/types.ts"

describe("una conversación abierta en otro lado", () => {
  let dir: string
  let db: Db
  let live: ExternalSession | null
  let launched: number
  let sessions: SessionManager
  let rec: SessionRecord

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-sessions-"))
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    live = { pid: 12345, kind: "interactive", id: null }
    launched = 0
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => {
        launched++
        throw new Error("no debería lanzarse")
      },
      accountIdFor: () => "acc",
      liveElsewhere: async () => live,
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    rec = sessions.create({ projectId: "p1", kind: "worker", name: "BETA", role: "", cwd: dir, claudeSessionId: "c-123" })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("no se reanuda mientras siga abierta en una terminal, y lo dice", async () => {
    await assert.rejects(sessions.start(rec.id), /abierta en una terminal \(pid 12345\).*\/exit/)
    assert.equal(launched, 0, "no lanzó un segundo proceso sobre la misma conversación")
    assert.deepEqual(sessions.view(db.getSession(rec.id)!).external, live)
  })

  it("en segundo plano, dice cómo detenerla", async () => {
    live = { pid: 99, kind: "background", id: "5e1c0a2b" }
    await assert.rejects(sessions.start(rec.id), /claude stop 5e1c0a2b/)
  })

  it("cuando se cierra, arranca normalmente", async () => {
    live = null
    await assert.rejects(sessions.start(rec.id), /no debería lanzarse/)
    assert.equal(launched, 1)
  })
})

// Claude Code de mentira: contesta el handshake y cierra cada turno con el costo acumulado de ESTE proceso,
// como hace el de verdad (total_cost_usd y modelUsage arrancan de cero en cada proceso).
const FAKE_CLAUDE = `#!/usr/bin/env node
import readline from "node:readline"
let turns = 0
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
for await (const line of readline.createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line)
  if (msg.type === "control_request") out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } })
  else if (msg.type === "user") {
    turns++
    const t = { inputTokens: 10 * turns, outputTokens: 5 * turns, cacheReadInputTokens: 100 * turns, cacheCreationInputTokens: 0 }
    out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.25 * turns, usage: {}, modelUsage: { "claude-x": t } })
  }
}
`

describe("lo gastado en una sesión", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  let rec: SessionRecord

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-spend-"))
    const bin = path.join(dir, "claude.mjs")
    fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 })
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: {}, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    rec = sessions.create({ projectId: "p1", kind: "worker", name: "ALFA", role: "", cwd: dir, claudeSessionId: "c-1" })
  })

  after(async () => {
    await sessions.stop(rec.id).catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(check(), "no llegó a tiempo")
  }

  it("se suma entre procesos: reanudar no lo vuelve a cero", async () => {
    await sessions.send(rec.id, "uno", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd === 0.25)
    await sessions.send(rec.id, "dos", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd === 0.5)
    assert.equal(db.getSession(rec.id)!.tokens?.total, 230)

    await sessions.stop(rec.id)
    await sessions.send(rec.id, "tres", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd === 0.75)
    const t = db.getSession(rec.id)!.tokens!
    assert.deepEqual([t.input, t.output, t.cacheRead, t.total], [30, 15, 300, 345])
    const ends = db.listEvents(rec.id).map((e) => e.event).filter((e) => e.kind === "turn_end")
    assert.deepEqual(ends.map((e) => e.kind === "turn_end" && e.costUsd), [0.25, 0.5, 0.75], "el acumulado del fin de turno sigue al de la sesión")
  })
})
