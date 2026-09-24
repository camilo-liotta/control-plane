import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import type { Hub } from "../src/hub.ts"
import { Orchestration } from "../src/orchestration.ts"
import type { SessionManager, SendOptions } from "../src/sessions.ts"
import type { ServerMessage, SessionStatus } from "../src/shared/types.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeHub {
  messages: ServerMessage[] = []
  broadcast(msg: ServerMessage) {
    this.messages.push(msg)
  }
}

/** Imita lo mínimo del SessionManager que usa Orchestration. */
class FakeSessions extends EventEmitter {
  statuses = new Map<string, SessionStatus>()
  sent: { id: string; text: string; opts: SendOptions }[] = []
  db: Db
  constructor(db: Db) {
    super()
    this.db = db
  }
  statusOf(id: string): SessionStatus {
    return this.statuses.get(id) ?? "idle"
  }
  async send(id: string, text: string, opts: SendOptions) {
    this.sent.push({ id, text, opts })
    this.statuses.set(id, "working")
    return { id: this.sent.length, sessionId: id, ts: Date.now(), event: opts.event ?? { kind: "notice", level: "info", text } }
  }
  update(id: string, patch: Partial<SessionRecord>) {
    this.db.updateSession(id, patch)
  }
  async start() {}
  create(input: Partial<SessionRecord> & { projectId: string; kind: "worker"; name: string; role: string; cwd: string }) {
    const rec = session(input.projectId, input.name, "worker")
    this.db.insertSession(rec)
    return rec
  }
  /** Simula que la orquestadora terminó su turno. */
  endTurn(rec: SessionRecord, ok = true) {
    this.statuses.set(rec.id, "idle")
    this.emit("turnEnd", rec, { ok, aborted: !ok, result: "" })
  }
}

let counter = 0
function session(projectId: string, name: string, kind: "worker" | "orchestrator"): SessionRecord {
  counter++
  return {
    id: `s_${name.toLowerCase()}_${counter}`,
    projectId,
    kind,
    name,
    role: "",
    claudeSessionId: `uuid-${counter}`,
    startedOnce: true,
    mcpToken: `tok-${name}-${counter}`,
    model: null,
    effort: null,
    worktree: false,
    cwd: "/tmp",
    status: "idle",
    taskTitle: null,
    taskState: "none",
    lastActivity: null,
    lastActivityAt: null,
    costUsd: 0,
    tokens: null,
    createdAt: Date.now(),
    archivedAt: null,
  }
}

describe("cola de resultados", () => {
  let dir: string
  let db: Db
  let hub: FakeHub
  let sessions: FakeSessions
  let orch: Orchestration
  let orq: SessionRecord
  let a: SessionRecord
  let b: SessionRecord
  const projectId = "p_test"

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-test-"))
    db = new Db(path.join(dir, "test.db"))
    db.insertProject({
      id: projectId,
      name: "Test",
      repoPath: dir,
      settings: { ...defaultSettings, batchWindowSec: 0.2 },
      accountId: null,
      createdAt: Date.now(),
      archivedAt: null,
    })
    orq = session(projectId, "ORQ", "orchestrator")
    a = session(projectId, "BACKEND", "worker")
    b = session(projectId, "FRONTEND", "worker")
    for (const s of [orq, a, b]) db.insertSession(s)
    hub = new FakeHub()
    sessions = new FakeSessions(db)
    orch = new Orchestration(db, hub as unknown as Hub, sessions as unknown as SessionManager)
  })

  afterEach(() => {
    orch.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("agrupa resultados que llegan juntos en un solo lote", async () => {
    orch.report(a, { status: "done", summary: "Listo backend" })
    await sleep(50)
    orch.report(b, { status: "done", summary: "Listo frontend" })
    await sleep(400)
    assert.equal(sessions.sent.length, 1)
    const batch = sessions.sent[0]!
    assert.equal(batch.id, orq.id)
    assert.match(batch.text, /2 resultados nuevos/)
    assert.match(batch.text, /BACKEND/)
    assert.match(batch.text, /FRONTEND/)
    assert.equal(db.listReports({ projectId, states: ["in_review"] }).length, 2)
  })

  it("no libera propuestas mientras haya resultados sin leer", async () => {
    orch.report(a, { status: "done", summary: "A terminó" })
    await sleep(400)
    assert.equal(sessions.sent.length, 1)
    // La orquestadora está analizando: propone algo y mientras tanto llega otro resultado.
    orch.proposePrompt(orq, { session: "FRONTEND", title: "Ajustar dashboards", prompt: "Hacé X" })
    const msg = orch.report(b, { status: "done", summary: "B terminó" })
    assert.match(msg, /Resultado registrado/)
    await sleep(400)
    assert.equal(sessions.sent.length, 1, "no se entrega mientras la orquestadora trabaja")

    // Termina el turno: hay cola, así que se entrega el lote nuevo y la propuesta sigue en preparación.
    sessions.endTurn(orq)
    await sleep(1700)
    assert.equal(sessions.sent.length, 2)
    assert.match(sessions.sent[1]!.text, /llegaron 1 más mientras analizabas/)
    assert.match(sessions.sent[1]!.text, /Propuestas sin enviar/)
    assert.equal(db.listDrafts({ projectId, states: ["staged"] }).length, 1)

    // Ahora sí termina con la cola vacía: se cierra la revisión y la propuesta queda lista.
    sessions.endTurn(orq)
    assert.equal(db.listDrafts({ projectId, states: ["ready"] }).length, 1)
    assert.equal(db.listReports({ projectId, states: ["reviewed"] }).length, 2)
  })

  it("un resultado nuevo vuelve a bloquear las propuestas listas", async () => {
    orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P" })
    sessions.endTurn(orq)
    const [ready] = db.listDrafts({ projectId, states: ["ready"] })
    assert.ok(ready)
    orch.report(b, { status: "partial", summary: "Cambié el schema" })
    assert.equal(db.getDraft(ready.id)!.state, "staged")
    await assert.rejects(orch.sendDraft(ready.id, {}), /revisando resultados/)
  })

  it("enviar una propuesta lista la manda a la sesión destino como mensaje", async () => {
    orch.proposePrompt(orq, { session: "BACKEND", title: "Migrar usuarios", prompt: "Migrá la tabla de usuarios" })
    sessions.endTurn(orq)
    const [ready] = db.listDrafts({ projectId, states: ["ready"] })
    const sent = await orch.sendDraft(ready!.id, { prompt: "Migrá la tabla de usuarios con índices" })
    assert.equal(sent.state, "sent")
    assert.equal(sent.edited, true)
    const last = sessions.sent.at(-1)!
    assert.equal(last.id, a.id)
    assert.equal(last.text, "Migrá la tabla de usuarios con índices")
    assert.equal(last.opts.origin, "draft")
    assert.equal(db.getSession(a.id)!.taskTitle, "Migrar usuarios")
  })

  it("si interrumpís a la orquestadora, la revisión queda en pausa", async () => {
    orch.report(a, { status: "done", summary: "A" })
    await sleep(400)
    orch.proposePrompt(orq, { session: "FRONTEND", title: "T", prompt: "P" })
    orch.report(b, { status: "done", summary: "B" })
    sessions.endTurn(orq, false)
    await sleep(1700)
    assert.equal(sessions.sent.length, 1, "no entrega nada sola")
    assert.equal(db.listDrafts({ projectId, states: ["staged"] }).length, 1, "no libera nada a medias")
    assert.equal(orch.reviewState(projectId).paused, true)
    await orch.reviewNow(projectId)
    assert.equal(sessions.sent.length, 2)
  })

  it("con auto-envío, las propuestas salen solas al cerrar la revisión", async () => {
    db.updateProject(projectId, { settings: { ...defaultSettings, batchWindowSec: 0.2, autoDispatch: true } })
    orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "Hacé algo" })
    sessions.endTurn(orq)
    await sleep(20)
    assert.equal(db.listDrafts({ projectId, states: ["sent"] }).length, 1)
    assert.equal(sessions.sent.at(-1)!.id, a.id)
  })

  it("las propuestas de sesión nueva crean la sesión al aprobarlas", async () => {
    orch.proposeSession(orq, { name: "tests e2e", role: "QA", title: "Armar suite", prompt: "Armá la suite" })
    sessions.endTurn(orq)
    const [ready] = db.listDrafts({ projectId, states: ["ready"] })
    assert.equal(ready!.newSession?.name, "TESTS-E2E")
    await orch.sendDraft(ready!.id, {})
    const created = db.listSessions().find((s) => s.name === "TESTS-E2E")
    assert.ok(created)
    assert.equal(sessions.sent.at(-1)!.id, created.id)
  })

  it("los subagentes pedidos viajan con la propuesta y salen en el prompt", async () => {
    const msg = orch.proposePrompt(orq, {
      session: "BACKEND",
      title: "Migrar",
      prompt: "Migrá la tabla",
      subagents: [{ name: "revisor", role: "revisor de SQL", task: "Revisá la migración", readOnly: true }],
    })
    assert.match(msg, /1 subagente \(revisor\)/)
    sessions.endTurn(orq)
    const [ready] = db.listDrafts({ projectId, states: ["ready"] })
    assert.equal(ready!.subagents.length, 1)
    await orch.sendDraft(ready!.id, {})
    const last = sessions.sent.at(-1)!
    assert.match(last.text, /^Migrá la tabla/)
    assert.match(last.text, /subagent_type: "Explore"/)
    assert.match(last.text, /Revisá la migración/)
  })

  it("read_results trae la cola a mitad de turno", async () => {
    orch.report(a, { status: "done", summary: "A" })
    await sleep(400)
    orch.report(b, { status: "blocked", summary: "Necesito decisión" })
    const text = orch.readResults(orq)
    assert.match(text, /FRONTEND/)
    assert.match(text, /bloqueado/)
    assert.equal(orch.reviewState(projectId).queued, 0)
    sessions.endTurn(orq)
    assert.equal(db.listReports({ projectId, states: ["reviewed"] }).length, 2)
  })
})
