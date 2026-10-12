import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import Fastify from "fastify"

import { Db, defaultSettings, type ProjectMessageRow, type SessionRecord } from "../src/db.ts"
import type { Hub } from "../src/hub.ts"
import { registerMcp } from "../src/mcp.ts"
import { Orchestration } from "../src/orchestration.ts"
import type { SessionManager } from "../src/sessions.ts"
import type { ServerMessage, TimelineEvent } from "../src/shared/types.ts"

const msg = (id: string, from: string, to: string, createdAt: number, extra: Partial<ProjectMessageRow> = {}): ProjectMessageRow => ({
  id,
  fromProjectId: from,
  toProjectId: to,
  fromSessionId: `s_${from}`,
  toSessionId: null,
  text: `texto ${id}`,
  replyTo: null,
  createdAt,
  deliveredAt: null,
  ...extra,
})

describe("mensajes entre proyectos: la base", () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-pm-"))
    db = new Db(path.join(dir, "t.db"))
    for (const id of ["a", "b", "c"])
      db.insertProject({ id, name: id.toUpperCase(), repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("guarda, entrega, devuelve a la cola y cuenta por ventana", () => {
    db.insertProjectMessage(msg("m_1", "a", "b", 100))
    db.insertProjectMessage(msg("m_2", "a", "b", 200, { replyTo: "m_0" }))
    db.insertProjectMessage(msg("m_3", "b", "a", 300))
    assert.deepEqual(db.listQueuedProjectMessages("b").map((m) => m.id), ["m_1", "m_2"])
    assert.equal(db.getProjectMessage("m_2")!.replyTo, "m_0")

    db.markProjectMessagesDelivered(["m_1"], "s_orch_b", 400)
    assert.deepEqual(db.listQueuedProjectMessages("b").map((m) => m.id), ["m_2"])
    assert.equal(db.getProjectMessage("m_1")!.toSessionId, "s_orch_b")
    assert.equal(db.getProjectMessage("m_1")!.deliveredAt, 400)
    db.requeueProjectMessages(["m_1"])
    assert.deepEqual(db.listQueuedProjectMessages("b").map((m) => m.id), ["m_1", "m_2"])

    assert.equal(db.countProjectMessagesSince("a", "b", 0), 2)
    assert.equal(db.countProjectMessagesSince("a", "b", 150), 1, "solo cuenta lo que entra en la ventana")
    assert.equal(db.countProjectMessagesSince("b", "a", 0), 1, "cada sentido cuenta aparte")
    assert.equal(db.countProjectMessagesSince("a", "c", 0), 0)
  })

  it("los de un proyecto, enviados y recibidos, más nuevos primero", () => {
    db.insertProjectMessage(msg("m_1", "a", "b", 100))
    db.insertProjectMessage(msg("m_2", "b", "a", 200))
    db.insertProjectMessage(msg("m_3", "b", "c", 300))
    assert.deepEqual(db.listProjectMessages("a").map((m) => m.id), ["m_2", "m_1"])
    assert.deepEqual(db.listProjectMessages("b").map((m) => m.id), ["m_3", "m_2", "m_1"])
    assert.deepEqual(db.listProjectMessages("b", 2).map((m) => m.id), ["m_3", "m_2"])
  })

  it("borrar un proyecto borra los mensajes que mandó y los que recibió, y deja los de los otros", () => {
    db.insertProjectMessage(msg("m_1", "a", "b", 100))
    db.insertProjectMessage(msg("m_2", "b", "a", 200))
    db.insertProjectMessage(msg("m_3", "b", "c", 300))
    db.purgeProject("a")
    assert.equal(db.getProjectMessage("m_1"), null)
    assert.equal(db.getProjectMessage("m_2"), null)
    assert.ok(db.getProjectMessage("m_3"))
  })
})

function rec(projectId: string, name: string, kind: "worker" | "orchestrator"): SessionRecord {
  return {
    id: `s_${name.toLowerCase()}`, projectId, kind, name, role: "", claudeSessionId: `c-${name}`, startedOnce: true,
    mcpToken: `tok-${name}`, model: null, effort: null, worktree: false, cwd: "/tmp", status: "idle", taskTitle: null, taskState: "none",
    lastActivity: null, lastActivityAt: null, costUsd: 0, costByModel: {}, tokens: null, context: null, createdAt: 1, archivedAt: null,
  }
}

describe("mensajes entre proyectos: las herramientas MCP", () => {
  let dir: string
  let db: Db
  let app: ReturnType<typeof Fastify>
  let orchestration: Orchestration
  const events: { id: string; event: TimelineEvent }[] = []
  const orqA = rec("pa", "ORQ-A", "orchestrator")
  const wA = rec("pa", "W-A", "worker")
  const orqB = rec("pb", "ORQ-B", "orchestrator")

  async function rpc(who: SessionRecord, method: string, params: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/mcp/${who.mcpToken}`,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    })
    return JSON.parse(res.body) as { result?: any; error?: unknown }
  }
  const call = async (who: SessionRecord, name: string, args: Record<string, unknown> = {}) => {
    const body = await rpc(who, "tools/call", { name, arguments: args })
    return { text: body.result.content.map((c: { text: string }) => c.text).join("\n") as string, isError: Boolean(body.result.isError) }
  }
  const toolNames = async (who: SessionRecord) => ((await rpc(who, "tools/list")).result.tools as { name: string }[]).map((t) => t.name)

  beforeEach(async () => {
    events.length = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-pm-mcp-"))
    db = new Db(path.join(dir, "t.db"))
    for (const [id, name] of [["pa", "Alfa"], ["pb", "Beta"], ["pc", "Gamma"]])
      db.insertProject({ id: id!, name: name!, repoPath: dir, settings: { ...defaultSettings, batchWindowSec: 60 }, accountId: null, createdAt: 1, archivedAt: null })
    for (const s of [orqA, wA, orqB]) db.insertSession(s)
    const sessions = Object.assign(new (await import("node:events")).EventEmitter(), {
      addEvent: (id: string, event: TimelineEvent) => events.push({ id, event }),
      statusOf: () => "idle",
      contextOf: () => null,
      meta: { models: [] },
    }) as unknown as SessionManager
    const hub = { broadcast: (_m: ServerMessage) => {}, size: 1 } as unknown as Hub
    orchestration = new Orchestration(db, hub, sessions)
    app = Fastify()
    registerMcp(app, { db, sessions, orchestration })
    await app.ready()
  })
  afterEach(async () => {
    orchestration.dispose()
    await app.close()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("list_projects y message_project las tiene la orquestadora y no los workers", async () => {
    const orq = await toolNames(orqA)
    assert.ok(orq.includes("list_projects") && orq.includes("message_project"))
    const worker = await toolNames(wA)
    assert.ok(!worker.includes("list_projects") && !worker.includes("message_project"))
    // Y aunque un worker las llame a mano, no existen para él.
    const res = await rpc(wA, "tools/call", { name: "message_project", arguments: { project: "Beta", message: "hola" } })
    assert.ok(res.result?.isError || res.error, "falla")
  })

  it("message_project devuelve el id del mensaje y los errores en palabras", async () => {
    const ok = await call(orqA, "message_project", { project: "Beta", message: "hola" })
    assert.equal(ok.isError, false)
    const id = db.listProjectMessages("pa")[0]!.id
    assert.ok(ok.text.includes(id))
    for (const [project, re] of [["Nada", /No existe el proyecto/], ["Alfa", /propio proyecto/], ["Gamma", /no tiene orquestadora/]] as const) {
      const r = await call(orqA, "message_project", { project, message: "hola" })
      assert.ok(r.isError && re.test(r.text), `${project}: ${r.text}`)
    }
    const l = await call(orqA, "list_projects")
    assert.match(l.text, /Beta \[pb\]/)
  })

  it("resume_plan y cancel_plan no tocan los planes de otro proyecto", async () => {
    orchestration.plans.propose(orqB, { newSession: { name: "W-B", role: "r" }, title: "Plan de Beta", steps: [{ title: "uno", prompt: "hacé algo" }] })
    const plan = db.listDrafts({ projectId: "pb" }).find((d) => d.kind === "plan")!
    db.updateDraft(plan.id, { state: "sent", planState: "paused" })
    for (const tool of ["resume_plan", "cancel_plan"]) {
      const r = await call(orqA, tool, { id: plan.id })
      assert.ok(r.isError && r.text === `No existe el plan ${plan.id}.`, `${tool}: ${r.text}`)
    }
    assert.equal(db.getDraft(plan.id)!.planState, "paused")
    const own = await call(orqB, "cancel_plan", { id: plan.id })
    assert.equal(own.isError, false, own.text)
    assert.equal(db.getDraft(plan.id)!.planState, "cancelled")
  })
})
