import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { Orchestration } from "../src/orchestration.ts"
import { ARM_MS, CONTINUE_PROMPT, MAX_AGE_MS, Restart, RESUME_FILE, resumeSummary } from "../src/restart.ts"
import { SessionManager } from "../src/sessions.ts"
import type { ExternalSession, ServerMessage } from "../src/shared/types.ts"
import { writeFakeClaude } from "./fake-claude.ts"

const until = async (check: () => boolean, what = "no llegó a tiempo") => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
  assert.ok(check(), what)
}

/** Un Hub que guarda lo que manda (y dice que hay alguien conectado). */
class SpyHub extends Hub {
  sent: ServerMessage[] = []
  override broadcast(msg: ServerMessage) {
    this.sent.push(msg)
  }
  override get size() {
    return 1
  }
}

describe("reiniciar para actualizar y retomar las sesiones", () => {
  let dir: string
  let db: Db
  let bin: string
  let hub: SpyHub
  let sessions: SessionManager
  let managers: SessionManager[]

  const manager = (opts: { strict?: boolean; liveElsewhere?: (s: SessionRecord) => Promise<ExternalSession | null> } = {}) => {
    const m = new SessionManager({
      liveElsewhere: opts.liveElsewhere,
      db,
      hub,
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir, FAKE_LONG_MS: "60000", ...(opts.strict ? { FAKE_STRICT_RESUME: "1" } : {}) }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    managers.push(m)
    return m
  }
  const restartOf = (m: SessionManager, clock?: () => number) =>
    new Restart({ home: dir, version: "9.9.9", sessions: m, hub, clientWaitMs: 0, retryDelaysMs: [50, 100], ...(clock ? { clock } : {}) })
  const create = (name: string, kind: "worker" | "orchestrator" = "worker", cwd = dir) =>
    sessions.create({ projectId: "p1", kind, name, role: "", cwd, claudeSessionId: `c-${name}` })
  const texts = (id: string) => db.listEvents(id).map((e) => e.event)

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-restart-"))
    bin = writeFakeClaude(dir)
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    hub = new SpyHub()
    managers = []
    sessions = manager()
  })
  afterEach(async () => {
    for (const m of managers) await m.shutdown().catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Tres sesiones vivas (esperando, trabajando, preguntando) y una detenida. */
  async function liveSessions() {
    const idle = create("QUIETA")
    const working = create("OCUPADA")
    const asking = create("PREGUNTONA")
    const stopped = create("DORMIDA")
    await sessions.send(idle.id, "hola", { origin: "user" })
    await sessions.send(working.id, "LARGO: un turno que no termina", { origin: "user" })
    await sessions.send(asking.id, "PREGUNTA", { origin: "user" })
    await until(() => sessions.statusOf(idle.id) === "idle" && sessions.statusOf(working.id) === "working" && sessions.statusOf(asking.id) === "needs_input")
    return { idle, working, asking, stopped }
  }

  it("guarda las vivas al apagar y, al volver, retoma cada una según cómo estaba", async () => {
    const { idle, working, asking, stopped } = await liveSessions()
    const restart = restartOf(sessions)
    const preview = restart.preview()
    assert.equal(preview.version, "9.9.9")
    assert.deepEqual([preview.working, preview.needsInput], [1, 1])
    assert.equal(preview.sessions.length, 3, "la detenida no cuenta")
    const armed = restart.prepare("update")
    assert.ok(armed.armedUntil > Date.now())

    // El apagado ordenado: primero anota, después cierra.
    const saved = restart.onShutdown()
    await sessions.shutdown()
    assert.deepEqual(
      Object.fromEntries(saved!.sessions.map((s) => [s.id, s.status])),
      { [idle.id]: "idle", [working.id]: "working", [asking.id]: "needs_input" }
    )
    assert.ok(fs.existsSync(path.join(dir, RESUME_FILE)))

    // El server nuevo.
    hub.sent = []
    sessions = manager()
    const result = await restartOf(sessions).resumePending()
    assert.equal(result.resumed.length, 3)
    assert.equal(fs.existsSync(path.join(dir, RESUME_FILE)), false, "la lista se borra: otro reinicio no la repite")
    for (const s of [idle, working, asking]) assert.ok(sessions.isRunning(s.id), `${s.name} volvió a arrancar`)
    assert.equal(sessions.isRunning(stopped.id), false)

    // La que trabajaba recibe el pedido de seguir (en el chat se ve de dónde vino).
    await until(() => texts(working.id).some((e) => e.kind === "text" && e.text.includes("control-plane se reinició")), "le llegó el mensaje")
    assert.ok(texts(working.id).some((e) => e.kind === "notice" && e.text.includes("se le pidió que revise lo que quedó a medias")))
    assert.ok(CONTINUE_PROMPT.includes("seguí con lo que estabas haciendo"))
    // La que esperaba vuelve sin mensaje.
    assert.equal(texts(idle.id).filter((e) => e.kind === "user").length, 1, "solo el 'hola' de antes")
    // La que preguntaba: aviso en su chat y un toast para vos.
    assert.ok(texts(asking.id).some((e) => e.kind === "notice" && e.level === "warn" && e.text.includes("contestale acá en el chat")))
    const toast = hub.sent.find((m) => m.type === "toast" && m.sessionId === asking.id)
    assert.ok(toast && toast.type === "toast" && toast.title === "PREGUNTONA te estaba preguntando algo: mirá el chat")

    assert.deepEqual(await restartOf(sessions).resumePending(), { resumed: [], failed: [] }, "no hay nada pendiente")
  })

  /** Apaga como lo hace el server al actualizar y arranca uno nuevo que retoma. */
  async function restartAll(opts: Parameters<typeof manager>[0] = {}) {
    const restart = restartOf(sessions)
    restart.prepare("update")
    const saved = restart.onShutdown()!
    await sessions.shutdown()
    sessions = manager(opts)
    const result = await restartOf(sessions).resumePending()
    return { saved, result }
  }
  /** Cuántas veces le pidió que siga (en el chat se ve el aviso en lugar del mensaje). */
  const continued = (id: string) => texts(id).filter((e) => e.kind === "notice" && e.text.includes("se le pidió que revise lo que quedó a medias")).length

  it("retoma varias a la vez: las que trabajaban (con la orquestadora) siguen y las que esperaban vuelven", async () => {
    const orch = create("ORQ", "orchestrator")
    const busy = ["UNO", "DOS", "TRES"].map((n) => create(n))
    const quiet = ["CUATRO", "CINCO"].map((n) => create(n))
    for (const s of [orch, ...busy]) await sessions.send(s.id, "LARGO", { origin: "user" })
    for (const s of quiet) await sessions.send(s.id, "hola", { origin: "user" })
    await until(() => [orch, ...busy].every((s) => sessions.statusOf(s.id) === "working") && quiet.every((s) => sessions.statusOf(s.id) === "idle"))

    const { saved, result } = await restartAll({ strict: true })
    assert.equal(saved.sessions.filter((s) => s.status === "working").length, 4)
    assert.equal(result.resumed.length, 6)
    assert.deepEqual(result.failed, [])
    for (const s of [orch, ...busy, ...quiet]) assert.ok(sessions.isRunning(s.id), `${s.name} volvió`)
    for (const s of [orch, ...busy]) await until(() => continued(s.id) === 1, `${s.name} recibió el seguí`)
    for (const s of quiet) assert.equal(continued(s.id), 0)
  })

  it("una que falla al arrancar se reintenta y, cuando arranca, recibe el seguí", async () => {
    const flaky = create("FALLA1")
    fs.writeFileSync(path.join(dir, "falla1-FALLA1"), "") // el primer arranque anda: falla el del server nuevo
    await sessions.send(flaky.id, "LARGO", { origin: "user" })
    await until(() => sessions.statusOf(flaky.id) === "working")
    const logs: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => void logs.push(a.join(" "))
    let result
    try {
      fs.rmSync(path.join(dir, "falla1-FALLA1"), { force: true })
      ;({ result } = await restartAll())
    } finally {
      console.log = log
    }
    assert.deepEqual(result.resumed, [flaky.id])
    assert.deepEqual(result.failed, [])
    assert.ok(logs.some((l) => /No arrancaron FALLA1 \(.*529 Overloaded.*\): reintento/.test(l)), "el log dice cuál y por qué")
    await until(() => continued(flaky.id) === 1, "le llegó el seguí")
  })

  it("si todavía figura abierta en otro lado (el proceso viejo), espera y la retoma", async () => {
    const s = create("PEGADA")
    await sessions.send(s.id, "LARGO", { origin: "user" })
    await until(() => sessions.statusOf(s.id) === "working")
    let calls = 0
    const { result } = await restartAll({
      liveElsewhere: async () => (++calls <= 2 ? { pid: 4242, kind: "interactive", id: null } : null),
    })
    assert.ok(calls >= 3, "volvió a mirar")
    assert.deepEqual(result.resumed, [s.id])
    await until(() => continued(s.id) === 1)
  })

  it("si sigue abierta en otro lado después de los reintentos, dice cuál y por qué", async () => {
    const s = create("AJENA")
    await sessions.send(s.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(s.id) === "idle")
    const { result } = await restartAll({ liveElsewhere: async () => ({ pid: 4242, kind: "interactive", id: null }) })
    assert.deepEqual(result.failed.map((f) => f.name), ["AJENA"])
    assert.match(result.failed[0]!.error, /abierta en una terminal \(pid 4242\)/)
  })

  it("el estado guardado es el que ves: con un subagente andando o una herramienta larga, está trabajando", async () => {
    const sub = create("CONSUB")
    const tool = create("HERRAMIENTA")
    await sessions.send(sub.id, "SUBAGENTE", { origin: "user" })
    await sessions.send(tool.id, "LARGO", { origin: "user" })
    await until(() => sessions.list().find((x) => x.id === sub.id)?.subagentsRunning === 1 && sessions.statusOf(sub.id) === "idle")
    await until(() => sessions.statusOf(tool.id) === "working")
    const { saved, result } = await restartAll()
    assert.deepEqual(Object.fromEntries(saved.sessions.map((x) => [x.id, x.status])), { [sub.id]: "working", [tool.id]: "working" })
    assert.equal(result.resumed.length, 2)
    for (const s of [sub, tool]) await until(() => continued(s.id) === 1, `${s.name} recibió el seguí`)
  })

  it("después de un /clear se retoma la conversación nueva (el id real, no el new_conversation_id)", async () => {
    const s = create("LIMPIA")
    await sessions.send(s.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(s.id) === "idle")
    const before = db.getSession(s.id)!.claudeSessionId
    await sessions.clearConversation(s.id)
    const after = db.getSession(s.id)!.claudeSessionId
    assert.notEqual(after, before)
    assert.match(after, /^clear-/, "el session_id de lo que siguió al reset")
    await sessions.send(s.id, "LARGO tarea nueva", { origin: "user" })
    await until(() => sessions.statusOf(s.id) === "working")

    const { result } = await restartAll({ strict: true })
    assert.deepEqual(result.resumed, [s.id])
    assert.deepEqual(result.failed, [])
    assert.equal(db.getSession(s.id)!.claudeSessionId, after)
    await until(() => continued(s.id) === 1)
  })

  it("si Claude Code no encuentra su conversación, no le pide que siga y avisa que arrancó de cero", async () => {
    const s = create("PERDIDA")
    await sessions.send(s.id, "LARGO", { origin: "user" })
    await until(() => sessions.statusOf(s.id) === "working")
    const restart = restartOf(sessions)
    restart.prepare("update")
    restart.onShutdown()
    await sessions.shutdown()
    // Como pasaba tras un /clear con 0.4.x: el id guardado no tiene transcript.
    db.updateSession(s.id, { claudeSessionId: "no-existe" })
    sessions = manager({ strict: true })
    const result = await restartOf(sessions).resumePending()
    assert.deepEqual(result.resumed, [])
    assert.deepEqual(result.failed.map((f) => f.name), ["PERDIDA"])
    assert.match(result.failed[0]!.error, /no encontró su conversación \(no-existe\)/)
    assert.equal(continued(s.id), 0, "no le manda el seguí a una conversación vacía")
    assert.ok(texts(s.id).some((e) => e.kind === "notice" && e.level === "warn" && e.text.includes("arrancó una nueva, sin el contexto de antes")))
  })

  it("un Detener normal (sin prepare), un pedido vencido o cancelado no guardan nada", async () => {
    await liveSessions()
    assert.equal(restartOf(sessions).onShutdown(), null, "sin prepare")
    let t = Date.now()
    const late = restartOf(sessions, () => t)
    late.prepare("update")
    t += ARM_MS + 1
    assert.equal(late.onShutdown(), null, "se pasó el plazo")
    const cancelled = restartOf(sessions)
    cancelled.prepare("server-update")
    cancelled.cancel()
    assert.equal(cancelled.onShutdown(), null)
    assert.equal(fs.existsSync(path.join(dir, RESUME_FILE)), false)
  })

  it("una que no arranca avisa y no frena a las demás; una lista vieja no se retoma", async () => {
    const gone = path.join(dir, "ya-no-esta")
    fs.mkdirSync(gone)
    const broken = create("ROTA", "worker", gone)
    const fine = create("SANA")
    fs.rmSync(gone, { recursive: true })
    const write = (at: number) =>
      fs.writeFileSync(
        path.join(dir, RESUME_FILE),
        JSON.stringify({ version: "0.1.0", reason: "update", at, sessions: [{ id: broken.id, status: "idle" }, { id: fine.id, status: "idle" }] })
      )
    write(Date.now() - MAX_AGE_MS - 1000)
    assert.deepEqual(await restartOf(sessions).resumePending(), { resumed: [], failed: [] })
    assert.equal(fs.existsSync(path.join(dir, RESUME_FILE)), false, "la vieja se borra igual")

    write(Date.now())
    const result = await restartOf(sessions).resumePending()
    assert.deepEqual(result.resumed, [fine.id])
    assert.deepEqual(result.failed.map((f) => [f.id, f.name]), [[broken.id, "ROTA"]])
    assert.match(result.failed[0]!.error, /No existe la carpeta de la sesión/, "con el motivo")
    assert.ok(sessions.isRunning(fine.id))
    // Se ve cuál y por qué: en el log, en el toast y en su chat.
    assert.match(resumeSummary(result)!, /^Retomé 1 sesión; 1 no arrancó: ROTA \(.*No existe la carpeta de la sesión.*\)\.$/)
    const toast = hub.sent.find((m) => m.type === "toast" && m.title === "No se pudo retomar ROTA después de reiniciar")
    assert.ok(toast && toast.type === "toast" && /No existe la carpeta de la sesión/.test(toast.body ?? ""))
    assert.ok(texts(broken.id).some((e) => e.kind === "notice" && e.level === "error" && e.text.includes("no se pudo retomar esta sesión")))
  })

  it("la cola de la orquestadora sigue igual y no recibe dos veces el mismo lote", async () => {
    const orch = create("ORQ", "orchestrator")
    const worker = create("OBRERA")
    const orchestration = new Orchestration(db, hub, sessions)
    orchestration.report(db.getSession(worker.id) as SessionRecord, { status: "done", summary: "Terminé la parte LARGO del deploy." })
    const reportId = db.listReports({ projectId: "p1" })[0]!.id
    await orchestration.reviewNow("p1")
    await until(() => sessions.statusOf(orch.id) === "working" && db.getReport(reportId)!.state === "in_review")

    const restart = restartOf(sessions)
    restart.prepare("update")
    restart.onShutdown()
    orchestration.dispose()
    await sessions.shutdown()
    assert.equal(db.getReport(reportId)!.state, "in_review", "el apagado no lo devuelve a la cola")

    sessions = manager()
    const next = new Orchestration(db, hub, sessions)
    await restartOf(sessions).resumePending()
    // Sigue con el turno que se cortó y, al terminarlo con la cola vacía, cierra la revisión.
    await until(() => db.getReport(reportId)!.state === "reviewed", "cerró la revisión")
    const batches = db.listEvents(orch.id).filter((e) => e.event.kind === "batch")
    assert.equal(batches.length, 1, "un solo lote en toda la historia")
    next.dispose()
  })
})
