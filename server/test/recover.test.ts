import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { transcriptDir } from "../src/claude/local.ts"
import { RESET_NOTICE } from "../src/claude/normalize.ts"
import { Db, defaultSettings } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { SessionManager } from "../src/sessions.ts"
import { writeFakeClaude } from "./fake-claude.ts"

describe("reparar las sesiones que un /clear viejo dejó sin conversación", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  let tdir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-recover-"))
    const bin = writeFakeClaude(dir)
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir, FAKE_STRICT_RESUME: "1" }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    tdir = transcriptDir(dir, dir)
    fs.mkdirSync(tdir, { recursive: true })
  })
  afterEach(async () => {
    await sessions.shutdown().catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const T0 = Date.parse("2026-09-29T13:50:12.000Z")
  /** Una sesión que ya arrancó alguna vez, apuntando a `claudeId`, con un /clear en cada `resets`. */
  const session = (name: string, claudeId: string, resets: number[] = []) => {
    const rec = sessions.create({ projectId: "p1", kind: "worker", name, role: "", cwd: dir, claudeSessionId: claudeId })
    for (const t of resets) db.insertEvent(rec.id, t, { kind: "notice", level: "info", text: RESET_NOTICE })
    return rec
  }
  /** Un transcript como los de Claude Code: empieza en `start` y lleva el nombre de la sesión. */
  const transcript = (id: string, start: number, title: string | null) => {
    const lines = [
      ...(title ? [{ type: "custom-title", customTitle: title, sessionId: id }, { type: "agent-name", agentName: title, sessionId: id }] : []),
      { type: "user", timestamp: new Date(start).toISOString(), sessionId: id, message: { role: "user", content: "x" } },
    ]
    fs.writeFileSync(path.join(tdir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  }
  const idOf = (id: string) => db.getSession(id)!.claudeSessionId

  it("adopta el transcript que nació con el /clear, avisa en el chat y después se reanuda", async () => {
    const s = session("ORQ-X", "no-existe", [T0])
    transcript("real-1", T0 + 600, "ORQ-X")
    const fixed = sessions.repairConversations()
    assert.deepEqual(fixed, [{ id: s.id, name: "ORQ-X", from: "no-existe", to: "real-1" }])
    assert.equal(idOf(s.id), "real-1")
    assert.ok(db.listEvents(s.id).some((e) => e.event.kind === "notice" && e.event.text.startsWith("Recuperé la conversación después de un /clear")))
    assert.deepEqual(sessions.repairConversations(), [], "una sola vez")
    // Con el id reparado, --resume la encuentra (el falso estricto falla si no existe).
    await sessions.start(s.id)
    assert.equal(sessions.lostConversation(s.id), null)
    assert.equal(idOf(s.id), "real-1")
  })

  it("sin candidatos no toca nada", () => {
    const sinClear = session("A", "no-existe-a")
    transcript("suelto", T0, "A")
    const lejos = session("B", "no-existe-b", [T0])
    transcript("de-otro-dia", T0 + 3 * 3600_000, "B")
    const otroNombre = session("C", "no-existe-c", [T0])
    transcript("de-otra-sesion", T0 + 500, "OTRA")
    assert.deepEqual(sessions.repairConversations(), [])
    assert.deepEqual([idOf(sinClear.id), idOf(lejos.id), idOf(otroNombre.id)], ["no-existe-a", "no-existe-b", "no-existe-c"])
  })

  it("si su transcript existe no la toca, aunque haya otro que encaje", () => {
    const s = session("SANA", "propio", [T0])
    transcript("propio", T0 - 86400_000, "SANA")
    transcript("candidato", T0 + 500, "SANA")
    assert.deepEqual(sessions.repairConversations(), [])
    assert.equal(idOf(s.id), "propio")
  })

  it("con varios candidatos se queda con el del /clear más reciente, y no adopta uno que ya usa otra sesión", () => {
    const T1 = T0 + 5 * 3600_000
    const s = session("VARIAS", "no-existe", [T0, T1])
    transcript("viejo", T0 + 300, "VARIAS")
    transcript("nuevo", T1 + 300, "VARIAS")
    session("DUENA", "ajeno")
    transcript("ajeno", T1 + 200, null)
    assert.deepEqual(sessions.repairConversations().map((r) => r.to), ["nuevo"])
    assert.equal(idOf(s.id), "nuevo")
  })
})
