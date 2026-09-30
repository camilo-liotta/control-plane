import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { Schedules } from "../src/schedule.ts"
import { SessionManager } from "../src/sessions.ts"
import { CANCEL_GRACE_MS, cancelMessage, cancelState } from "../src/shared/cancel-scheduled.ts"
import type { StoredEvent, TimelineEvent } from "../src/shared/types.ts"
import { writeFakeClaude } from "./fake-claude.ts"

describe("el pedido de cancelar lo programado", () => {
  it("arma un mensaje corto según qué hay que cancelar, y dice que lo pidió el usuario desde el panel", () => {
    const cron = cancelMessage({ kind: "cron", id: "a1b2c3d4", when: "todos los días a las 9:00" })
    assert.equal(cron, 'Pedido del usuario desde el panel "Programado": cancelá la tarea programada `a1b2c3d4` (todos los días a las 9:00) con CronDelete.')
    assert.equal(
      cancelMessage({ kind: "wakeup", id: "toolu_1", when: "vuelve a las 14:30" }),
      'Pedido del usuario desde el panel "Programado": cortá el /loop con ScheduleWakeup y stop: true.'
    )
    const routine = cancelMessage({ kind: "routine", id: "trig_01X", when: "los lunes a las 12:00 (en la nube)" })
    assert.match(routine, /desactivá o borrá la rutina en la nube `trig_01X`.*con RemoteTrigger\. Si no tenés esa herramienta, avisame\.$/)
  })

  it("queda pedido hasta que se cancela; si la sesión termina su turno sin hacerlo, al rato avisa", () => {
    const t = 1_000_000
    const active = { status: "active" as const }
    assert.equal(cancelState(null, active, "idle", t), "none")
    const req = { requestedAt: t, lastTurnEndAt: null }
    assert.equal(cancelState(req, active, "working", t + 5000), "pending")
    assert.equal(cancelState(req, active, "idle", t + 10 * CANCEL_GRACE_MS), "pending", "sin fin de turno todavía no se sabe")
    const ended = { requestedAt: t, lastTurnEndAt: t + 2000 }
    assert.equal(cancelState(ended, active, "idle", t + 2000 + CANCEL_GRACE_MS - 1), "pending")
    assert.equal(cancelState(ended, active, "idle", t + 2000 + CANCEL_GRACE_MS), "failed")
    assert.equal(cancelState(ended, active, "stopped", t + 2000 + CANCEL_GRACE_MS), "failed")
    assert.equal(cancelState(ended, active, "working", t + 2000 + CANCEL_GRACE_MS), "pending", "si volvió a trabajar, sigue esperando")
    assert.equal(cancelState(ended, active, "needs_input", t + 2000 + CANCEL_GRACE_MS), "pending", "si te está preguntando algo, también")
    assert.equal(cancelState(ended, { status: "cancelled" }, "idle", t + 2000 + CANCEL_GRACE_MS), "none", "se canceló: no hay nada que mostrar")
  })
})

describe("los pedidos en lo programado de la sesión", () => {
  const t0 = new Date(2026, 8, 29, 14, 0).getTime()
  const opts = { claudeSessionId: "c1", dirs: [], running: true, runtimeStartedAt: t0 - 1 }

  function setup() {
    const events: StoredEvent[] = []
    let id = 0
    let now = t0
    const s = new Schedules({ load: () => events, now: () => now })
    const add = (ts: number, event: TimelineEvent) => {
      const e = { id: ++id, sessionId: "s1", ts, event }
      events.push(e)
      return s.observe(e)
    }
    const create = (useId: string, jobId: string) => {
      add(t0, { kind: "tool_use", id: useId, name: "CronCreate", input: { cron: "0 9 * * *", prompt: "p", recurring: true }, parent: null })
      add(t0, { kind: "tool_result", toolUseId: useId, content: `Scheduled recurring job ${jobId}.`, isError: false, parent: null, structured: { id: jobId, recurring: true, durable: false } })
    }
    const turnEnd = (ts: number) => add(ts, { kind: "turn_end", ok: true, subtype: "success", durationMs: 1, costUsd: 0 })
    return { s, add, create, turnEnd, setNow: (n: number) => (now = n) }
  }

  it("el pedido se ve hasta el CronDelete, y ahí se limpia solo", () => {
    const { s, add, create, turnEnd, setNow } = setup()
    create("u1", "aaaa1111")
    setNow(t0 + 1000)
    s.requestCancel("s1", "aaaa1111")
    let [item] = s.list("s1", opts)
    assert.deepEqual(item!.cancelRequest, { requestedAt: t0 + 1000, lastTurnEndAt: null })
    assert.equal(turnEnd(t0 + 500), false, "un turno que terminó antes del pedido no cuenta")
    add(t0 + 2000, { kind: "tool_use", id: "u2", name: "CronDelete", input: { id: "aaaa1111" }, parent: null })
    add(t0 + 2000, { kind: "tool_result", toolUseId: "u2", content: "Cancelled job aaaa1111.", isError: false, parent: null, structured: { id: "aaaa1111" } })
    assert.equal(turnEnd(t0 + 3000), true)
    ;[item] = s.list("s1", opts)
    assert.equal(item!.status, "cancelled")
    assert.equal(item!.cancelRequest, null)
  })

  it("si la sesión termina el turno sin cancelarla, el pedido lleva ese fin de turno (y la web avisa al rato)", () => {
    const { s, create, turnEnd, setNow } = setup()
    create("u1", "bbbb2222")
    setNow(t0 + 1000)
    s.requestCancel("s1", "bbbb2222")
    assert.equal(turnEnd(t0 + 4000), true)
    const [item] = s.list("s1", opts)
    assert.equal(item!.status, "active")
    assert.equal(item!.cancelRequest!.lastTurnEndAt, t0 + 4000)
    assert.equal(cancelState(item!.cancelRequest, item!, "idle", t0 + 4000 + CANCEL_GRACE_MS), "failed")
  })

  it("apagar o borrar una rutina con RemoteTrigger la da por cancelada", () => {
    const { s, add } = setup()
    add(t0, { kind: "tool_use", id: "r1", name: "RemoteTrigger", input: { action: "create", body: { name: "Informe", cron_expression: "0 12 * * 1" } }, parent: null })
    add(t0, { kind: "tool_result", toolUseId: "r1", content: 'HTTP 200\n{"trigger":{"id":"trig_1"}}', isError: false, parent: null })
    add(t0, { kind: "tool_use", id: "r2", name: "RemoteTrigger", input: { action: "update", trigger_id: "trig_1", body: { enabled: false } }, parent: null })
    add(t0, { kind: "tool_result", toolUseId: "r2", content: 'HTTP 200\n{"trigger":{"id":"trig_1","enabled":false}}', isError: false, parent: null })
    assert.equal(s.list("s1", opts)[0]!.status, "cancelled")
  })
})

describe("pedirle a una sesión de verdad que cancele (con el Claude falso)", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(check(), "no llegó a tiempo")
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-cancel-"))
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
  })
  after(async () => {
    for (const s of db.listSessions()) await sessions.stop(s.id).catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const scheduled = (id: string) => sessions.view(db.getSession(id)!).scheduled

  it("la cancela con CronDelete; un segundo pedido mientras está pendiente no sale", async () => {
    const rec = sessions.create({ projectId: "p1", kind: "worker", name: "ALFA", role: "", cwd: dir, claudeSessionId: "c-alfa" })
    await sessions.send(rec.id, "CRON */5 * * * *|1|0|mirá el CI", { origin: "user" })
    await until(() => scheduled(rec.id).length === 1 && sessions.statusOf(rec.id) === "idle")
    const [job] = scheduled(rec.id)
    assert.deepEqual(await sessions.requestCancelScheduled(rec.id, job!.id, "c1"), { sent: true })
    const again = await sessions.requestCancelScheduled(rec.id, job!.id, "c2").catch((e: Error) => e)
    // O no salió de nuevo (seguía pendiente) o ya se había cancelado: nunca manda dos pedidos.
    assert.ok(again instanceof Error ? /ya no está programado/.test(again.message) : again.sent === false)
    await until(() => scheduled(rec.id)[0]?.status === "cancelled")
    const asked = db.listEvents(rec.id).filter((e) => e.event.kind === "user" && e.event.text.includes("CronDelete"))
    assert.equal(asked.length, 1, "un solo mensaje en el chat")
  })

  it("si no la cancela, el pedido queda con el fin de su turno", async () => {
    const rec = sessions.create({ projectId: "p1", kind: "worker", name: "TERCA", role: "", cwd: dir, claudeSessionId: "c-terca" })
    await sessions.send(rec.id, "CRON 0 9 * * *|1|0|resumen", { origin: "user" })
    await until(() => scheduled(rec.id).length === 1 && sessions.statusOf(rec.id) === "idle")
    const [job] = scheduled(rec.id)
    await sessions.requestCancelScheduled(rec.id, job!.id, "t1")
    await until(() => scheduled(rec.id)[0]?.cancelRequest?.lastTurnEndAt != null)
    const [item] = scheduled(rec.id)
    assert.equal(item!.status, "active")
    assert.equal(cancelState(item!.cancelRequest, item!, "idle", item!.cancelRequest!.lastTurnEndAt! + CANCEL_GRACE_MS), "failed")
  })
})
