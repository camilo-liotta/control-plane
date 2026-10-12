import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import type { Hub } from "../src/hub.ts"
import { Orchestration } from "../src/orchestration.ts"
import type { SendOptions, SessionManager } from "../src/sessions.ts"
import type { Draft, ModelOption, SessionStatus, TimelineEvent } from "../src/shared/types.ts"

const CATALOG: ModelOption[] = [
  { value: "default", label: "Default (recommended)", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", label: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
  { value: "haiku", label: "Haiku 5.5", efforts: [] },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Lo mínimo del SessionManager que usan Orchestration y Plans, con un registro de lo que pasó. */
class FakeSessions extends EventEmitter {
  statuses = new Map<string, SessionStatus>()
  sent: { id: string; text: string; opts: SendOptions }[] = []
  log: string[] = []
  events: { id: string; event: TimelineEvent }[] = []
  meta = { models: CATALOG }
  failNextSend = false
  db: Db
  constructor(db: Db) {
    super()
    this.db = db
  }
  statusOf(id: string): SessionStatus {
    return this.statuses.get(id) ?? "idle"
  }
  async send(id: string, text: string, opts: SendOptions) {
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error("La sesión se cerró antes de recibir el mensaje")
    }
    this.log.push(`send:${id}`)
    this.sent.push({ id, text, opts })
    this.statuses.set(id, "working")
    return { id: this.sent.length, sessionId: id, ts: Date.now(), event: opts.event ?? { kind: "notice" as const, level: "info" as const, text } }
  }
  update(id: string, patch: Partial<SessionRecord>) {
    this.db.updateSession(id, patch)
  }
  async clearConversation(id: string) {
    if (this.statusOf(id) === "working") throw new Error("La sesión está trabajando")
    this.log.push(`clear:${id}`)
  }
  async start() {}
  async setModel(id: string, model: string | null) {
    this.log.push(`model:${model}`)
    this.db.updateSession(id, { model })
  }
  async setEffort(id: string, effort: string | null) {
    this.log.push(`effort:${effort}`)
    this.db.updateSession(id, { effort })
  }
  addEvent(id: string, event: TimelineEvent) {
    this.events.push({ id, event })
  }
  create(input: { projectId: string; name: string; model?: string | null; effort?: string | null }) {
    const rec = { ...session(input.projectId, input.name, "worker"), model: input.model ?? null, effort: input.effort ?? null }
    this.db.insertSession(rec)
    return rec
  }
  /** La sesión terminó su turno. */
  endTurn(rec: SessionRecord, info: { ok?: boolean; aborted?: boolean; local?: boolean; result?: string } = {}) {
    this.statuses.set(rec.id, "idle")
    const fresh = this.db.getSession(rec.id) ?? rec
    this.emit("status", fresh, "idle")
    this.emit("turnEnd", fresh, { ok: info.ok ?? true, aborted: info.aborted ?? false, result: info.result ?? "", local: info.local ?? false, contextFull: false, retried: false })
  }
  setStatus(rec: SessionRecord, status: SessionStatus) {
    this.statuses.set(rec.id, status)
    this.emit("status", this.db.getSession(rec.id) ?? rec, status)
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

const STEPS = [
  { title: "Tipos", prompt: "Sumá los tipos", model: "sonnet", effort: "medium" },
  { title: "Tests", prompt: "Escribí los tests", model: "haiku", fresh: true },
  { title: "Revisión", prompt: "Revisá todo", model: "opus", effort: "high" },
]

describe("planes por pasos", () => {
  let dir: string
  let db: Db
  let sessions: FakeSessions
  let orch: Orchestration
  let orq: SessionRecord
  let w: SessionRecord
  const projectId = "p_plan"

  const newOrchestration = () => new Orchestration(db, { broadcast() {} } as unknown as Hub, sessions as unknown as SessionManager)
  const plan = (): Draft => db.listDrafts({ projectId }).find((d) => d.kind === "plan" && !d.revises)!
  const toWorker = () => sessions.sent.filter((m) => m.id === w.id)
  const toOrq = () => sessions.sent.filter((m) => m.id === orq.id)
  /** Propone el plan, cierra la revisión y lo aprueba. */
  const approved = async (steps = STEPS) => {
    orch.plans.propose(orq, { session: "BACKEND", title: "Modelos", steps })
    sessions.endTurn(orq)
    await orch.sendDraft(plan().id, {})
    return plan()
  }
  /** El worker reporta y termina el turno. */
  const report = async (status: "done" | "blocked" | "partial", summary: string, details?: string) => {
    orch.report(db.getSession(w.id)!, { status, summary, details })
    sessions.endTurn(w)
    await sleep(10)
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-plans-"))
    db = new Db(path.join(dir, "test.db"))
    db.insertProject({ id: projectId, name: "Test", repoPath: dir, settings: { ...defaultSettings, batchWindowSec: 0.05 }, accountId: null, createdAt: 1, archivedAt: null })
    orq = session(projectId, "ORQ", "orchestrator")
    w = session(projectId, "BACKEND", "worker")
    db.insertSession(orq)
    db.insertSession(w)
    sessions = new FakeSessions(db)
    orch = newOrchestration()
    orch.plans.graceMs = 1
  })

  afterEach(() => {
    orch.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("valida modelo y esfuerzo de cada paso, contra el modelo con que sigue la sesión", () => {
    assert.throws(
      () => orch.plans.propose(orq, { session: "BACKEND", title: "X", steps: [{ title: "a", prompt: "a", model: "sonnet" }, { title: "b", prompt: "b", effort: "max" }] }),
      /Paso 2: Sonnet 5\.5 no tiene esfuerzo "max"/
    )
    assert.throws(() => orch.plans.propose(orq, { session: "BACKEND", title: "X", steps: [] }), /no tiene pasos/)
    assert.throws(() => orch.plans.propose(orq, { session: "NADIE", title: "X", steps: STEPS }), /No existe la sesión/)
    const reply = orch.plans.propose(orq, { session: "BACKEND", title: "X", steps: STEPS })
    assert.match(reply, /3 pasos/)
    assert.equal(plan().planState, null)
    assert.deepEqual(plan().steps.map((s) => s.state), ["pending", "pending", "pending"])
  })

  it("avanza solo con cada done, sin despertar a la orquestadora, y entrega un solo resultado al final", async () => {
    const d = await approved()
    assert.equal(d.planState, "running")
    assert.equal(d.currentStep, 0)
    const first = toWorker()[0]!
    assert.match(first.text, /^Paso 1 de 3 del plan «Modelos»\. Cuando termines este paso, reportá con report_result: el siguiente te llega solo\.\n\nSumá los tipos/)
    assert.deepEqual(first.opts.plan, { draftId: d.id, step: 0, total: 3, title: "Tipos" })
    assert.equal(db.getSession(w.id)!.model, "sonnet")

    const reply = orch.report(db.getSession(w.id)!, { status: "done", summary: "Tipos listos", details: "types.ts" })
    assert.match(reply, /el siguiente paso te llega solo/)
    assert.equal(toWorker().length, 1, "no manda el siguiente hasta que termine el turno")
    sessions.endTurn(w)
    await sleep(10)
    // Paso 2: de cero, con Haiku, y con lo que reportó el paso 1.
    assert.deepEqual(sessions.log.slice(-3), [`clear:${w.id}`, "model:haiku", `send:${w.id}`])
    const second = toWorker()[1]!
    assert.match(second.text, /^Paso 2 de 3/)
    assert.match(second.text, /## Dónde quedó el paso anterior \(1\. Tipos\)[\s\S]*Tipos listos\n\ntypes\.ts\n\nEscribí los tests/)
    assert.equal(plan().steps[0]!.state, "done")
    assert.equal(plan().steps[0]!.summary, "Tipos listos")

    await report("done", "Tests listos")
    assert.match(toWorker()[2]!.text, /^Paso 3 de 3 \(el último\)/)
    assert.equal(db.listReports({ projectId }).length, 0, "los done intermedios no van a la cola")
    await report("done", "Revisado")
    assert.equal(plan().planState, "done")
    const reports = db.listReports({ projectId })
    assert.equal(reports.length, 1)
    assert.equal(reports[0]!.taskTitle, "Modelos")
    assert.match(reports[0]!.summary, /^«Modelos» terminado: 3 pasos\./)
    assert.ok(!reports[0]!.summary.includes(plan().id), "el id no va en el resumen (lo ve el usuario)")
    assert.match(reports[0]!.details!, new RegExp(`^Plan ${plan().id}\\.`))
    assert.equal(plan().planNote, "Terminó: 3 pasos.")
    assert.match(reports[0]!.details!, /### Paso 1: Tipos \(sonnet, medium\)\nTipos listos[\s\S]*### Paso 3: Revisión/)
    await sleep(100)
    assert.equal(toOrq().length, 1, "la orquestadora recibe un solo lote")
  })

  it("dos reportes en el mismo turno: vale el último y avanza una sola vez", async () => {
    await approved()
    orch.report(db.getSession(w.id)!, { status: "done", summary: "uno" })
    orch.report(db.getSession(w.id)!, { status: "done", summary: "dos" })
    sessions.endTurn(w)
    await sleep(10)
    sessions.endTurn(w)
    await sleep(10)
    assert.equal(toWorker().length, 2)
    assert.equal(plan().steps[0]!.summary, "dos")
    assert.equal(plan().currentStep, 1)
  })

  it("un blocked pausa el plan y el resultado va a la cola con los pasos que faltan", async () => {
    await approved()
    await report("blocked", "Falta una decisión")
    const d = plan()
    assert.equal(d.planState, "paused")
    assert.equal(d.steps[0]!.state, "blocked")
    assert.equal(toWorker().length, 1)
    const [r] = db.listReports({ projectId })
    assert.equal(r!.status, "blocked")
    assert.match(r!.summary, /en pausa en el paso 1 de 3 \(«Tipos»\)\. Quedó bloqueado\.\nFalta una decisión/)
    assert.ok(!r!.summary.includes(d.id), "el id no va en el resumen (lo ve el usuario)")
    assert.match(r!.details!, new RegExp(`Plan ${d.id}\\.`))
    assert.equal(d.planNote, "Quedó bloqueado.")
    assert.match(r!.details!, /Faltan 2 pasos/)
    assert.match(r!.details!, /resume_plan/)
    await sleep(100)
    assert.equal(toOrq().length, 1)
  })

  it("un partial también pausa; reanudar con next sigue con el siguiente", async () => {
    await approved()
    await report("partial", "A medias")
    assert.equal(plan().planState, "paused")
    await orch.plans.resume(plan().id, "next")
    assert.equal(plan().steps[0]!.state, "skipped")
    assert.equal(plan().currentStep, 1)
    assert.match(toWorker().at(-1)!.text, /^Paso 2 de 3/)
  })

  it("reanudar con retry repite el paso que se frenó", async () => {
    await approved()
    await report("blocked", "Falta algo")
    sessions.endTurn(orq)
    await orch.plans.resume(plan().id)
    assert.equal(plan().planState, "running")
    assert.equal(plan().steps[0]!.state, "running")
    assert.match(toWorker().at(-1)!.text, /^Paso 1 de 3/)
  })

  it("un error en el turno o la sesión detenida pausan el plan y avisan enseguida", async () => {
    await approved()
    sessions.endTurn(w, { ok: false, result: "API Error" })
    assert.equal(plan().planState, "paused")
    assert.match(plan().planNote!, /dio error en el paso 1/)
    assert.equal(db.listReports({ projectId })[0]!.status, "blocked")

    // Reanuda, y esta vez la sesión se detiene.
    await orch.plans.resume(plan().id, "retry")
    sessions.setStatus(w, "stopped")
    assert.equal(plan().planState, "paused")
    assert.match(plan().planNote!, /se detuvo en el paso 1/)
    assert.equal(db.listReports({ projectId }).length, 2)
  })

  it("si interrumpís el paso, el plan se pausa sin molestar a la orquestadora", async () => {
    await approved()
    sessions.endTurn(w, { ok: false, aborted: true })
    assert.equal(plan().planState, "paused")
    assert.equal(db.listReports({ projectId }).length, 0)
  })

  it("un turno que termina sin reporte (el usuario le escribió) no mueve el plan", async () => {
    await approved()
    sessions.endTurn(w)
    await sleep(10)
    assert.equal(plan().planState, "running")
    assert.equal(plan().steps[0]!.state, "running")
    await report("done", "ok")
    assert.equal(plan().currentStep, 1)
  })

  it("si la sesión sigue ocupada al terminar el paso, el siguiente espera a que quede libre", async () => {
    await approved()
    orch.report(db.getSession(w.id)!, { status: "done", summary: "ok" })
    // Termina el turno, pero arranca enseguida otro (un mensaje tuyo que estaba en cola).
    sessions.emit("turnEnd", db.getSession(w.id)!, { ok: true, aborted: false, result: "", local: false, contextFull: false, retried: false })
    await sleep(10)
    assert.equal(toWorker().length, 1, "no se mete mientras trabaja")
    sessions.setStatus(w, "idle")
    await sleep(10)
    assert.equal(toWorker().length, 2)
  })

  it("pausar mientras corre un paso: guarda el done y no manda el siguiente hasta reanudar", async () => {
    await approved()
    orch.plans.userPause(plan().id)
    await report("done", "ok")
    assert.equal(plan().planState, "paused")
    assert.equal(plan().steps[0]!.state, "done")
    assert.equal(toWorker().length, 1)
    assert.equal(db.listReports({ projectId }).length, 0)
    await orch.plans.resume(plan().id)
    assert.match(toWorker().at(-1)!.text, /^Paso 2 de 3/)
  })

  it("cancelar saltea lo que falta; un reporte posterior va a la cola como siempre", async () => {
    await approved()
    orch.plans.cancel(plan().id, "Lo cancelaste.", "user")
    assert.equal(plan().planState, "cancelled")
    assert.deepEqual(plan().steps.map((s) => s.state), ["skipped", "skipped", "skipped"])
    await report("done", "Terminé igual")
    assert.equal(toWorker().length, 1)
    const [r] = db.listReports({ projectId })
    assert.equal(r!.summary, "Terminé igual")
  })

  it("con un plan en curso, la sesión no recibe otros prompts ni otro plan", async () => {
    await approved()
    assert.throws(() => orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P" }), /en medio del plan/)
    assert.throws(() => orch.plans.propose(orq, { session: "BACKEND", title: "Otro", steps: STEPS }), /ya tiene un plan en curso/)
  })

  it("dos planes aprobados para la misma sesión: el segundo se rechaza al aprobarlo", async () => {
    orch.plans.propose(orq, { session: "BACKEND", title: "Uno", steps: STEPS })
    orch.plans.propose(orq, { session: "BACKEND", title: "Dos", steps: STEPS })
    sessions.endTurn(orq)
    const [one, two] = db.listDrafts({ projectId, states: ["ready"] })
    await orch.sendDraft(one!.id, {})
    await assert.rejects(orch.sendDraft(two!.id, {}), /ya tiene un plan en curso/)
    assert.equal(db.getDraft(two!.id)!.state, "ready")
  })

  it("la orquestadora cambia los pasos que faltan de un plan pausado; vuelve a pasar por el usuario", async () => {
    await approved()
    await report("done", "Tipos ok")
    await report("blocked", "Sonnet no pudo")
    await sleep(100) // el resultado le llega a la orquestadora
    assert.throws(() => orch.updateProposal(orq, { id: plan().id, title: "x" }), /Pasá steps/)
    const reply = orch.updateProposal(orq, {
      id: plan().id,
      steps: [
        { title: "Tests otra vez", prompt: "Escribí los tests con cuidado", model: "opus", effort: "high" },
        { title: "Revisión", prompt: "Revisá" },
      ],
    })
    assert.match(reply, /sigue desde el paso 2/)
    const rev = db.listDrafts({ projectId }).find((d) => d.revises)!
    assert.equal(rev.state, "staged")
    assert.equal(rev.steps.length, 3)
    assert.equal(rev.steps[0]!.state, "done")
    // Una segunda vuelta actualiza la misma propuesta de cambio.
    orch.updateProposal(orq, { id: plan().id, steps: [{ title: "Tests otra vez", prompt: "Escribí los tests", model: "opus", effort: "high" }] })
    assert.equal(db.listDrafts({ projectId }).filter((d) => d.revises).length, 1)
    sessions.endTurn(orq)
    assert.equal(plan().planState, "paused", "hasta que el usuario lo apruebe, sigue pausado")
    await orch.sendDraft(rev.id, {})
    const d = plan()
    assert.equal(d.planState, "running")
    assert.equal(d.steps.length, 2)
    assert.equal(d.steps[0]!.summary, "Tipos ok")
    assert.equal(d.steps[1]!.state, "running")
    assert.equal(d.steps[1]!.model, "opus")
    assert.equal(db.getSession(w.id)!.model, "opus")
    assert.equal(db.getDraft(rev.id)!.state, "sent")
  })

  it("en AFK, el plan y sus cambios salen solos", async () => {
    db.updateProject(projectId, { settings: { ...defaultSettings, batchWindowSec: 0.05 }, afk: { since: Date.now(), until: null, budgetUsd: null, spentAtStart: 0 } })
    orch.plans.propose(orq, { session: "BACKEND", title: "Auto", steps: STEPS })
    sessions.endTurn(orq)
    await sleep(10)
    assert.equal(plan().planState, "running")
    await report("blocked", "No")
    await sleep(100)
    orch.updateProposal(orq, { id: plan().id, steps: [{ title: "Otra", prompt: "Otra", model: "opus" }] })
    sessions.endTurn(orq)
    await sleep(10)
    assert.equal(plan().planState, "running")
    assert.equal(plan().steps[0]!.title, "Otra")
  })

  it("el usuario cambia los pasos al aprobar, y los que faltan con el plan pausado", async () => {
    orch.plans.propose(orq, { session: "BACKEND", title: "Modelos", steps: STEPS })
    sessions.endTurn(orq)
    await assert.rejects(orch.sendDraft(plan().id, { steps: [{ title: "a", prompt: "a", model: "haiku", effort: "low" }] }), /Haiku 5\.5 no tiene niveles/)
    const sent = await orch.sendDraft(plan().id, { steps: [{ title: "Único", prompt: "Hacé todo", model: "sonnet" }, { title: "Fin", prompt: "Cerrá" }] })
    assert.equal(sent.edited, true)
    assert.equal(sent.steps.length, 2)
    orch.plans.userPause(plan().id)
    await report("done", "ok")
    const done = plan().steps[0]!
    const edited = orch.editDraft(plan().id, { steps: [{ ...done, title: "No se toca" }, { title: "Fin distinto", prompt: "Cerrá distinto", model: "haiku" }] })
    assert.equal(edited.steps.length, 2)
    assert.equal(edited.steps[0]!.state, "done")
    assert.equal(edited.steps[0]!.title, "Único")
    assert.equal(edited.steps[1]!.title, "Fin distinto")
  })

  it("un plan para una sesión nueva la crea con el modelo del primer paso", async () => {
    orch.plans.propose(orq, { newSession: { name: "docs", role: "Docs" }, title: "Docs", steps: [{ title: "a", prompt: "Escribí", model: "haiku" }] })
    sessions.endTurn(orq)
    await orch.sendDraft(plan().id, {})
    const created = db.listSessions().find((s) => s.name === "DOCS")!
    assert.equal(created.model, "haiku")
    assert.equal(plan().targetSessionId, created.id)
    assert.equal(sessions.sent.at(-1)!.id, created.id)
  })

  it("si no sale el primer paso, la propuesta vuelve a quedar para aprobar", async () => {
    orch.plans.propose(orq, { session: "BACKEND", title: "Modelos", steps: STEPS })
    sessions.endTurn(orq)
    sessions.failNextSend = true
    await assert.rejects(orch.sendDraft(plan().id, {}), /se cerró/)
    assert.equal(plan().state, "ready")
    assert.equal(plan().planState, null)
  })

  it("archivar la sesión cancela su plan", async () => {
    await approved()
    sessions.emit("archiving", w.id)
    sessions.setStatus(w, "stopped")
    assert.equal(plan().planState, "cancelled")
    assert.equal(db.listReports({ projectId }).length, 0)
  })

  it("apagar el server no pausa los planes", async () => {
    await approved()
    orch.dispose()
    sessions.setStatus(w, "stopped")
    assert.equal(plan().planState, "running")
  })

  it("sobrevive a un reinicio: el paso en curso sigue esperando su reporte, y un done sin seguir avanza", async () => {
    await approved()
    // Se reinicia el server en medio del paso 1.
    orch.dispose()
    sessions.removeAllListeners()
    orch = newOrchestration()
    orch.plans.graceMs = 1
    orch.plans.recover()
    assert.equal(toWorker().length, 1)
    await report("done", "ok después del reinicio")
    assert.equal(plan().currentStep, 1)
    assert.equal(toWorker().length, 2)

    // Reportó done y se cortó antes de mandar el siguiente.
    orch.report(db.getSession(w.id)!, { status: "done", summary: "tests" })
    orch.dispose()
    sessions.removeAllListeners()
    sessions.statuses.set(w.id, "stopped")
    orch = newOrchestration()
    orch.plans.graceMs = 1
    orch.plans.recover()
    await sleep(10)
    assert.equal(plan().currentStep, 2)
    assert.match(toWorker().at(-1)!.text, /^Paso 3 de 3/)
  })

  it("list_proposals y list_sessions muestran los planes", async () => {
    orch.plans.propose(orq, { session: "BACKEND", title: "Modelos", steps: STEPS })
    assert.match(orch.listProposals(projectId), /plan de 3 pasos → BACKEND: "Modelos"[\s\S]*2\. Tests \(modelo haiku, de cero\)/)
    sessions.endTurn(orq)
    await orch.sendDraft(plan().id, {})
    assert.match(orch.listProposals(projectId), /Planes aprobados que siguen[\s\S]*en curso, paso 1 de 3[\s\S]*1\. Tipos \(modelo sonnet, esfuerzo medium\) \[en curso\]/)
    assert.match(orch.plans.sessionLine(w.id)!, /«Modelos»: paso 1 de 3/)
  })

  it("después de un error, reanudar repite el paso y una revisión lo puede cambiar", async () => {
    await approved()
    sessions.endTurn(w, { ok: false, result: "API Error" })
    assert.equal(plan().steps[0]!.state, "blocked")
    await orch.plans.resume(plan().id)
    assert.equal(toWorker().length, 2, "retry manda el paso otra vez")
    sessions.endTurn(w, { ok: false, local: true, result: "falló antes de responder" })
    assert.equal(plan().planState, "paused", "un error antes de la primera respuesta también cuenta")
    await sleep(100)
    sessions.endTurn(orq)
    orch.updateProposal(orq, { id: plan().id, steps: [{ title: "Tipos con Opus", prompt: "Sumá los tipos", model: "opus" }] })
    sessions.endTurn(orq)
    await orch.sendDraft(db.listDrafts({ projectId, states: ["ready"] })[0]!.id, {})
    assert.equal(plan().steps.length, 1)
    assert.equal(plan().steps[0]!.title, "Tipos con Opus")
    assert.equal(plan().steps[0]!.state, "running")
  })

  it("con el plan ya pausado, otro error o detenerla no manda otro resultado; un done posterior va a la cola", async () => {
    await approved()
    sessions.endTurn(w, { ok: false, result: "x" })
    sessions.setStatus(w, "stopped")
    sessions.endTurn(w, { ok: false, result: "y" })
    assert.equal(db.listReports({ projectId }).length, 1)
    // El usuario le pide que siga y termina: llega como un resultado común.
    orch.report(db.getSession(w.id)!, { status: "done", summary: "Lo terminé" })
    assert.equal(db.listReports({ projectId }).length, 2)
    assert.equal(plan().planState, "paused")
  })

  it("reportó blocked y el server se cortó antes del fin del turno: al arrancar se pausa y avisa", async () => {
    await approved()
    orch.report(db.getSession(w.id)!, { status: "blocked", summary: "No sé" })
    orch.dispose()
    sessions.removeAllListeners()
    orch = newOrchestration()
    orch.plans.graceMs = 1
    orch.plans.recover()
    assert.equal(plan().planState, "paused")
    assert.equal(db.listReports({ projectId }).length, 1)
  })

  it("reinicio sin retomar la sesión con un paso en curso: queda pausado y reanudarlo lo repite", async () => {
    await approved()
    orch.dispose()
    sessions.removeAllListeners()
    sessions.statuses.set(w.id, "stopped")
    orch = newOrchestration()
    orch.plans.graceMs = 1
    orch.plans.recover()
    assert.equal(plan().planState, "paused")
    assert.match(plan().planNote!, /se reinició/)
    await orch.plans.resume(plan().id)
    assert.equal(toWorker().length, 2)
  })

  it("aprobar con el worker ocupado: el primer paso espera, y el reporte de lo anterior va a la cola", async () => {
    sessions.statuses.set(w.id, "working")
    await approved()
    assert.equal(toWorker().length, 0)
    assert.equal(plan().steps[0]!.state, "pending")
    await report("done", "La tarea de antes")
    assert.equal(db.listReports({ projectId }).length, 1, "no se la come el plan")
    assert.equal(toWorker().length, 1)
    assert.equal(plan().steps[0]!.state, "running")
  })

  it("un mensaje tuyo en cola cuando termina el paso: el siguiente espera", async () => {
    await approved()
    orch.plans.graceMs = 30
    orch.report(db.getSession(w.id)!, { status: "done", summary: "ok" })
    sessions.endTurn(w)
    // Claude Code agarra tu mensaje enseguida: vuelve a trabajar.
    sessions.setStatus(w, "working")
    await sleep(60)
    assert.equal(toWorker().length, 1)
    sessions.endTurn(w)
    await sleep(60)
    await sleep(10)
    assert.equal(toWorker().length, 2)
  })

  it("un turno tuyo interrumpido mientras el paso esperaba no pausa el paso que sale", async () => {
    await approved()
    orch.plans.graceMs = 30
    orch.report(db.getSession(w.id)!, { status: "done", summary: "ok" })
    sessions.endTurn(w)
    sessions.setStatus(w, "working")
    sessions.endTurn(w, { ok: false, aborted: true })
    await sleep(60)
    await sleep(10)
    assert.equal(plan().planState, "running")
    assert.equal(plan().steps[1]!.state, "running")
  })

  it("cancelar después del done y antes del fin del turno: ese resultado va a la cola", async () => {
    await approved()
    orch.report(db.getSession(w.id)!, { status: "done", summary: "Tipos listos" })
    orch.plans.cancel(plan().id, "Ya no", "orchestrator")
    sessions.endTurn(w)
    await sleep(10)
    const [r] = db.listReports({ projectId })
    assert.equal(r!.summary, "Tipos listos")
    assert.equal(r!.taskTitle, "Modelos · Tipos")
    assert.equal(toWorker().length, 1)
  })

  it("dos aprobaciones a la vez de un plan para una sesión nueva crean una sola", async () => {
    orch.plans.propose(orq, { newSession: { name: "docs", role: "" }, title: "Docs", steps: [{ title: "a", prompt: "a" }] })
    sessions.endTurn(orq)
    const id = plan().id
    const results = await Promise.allSettled([orch.sendDraft(id, {}), orch.sendDraft(id, {})])
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
    assert.equal(db.listSessions().filter((s) => s.name === "DOCS").length, 1)
  })

  it("una revisión armada con el paso corriendo, que después se frenó, lo repite antes de los nuevos", async () => {
    await approved()
    orch.plans.userPause(plan().id)
    orch.updateProposal(orq, { id: plan().id, steps: [{ title: "Nuevo", prompt: "Nuevo" }] })
    await report("blocked", "No pude")
    assert.equal(db.listReports({ projectId }).length, 1, "lo que reporta el worker llega aunque estuviera pausado")
    await sleep(100)
    sessions.endTurn(orq)
    const rev = db.listDrafts({ projectId, states: ["ready"] }).find((d) => d.revises)!
    await orch.sendDraft(rev.id, {})
    assert.deepEqual(plan().steps.map((s) => s.title), ["Tipos", "Nuevo"])
    assert.equal(plan().steps[0]!.state, "running")
  })
})
