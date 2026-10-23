import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Db } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { SessionManager } from "../src/sessions.ts"
import { tmpRunRoot } from "./run-root.ts"

describe("sessions.pendingPermission (R6.1): la herramienta sale del pedido de la CLI", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  const runtimes = () => (sessions as unknown as { runtimes: Map<string, unknown> }).runtimes

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-pending-"))
    db = new Db(path.join(dir, "t.db"))
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      runRoot: tmpRunRoot(),
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: {}, bin: "x", accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    runtimes().set("s1", {
      pendingControl: new Map([
        ["perm", { kind: "permission", eventId: 1, input: { command: "ls -la", __toolName: "Bash" } }],
        ["ask", { kind: "question", eventId: 2, input: { questions: [] } }],
      ]),
    })
  })
  after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("devuelve la herramienta y el input guardado (sin el nombre interno)", () => {
    assert.deepEqual(sessions.pendingPermission("s1", "perm"), { toolName: "Bash", input: { command: "ls -la" } })
  })

  it("un requestId desconocido, una pregunta, o una sesión sin proceso: null", () => {
    assert.equal(sessions.pendingPermission("s1", "nope"), null)
    assert.equal(sessions.pendingPermission("s1", "ask"), null)
    assert.equal(sessions.pendingPermission("s2", "perm"), null)
  })

  it("solo lee: el pedido sigue pendiente después", () => {
    sessions.pendingPermission("s1", "perm")
    assert.ok(sessions.pendingPermission("s1", "perm"))
  })
})
