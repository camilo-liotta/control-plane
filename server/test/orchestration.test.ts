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
import type { ModelOption, ServerMessage, SessionStatus, TimelineEvent } from "../src/shared/types.ts"

/** Lo que devuelve el initialize de Claude Code, recortado. */
const CATALOG: ModelOption[] = [
  { value: "default", label: "Default (recommended)", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], resolved: "claude-opus-5-5" },
  { value: "sonnet", label: "Sonnet 5.5", efforts: ["low", "medium", "high"], resolved: "claude-sonnet-5-5" },
  { value: "haiku", label: "Haiku 5.5", efforts: [], resolved: "claude-haiku-5-5" },
]

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
  /** En qué orden pasaron las cosas: clear, model:x, effort:y, send. */
  log: string[] = []
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
    this.log.push("send")
    this.sent.push({ id, text, opts })
    this.statuses.set(id, "working")
    return { id: this.sent.length, sessionId: id, ts: Date.now(), event: opts.event ?? { kind: "notice", level: "info", text } }
  }
  update(id: string, patch: Partial<SessionRecord>) {
    this.db.updateSession(id, patch)
  }
  cleared: string[] = []
  async clearConversation(id: string) {
    this.cleared.push(id)
    this.log.push("clear")
    this.sent.push({ id, text: "/clear", opts: { origin: "control" } })
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
  create(input: Partial<SessionRecord> & { projectId: string; kind: "worker"; name: string; role: string; cwd: string }) {
    const rec = { ...session(input.projectId, input.name, "worker"), model: input.model ?? null, effort: input.effort ?? null }
    this.db.insertSession(rec)
    return rec
  }
  /** Simula que la orquestadora terminó su turno. */
  endTurn(rec: SessionRecord, ok = true, local = false) {
    this.statuses.set(rec.id, "idle")
    this.emit("turnEnd", rec, { ok, aborted: !ok, result: "", local })
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
    costUsd: 0, costByModel: {},
    tokens: null,
    context: null,
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

  it("el aviso de propuestas listas lleva al chat de la orquestadora, a las propuestas", () => {
    orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P" })
    sessions.endTurn(orq)
    const toast = hub.messages.find((m) => m.type === "toast" && m.event === "proposals")
    assert.ok(toast && toast.type === "toast")
    assert.deepEqual([toast.projectId, toast.sessionId, toast.open], [projectId, orq.id, "proposals"])
  })

  it("si no puede entregarle la cola, el aviso lleva al chat de la orquestadora", async () => {
    sessions.send = async () => {
      throw new Error("La sesión está detenida")
    }
    orch.report(a, { status: "done", summary: "Listo" })
    await sleep(400)
    const toast = hub.messages.find((m) => m.type === "toast" && m.event === "error")
    assert.ok(toast && toast.type === "toast")
    assert.deepEqual([toast.projectId, toast.sessionId, toast.open], [projectId, orq.id, undefined])
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

  it("una propuesta que empieza de cero limpia la sesión antes del prompt, y se puede sacar al aprobar", async () => {
    const reply = orch.proposePrompt(orq, { session: "BACKEND", title: "Otra cosa", prompt: "Hacé X desde cero", fresh: true })
    assert.match(reply, /empieza de cero/)
    orch.proposePrompt(orq, { session: "BACKEND", title: "Sigue", prompt: "Seguí con Y", fresh: true })
    sessions.endTurn(orq)
    const [first, second] = db.listDrafts({ projectId, states: ["ready"] })
    assert.equal(first!.fresh, true)
    await orch.sendDraft(first!.id, {})
    assert.deepEqual(sessions.sent.slice(-2).map((m) => m.text), ["/clear", "Hacé X desde cero"])
    // Al aprobar se lo podés sacar: va sin /clear y cuenta como editada.
    const before = sessions.cleared.length
    const sent = await orch.sendDraft(second!.id, { fresh: false })
    assert.equal(sessions.cleared.length, before)
    assert.equal(sent.fresh, false)
    assert.equal(sent.edited, true)
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

  it("un comando local (/compact) no cierra ni reanuda una revisión en pausa", async () => {
    orch.report(a, { status: "done", summary: "A" })
    await sleep(400)
    orch.proposePrompt(orq, { session: "FRONTEND", title: "T", prompt: "P" })
    sessions.endTurn(orq, false)
    assert.equal(orch.reviewState(projectId).paused, true)
    // Compactar a la orquestadora termina un turno sin respuesta del modelo.
    sessions.endTurn(orq, true, true)
    assert.equal(db.listDrafts({ projectId, states: ["staged"] }).length, 1, "la propuesta sigue bloqueada")
    assert.equal(db.listReports({ projectId, states: ["in_review"] }).length, 1, "el resultado sigue en revisión")
    assert.equal(orch.reviewState(projectId).paused, true)
    // Cuando retoma y termina de verdad, se cierra.
    sessions.endTurn(orq)
    assert.equal(db.listDrafts({ projectId, states: ["ready"] }).length, 1)
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

  it("valida el modelo y el esfuerzo contra el catálogo, con las opciones en el error", () => {
    assert.throws(() => orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", model: "gpt" }), /No existe el modelo "gpt"\. Modelos: opus \(Opus 5\.5: low/)
    assert.throws(() => orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", model: "sonnet", effort: "max" }), /Sonnet 5\.5 no tiene esfuerzo "max"\. Esfuerzos: low, medium, high/)
    assert.throws(() => orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", model: "haiku", effort: "low" }), /Haiku 5\.5 no tiene niveles de esfuerzo/)
    assert.throws(() => orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", effort: "turbo" }), /no existe/)
    // El id completo vale y queda como lo conoce el catálogo.
    const reply = orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", model: "claude-sonnet-5-5", effort: "Medium" })
    assert.match(reply, /con Sonnet 5\.5 · esfuerzo medio/)
    const [d] = db.listDrafts({ projectId })
    assert.equal(d!.model, "sonnet")
    assert.equal(d!.effort, "medium")
    // Solo el esfuerzo: se valida contra el modelo que ya tiene la sesión.
    db.updateSession(a.id, { model: "sonnet" })
    assert.throws(() => orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", effort: "xhigh" }), /Sonnet 5\.5 no tiene esfuerzo/)
  })

  it("al enviar: primero de cero, después el modelo y el esfuerzo, y al final el prompt", async () => {
    orch.proposePrompt(orq, { session: "BACKEND", title: "Tests", prompt: "Escribí los tests", fresh: true, model: "sonnet", effort: "medium" })
    sessions.endTurn(orq)
    const [ready] = db.listDrafts({ projectId, states: ["ready"] })
    await orch.sendDraft(ready!.id, {})
    assert.deepEqual(sessions.log, ["clear", "model:sonnet", "effort:medium", "send"])
    assert.equal(db.getSession(a.id)!.model, "sonnet")
    const notice = sessions.events.find((e) => e.id === a.id && e.event.kind === "notice")
    assert.deepEqual(notice?.event, { kind: "notice", level: "info", text: "Modelo: Sonnet 5.5 · esfuerzo medio, para «Tests»" })
    // Lo que vuelve a la orquestadora dice con qué salió.
    sessions.endTurn(orq)
    orch.report(a, { status: "done", summary: "ok" })
    await sleep(400)
    assert.match(sessions.sent.at(-1)!.text, /Aprobó d_\w+ → BACKEND \(empezando de cero\), con Sonnet 5\.5 · esfuerzo medio: "Tests"/)
  })

  it("sin modelo ni esfuerzo, la sesión sigue con lo que tiene y no hay aviso", async () => {
    db.updateSession(a.id, { model: "opus", effort: "high" })
    orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P" })
    sessions.endTurn(orq)
    await orch.sendDraft(db.listDrafts({ projectId, states: ["ready"] })[0]!.id, {})
    assert.deepEqual(sessions.log, ["send"])
    assert.equal(sessions.events.length, 0)
    assert.equal(db.getSession(a.id)!.model, "opus")
  })

  it("el usuario puede cambiar el modelo y el esfuerzo al aprobar", async () => {
    orch.proposePrompt(orq, { session: "BACKEND", title: "Refactor", prompt: "P", model: "sonnet", effort: "medium" })
    sessions.endTurn(orq)
    const [ready] = db.listDrafts({ projectId, states: ["ready"] })
    assert.throws(() => orch.editDraft(ready!.id, { effort: "max" }), /Sonnet 5\.5 no tiene esfuerzo "max"/)
    const edited = orch.editDraft(ready!.id, { model: "opus" })
    assert.equal(edited.model, "opus")
    assert.equal(edited.effort, "medium")
    const sent = await orch.sendDraft(ready!.id, { effort: "max" })
    assert.equal(sent.edited, true)
    assert.equal(sent.effort, "max")
    assert.deepEqual(sessions.log, ["model:opus", "effort:max", "send"])
    sessions.endTurn(orq)
    orch.report(a, { status: "done", summary: "ok" })
    await sleep(400)
    assert.match(sessions.sent.at(-1)!.text, /Aprobó con cambios d_\w+ → BACKEND, con Opus 5\.5 · esfuerzo máximo/)
  })

  it("update_proposal cambia o saca el modelo", () => {
    orch.proposePrompt(orq, { session: "BACKEND", title: "T", prompt: "P", model: "haiku" })
    const [d] = db.listDrafts({ projectId })
    assert.throws(() => orch.updateProposal(orq, { id: d!.id, effort: "low" }), /Haiku 5\.5 no tiene niveles/)
    orch.updateProposal(orq, { id: d!.id, model: "sonnet", effort: "high" })
    assert.equal(db.getDraft(d!.id)!.model, "sonnet")
    orch.updateProposal(orq, { id: d!.id, model: null, effort: null })
    assert.equal(db.getDraft(d!.id)!.model, null)
    assert.match(orch.listProposals(projectId), /T"/)
    orch.updateProposal(orq, { id: d!.id, model: "opus", effort: "xhigh" })
    assert.match(orch.listProposals(projectId), /modelo opus, esfuerzo xhigh/)
  })

  it("una sesión nueva arranca con el modelo de la propuesta", async () => {
    orch.proposeSession(orq, { name: "docs", role: "Docs", title: "Docs", prompt: "Escribí", model: "haiku" })
    sessions.endTurn(orq)
    await orch.sendDraft(db.listDrafts({ projectId, states: ["ready"] })[0]!.id, {})
    assert.equal(db.listSessions().find((s) => s.name === "DOCS")!.model, "haiku")
  })

  it("el modelo de los workers vale para los que no tienen uno propio, no para la orquestadora", () => {
    db.updateProject(projectId, { settings: { ...defaultSettings, defaultModel: "opus", workerModel: "sonnet", workerEffort: "medium" } })
    assert.equal(orch.effectiveModel(a), "sonnet")
    assert.equal(orch.effectiveEffort(a), "medium")
    assert.equal(orch.effectiveModel(orq), "opus")
    assert.equal(orch.effectiveModel({ ...a, model: "haiku" }), "haiku")
    db.updateProject(projectId, { settings: { ...defaultSettings, defaultModel: "opus" } })
    assert.equal(orch.effectiveModel(a), "opus")
  })
})
