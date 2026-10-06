import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { Orchestration } from "../src/orchestration.ts"
import { archiveProject, restoreProject, RESTORE_WINDOW_MS, type ArchiveProjectDeps } from "../src/project-archive.ts"
import { SessionManager } from "../src/sessions.ts"
import type { ServerMessage } from "../src/shared/types.ts"
import { writeFakeClaude } from "./fake-claude.ts"

class SpyHub extends Hub {
  messages: ServerMessage[] = []
  override broadcast(msg: ServerMessage) {
    this.messages.push(msg)
    super.broadcast(msg)
  }
}

describe("archivar y restaurar un proyecto", () => {
  let dir: string
  let db: Db
  let hub: SpyHub
  let sessions: SessionManager
  let deps: ArchiveProjectDeps

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-archive-"))
    const bin = writeFakeClaude(dir)
    db = new Db(path.join(dir, "t.db"))
    hub = new SpyHub()
    const attachments = new AttachmentStore(db, path.join(dir, "home", "attachments"))
    sessions = new SessionManager({
      db,
      hub,
      attachments,
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: {}, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    deps = { db, hub, sessions, orchestration: new Orchestration(db, hub, sessions) }
    db.insertProject({ id: "p1", name: "Viejo", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
  })

  afterEach(async () => {
    await sessions.shutdown()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const make = (kind: "orchestrator" | "worker", name: string) => sessions.create({ projectId: "p1", kind, name, role: "", cwd: dir })

  it("vuelve con las sesiones que se archivaron con él, no con las que ya estaban archivadas", async () => {
    const orch = make("orchestrator", "ORQ-VIEJO")
    const worker = make("worker", "W1")
    const before = make("worker", "ANTES")
    sessions.update(before.id, { archivedAt: Date.now() - RESTORE_WINDOW_MS - 10_000 })

    await archiveProject(deps, db.getProject("p1")!)
    assert.ok(db.getProject("p1")!.archivedAt)
    assert.deepEqual(db.listArchivedProjects().map((p) => p.id), ["p1"])
    assert.equal(db.listProjects().length, 0)

    const { project, restored, skipped } = restoreProject(deps, "p1")
    assert.equal(project.archivedAt, null)
    assert.equal(restored, 2)
    assert.deepEqual(skipped, [])
    assert.equal(db.getSession(orch.id)!.archivedAt, null)
    assert.equal(db.getSession(worker.id)!.archivedAt, null)
    assert.equal(db.getSession(worker.id)!.status, "stopped")
    assert.ok(db.getSession(before.id)!.archivedAt, "la que ya estaba archivada sigue archivada")
    assert.equal(db.listArchivedProjects().length, 0)
    const last = hub.messages.filter((m) => m.type === "project").at(-1)
    assert.ok(last?.type === "project" && last.project.archivedAt === null, "avisa por WS que volvió")
  })

  it("si un nombre está tomado, la worker queda archivada y la orquestadora se renombra", async () => {
    const orch = make("orchestrator", "ORQ-VIEJO")
    const worker = make("worker", "W1")
    await archiveProject(deps, db.getProject("p1")!)
    db.insertProject({ id: "p2", name: "Nuevo", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 2, archivedAt: null })
    sessions.create({ projectId: "p2", kind: "orchestrator", name: "ORQ-VIEJO", role: "", cwd: dir })
    sessions.create({ projectId: "p2", kind: "worker", name: "w1", role: "", cwd: dir })

    const { restored, skipped } = restoreProject(deps, "p1")
    assert.equal(restored, 1)
    assert.deepEqual(skipped, ["W1"])
    assert.equal(db.getSession(orch.id)!.archivedAt, null)
    assert.equal(db.getSession(orch.id)!.name, "ORQ-VIEJO-2")
    assert.ok(db.getSession(worker.id)!.archivedAt)
  })

  it("no restaura uno que no está archivado ni uno que no existe", () => {
    assert.throws(() => restoreProject(deps, "p1"), /no está archivado/)
    assert.throws(() => restoreProject(deps, "nada"), /no existe/)
  })
})
