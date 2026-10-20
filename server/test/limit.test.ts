import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { Afk } from "../src/afk.ts"
import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { LimitedError, limitContinuePrompt, UsageLimits } from "../src/limit.ts"
import { limitLine } from "../src/mcp.ts"
import { Orchestration } from "../src/orchestration.ts"
import { Restart } from "../src/restart.ts"
import { SessionManager } from "../src/sessions.ts"
import type { ServerMessage } from "../src/shared/types.ts"
import { writeFakeClaude } from "./fake-claude.ts"
import { tmpRunRoot } from "./run-root.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (check: () => boolean, what = "no llegó a tiempo", ms = 12_000) => {
  for (let i = 0; i < ms / 25 && !check(); i++) await sleep(25)
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

const NO_LIMIT_TEXT = "Se renovó tu límite de uso"

describe("límite de uso: reconocerlo, retener lo que se manda y retomar al renovarse", () => {
  let dir: string
  let dir2: string
  let file: string
  let db: Db
  let bin: string
  let hub: SpyHub
  let sessions: SessionManager
  let limits: UsageLimits
  let orch: Orchestration
  let managers: SessionManager[]
  let all: UsageLimits[]
  let inputLog: string
  let env: Record<string, string>

  /** Las cuentas: el proyecto p1 usa acc (carpeta dir) y el p2 usa acc2 (carpeta dir2). */
  const accountOf = (s: SessionRecord) => (s.projectId === "p2" ? "acc2" : "acc")
  const manager = (opts: { strict?: boolean } = {}) => {
    const m = new SessionManager({
      db,
      hub,
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      runRoot: tmpRunRoot(),
      launchFor: (s) => ({
        protocol: "",
        orchestratorCanEdit: false,
        model: null,
        effort: null,
        env: { CLAUDE_CONFIG_DIR: s.projectId === "p2" ? dir2 : dir, FAKE_LOG_INPUT: inputLog, ...env, ...(opts.strict ? { FAKE_STRICT_RESUME: "1" } : {}) },
        bin,
        accountId: accountOf(s),
      }),
      accountIdFor: accountOf,
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    managers.push(m)
    return m
  }
  /** El límite con tiempos cortos: se renueva en un par de segundos y se reintenta enseguida. */
  const limitsOf = (m: SessionManager, o: Orchestration) => {
    const l = new UsageLimits({
      db,
      hub,
      sessions: m,
      orchestration: o,
      broadcastAccount: () => {},
      accountName: (id) => (id === "acc2" ? "Otra" : "Principal"),
      sweepMs: 100,
      gapMs: 30,
      announceMs: 40,
      marginMs: 100,
      retryMs: 500,
      probeMs: 150,
    })
    all.push(l)
    return l
  }
  const create = (name: string, projectId = "p1", kind: "worker" | "orchestrator" = "worker") =>
    sessions.create({ projectId, kind, name, role: "", cwd: dir, claudeSessionId: `c-${name}` })
  const events = (id: string) => db.listEvents(id).map((e) => e.event)
  const inputs = () => (fs.existsSync(inputLog) ? fs.readFileSync(inputLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string) : [])
  const continuations = () => inputs().filter((t) => t.includes(NO_LIMIT_TEXT))
  const toasts = () => hub.sent.filter((m): m is Extract<ServerMessage, { type: "toast" }> => m.type === "toast")
  const limitFile = () => path.join(dir, "fake-limit.json")
  /** Una sesión que se corta por el límite: manda LIMITE y espera a que la cuenta quede marcada. */
  async function cut(s: SessionRecord, kind = "five_hour", secs = 2) {
    await sessions.send(s.id, `LIMITE ${kind} ${secs}`, { origin: "user" })
    await until(() => limits.accountLimit(accountOf(s)) !== null || db.getSession(s.id)!.limited !== null, "se marcó el límite")
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-limit-"))
    dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cp-limit2-"))
    inputLog = path.join(dir, "inputs.log")
    file = path.join(dir, "t.db")
    bin = writeFakeClaude(dir)
    db = new Db(file)
    for (const id of ["p1", "p2"])
      db.insertProject({ id, name: id.toUpperCase(), repoPath: dir, settings: { ...defaultSettings, batchWindowSec: 0.05 }, accountId: null, createdAt: 1, archivedAt: null })
    hub = new SpyHub()
    managers = []
    all = []
    env = {}
    sessions = manager()
    orch = new Orchestration(db, hub, sessions)
    limits = limitsOf(sessions, orch)
  })
  afterEach(async () => {
    for (const l of all) l.dispose()
    orch.dispose()
    for (const m of managers) await m.shutdown().catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  it("se frena: marca la cuenta y la sesión, avisa una vez y no manda nada hasta que se renueva; después sigue y suelta lo retenido", async () => {
    const a = create("UNA")
    const b = create("OTRA")
    await sessions.send(b.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(b.id) === "idle")
    await cut(a)

    const limit = limits.accountLimit("acc")!
    assert.equal(limit.kind, "five_hour")
    assert.equal(limit.source, "event", "el reloj del CLI (rate_limit_event) manda")
    assert.ok(limit.resetsAt > Date.now() && limit.resetsAt <= Date.now() + 3000)
    assert.match(limit.message, /^You've hit your session limit · resets \d{1,2}(:\d\d)?[ap]m \(America\/New_York\)$/)
    // La sesión que se cortó queda marcada para seguir; el turno del chat dice que fue por el límite.
    assert.equal(db.getSession(a.id)!.limited?.interrupted, true)
    const end = events(a.id).filter((e) => e.kind === "turn_end").at(-1)!
    assert.ok(end.kind === "turn_end" && end.ok === false && end.limit === "five_hour")
    assert.ok(events(a.id).some((e) => e.kind === "notice" && /Se terminó el uso de 5 horas\. control-plane la retoma sola cuando se renueve \(hasta /.test(e.text)))
    // Lo que ve la web: la cuenta y cada sesión de la cuenta (también la que no se cortó) están sin uso.
    const viewA = sessions.view(db.getSession(a.id)!)
    assert.deepEqual([viewA.limited?.kind, viewA.limited?.interrupted, viewA.limited?.willResume], ["five_hour", true, true])
    const viewB = sessions.view(db.getSession(b.id)!)
    assert.deepEqual([viewB.limited?.kind, viewB.limited?.interrupted, viewB.limited?.willResume], ["five_hour", false, false])
    // Un solo aviso por tanda, con la cuenta y cuántas esperan. No es "te necesita".
    await until(() => toasts().some((t) => /^Se terminó el uso de 5 horas de la cuenta Principal$/.test(t.title)))
    const announce = toasts().filter((t) => t.title.includes("Se terminó el uso"))
    assert.equal(announce.length, 1)
    assert.equal(announce[0]!.level, "info")
    assert.equal(announce[0]!.event, undefined)
    assert.match(announce[0]!.body ?? "", /^1 sesión espera hasta .* y sigue sola\.$/)

    // Mientras dura, nada llega a la sesión: ni por send ni lo que escribe el usuario.
    const before = inputs().length
    await assert.rejects(() => sessions.send(a.id, "otra cosa", { origin: "user" }), (e) => e instanceof LimitedError && /Se terminó el uso de 5 horas/.test(e.message))
    const held = await limits.sendOrHold(a.id, "para cuando vuelva", { origin: "user", clientId: "c-1" })
    assert.ok("held" in held && /Queda en espera: se envía cuando se renueve el uso, a las \d\d:\d\d\./.test(held.note))
    const again = await limits.sendOrHold(a.id, "para cuando vuelva", { origin: "user", clientId: "c-1" })
    assert.ok("held" in again && again.held.id === (held as { held: { id: string } }).held.id, "el mismo clientId no se duplica")
    await limits.sendOrHold(b.id, "también esta", { origin: "user" })
    assert.deepEqual(sessions.view(db.getSession(a.id)!).held.map((h) => h.text), ["para cuando vuelva"])
    assert.equal(inputs().length, before, "no se mandó nada")
    // Un /clear no llama a la API: pasa.
    await sessions.send(b.id, "/clear", { origin: "control", event: { kind: "notice", level: "info", text: "x" } })

    // Se renueva: la cuenta queda libre, la sesión cortada sigue (con un mensaje del sistema) y después sale lo retenido.
    await until(() => limits.accountLimit("acc") === null, "se renovó")
    await until(() => inputs().includes("para cuando vuelva") && inputs().includes("también esta"), "salió lo retenido")
    const all_ = inputs()
    assert.equal(continuations().length, 1)
    assert.equal(continuations()[0], limitContinuePrompt("five_hour"))
    assert.match(continuations()[0]!, /^Se renovó tu límite de uso \(de 5 horas\) y se había cortado tu turno\. Revisá si quedó algo a medias y seguí con lo que estabas haciendo\.$/)
    assert.ok(all_.indexOf(continuations()[0]!) < all_.indexOf("para cuando vuelva"), "primero seguir, después lo retenido")
    assert.equal(db.getSession(a.id)!.limited, null)
    assert.deepEqual([sessions.view(db.getSession(a.id)!).held.length, sessions.view(db.getSession(a.id)!).limited], [0, null])
    assert.equal(db.listHeld().length, 0)
    // En el chat: el aviso de que siguió (no un mensaje del usuario) y después el mensaje retenido, ya como mensaje.
    const chat = events(a.id)
    assert.ok(chat.some((e) => e.kind === "notice" && e.text.startsWith("Se renovó el uso de 5 horas: se le pidió que revise lo que quedó a medias y siga")))
    assert.ok(chat.some((e) => e.kind === "user" && e.text === "para cuando vuelva" && e.origin === "user"))
    assert.ok(!chat.some((e) => e.kind === "user" && e.text.includes(NO_LIMIT_TEXT)), "la continuación no se hace pasar por el usuario")
    assert.ok(toasts().some((t) => t.title === "Se renovó el uso de la cuenta Principal" && t.body === "Siguieron 1 sesión."))
    // Y un turno nuevo anda.
    await sessions.send(a.id, "hola de nuevo", { origin: "user" })
    await until(() => events(a.id).some((e) => e.kind === "text" && e.text.includes("respuesta a: hola de nuevo")))
  })

  it("lo guarda todo en la base: al reabrir la app sigue marcado el límite, lo retenido y el último uso", async () => {
    const a = create("UNA")
    await cut(a, "seven_day", 30)
    await limits.sendOrHold(a.id, "esperá", { origin: "user", clientId: "x1" })
    await until(() => sessions.usageFor("acc")?.sevenDay != null)
    await sessions.shutdown() // guarda el uso que faltaba
    limits.dispose()
    db.close()

    db = new Db(file)
    assert.equal(db.listAccountLimits().length, 1)
    assert.deepEqual(db.listAccountLimits().map((l) => [l.accountId, l.kind, l.source]), [["acc", "seven_day", "event"]])
    assert.equal(db.getSession(a.id)!.limited?.interrupted, true)
    assert.deepEqual(db.listHeld().map((h) => h.text), ["esperá"])
    assert.ok((db.listAccountUsage().find((u) => u.accountId === "acc")?.usage.sevenDay?.resetsAt ?? 0) > Date.now())

    sessions = manager()
    orch = new Orchestration(db, hub, sessions)
    limits = limitsOf(sessions, orch)
    assert.equal(limits.accountLimit("acc")?.kind, "seven_day")
    assert.equal(sessions.usageFor("acc")?.sevenDay?.resetsAt, limits.accountLimit("acc")!.resetsAt, "sabe cuándo se renueva antes de que arranque ninguna sesión")
    assert.deepEqual(sessions.view(db.getSession(a.id)!).held.map((h) => h.text), ["esperá"])
    assert.equal(sessions.view(db.getSession(a.id)!).limited?.willResume, true)
    await assert.rejects(() => sessions.send(a.id, "no", { origin: "user" }), LimitedError)
    assert.equal(sessions.view(db.getSession(a.id)!).limited?.kind, "seven_day")
  })

  it("cerró la app sin uso y al abrirla ya se renovó: las sesiones cortadas se lanzan y siguen solas", async () => {
    const a = create("UNA")
    const b = create("DOS")
    await sessions.send(b.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(b.id) === "idle")
    await cut(a, "five_hour", 1)
    await sessions.send(b.id, "LIMITE five_hour 1", { origin: "user", bypassLimit: true })
    await until(() => db.getSession(b.id)!.limited !== null)
    await limits.sendOrHold(a.id, "retenido", { origin: "user" })
    limits.dispose()
    await sessions.shutdown()
    assert.equal(sessions.isRunning(a.id), false)
    // La app queda cerrada hasta que pasa la renovación.
    await sleep(1400)
    assert.equal(db.listAccountLimits().length, 1, "sigue marcado: nadie lo limpió")

    const before = continuations().length
    sessions = manager({ strict: true })
    orch = new Orchestration(db, hub, sessions)
    limits = limitsOf(sessions, orch)
    limits.start()
    await until(() => limits.accountLimit("acc") === null)
    // Los procesos no estaban corriendo: se lanzan y reciben el mensaje; después sale lo retenido.
    await until(() => continuations().length === before + 2 && inputs().includes("retenido"), "siguieron las dos")
    assert.ok(sessions.isRunning(a.id) && sessions.isRunning(b.id))
    assert.equal(db.getSession(a.id)!.limited, null)
    assert.equal(db.getSession(b.id)!.limited, null)
    assert.ok(toasts().some((t) => t.title === "Se renovó el uso de la cuenta Principal" && t.body === "Siguieron 2 sesiones."))
    assert.equal(sessions.view(db.getSession(a.id)!).limited, null)
    // De a una, no todas juntas.
    const turns = events(a.id).filter((e) => e.kind === "turn_end")
    assert.ok(turns.length >= 2)
  })

  it("no retomar: la sesión no sigue sola, pero lo que le escribiste sí sale; con el ajuste apagado, ninguna", async () => {
    const a = create("UNA")
    const b = create("DOS")
    await cut(a, "five_hour", 1)
    await sessions.send(b.id, "LIMITE five_hour 1", { origin: "user", bypassLimit: true })
    await until(() => db.getSession(b.id)!.limited !== null)
    await limits.sendOrHold(a.id, "este sí", { origin: "user" })
    limits.setResume(a.id, false)
    assert.deepEqual([sessions.view(db.getSession(a.id)!).limited?.interrupted, sessions.view(db.getSession(a.id)!).limited?.willResume], [false, false])
    await until(() => limits.accountLimit("acc") === null)
    await until(() => inputs().includes("este sí") && continuations().length === 1, "siguió una sola")
    assert.equal(db.getSession(a.id)!.limited, null)
    assert.ok(!events(a.id).some((e) => e.kind === "notice" && e.text.startsWith("Se renovó el uso")))
    assert.throws(() => limits.setResume(a.id, true), /no está sin uso/)

    // Con «Retomar solas» apagado nadie sigue, aunque el turno se haya cortado.
    assert.equal(limits.setSettings({ resumeOnRenewal: false }).resumeOnRenewal, false)
    assert.ok(hub.sent.some((m) => m.type === "settings" && !m.settings.resumeOnRenewal))
    const c = create("TRES")
    await cut(c, "five_hour", 1)
    assert.equal(sessions.view(db.getSession(c.id)!).limited?.willResume, false)
    await until(() => limits.accountLimit("acc") === null)
    await sleep(300)
    assert.equal(continuations().length, 1, "la de antes; esta no")
    assert.equal(db.getSession(c.id)!.limited, null)
    assert.equal(limits.setSettings({ resumeOnRenewal: true }).resumeOnRenewal, true)
  })

  it("se detuvo a mano o se archivó mientras esperaba: no se la lanza sola", async () => {
    const a = create("PARADA")
    const b = create("ARCHIVADA")
    const c = create("SIGUE")
    for (const s of [a, b, c]) await sessions.send(s.id, "hola", { origin: "user" })
    await until(() => [a, b, c].every((s) => sessions.statusOf(s.id) === "idle"))
    await cut(a, "five_hour", 1)
    for (const s of [b, c]) await sessions.send(s.id, "LIMITE five_hour 1", { origin: "user", bypassLimit: true })
    await until(() => [b, c].every((s) => db.getSession(s.id)!.limited !== null))
    await sessions.stop(a.id, { manual: true })
    await limits.sendOrHold(b.id, "de la archivada", { origin: "user" })
    await sessions.archive(b.id)
    assert.equal(db.getSession(b.id)!.limited, null)
    assert.equal(db.listHeld().length, 0, "lo retenido de una archivada se descarta")
    // El apagado del server no cuenta como detenerla a mano.
    await until(() => limits.accountLimit("acc") === null)
    await until(() => continuations().length === 1, "siguió solo la que no se tocó")
    assert.equal(sessions.isRunning(a.id), false)
    assert.equal(sessions.isRunning(b.id), false)
    assert.ok(sessions.isRunning(c.id))
    assert.equal(db.getSession(a.id)!.limited, null)
  })

  it("«Reintentar ahora» por cuenta: si ya hay uso (subiste el tope) sigue todo; si no, se vuelve a frenar sin bucles", async () => {
    const a = create("UNA")
    const b = create("DOS")
    await cut(a, "spend", 60)
    await sessions.send(b.id, "LIMITE spend 60", { origin: "user", bypassLimit: true })
    await until(() => db.getSession(b.id)!.limited !== null)
    const spend = limits.accountLimit("acc")!
    assert.equal(spend.kind, "spend")
    assert.match(spend.message, /individual spend limit/)
    await limits.sendOrHold(a.id, "retenido", { origin: "user" })
    await until(() => toasts().some((t) => /^Se llegó al tope de gasto de la cuenta Principal$/.test(t.title)))
    assert.match(toasts().find((t) => t.title.startsWith("Se llegó"))!.body ?? "", /Si subís el tope, tocá «Reintentar ahora»\.$/)

    // Todavía sin uso: lo intenta una vez y se vuelve a frenar con la renovación nueva.
    limits.retryAccount("acc")
    assert.throws(() => limits.retryAccount("acc2"), /no está sin uso/)
    // La primera continuación vuelve a cortarse: la cuenta se marca de nuevo y las demás no gastan un intento más.
    await until(() => continuations().length === 1 && limits.accountLimit("acc") !== null && db.getSession(a.id)!.limited !== null, "se frenó otra vez")
    await sleep(500)
    assert.equal(continuations().length, 1, "sin bucle: no insiste mientras dura")
    assert.equal(limits.accountLimit("acc")!.resetsAt, spend.resetsAt)
    assert.equal(db.getSession(a.id)!.limited?.interrupted, true)
    assert.equal(db.getSession(b.id)!.limited?.interrupted, true, "la otra sigue marcada: le toca en la próxima renovación")
    assert.equal(db.listHeld().length, 1, "lo retenido sigue esperando")

    // Ahora sí hay uso (subió el tope): reintentar ahora sigue todo.
    fs.rmSync(limitFile())
    limits.retryAccount("acc")
    await until(() => continuations().length === 3 && inputs().includes("retenido"), "siguieron las dos y salió lo retenido")
    assert.equal(limits.accountLimit("acc"), null)
    assert.deepEqual([db.getSession(a.id)!.limited, db.getSession(b.id)!.limited], [null, null])
  })

  it("«Reintentar ahora» por sesión: manda sin esperar a la cuenta y, si no hay uso, se vuelve a frenar", async () => {
    const a = create("UNA")
    await cut(a, "five_hour", 60)
    await limits.sendOrHold(a.id, "retenido", { origin: "user" })
    const reset = limits.accountLimit("acc")!.resetsAt
    await limits.retrySession(a.id)
    await until(() => inputs().includes("retenido") && continuations().length === 1)
    await until(() => db.getSession(a.id)!.limited !== null && limits.accountLimit("acc")?.resetsAt === reset)
    assert.equal(db.getSession(a.id)!.limited?.interrupted, true, "el turno se volvió a cortar: sigue marcada")
    // Sin nada que reintentar, avisa.
    const idle = create("QUIETA", "p2")
    await assert.rejects(() => limits.retrySession(idle.id), /no está sin uso/)
  })

  it("si al renovarse se frena otra vez (era otra ventana), se marca con la renovación nueva y no entra en un bucle", async () => {
    const a = create("UNA")
    await cut(a, "five_hour", 1)
    // Mientras tanto el semanal se agotó: cuando se renueve el de 5 h, el turno vuelve a cortarse.
    fs.writeFileSync(limitFile(), JSON.stringify({ until: Date.now() + 5000, kind: "seven_day" }))
    const first = limits.accountLimit("acc")!
    await until(() => limits.accountLimit("acc")?.kind === "seven_day", "se frenó otra vez, ahora por el semanal")
    const second = limits.accountLimit("acc")!
    assert.ok(second.resetsAt > first.resetsAt)
    assert.ok(second.since > first.since, "es otra tanda")
    assert.equal(continuations().length, 1)
    await sleep(700)
    assert.equal(continuations().length, 1, "mientras dura el nuevo no manda nada")
    assert.equal(db.getSession(a.id)!.limited?.kind, "seven_day")
    // Cuando también se renueva ese, sigue.
    await until(() => limits.accountLimit("acc") === null && continuations().length === 2, "sigue cuando se renueva el semanal", 15_000)
    await until(() => events(a.id).some((e) => e.kind === "text" && e.text.startsWith("respuesta a: Se renovó tu límite de uso (semanal)")))
    assert.deepEqual(db.listLimitWaits("acc", 0, Date.now()).map((w) => w.kind), ["five_hour", "seven_day"], "cada lapso sin uso quedó anotado")
  })

  it("sin saber cuándo se renueva reintenta cada tanto, y un reloj que no es creíble no se usa", async () => {
    const a = create("UNA")
    env = { FAKE_LIMIT_EVENT: "0", FAKE_LIMIT_TEXT: "0" }
    sessions = manager()
    orch = new Orchestration(db, hub, sessions)
    limits = limitsOf(sessions, orch)
    const x = create("SIN-DATOS")
    // El error ni dice de qué límite es y no hay reloj: no se reconoce.
    await sessions.send(x.id, "LIMITE five_hour 1", { origin: "user" })
    await until(() => events(x.id).some((e) => e.kind === "turn_end"))
    assert.equal(limits.accountLimit("acc"), null, "sin evento ni texto de límite no hay límite")
    assert.equal(a.id.length > 0, true)

    // El caso de resolveReset: sin reloj ni texto, a los 15 minutos (acá, retryMs).
    const t = Date.now()
    assert.deepEqual(limits.resolveReset("acc", { kind: "five_hour", message: "x", resetText: null }, null, t), { resetsAt: t + 500, source: "fallback" })
    // Un reloj que dice dentro de una semana para un límite de 5 h no es creíble.
    assert.equal(limits.resolveReset("acc", { kind: "five_hour", message: "x", resetText: null }, { kind: "five_hour", resetsAt: t + 7 * 86_400_000 }, t).source, "fallback")
    // El reloj del CLI y el texto de acuerdo: gana el reloj; en desacuerdo por horas, el texto.
    const text = "10pm (America/New_York)"
    const ten = limits.resolveReset("acc", { kind: "five_hour", message: "x", resetText: text }, null, Date.parse("2026-10-19T23:30:00Z")) // 19:30 NY
    assert.deepEqual(ten, { resetsAt: Date.parse("2026-10-20T02:00:00Z"), source: "text" })
    const agree = limits.resolveReset("acc", { kind: "five_hour", message: "x", resetText: text }, { kind: "five_hour", resetsAt: Date.parse("2026-10-20T02:00:20Z") }, Date.parse("2026-10-19T23:30:00Z"))
    assert.deepEqual(agree, { resetsAt: Date.parse("2026-10-20T02:00:20Z"), source: "event" })
    const disagree = limits.resolveReset("acc", { kind: "five_hour", message: "x", resetText: text }, { kind: "five_hour", resetsAt: Date.parse("2026-10-20T04:30:00Z") }, Date.parse("2026-10-19T23:30:00Z"))
    assert.equal(disagree.source, "text")
    // Un reloj de otra ventana no vale; el último uso informado de la cuenta sí (cuando el error no trae el evento).
    const other = limits.resolveReset("acc", { kind: "seven_day", message: "x", resetText: null }, { kind: "five_hour", resetsAt: t + 1000 }, t)
    assert.equal(other.source, "fallback")
  })

  it("rejected sin el texto: el rate_limit_event alcanza para reconocer el límite (y su renovación)", async () => {
    env = { FAKE_LIMIT_TEXT: "0" }
    sessions = manager()
    orch = new Orchestration(db, hub, sessions)
    limits = limitsOf(sessions, orch)
    const a = create("UNA")
    await cut(a, "seven_day", 1)
    const l = limits.accountLimit("acc")!
    assert.equal(l.kind, "seven_day")
    assert.equal(l.source, "event")
    assert.equal(db.getSession(a.id)!.limited?.interrupted, true)
    assert.match(l.message, /API Error: 429/)
    await until(() => limits.accountLimit("acc") === null && continuations().length === 1)
  })

  it("el límite de un modelo («other») frena solo a esa sesión, no a la cuenta", async () => {
    const opus = create("OPUS")  // el nombre le dice al Claude falso que es la que usa el modelo con límite
    const sonnet = create("SONNET")
    await sessions.send(sonnet.id, "hola", { origin: "user" })
    await cut(opus, "other", 1)
    assert.equal(limits.accountLimit("acc"), null)
    assert.equal(sessions.view(db.getSession(opus.id)!).limited?.kind, "other")
    assert.equal(sessions.view(db.getSession(sonnet.id)!).limited, null)
    await assert.rejects(() => sessions.send(opus.id, "no", { origin: "user" }), LimitedError)
    await sessions.send(sonnet.id, "esta sí", { origin: "user" })
    await until(() => events(sonnet.id).some((e) => e.kind === "text" && e.text.includes("respuesta a: esta sí")))
    await until(() => continuations().length === 1 && db.getSession(opus.id)!.limited === null, "la sesión sigue sola cuando se renueva")
    assert.match(continuations()[0]!, /\(de uso\)/)
  })

  it("dos cuentas con límites distintos: una frenada no frena a la otra, y cada una se renueva a su hora", async () => {
    const a = create("EN-ACC")
    const b = create("EN-ACC2", "p2")
    await sessions.send(b.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(b.id) === "idle")
    await cut(a, "five_hour", 60)
    assert.ok(limits.accountLimit("acc"))
    assert.equal(limits.accountLimit("acc2"), null)
    await sessions.send(b.id, "sigo andando", { origin: "user" })
    await until(() => events(b.id).some((e) => e.kind === "text" && e.text.includes("respuesta a: sigo andando")))
    // La otra se frena con otro tipo y otra hora.
    await sessions.send(b.id, "LIMITE seven_day 1", { origin: "user" })
    await until(() => limits.accountLimit("acc2") !== null)
    assert.equal(limits.accountLimit("acc2")!.kind, "seven_day")
    assert.equal(limits.accountLimit("acc")!.kind, "five_hour")
    await until(() => limits.accountLimit("acc2") === null && continuations().length === 1, "la segunda se renueva sola")
    assert.ok(limits.accountLimit("acc"), "la primera sigue sin uso")
    assert.ok(toasts().some((t) => /de la cuenta Otra$/.test(t.title)) && toasts().some((t) => /de la cuenta Principal$/.test(t.title)))
  })

  it("la orquestadora: la cola queda retenida y se le entrega al renovarse; si se le corta la revisión, retoma igual", async () => {
    const orq = create("ORQ", "p1", "orchestrator")
    const w = create("TRABAJADORA")
    await sessions.send(orq.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(orq.id) === "idle")
    await cut(w, "five_hour", 2)
    // Un resultado llega con la cuenta sin uso: queda en la cola, sin entregarse ni pausar nada.
    orch.report(db.getSession(w.id)!, { status: "done", summary: "Listo lo mío" })
    await sleep(400)
    assert.equal(db.listReports({ projectId: "p1", states: ["queued"] }).length, 1)
    assert.ok(!inputs().some((t) => t.includes("Cola de resultados")))
    assert.equal(orch.reviewState("p1").queued, 1)
    await assert.rejects(() => orch.reviewNow("p1"), LimitedError)
    // Se renueva: sale el lote.
    await until(() => inputs().some((t) => t.includes("[control-plane] Cola de resultados")), "se entregó el lote", 15_000)
    assert.equal(db.listReports({ projectId: "p1", states: ["queued"] }).length, 0)
    assert.equal(orch.reviewState("p1").paused, false)

    // Se le corta el turno a la orquestadora en plena revisión: no queda "pausada" y retoma sola.
    await sessions.send(orq.id, "LIMITE five_hour 1", { origin: "control", event: { kind: "notice", level: "info", text: "x" } })
    await until(() => db.getSession(orq.id)!.limited !== null)
    assert.equal(orch.reviewState("p1").paused, false, "un corte por el límite no es una interrupción tuya")
    await until(() => continuations().length >= 2 && db.getSession(orq.id)!.limited === null, "la orquestadora retoma", 15_000)
  })

  it("el modo AFK anota cuánto esperó el uso, y sus envíos automáticos quedan retenidos", async () => {
    const afk = new Afk({ db, hub, sessions, orchestration: orch })
    const orq = create("ORQ", "p1", "orchestrator")
    const w = create("TRABAJADORA")
    afk.start("p1", {})
    const t0 = Date.now()
    await cut(w, "five_hour", 1)
    await until(() => afk.log("p1")!.limitWaits.length === 1 && afk.log("p1")!.limitWaits[0]!.endedAt === null)
    assert.equal(afk.log("p1")!.limitWaits[0]!.kind, "five_hour")
    assert.ok(afk.log("p1")!.limitWaits[0]!.since >= t0)
    // Una propuesta que sale sola con la cuenta sin uso: se aprueba, pero el mensaje espera.
    const d = {
      id: "d_afk",
      projectId: "p1",
      kind: "prompt" as const,
      targetSessionId: w.id,
      newSession: null,
      title: "Tarea",
      prompt: "Hacé la tarea",
      state: "ready" as const,
      createdBy: orq.id,
      createdAt: 1,
      updatedAt: 1,
      decidedAt: null,
      edited: false,
      revision: 1,
      subagents: [],
      fresh: false,
      model: null,
      effort: null,
      steps: [],
      planState: null,
      currentStep: null,
      planNote: null,
      revises: null,
      hold: false,
      sentBy: null,
    }
    db.insertDraft(d)
    await orch.sendDraft("d_afk", {}, true)
    assert.equal(db.getDraft("d_afk")!.state, "sent")
    assert.equal(db.getDraft("d_afk")!.sentBy, "afk")
    assert.ok(!inputs().some((t) => t.includes("Hacé la tarea")))
    const held = sessions.view(db.getSession(w.id)!).held
    assert.equal(held.length, 1)
    assert.equal(held[0]!.draftTitle, "Tarea")
    assert.equal(held[0]!.text, "Hacé la tarea", "el chat muestra el prompt, sin el encabezado de AFK")
    await until(() => limits.accountLimit("acc") === null && inputs().some((t) => t.includes("Hacé la tarea")), "sale al renovarse")
    assert.match(inputs().find((t) => t.includes("Hacé la tarea"))!, /^El usuario está AFK/)
    const done = afk.log("p1")!.limitWaits
    assert.equal(done.length, 1)
    assert.ok(done[0]!.endedAt !== null && done[0]!.endedAt >= done[0]!.since)
    afk.dispose()
  })

  it("reiniciar para actualizar con la cuenta sin uso: no se le manda el «seguí» del reinicio; las que seguían trabajando quedan marcadas y las retoma el límite", async () => {
    const cutOne = create("CORTADA")
    const busy = create("OCUPADA")
    await sessions.send(busy.id, "LARGO", { origin: "user" })
    await until(() => sessions.statusOf(busy.id) === "working")
    await cut(cutOne, "five_hour", 2)
    const restart = new Restart({ home: dir, version: "9.9.9", sessions, hub, clientWaitMs: 0, retryDelaysMs: [50] })
    restart.prepare("update")
    const saved = restart.onShutdown()!
    assert.deepEqual(saved.sessions.map((s) => [s.id, s.status]).sort(), [[busy.id, "working"], [cutOne.id, "idle"]].sort())
    limits.dispose()
    await sessions.shutdown()

    sessions = manager({ strict: true })
    orch = new Orchestration(db, hub, sessions)
    limits = limitsOf(sessions, orch)
    const result = await new Restart({ home: dir, version: "9.9.9", sessions, hub, clientWaitMs: 0, retryDelaysMs: [50] }).resumePending()
    assert.equal(result.resumed.length, 2)
    // Con la cuenta sin uso, a la que trabajaba no se le pide que siga ahora (gastaría un intento): queda un aviso y una marca.
    assert.ok(!inputs().some((t) => t.includes("control-plane se reinició para actualizarse y cortó tu turno")))
    assert.ok(events(busy.id).some((e) => e.kind === "notice" && e.text.includes("espera que se renueve el uso y sigue sola")))
    assert.equal(db.getSession(busy.id)!.limited?.interrupted, true, "queda marcada: si no, nadie la retomaría")
    assert.ok(sessions.isRunning(cutOne.id))
    // Las dos siguen cuando se renueve, por el límite (una vez cada una).
    limits.start()
    await until(() => limits.accountLimit("acc") === null && continuations().length === 2, "las retomó el límite", 15_000)
    await sleep(300)
    assert.equal(continuations().length, 2)
    assert.deepEqual([db.getSession(busy.id)!.limited, db.getSession(cutOne.id)!.limited], [null, null])
  })

  it("«Reintentar ahora» o la renovación repetidos no mandan dos veces lo retenido ni lo desordenan", async () => {
    const a = create("UNA")
    await cut(a, "five_hour", 1)
    for (const t of ["uno", "dos", "tres"]) await limits.sendOrHold(a.id, t, { origin: "user" })
    limits.setResume(a.id, false)
    await Promise.all([limits.retrySession(a.id), limits.retrySession(a.id), limits.retrySession(a.id)])
    await until(() => limits.accountLimit("acc") === null && inputs().includes("tres"), "salieron los tres")
    await sleep(300)
    assert.deepEqual(inputs().filter((t) => ["uno", "dos", "tres"].includes(t)), ["uno", "dos", "tres"], "cada uno una vez, en orden")
    assert.equal(db.listHeld().length, 0)
  })

  it("si lo que se mandó al renovarse vuelve a cortarse, no se suelta el resto de lo retenido (el primer mensaje hace de prueba)", async () => {
    const a = create("UNA")
    await cut(a, "five_hour", 1)
    limits.setResume(a.id, false)
    for (const t of ["uno", "dos", "tres"]) await limits.sendOrHold(a.id, t, { origin: "user" })
    // Cuando se renueve, sigue sin haber uso (otra ventana).
    fs.writeFileSync(limitFile(), JSON.stringify({ until: Date.now() + 60_000, kind: "seven_day" }))
    await until(() => inputs().includes("uno"), "salió el primero")
    await until(() => limits.accountLimit("acc")?.kind === "seven_day", "se volvió a frenar")
    await sleep(500)
    assert.ok(!inputs().includes("dos") && !inputs().includes("tres"), "el resto sigue retenido")
    assert.deepEqual(sessions.view(db.getSession(a.id)!).held.map((h) => h.text), ["dos", "tres"])
    // Cuando hay uso de verdad, salen en orden.
    fs.rmSync(limitFile())
    limits.retryAccount("acc")
    await until(() => inputs().includes("tres"), "salieron los demás")
    assert.deepEqual(inputs().filter((t) => ["dos", "tres"].includes(t)), ["dos", "tres"])
  })

  it("«No retomar» o detenerla mientras esperaba no deja colgada a la orquestadora: su revisión queda en pausa", async () => {
    const orq = create("ORQ", "p1", "orchestrator")
    const w = create("TRABAJADORA")
    await sessions.send(orq.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(orq.id) === "idle")
    orch.report(db.getSession(w.id)!, { status: "done", summary: "Listo" })
    await until(() => inputs().some((t) => t.includes("[control-plane] Cola de resultados")), "se entregó el lote")
    await until(() => db.listReports({ projectId: "p1", states: ["reviewed"] }).length === 1)
    // Una revisión abierta (la orquestadora estaba leyendo el lote cuando se cortó).
    db.updateReport(db.listReports({ projectId: "p1" })[0]!.id, { state: "in_review" })
    assert.equal(orch.reviewState("p1").inReview, 1)
    await sessions.send(orq.id, "LIMITE five_hour 30", { origin: "control", event: { kind: "notice", level: "info", text: "x" } })
    await until(() => db.getSession(orq.id)!.limited !== null)
    assert.equal(orch.reviewState("p1").paused, false)
    limits.setResume(orq.id, false)
    assert.equal(orch.reviewState("p1").paused, true, "con «No retomar» nadie va a cerrar esa revisión: queda en pausa para que la retomes")
  })

  it("el límite de un modelo que vence libera lo que esperaba a esa sesión (aunque no siga sola)", async () => {
    const orq = create("OPUS-ORQ", "p1", "orchestrator")
    const w = create("TRABAJADORA")
    await sessions.send(orq.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(orq.id) === "idle")
    await cut(orq, "other", 1)
    limits.setResume(orq.id, false)
    orch.report(db.getSession(w.id)!, { status: "done", summary: "Listo" })
    await sleep(300)
    assert.ok(!inputs().some((t) => t.includes("Cola de resultados")), "mientras dura no se le entrega")
    await until(() => inputs().some((t) => t.includes("[control-plane] Cola de resultados")), "al vencer se entrega la cola", 10_000)
    assert.equal(db.getSession(orq.id)!.limited, null)
  })

  it("una renovación a ciegas que se vuelve a cortar es la misma tanda: un solo aviso y un solo lapso anotado", async () => {
    const a = create("UNA")
    await sessions.send(a.id, "hola", { origin: "user" })
    await until(() => sessions.statusOf(a.id) === "idle")
    const hit = () => limits.hit(db.getSession(a.id)!, "acc", { kind: "five_hour", message: "You've hit your session limit", resetText: null }, null)
    hit()
    assert.equal(limits.accountLimit("acc")!.source, "fallback")
    const since = limits.accountLimit("acc")!.since
    await until(() => limits.accountLimit("acc") === null, "probó a ciegas")
    hit() // vuelve a cortarse
    assert.equal(limits.accountLimit("acc")!.since, since)
    await until(() => limits.accountLimit("acc") === null)
    hit()
    await sleep(150)
    assert.equal(db.listLimitWaits("acc", 0, Date.now()).length, 1)
    assert.equal(toasts().filter((t) => t.title.startsWith("Se terminó el uso")).length, 1, "un aviso por tanda")
    assert.ok(!toasts().some((t) => t.title.startsWith("Se renovó el uso")), "una prueba a ciegas no es una renovación")
    assert.equal(events(a.id).filter((e) => e.kind === "notice" && e.text.startsWith("Se terminó el uso")).length, 1)
  })

  it("list_sessions (MCP) la muestra «sin uso hasta las 22:00 (límite de 5 h): sigue sola»", async () => {
    const a = create("UNA")
    const b = create("OTRA")
    await cut(a, "five_hour", 30)
    const line = (id: string) => limitLine(sessions.view(db.getSession(id)!).limited)
    assert.match(line(a.id)!, /^sin uso, hasta (las \d\d:\d\d|el .* a las \d\d:\d\d) \(límite de 5 h\): sigue sola$/)
    assert.match(line(b.id)!, /^sin uso, hasta .* \(límite de 5 h\): se le puede escribir cuando se renueve$/)
    limits.setResume(a.id, false)
    assert.doesNotMatch(line(a.id)!, /sigue sola/)
    assert.equal(limitLine(null), null)
    const at = (kind: "seven_day" | "spend", source: "event" | "fallback") => limitLine({ kind, resetsAt: Date.now() + 3_600_000, source, since: 1, interrupted: true, willResume: true })
    assert.match(at("seven_day", "event")!, /\(límite semanal\): sigue sola$/)
    assert.match(at("spend", "event")!, /\(tope de gasto\)/)
    assert.match(at("seven_day", "fallback")!, /^sin uso, reintenta a las \d\d:\d\d/)
  })
})
