import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, afterEach, before, beforeEach, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { lastCostState } from "../src/claude/local.ts"
import { SessionManager } from "../src/sessions.ts"
import type { ExternalSession } from "../src/shared/types.ts"
import { writeFakeClaude } from "./fake-claude.ts"

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

describe("lo gastado en una sesión", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  let rec: SessionRecord

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-spend-"))
    const bin = writeFakeClaude(dir)
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir }, bin, accountId: "acc" }),
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

  it("se suma entre procesos sin contar dos veces lo que Claude Code restaura al reanudar", async () => {
    await sessions.send(rec.id, "uno", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd === 0.25)
    await sessions.send(rec.id, "dos", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd === 0.5)
    assert.equal(db.getSession(rec.id)!.tokens?.total, 230)

    // Al cerrarse guarda su cost-state; el proceso nuevo sigue desde ahí (0,5 + 0,25), como Claude Code.
    await sessions.stop(rec.id)
    await sessions.send(rec.id, "tres", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd !== 0.5)
    assert.equal(db.getSession(rec.id)!.costUsd, 0.75)
    const t = db.getSession(rec.id)!.tokens!
    assert.deepEqual([t.input, t.output, t.cacheRead, t.total], [30, 15, 300, 345])
    const ends = db.listEvents(rec.id).map((e) => e.event).filter((e) => e.kind === "turn_end")
    assert.deepEqual(ends.map((e) => e.kind === "turn_end" && e.costUsd), [0.25, 0.5, 0.75], "el acumulado del fin de turno sigue al de la sesión")
  })

  it("/clear empieza una conversación nueva sin perder lo gastado antes", async () => {
    const s = sessions.create({ projectId: "p1", kind: "worker", name: "GAMMA", role: "", cwd: dir, claudeSessionId: "c-3" })
    await sessions.send(s.id, "uno", { origin: "user" })
    await until(() => db.getSession(s.id)!.costUsd === 0.25 && sessions.statusOf(s.id) === "idle")
    await sessions.clearConversation(s.id)
    assert.notEqual(db.getSession(s.id)!.claudeSessionId, "c-3", "sigue con el id nuevo")
    // Claude Code arranca los totales de la conversación nueva en cero: lo de antes queda como base.
    await sessions.send(s.id, "dos", { origin: "user" })
    await until(() => db.getSession(s.id)!.costUsd !== 0.25)
    assert.equal(db.getSession(s.id)!.costUsd, 0.5)
    assert.equal(db.getSession(s.id)!.tokens?.total, 230)
    await sessions.stop(s.id)
  })

  it("una conversación importada arranca con lo que ya había gastado y suma solo lo nuevo", async () => {
    const other = sessions.create({ projectId: "p1", kind: "worker", name: "BETA", role: "", cwd: dir, claudeSessionId: "c-2" })
    const tdir = path.join(dir, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"))
    fs.mkdirSync(tdir, { recursive: true })
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 }
    fs.writeFileSync(path.join(tdir, "c-2.jsonl"), JSON.stringify({ type: "cost-state", sessionId: "c-2", totalCostUSD: 10, modelUsage: { "claude-x": usage } }) + "\n")
    const spent = lastCostState(dir, "c-2", dir)
    assert.deepEqual(spent, { usd: 10, tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, total: 1150 } })
    db.updateSession(other.id, { costUsd: spent!.usd, tokens: spent!.tokens })
    await sessions.send(other.id, "hola", { origin: "user" })
    await until(() => db.getSession(other.id)!.costUsd !== 10)
    assert.equal(db.getSession(other.id)!.costUsd, 10.25)
    assert.equal(db.getSession(other.id)!.tokens?.total, 1265)
    await sessions.stop(other.id)
  })
})

describe("el último cost-state del transcript", () => {
  it("lo encuentra aunque haya líneas enormes después y lo ignora si es de otra conversación", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-cost-"))
    const tdir = path.join(dir, "projects", "-repo")
    fs.mkdirSync(tdir, { recursive: true })
    const line = (o: object) => JSON.stringify(o) + "\n"
    fs.writeFileSync(
      path.join(tdir, "s1.jsonl"),
      line({ type: "cost-state", sessionId: "s1", totalCostUSD: 1, modelUsage: {} }) +
        line({ type: "cost-state", sessionId: "s1", totalCostUSD: 2.5, modelUsage: { m: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } } }) +
        line({ type: "assistant", message: { content: "x".repeat(3 * 1024 * 1024) } }) +
        line({ type: "cost-state", sessionId: "otra", totalCostUSD: 99, modelUsage: {} })
    )
    assert.deepEqual(lastCostState("/repo", "s1", dir), { usd: 2.5, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } })
    assert.equal(lastCostState("/repo", "no-existe", dir), null)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
