import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { Afk, AFK_HEADER, afkEnterNotice } from "../src/afk.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { Orchestration } from "../src/orchestration.ts"
import type { SendOptions, SessionManager } from "../src/sessions.ts"
import type { ModelOption, ServerMessage, SessionStatus, TimelineEvent } from "../src/shared/types.ts"

const CATALOG: ModelOption[] = [
  { value: "default", label: "Default (recommended)", efforts: ["low", "medium", "high"] },
  { value: "sonnet", label: "Sonnet 5.5", efforts: ["low", "medium", "high"], resolved: "claude-sonnet-5-5" },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeHub {
  messages: ServerMessage[] = []
  broadcast(msg: ServerMessage) {
    this.messages.push(msg)
  }
  toasts() {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: "toast" }> => m.type === "toast")
  }
}

class FakeSessions extends EventEmitter {
  statuses = new Map<string, SessionStatus>()
  sent: { id: string; text: string; opts: SendOptions }[] = []
  events: { id: string; event: TimelineEvent }[] = []
  meta: { models: ModelOption[] } = { models: CATALOG }
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
  async clearConversation() {}
  async start() {}
  async setModel(id: string, model: string | null) {
    this.db.updateSession(id, { model })
  }
  async setEffort(id: string, effort: string | null) {
    this.db.updateSession(id, { effort })
  }
  addEvent(id: string, event: TimelineEvent) {
    this.events.push({ id, event })
  }
  notices(id: string) {
    return this.events.filter((e) => e.id === id && e.event.kind === "notice").map((e) => (e.event as { text: string }).text)
  }
  create(input: { projectId: string; name: string; role: string; model?: string | null; effort?: string | null }) {
    const rec = { ...session(input.projectId, input.name, "worker"), model: input.model ?? null, effort: input.effort ?? null }
    this.db.insertSession(rec)
    return rec
  }
  endTurn(rec: SessionRecord) {
    this.statuses.set(rec.id, "idle")
    this.emit("turnEnd", rec, { ok: true, aborted: false, result: "", local: false })
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
    costByModel: {},
    tokens: null,
    context: null,
    createdAt: Date.now(),
    archivedAt: null,
  }
}

describe("modo AFK", () => {
  let dir: string
  let db: Db
  let hub: FakeHub
  let sessions: FakeSessions
  let orch: Orchestration
  let afk: Afk
  let orq: SessionRecord
  let a: SessionRecord
  const projectId = "p1"

  const boot = () => {
    hub = new FakeHub()
    sessions = new FakeSessions(db)
    orch = new Orchestration(db, hub as unknown as import("../src/hub.ts").Hub, sessions as unknown as SessionManager)
    afk = new Afk({ db, hub: hub as unknown as import("../src/hub.ts").Hub, sessions: sessions as unknown as SessionManager, orchestration: orch })
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-afk-"))
    db = new Db(path.join(dir, "test.db"))
    db.insertProject({
      id: projectId,
      name: "Demo",
      repoPath: "/tmp",
      settings: { ...defaultSettings, batchWindowSec: 0.05 },
      accountId: null,
      createdAt: Date.now(),
      archivedAt: null,
    })
    orq = session(projectId, "ORQ", "orchestrator")
    a = session(projectId, "BACKEND", "worker")
    db.insertSession(orq)
    db.insertSession(a)
    boot()
  })

  afterEach(() => {
    afk.dispose()
    orch.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("entra en AFK: guarda el estado, el costo de partida y avisa en el chat de la orquestadora", () => {
    db.updateSession(a.id, { costUsd: 3.5, costByModel: { sonnet: 3.5 } })
    const until = Date.now() + 3 * 3600_000
    const view = afk.start(projectId, { until, budgetUsd: 5 })
    assert.equal(view.afk?.until, until)
    assert.equal(view.afk?.budgetUsd, 5)
    assert.equal(view.afk?.spentAtStart, 3.5)
    assert.ok(view.afk!.since <= Date.now())
    assert.deepEqual(db.getProject(projectId)!.afk, view.afk)
    assert.match(sessions.notices(orq.id).at(-1)!, /^El usuario está AFK hasta las \d\d:\d\d \(presupuesto US\$ 5\): tus propuestas salen solas, salvo las que marques con hold\.$/)
    const sent = hub.messages.filter((m) => m.type === "project")
    assert.equal(sent.at(-1)!.type === "project" && sent.at(-1)!.project.afk?.budgetUsd, 5)
  })

  it("sin límites el aviso no menciona hora ni presupuesto", () => {
    afk.start(projectId)
    assert.equal(sessions.notices(orq.id).at(-1), "El usuario está AFK: tus propuestas salen solas, salvo las que marques con hold.")
    assert.equal(afkEnterNotice({ until: null, budgetUsd: 2.5 }), "El usuario está AFK (presupuesto US$ 2.50): tus propuestas salen solas, salvo las que marques con hold.")
  })

  it("volver a ponerse AFK cambia los topes y deja el mismo período", () => {
    const first = afk.start(projectId, { budgetUsd: 1 }).afk!
    const second = afk.start(projectId, { budgetUsd: 10 }).afk!
    assert.equal(second.since, first.since)
    assert.equal(second.budgetUsd, 10)
    assert.equal(afk.log(projectId)!.budgetUsd, 10)
  })

  it("rechaza topes que no valen", () => {
    assert.throws(() => afk.start(projectId, { until: Date.now() - 1000 }), /ya pasó/)
    assert.throws(() => afk.start(projectId, { budgetUsd: 0 }), /mayor que 0/)
    assert.throws(() => afk.start(projectId, { budgetUsd: -3 }), /mayor que 0/)
    assert.throws(() => afk.start("nope"), /no existe/)
    assert.equal(db.getProject(projectId)!.afk, null)
  })

  it("al salir: vuelve a null, avisa y deja el registro con el motivo y lo gastado", () => {
    afk.start(projectId, { budgetUsd: 20 })
    db.updateSession(a.id, { costUsd: 4, costByModel: { sonnet: 3, haiku: 1 } })
    const view = afk.stop(projectId)!
    assert.equal(view.afk, null)
    assert.equal(sessions.notices(orq.id).at(-1), "El usuario volvió: tus propuestas vuelven a esperar su aprobación.")
    const log = afk.log(projectId)!
    assert.equal(log.endReason, "user")
    assert.ok(log.endedAt)
    assert.equal(log.spentUsd, 4)
    assert.deepEqual(log.costByModel, { sonnet: 3, haiku: 1 })
    // Salir de un proyecto que no está AFK no hace nada.
    assert.equal(afk.stop(projectId), null)
    // Y salir a mano no es un aviso de "terminó solo".
    assert.equal(hub.toasts().length, 0)
  })

  it("el registro del proyecto que nunca estuvo AFK es null, y el de uno en curso sigue abierto", () => {
    assert.equal(afk.log(projectId), null)
    afk.start(projectId)
    db.updateSession(a.id, { costUsd: 1.25, costByModel: { sonnet: 1.25 } })
    const log = afk.log(projectId)!
    assert.equal(log.endedAt, null)
    assert.equal(log.endReason, null)
    assert.equal(log.spentUsd, 1.25)
    assert.deepEqual(log.costByModel, { sonnet: 1.25 })
  })

  it("solo cuenta lo gastado desde que empezó el AFK", () => {
    db.updateSession(a.id, { costUsd: 10, costByModel: { sonnet: 10 } })
    afk.start(projectId)
    db.updateSession(a.id, { costUsd: 10.75, costByModel: { sonnet: 10.5, haiku: 0.25 } })
    const log = afk.log(projectId)!
    assert.equal(log.spentUsd, 0.75)
    assert.deepEqual(log.costByModel, { sonnet: 0.5, haiku: 0.25 })
  })

  it("migra autoDispatch: un proyecto con auto-envío pasa a AFK sin límites y la opción desaparece", () => {
    const file = path.join(dir, "old.db")
    const old = new Db(file)
    old.insertProject({
      id: "p_old",
      name: "Viejo",
      repoPath: "/tmp",
      settings: { ...defaultSettings, autoDispatch: true },
      accountId: null,
      createdAt: Date.now(),
      archivedAt: null,
    })
    old.insertProject({ id: "p_off", name: "Sin", repoPath: "/tmp", settings: { ...defaultSettings, autoDispatch: false }, accountId: null, createdAt: Date.now(), archivedAt: null })
    const s = { ...session("p_old", "W", "worker") }
    old.insertSession(s)
    old.updateSession(s.id, { costUsd: 7, costByModel: { sonnet: 7 } })
    old.close()
    const again = new Db(file)
    try {
      const p = again.getProject("p_old")!
      assert.equal(p.afk?.until, null)
      assert.equal(p.afk?.budgetUsd, null)
      assert.equal(p.afk?.spentAtStart, 7)
      assert.equal("autoDispatch" in p.settings, false)
      assert.equal(again.getProject("p_off")!.afk, null)
      assert.equal("autoDispatch" in again.getProject("p_off")!.settings, false)
      assert.equal(again.lastAfkPeriod("p_old")!.endedAt, null)
      // Idempotente: otra vuelta no lo toca.
      again.close()
      const third = new Db(file)
      assert.equal(third.getProject("p_old")!.afk?.since, p.afk?.since)
      third.close()
    } finally {
      try {
        again.close()
      } catch {}
    }
  })

  it("termina solo al vencer `until`: avisa con toast y deja el motivo", async () => {
    afk.start(projectId, { until: Date.now() + 60 })
    await sleep(150)
    assert.equal(db.getProject(projectId)!.afk, null)
    const log = afk.log(projectId)!
    assert.equal(log.endReason, "until")
    const toast = hub.toasts().at(-1)!
    assert.equal(toast.event, "needs_you")
    assert.equal(toast.level, "warn")
    assert.equal(toast.projectId, projectId)
    assert.match(toast.title, /se cumplió el tiempo/)
    assert.match(sessions.notices(orq.id).at(-1)!, /Se cumplió el tiempo del AFK/)
  })

  it("termina solo al gastar el presupuesto (se revisa al terminar un turno)", () => {
    afk.start(projectId, { budgetUsd: 2 })
    db.updateSession(a.id, { costUsd: 1.5 })
    sessions.endTurn(a)
    assert.ok(db.getProject(projectId)!.afk, "todavía no llegó al tope")
    db.updateSession(a.id, { costUsd: 2.25, costByModel: { sonnet: 2.25 } })
    sessions.endTurn(a)
    assert.equal(db.getProject(projectId)!.afk, null)
    const log = afk.log(projectId)!
    assert.equal(log.endReason, "budget")
    assert.equal(log.spentUsd, 2.25)
    const toast = hub.toasts().at(-1)!
    assert.equal(toast.event, "needs_you")
    assert.match(toast.title, /se agotó el presupuesto/)
    assert.match(toast.body!, /US\$ 2\.25/)
    assert.match(sessions.notices(orq.id).at(-1)!, /Se agotó el presupuesto del AFK/)
  })

  it("sobrevive a un reinicio: sigue en AFK con sus topes", () => {
    const until = Date.now() + 3600_000
    const before = afk.start(projectId, { until, budgetUsd: 8 }).afk!
    afk.dispose()
    orch.dispose()
    boot()
    assert.deepEqual(db.getProject(projectId)!.afk, before)
    assert.equal(afk.log(projectId)!.endedAt, null)
  })

  it("un `until` vencido con el server apagado termina al arrancar", () => {
    const state = { since: Date.now() - 7200_000, until: Date.now() - 3600_000, budgetUsd: null, spentAtStart: 0 }
    db.updateProject(projectId, { afk: state })
    db.insertAfkPeriod({ projectId, since: state.since, until: state.until, budgetUsd: null, spentAtStart: 0, costByModelAtStart: {} })
    afk.dispose()
    orch.dispose()
    boot()
    assert.equal(db.getProject(projectId)!.afk, null)
    assert.equal(afk.log(projectId)!.endReason, "until")
    assert.match(sessions.notices(orq.id).at(-1)!, /Se cumplió el tiempo/)
  })

  it("archivar el proyecto no lo deja en AFK (listAfkProjects solo trae los activos)", () => {
    afk.start(projectId)
    db.updateProject(projectId, { archivedAt: Date.now() })
    assert.equal(db.listAfkProjects().length, 0)
  })

  it("el encabezado para los workers pide no preguntar", () => {
    assert.match(AFK_HEADER, /AskUserQuestion/)
    assert.match(AFK_HEADER, /report_result/)
    assert.match(AFK_HEADER, /blocked/)
  })
})
