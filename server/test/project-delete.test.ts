import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Compaction } from "../src/compaction.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { desktopSummary } from "../src/desktop.ts"
import { Hub } from "../src/hub.ts"
import { Orchestration } from "../src/orchestration.ts"
import { deleteProject, type DeleteProjectDeps } from "../src/project-delete.ts"
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })

describe("borrar un proyecto", () => {
  let dir: string
  let repo: string
  let worktree: string
  let claudeDir: string
  let dbFile: string
  let db: Db
  let hub: SpyHub
  let sessions: SessionManager
  let orchestration: Orchestration
  let compaction: Compaction
  let attachments: AttachmentStore
  let deps: DeleteProjectDeps
  const own: Record<"p1" | "p2", SessionRecord[]> = { p1: [], p2: [] }

  /** Cuántas filas de cada tabla son de un proyecto (leído con otra conexión, como la vería cualquiera). */
  const counts = (projectId: string) => {
    const raw = new DatabaseSync(dbFile)
    try {
      const n = (sql: string) => Number((raw.prepare(sql).get(projectId) as { n: number }).n)
      const sids = "SELECT id FROM sessions WHERE project_id = ?"
      return {
        projects: n("SELECT COUNT(*) AS n FROM projects WHERE id = ?"),
        sessions: n("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?"),
        events: n(`SELECT COUNT(*) AS n FROM events WHERE session_id IN (${sids})`),
        attachments: n(`SELECT COUNT(*) AS n FROM attachments WHERE session_id IN (${sids})`),
        drafts: n("SELECT COUNT(*) AS n FROM drafts WHERE project_id = ?"),
        reports: n("SELECT COUNT(*) AS n FROM reports WHERE project_id = ?"),
        tasks: n("SELECT COUNT(*) AS n FROM user_tasks WHERE project_id = ?"),
      }
    } finally {
      raw.close()
    }
  }

  /**
   * Todo lo que quedó en la base (para comparar antes y después de un borrado que falla). Los eventos
   * van aparte: al detenerse, cada sesión suma el suyo ("Sesión detenida.").
   */
  const everything = () => {
    const raw = new DatabaseSync(dbFile)
    try {
      const n = (t: string) => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)
      return { rows: ["projects", "sessions", "attachments", "drafts", "reports", "user_tasks"].map(n), events: n("events") }
    } finally {
      raw.close()
    }
  }
  const unchanged = (before: ReturnType<typeof everything>) => {
    const now = everything()
    assert.deepEqual(now.rows, before.rows)
    assert.ok(now.events >= before.events, "se borraron eventos")
  }

  const fill = (projectId: "p1" | "p2", cwd: string) => {
    db.insertProject({ id: projectId, name: projectId === "p1" ? "Borrame" : "Quedate", repoPath: repo, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    const orch = sessions.create({ projectId, kind: "orchestrator", name: `ORQ-${projectId}`, role: "", cwd: repo })
    const worker = sessions.create({ projectId, kind: "worker", name: `W-${projectId}`, role: "", cwd, worktree: cwd !== repo })
    const archived = sessions.create({ projectId, kind: "worker", name: `VIEJA-${projectId}`, role: "", cwd: repo })
    sessions.update(archived.id, { archivedAt: 5 })
    own[projectId] = [orch, worker, archived]
    for (const s of own[projectId]) {
      sessions.addEvent(s.id, { kind: "notice", level: "info", text: "hola" })
      attachments.save(s.id, { name: "a.png", mime: "image/png", data: Buffer.from("x"), source: "user" })
    }
    const t = 10
    db.insertDraft({ id: `d-${projectId}`, projectId, kind: "prompt", targetSessionId: worker.id, newSession: null, title: "t", prompt: "p", state: "ready", createdBy: orch.id, createdAt: t, updatedAt: t, decidedAt: null, edited: false, revision: 1, subagents: [], fresh: false })
    db.insertReport({ id: `r-${projectId}`, projectId, sessionId: worker.id, taskTitle: "t", status: "done", summary: "s", details: null, state: "reviewed", createdAt: t, deliveredAt: t, reviewedAt: t })
    db.insertTask({ id: `t-${projectId}`, projectId, title: "t", steps: ["a"], why: null, blocking: true, due: null, createdBy: worker.id, alsoBy: [], status: "open", note: null, closedBy: null, createdAt: t, updatedAt: t, closedAt: null, cli: null, priority: null, tags: [] })
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-delete-"))
    repo = path.join(dir, "repo")
    worktree = path.join(dir, "repo-wt")
    claudeDir = path.join(dir, "claude")
    fs.mkdirSync(repo)
    git(repo, "init", "-q", "-b", "main")
    fs.writeFileSync(path.join(repo, "LEEME.md"), "no me borres\n")
    git(repo, "add", "LEEME.md")
    git(repo, "commit", "-q", "-m", "inicio")
    git(repo, "worktree", "add", "-q", "-b", "feat/w", worktree)
    fs.writeFileSync(path.join(worktree, "trabajo.txt"), "a medias\n")

    const bin = writeFakeClaude(dir)
    dbFile = path.join(dir, "t.db")
    db = new Db(dbFile)
    hub = new SpyHub()
    attachments = new AttachmentStore(db, path.join(dir, "home", "attachments"))
    sessions = new SessionManager({
      db,
      hub,
      attachments,
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: claudeDir }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    orchestration = new Orchestration(db, hub, sessions)
    compaction = new Compaction({ db, hub, sessions, launchFor: () => ({ bin: "false", env: {}, model: null }) })
    deps = { db, hub, sessions, orchestration, compaction, attachments }
    fill("p1", worktree)
    fill("p2", repo)
    // Las dos activas del proyecto a borrar quedan corriendo, y una del otro también.
    await Promise.all([sessions.start(own.p1[0]!.id), sessions.start(own.p1[1]!.id), sessions.start(own.p2[0]!.id)])
  })

  afterEach(async () => {
    await sessions.shutdown()
    orchestration.dispose()
    compaction.dispose()
    hub.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("detiene sus sesiones y borra todo lo suyo, sin tocar el otro proyecto", async () => {
    const other = counts("p2")
    const result = await deleteProject(deps, "p1", "Borrame")
    assert.deepEqual(result, { ok: true, stopped: 2 })
    for (const s of own.p1) assert.equal(sessions.isRunning(s.id), false, `${s.name} quedó corriendo`)
    assert.deepEqual(counts("p1"), { projects: 0, sessions: 0, events: 0, attachments: 0, drafts: 0, reports: 0, tasks: 0 })
    for (const s of own.p1) assert.equal(fs.existsSync(path.join(attachments.root, s.id)), false, "quedaron adjuntos")

    assert.deepEqual(counts("p2"), other)
    assert.equal(sessions.isRunning(own.p2[0]!.id), true, "detuvo una sesión de otro proyecto")
    for (const s of own.p2) assert.equal(fs.existsSync(path.join(attachments.root, s.id)), true)

    assert.ok(hub.messages.some((m) => m.type === "project_removed" && m.id === "p1"))
    // La bandeja ya no lo cuenta: queda la propuesta y la tarea del otro.
    const summary = desktopSummary({ db, sessions })
    assert.deepEqual(summary.projects.map((p) => p.id), ["p2"])
    assert.equal(summary.needs, 2)
  })

  it("no toca el repo, el worktree ni las conversaciones de Claude Code", async () => {
    const transcripts = () => fs.readdirSync(path.join(claudeDir, "projects"), { recursive: true }).map(String).sort()
    await deleteProject(deps, "p1", "Borrame")
    assert.equal(fs.readFileSync(path.join(repo, "LEEME.md"), "utf8"), "no me borres\n")
    assert.equal(git(repo, "status", "--porcelain"), "")
    assert.equal(fs.readFileSync(path.join(worktree, "trabajo.txt"), "utf8"), "a medias\n")
    assert.match(git(repo, "worktree", "list"), /repo-wt.*\[feat\/w\]/)
    assert.match(git(repo, "branch", "--list", "feat/w"), /feat\/w/)
    const after = transcripts()
    assert.ok(after.some((f) => f.endsWith(".jsonl")), "las conversaciones siguen en la cuenta")
  })

  it("sin el nombre del proyecto no borra nada", async () => {
    const before = everything()
    await assert.rejects(deleteProject(deps, "p1", undefined), /escribí el nombre del proyecto: Borrame/)
    await assert.rejects(deleteProject(deps, "p1", "borrame"), /escribí el nombre/)
    unchanged(before)
    assert.equal(sessions.isRunning(own.p1[0]!.id), true, "no detiene nada si no confirmaste")
  })

  it("si una sesión no se detiene a tiempo, aborta sin borrar nada", async () => {
    const before = everything()
    const stubborn = own.p1[1]!
    const stuck: DeleteProjectDeps = {
      ...deps,
      sessions: {
        setDeleting: (id, on) => sessions.setDeleting(id, on),
        forget: (ids) => sessions.forget(ids),
        isRunning: (id) => sessions.isRunning(id),
        stopAll: async () => [stubborn.id],
      },
    }
    await assert.rejects(deleteProject(stuck, "p1", "Borrame"), new RegExp(`No pude detener ${stubborn.name}: no borré nada`))
    unchanged(before)
    assert.equal(hub.messages.some((m) => m.type === "project_removed"), false)
    // Se puede volver a usar: sus sesiones arrancan de nuevo.
    await sessions.start(own.p1[2]!.id).catch((err: Error) => assert.doesNotMatch(err.message, /se está borrando/))
  })

  it("si el borrado falla a mitad de camino, la base queda como estaba", async () => {
    const raw = new DatabaseSync(dbFile)
    raw.exec("CREATE TRIGGER no_borrar BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'falla de prueba'); END")
    raw.close()
    const before = everything()
    await assert.rejects(deleteProject(deps, "p1", "Borrame"), /falla de prueba/)
    unchanged(before)
    for (const s of own.p1) assert.equal(fs.existsSync(path.join(attachments.root, s.id)), true, "borró adjuntos de un borrado que falló")
    assert.equal(hub.messages.some((m) => m.type === "project_removed"), false)
    await sessions.start(own.p1[0]!.id)
    assert.equal(sessions.isRunning(own.p1[0]!.id), true, "después de fallar, sus sesiones vuelven a arrancar")
  })

  it("mientras se borra, sus sesiones no arrancan", async () => {
    sessions.setDeleting("p1", true)
    await assert.rejects(sessions.start(own.p1[1]!.id).then(() => sessions.stop(own.p1[1]!.id)).then(() => sessions.start(own.p1[1]!.id)), /se está borrando/)
    sessions.setDeleting("p1", false)
  })
})
