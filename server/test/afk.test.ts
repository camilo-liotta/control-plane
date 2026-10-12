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
    const fresh = this.db.getSession(rec.id) ?? rec
    this.emit("status", fresh, "idle")
    this.emit("turnEnd", fresh, { ok: true, aborted: false, result: "", local: false, contextFull: false, retried: false })
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
    orch.plans.graceMs = 0
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
    // Con la hora a secas si es hoy, y con el día si el `until` cae después de medianoche.
    assert.match(sessions.notices(orq.id).at(-1)!, /^El usuario está AFK hasta (las|el .+ a las) \d\d:\d\d \(presupuesto US\$ 5\): tus propuestas salen solas, salvo las que marques con hold\.$/)
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
      settings: { ...defaultSettings, autoDispatch: true } as typeof defaultSettings,
      accountId: null,
      createdAt: Date.now(),
      archivedAt: null,
    })
    old.insertProject({ id: "p_off", name: "Sin", repoPath: "/tmp", settings: { ...defaultSettings, autoDispatch: false } as typeof defaultSettings, accountId: null, createdAt: Date.now(), archivedAt: null })
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

  const STEPS = [
    { title: "Uno", prompt: "Primer paso", model: "sonnet", effort: "medium" },
    { title: "Dos", prompt: "Segundo paso", model: "sonnet", effort: "medium" },
  ]
  const drafts = (states?: ("staged" | "ready" | "sent" | "discarded")[]) => db.listDrafts({ projectId, states })
  /** El worker BACKEND reporta y termina el turno (avanza el plan). */
  const finishStep = async (status: "done" | "blocked", summary: string) => {
    orch.report(db.getSession(a.id)!, { status, summary })
    sessions.endTurn(db.getSession(a.id)!)
    await sleep(30)
  }
  const release = async () => {
    sessions.endTurn(orq)
    await sleep(150)
  }

  describe("qué sale solo", () => {
    it("en AFK sale todo al terminar la revisión: prompt, sesión nueva, plan, plan con sesión nueva, y lleva el encabezado", async () => {
      afk.start(projectId)
      orch.proposePrompt(orq, { session: "BACKEND", title: "Prompt", prompt: "Hacé algo", model: "sonnet", effort: "medium" })
      orch.proposeSession(orq, { name: "tests", role: "QA", title: "Suite", prompt: "Armá la suite", model: "sonnet", effort: "medium" })
      orch.plans.propose(orq, { session: "BACKEND", title: "Plan", steps: STEPS })
      orch.plans.propose(orq, { newSession: { name: "docs", role: "Docs" }, title: "Plan nuevo", steps: STEPS })
      assert.equal(drafts(["staged"]).length, 4)
      await release()
      assert.equal(drafts(["staged", "ready"]).length, 0)
      const sent = drafts(["sent"])
      assert.equal(sent.length, 4)
      assert.ok(sent.every((d) => d.sentBy === "afk"))
      assert.ok(db.listSessions().some((s) => s.name === "TESTS"))
      assert.ok(db.listSessions().some((s) => s.name === "DOCS"))
      // El prompt directo, el de la sesión nueva y el primer paso de cada plan salen con el encabezado.
      const texts = sessions.sent.map((m) => m.text)
      assert.equal(texts.filter((t) => t.startsWith(AFK_HEADER)).length, 4)
      assert.ok(texts.some((t) => t.startsWith(AFK_HEADER) && t.includes("Hacé algo")))
      assert.ok(texts.some((t) => t.startsWith(AFK_HEADER) && t.includes("Armá la suite")))
      // El timeline muestra lo que escribió la orquestadora, sin el encabezado.
      assert.ok(sessions.sent.every((m) => !m.opts.display || !m.opts.display.includes(AFK_HEADER)))
    })

    it("una revisión de un plan pausado también sale sola", async () => {
      afk.start(projectId)
      orch.plans.propose(orq, { session: "BACKEND", title: "Plan", steps: STEPS })
      await release()
      const plan = drafts(["sent"])[0]!
      assert.equal(db.getDraft(plan.id)!.planState, "running")
      await finishStep("done", "Uno listo")
      await finishStep("blocked", "Se trabó")
      await sleep(150) // el resultado le llega a la orquestadora
      assert.equal(db.getDraft(plan.id)!.planState, "paused")
      orch.updateProposal(orq, { id: plan.id, steps: [{ title: "Otro", prompt: "Otro", model: "sonnet", effort: "medium" }] })
      await release()
      const rev = drafts().find((d) => d.revises === plan.id)!
      assert.equal(rev.state, "sent")
      assert.equal(rev.sentBy, "afk")
      const after = db.getDraft(plan.id)!
      assert.equal(after.planState, "running")
      assert.equal(after.sentBy, "afk")
      assert.equal(after.steps[1]!.title, "Otro")
    })

    it("lo marcado con hold espera al usuario, con un aviso que lo dice", async () => {
      afk.start(projectId)
      orch.proposePrompt(orq, { session: "BACKEND", title: "Libre", prompt: "Libre", model: "sonnet", effort: "medium" })
      const reply = orch.proposePrompt(orq, { session: "BACKEND", title: "Caro", prompt: "Caro", hold: true, model: "sonnet", effort: "medium" })
      assert.match(reply, /AFK, pero la marcaste con hold/)
      orch.proposeSession(orq, { name: "caja", role: "Caja", title: "Caja", prompt: "Caja", hold: true, model: "sonnet", effort: "medium" })
      orch.plans.propose(orq, { session: "BACKEND", title: "Plan hold", steps: STEPS, hold: true })
      await release()
      const byTitle = (t: string) => drafts().find((d) => d.title === t)!
      assert.equal(byTitle("Libre").state, "sent")
      for (const t of ["Caro", "Nueva sesión CAJA", "Plan hold"]) {
        const d = t === "Nueva sesión CAJA" ? drafts().find((x) => x.kind === "session")! : byTitle(t)
        assert.equal(d.state, "ready", t)
        assert.equal(d.hold, true)
        assert.equal(d.sentBy, null)
      }
      assert.equal(db.listSessions().some((s) => s.name === "CAJA"), false)
      const toast = hub.toasts().find((m) => m.event === "proposals")!
      assert.match(toast.title, /3 propuestas listas/)
      assert.match(toast.body!, /hold/)
      // El usuario la aprueba a mano: sale sin encabezado y marcada como suya.
      const caro = byTitle("Caro")
      await orch.sendDraft(caro.id, {})
      assert.equal(db.getDraft(caro.id)!.sentBy, "user")
      assert.equal(sessions.sent.at(-1)!.text, "Caro")
    })

    it("si en la revisión leyó mensajes de otro proyecto, lo que arma no sale solo (queda con hold)", async () => {
      const other = "p2"
      db.insertProject({ id: other, name: "Otro", repoPath: "/tmp", settings: { ...defaultSettings, batchWindowSec: 0.05 }, accountId: null, createdAt: Date.now(), archivedAt: null })
      const orq2 = session(other, "ORQ2", "orchestrator")
      db.insertSession(orq2)
      afk.start(projectId)
      orch.messageProject(orq2, { project: "Demo", message: "Necesitamos un endpoint" })
      await sleep(400) // el mensaje le llega a ORQ en un lote
      orch.proposePrompt(orq, { session: "BACKEND", title: "Pedido ajeno", prompt: "Hacelo", model: "sonnet", effort: "medium" })
      await release()
      const [d] = drafts()
      assert.equal(d!.state, "ready")
      assert.equal(d!.hold, true)
      assert.equal(sessions.sent.filter((m) => m.id === a.id).length, 0)
      assert.match(hub.toasts().at(-1)!.body!, /pedido de otro proyecto/)
    })

    it("update_proposal cambia el hold, y la respuesta dice qué va a pasar", async () => {
      afk.start(projectId)
      orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", model: "sonnet", effort: "medium" })
      const d = drafts()[0]!
      assert.match(orch.updateProposal(orq, { id: d.id, hold: true }), /con hold: la tiene que aprobar él/)
      assert.equal(db.getDraft(d.id)!.hold, true)
      assert.match(orch.updateProposal(orq, { id: d.id, hold: false }), /sale sola/)
      await release()
      assert.equal(db.getDraft(d.id)!.state, "sent")
    })

    it("sin AFK nada sale solo, y las respuestas siguen diciendo que lo aprueba el usuario", async () => {
      const reply = orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", model: "sonnet", effort: "medium" })
      assert.match(reply, /después la aprueba el usuario/)
      await release()
      assert.equal(drafts(["ready"]).length, 1)
      assert.equal(sessions.sent.length, 0)
      assert.match(orch.proposeSession(orq, { name: "x", role: "x", title: "x", prompt: "x", model: "sonnet", effort: "medium" }), /el usuario la tiene que aprobar para que se cree/)
    })

    it("si el usuario vuelve antes de que se libere, ya no sale sola", async () => {
      afk.start(projectId)
      orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", model: "sonnet", effort: "medium" })
      afk.stop(projectId)
      await release()
      assert.equal(drafts(["ready"]).length, 1)
      assert.equal(sessions.sent.length, 0)
      assert.equal(hub.toasts().filter((m) => m.event === "proposals").length, 1, "avisa que hay una propuesta lista")
    })

    it("si una no se puede enviar, queda lista para el usuario y avisa", async () => {
      afk.start(projectId)
      orch.proposePrompt(orq, { session: "BACKEND", title: "Rota", prompt: "P", model: "sonnet", effort: "medium" })
      db.updateSession(a.id, { archivedAt: Date.now() })
      await release()
      const [d] = drafts()
      assert.equal(d!.state, "ready")
      assert.equal(d!.sentBy, null)
      assert.match(hub.toasts().at(-1)!.title, /No se pudo enviar sola «Rota»/)
    })

    it("el lote de resultados le recuerda a la orquestadora que el usuario está AFK", async () => {
      afk.start(projectId, { budgetUsd: 3 })
      orch.report(a, { status: "done", summary: "Listo" })
      await sleep(400)
      const text = sessions.sent.find((m) => m.id === orq.id)!.text
      assert.match(text, /El usuario está AFK \(presupuesto US\$ 3\): tus propuestas salen solas, salvo las que marques con hold\./)
    })

    it("al terminar el AFK por presupuesto, un plan que aprobó el AFK queda pausado; uno del usuario sigue", async () => {
      const w2 = session(projectId, "FRONT", "worker")
      db.insertSession(w2)
      orch.plans.propose(orq, { session: "FRONT", title: "Del usuario", steps: STEPS })
      sessions.endTurn(orq)
      await orch.sendDraft(drafts(["ready"])[0]!.id, {})
      afk.start(projectId, { budgetUsd: 1 })
      orch.plans.propose(orq, { session: "BACKEND", title: "Del AFK", steps: STEPS })
      await release()
      const planOf = (t: string) => drafts().find((d) => d.title === t)!
      assert.equal(planOf("Del AFK").planState, "running")
      db.updateSession(a.id, { costUsd: 1.5 })
      sessions.endTurn(a)
      assert.equal(db.getProject(projectId)!.afk, null)
      assert.equal(planOf("Del AFK").planState, "paused")
      assert.match(planOf("Del AFK").planNote!, /se agotó el presupuesto/)
      assert.equal(planOf("Del usuario").planState, "running")
    })

    it("un paso de un plan que sigue solo mientras hay AFK lleva el encabezado", async () => {
      orch.plans.propose(orq, { session: "BACKEND", title: "Plan", steps: STEPS })
      sessions.endTurn(orq)
      await orch.sendDraft(drafts(["ready"])[0]!.id, {})
      assert.ok(!sessions.sent.at(-1)!.text.startsWith(AFK_HEADER), "con el usuario presente no lleva encabezado")
      afk.start(projectId)
      await finishStep("done", "Uno listo")
      await sleep(300)
      const second = sessions.sent.find((m) => m.text.includes("Segundo paso"))
      assert.ok(second, "salió el segundo paso")
      assert.ok(second.text.startsWith(AFK_HEADER))
    })
  })

  describe("registro", () => {
    it("guarda lo que se envió solo, lo que esperó, los resultados y el costo", async () => {
      afk.start(projectId, { budgetUsd: 50 })
      orch.proposePrompt(orq, { session: "BACKEND", title: "Sale", prompt: "P", model: "sonnet", effort: "medium" })
      orch.proposeSession(orq, { name: "tests", role: "QA", title: "Suite", prompt: "S", model: "sonnet", effort: "medium" })
      orch.proposePrompt(orq, { session: "BACKEND", title: "Espera", prompt: "E", hold: true, model: "sonnet", effort: "medium" })
      await release()
      orch.report(a, { status: "done", summary: "Terminé lo de la sesión" })
      db.updateSession(a.id, { costUsd: 2, costByModel: { sonnet: 2 } })
      const log = afk.log(projectId)!
      assert.deepEqual(log.sent.map((d) => d.title), ["Sale", "Suite"])
      assert.ok(log.sent.every((d) => d.sentBy === "afk" && d.state === "sent" && d.sentAt))
      const suite = log.sent[1]!
      assert.equal(suite.createdSession, true)
      assert.equal(suite.sessionName, "TESTS")
      assert.equal(suite.sessionId, db.listSessions().find((s) => s.name === "TESTS")!.id)
      // Con el resultado nuevo en la cola, la propuesta que esperaba vuelve a "en preparación".
      assert.deepEqual(log.held.map((d) => [d.title, d.hold]), [["Espera", true]])
      assert.equal(log.results.length, 1)
      assert.equal(log.results[0]!.sessionName, "BACKEND")
      assert.equal(log.results[0]!.summary, "Terminé lo de la sesión")
      assert.equal(log.spentUsd, 2)
      // Lo de antes o después del período no cuenta.
      afk.stop(projectId)
      await sleep(5)
      orch.proposePrompt(orq, { session: "BACKEND", title: "Después", prompt: "P", model: "sonnet", effort: "medium" })
      const after = afk.log(projectId)!
      assert.equal(after.endReason, "user")
      assert.ok(!after.sent.some((d) => d.title === "Después") && !after.held.some((d) => d.title === "Después"))
    })

    it("en «espera tu aprobación» solo quedan las que siguen sin enviar: una con hold que el usuario aprobó después ya no", async () => {
      afk.start(projectId)
      orch.proposePrompt(orq, { session: "BACKEND", title: "Sigue", prompt: "S", hold: true, model: "sonnet", effort: "medium" })
      orch.proposePrompt(orq, { session: "BACKEND", title: "Aprobada", prompt: "A", hold: true, model: "sonnet", effort: "medium" })
      orch.proposePrompt(orq, { session: "BACKEND", title: "Descartada", prompt: "D", hold: true, model: "sonnet", effort: "medium" })
      await release()
      const byTitle = (t: string) => db.listDrafts({ projectId }).find((d) => d.title === t)!
      assert.deepEqual(afk.log(projectId)!.held.map((d) => d.title).sort(), ["Aprobada", "Descartada", "Sigue"])
      await orch.sendDraft(byTitle("Aprobada").id, {})
      orch.discardDraft(byTitle("Descartada").id)
      const log = afk.log(projectId)!
      assert.deepEqual(log.held.map((d) => d.title), ["Sigue"])
      assert.ok(!log.sent.some((d) => d.title === "Aprobada"), "lo aprobó el usuario, no salió solo")
    })

    it("cada período tiene su registro: el último reemplaza al anterior", () => {
      afk.start(projectId)
      afk.stop(projectId)
      const first = afk.log(projectId)!
      afk.start(projectId, { budgetUsd: 4 })
      const second = afk.log(projectId)!
      assert.ok(second.since >= first.since)
      assert.equal(second.endedAt, null)
      assert.equal(second.budgetUsd, 4)
    })
  })
})
