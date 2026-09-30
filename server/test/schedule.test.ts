import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { describeCron, isPinned, nextRun, parseCron } from "../src/cron.ts"
import { readDurable, RECURRING_MAX_AGE_MS, Schedules } from "../src/schedule.ts"
import type { StoredEvent, TimelineEvent } from "../src/shared/types.ts"

// Fechas en la hora local, como las usa Claude Code.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const iso = (t: Date | null) =>
  t ? `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()} ${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}` : null

describe("cron de 5 campos", () => {
  it("calcula la próxima ejecución en la hora local", () => {
    const from = at(2026, 9, 29, 14, 7) // martes
    assert.equal(iso(nextRun("* * * * *", from)), "2026-9-29 14:08")
    assert.equal(iso(nextRun("*/15 * * * *", from)), "2026-9-29 14:15")
    assert.equal(iso(nextRun("0 9 * * *", from)), "2026-9-30 9:00")
    assert.equal(iso(nextRun("30 14 * * *", at(2026, 9, 29, 14, 29))), "2026-9-29 14:30")
    assert.equal(iso(nextRun("0 9 * * 1-5", at(2026, 10, 2, 10))), "2026-10-5 9:00", "del viernes salta al lunes")
    assert.equal(iso(nextRun("0 9 * * mon,fri", from)), "2026-10-2 9:00")
    assert.equal(iso(nextRun("0 0 1 * *", from)), "2026-10-1 0:00")
    assert.equal(iso(nextRun("23 1 30 9 *", from)), "2026-9-30 1:23", "una vez, día y mes fijos")
    assert.equal(iso(nextRun("0 12 * * 7", from)), "2026-10-4 12:00", "el 7 también es domingo")
    assert.equal(iso(nextRun("0 8-18/5 * * *", from)), "2026-9-29 18:00")
  })

  it("con día del mes y de la semana, alcanza con uno (como cron)", () => {
    // El 1 de octubre de 2026 es jueves; el primer lunes después del 29/9 es el 5.
    assert.equal(iso(nextRun("0 9 1 * 1", at(2026, 9, 29))), "2026-10-1 9:00")
    assert.equal(iso(nextRun("0 9 30 2 *", at(2026, 1, 1))), null, "el 30 de febrero no existe")
  })

  it("rechaza lo que no es un cron", () => {
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "a b c d e", "5-1 * * * *"]) assert.throws(() => parseCron(bad), bad)
  })

  it("lo dice en palabras", () => {
    assert.equal(describeCron("* * * * *"), "cada minuto")
    assert.equal(describeCron("*/5 * * * *"), "cada 5 minutos")
    assert.equal(describeCron("0 * * * *"), "cada hora, en punto")
    assert.equal(describeCron("0 9 * * *"), "todos los días a las 9:00")
    assert.equal(describeCron("30 18 * * 1-5"), "de lunes a viernes a las 18:30")
    assert.equal(describeCron("0 10 * * 6,0"), "los sábados y domingos a las 10:00")
    assert.equal(describeCron("0 9 * * 1,3"), "los lunes y miércoles a las 9:00")
    assert.equal(describeCron("0 9 15 * *"), "el día 15 de cada mes a las 9:00")
    assert.equal(describeCron("41 1 30 9 *"), "el 30 de septiembre a las 1:41")
    assert.equal(describeCron("7,37 */3 * 1-6 *"), "7,37 */3 * 1-6 *", "lo raro, tal cual")
    assert.equal(isPinned("41 1 30 9 *"), true)
    assert.equal(isPinned("0 9 * * *"), false)
  })
})

/** Eventos como los que guarda el server del stream de Claude Code (armados a mano). */
function timeline() {
  const events: StoredEvent[] = []
  let id = 0
  const add = (ts: number, event: TimelineEvent) => {
    const e = { id: ++id, sessionId: "s1", ts, event }
    events.push(e)
    return e
  }
  return {
    events,
    add,
    use: (ts: number, useId: string, name: string, input: unknown) => add(ts, { kind: "tool_use", id: useId, name, input, parent: null }),
    result: (ts: number, useId: string, content: string, structured?: unknown, isError = false) =>
      add(ts, { kind: "tool_result", toolUseId: useId, content, isError, parent: null, ...(structured !== undefined ? { structured } : {}) }),
    user: (ts: number, text: string) => add(ts, { kind: "user", text, origin: "external", uuid: `u${id}` }),
  }
}

describe("lo programado por una sesión", () => {
  const t0 = at(2026, 9, 29, 14, 0)
  const running = { claudeSessionId: "c1", dirs: [], running: true, runtimeStartedAt: t0 - 60_000 }

  it("un cron recurrente: se crea, se dispara, se cancela", () => {
    const tl = timeline()
    let now = t0 + 1000
    const s = new Schedules({ load: () => tl.events, now: () => now })
    tl.use(t0, "tu1", "CronCreate", { cron: "*/20 * * * *", prompt: "revisá el deploy", recurring: true })
    tl.result(t0, "tu1", "Scheduled recurring job a1b2c3d4 (Every 20 minutes). Session-only (not written to disk, dies when Claude exits).", {
      id: "a1b2c3d4",
      humanSchedule: "Every 20 minutes",
      recurring: true,
      durable: false,
    })
    let [item] = s.list("s1", running)
    assert.equal(item!.id, "a1b2c3d4")
    assert.equal(item!.status, "active")
    assert.equal(item!.when, "cada 20 minutos")
    assert.equal(item!.nextAt, at(2026, 9, 29, 14, 20))
    assert.equal(item!.paused, false)

    now = at(2026, 9, 29, 14, 21)
    assert.equal(s.observe(tl.user(at(2026, 9, 29, 14, 20), "revisá el deploy")), true, "el disparo cambia lo programado")
    ;[item] = s.list("s1", running)
    assert.equal(item!.fires, 1)
    assert.equal(item!.lastFiredAt, at(2026, 9, 29, 14, 20))
    assert.equal(item!.nextAt, at(2026, 9, 29, 14, 40))

    assert.equal(s.observe(tl.use(now, "tu2", "CronDelete", { id: "a1b2c3d4" })), false)
    assert.equal(s.observe(tl.result(now, "tu2", "Cancelled job a1b2c3d4.", { id: "a1b2c3d4" })), true)
    ;[item] = s.list("s1", running)
    assert.equal(item!.status, "cancelled")
    assert.equal(item!.nextAt, null)
  })

  it("uno de una vez corre en su hora y queda como ya corrido; si pasa la hora sin correr, vencido", () => {
    const tl = timeline()
    let now = t0
    const s = new Schedules({ load: () => tl.events, now: () => now })
    tl.use(t0, "tu1", "CronCreate", { cron: "30 14 29 9 *", prompt: "mandá el resumen", recurring: false })
    tl.result(t0, "tu1", "Scheduled one-shot job 0000beef (30 14 29 9 *).", { id: "0000beef", humanSchedule: "30 14 29 9 *", recurring: false, durable: false })
    tl.use(t0, "tu2", "CronCreate", { cron: "45 14 29 9 *", prompt: "otra cosa", recurring: false })
    tl.result(t0, "tu2", "Scheduled one-shot job 0000cafe (45 14 29 9 *).", { id: "0000cafe", recurring: false, durable: false })
    const first = s.list("s1", running).find((i) => i.id === "0000beef")!
    assert.equal(first.when, "una vez, a las 14:30")
    assert.equal(first.recurring, false)
    s.observe(tl.user(at(2026, 9, 29, 14, 30), "mandá el resumen"))
    now = at(2026, 9, 29, 15, 0)
    const list = s.list("s1", running)
    assert.equal(list.find((i) => i.id === "0000beef")!.status, "done")
    assert.equal(list.find((i) => i.id === "0000cafe")!.status, "missed")
  })

  it("los de la sesión se pierden cuando termina el proceso; con la sesión detenida, lo durable queda en pausa", () => {
    const tl = timeline()
    const s = new Schedules({ load: () => tl.events, now: () => t0 + 1000 })
    tl.use(t0, "tu1", "CronCreate", { cron: "0 9 * * *", prompt: "a", recurring: true })
    tl.result(t0, "tu1", "Scheduled recurring job 11111111 (…).", { id: "11111111", recurring: true, durable: false })
    tl.use(t0, "tu2", "CronCreate", { cron: "0 10 * * *", prompt: "b", recurring: true, durable: true })
    tl.result(t0, "tu2", "Scheduled recurring job 22222222 (…). Persisted to .claude/scheduled_tasks.json.", { id: "22222222", recurring: true, durable: true })
    const stopped = { claudeSessionId: "c1", dirs: [], running: false, runtimeStartedAt: null }
    const by = Object.fromEntries(s.list("s1", stopped).map((i) => [i.id, i]))
    assert.equal(by["11111111"]!.status, "lost")
    assert.equal(by["22222222"]!.status, "active")
    assert.equal(by["22222222"]!.paused, true, "no corre hasta que la sesión vuelva a arrancar")
    // Arrancó de nuevo (con --resume): lo de la sesión anterior no vuelve, lo durable sí.
    const again = Object.fromEntries(s.list("s1", { ...stopped, running: true, runtimeStartedAt: t0 + 500 }).map((i) => [i.id, i]))
    assert.equal(again["11111111"]!.status, "lost")
    assert.equal(again["22222222"]!.paused, false)
  })

  it("los recurrentes vencen a los 7 días", () => {
    const tl = timeline()
    const s = new Schedules({ load: () => tl.events, now: () => t0 + RECURRING_MAX_AGE_MS + 1 })
    tl.use(t0, "tu1", "CronCreate", { cron: "0 9 * * *", prompt: "a" })
    tl.result(t0, "tu1", "Scheduled recurring job 33333333 (Every day at 9am).", { id: "33333333", recurring: true, durable: true })
    assert.equal(s.list("s1", { ...running, runtimeStartedAt: t0 - 1 })[0]!.status, "expired")
  })

  it("los wakeups de /loop: uno nuevo reemplaza al anterior, vuelven con el primer mensaje después de su hora y stop los cancela", () => {
    const tl = timeline()
    let now = t0
    const s = new Schedules({ load: () => tl.events, now: () => now })
    tl.use(t0, "w1", "ScheduleWakeup", { delaySeconds: 1200, reason: "esperar el CI", prompt: "<<autonomous-loop-dynamic>>" })
    tl.result(t0, "w1", "Next wakeup scheduled for 14:20:00 (in 1200s).", { scheduledFor: at(2026, 9, 29, 14, 20), clampedDelaySeconds: 1200, wasClamped: false })
    let [w] = s.list("s1", running)
    assert.equal(w!.kind, "wakeup")
    assert.equal(w!.when, "vuelve a las 14:20")
    assert.equal(w!.reason, "esperar el CI")
    s.observe(tl.use(t0 + 1000, "w2", "ScheduleWakeup", { delaySeconds: 1800, reason: "otra vuelta", prompt: "x" }))
    s.observe(tl.result(t0 + 1000, "w2", "Next wakeup scheduled for 14:30:00 (in 1800s).", { scheduledFor: at(2026, 9, 29, 14, 30), clampedDelaySeconds: 1800, wasClamped: false }))
    const list = s.list("s1", running)
    assert.equal(list.find((i) => i.id === "w1")!.status, "cancelled", "lo reemplazó el nuevo")
    assert.equal(list.find((i) => i.id === "w2")!.status, "active")
    s.observe(tl.user(at(2026, 9, 29, 14, 30), "(el prompt expandido del loop)"))
    now = at(2026, 9, 29, 14, 31)
    ;[w] = s.list("s1", running).filter((i) => i.id === "w2")
    assert.equal(w!.status, "done")
    tl.use(now, "w3", "ScheduleWakeup", { delaySeconds: 60, reason: "r", prompt: "p" })
    tl.result(now, "w3", "Next wakeup scheduled for 14:32:00 (in 60s).", { scheduledFor: now + 60_000, clampedDelaySeconds: 60, wasClamped: false })
    tl.use(now, "w4", "ScheduleWakeup", { stop: true })
    tl.result(now, "w4", "Loop stopped — cancelled 1 pending wakeup(s).", { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 })
    const fresh = new Schedules({ load: () => tl.events, now: () => now })
    assert.equal(fresh.list("s1", running).find((i) => i.id === "w3")!.status, "cancelled")
    assert.equal(fresh.list("s1", running).some((i) => i.id === "w4"), false)
  })

  it("un error o un tool_use sin resultado no programa nada; tampoco un disparo ajeno", () => {
    const tl = timeline()
    const s = new Schedules({ load: () => tl.events, now: () => t0 })
    tl.use(t0, "tu1", "CronCreate", { cron: "0 9 * * *", prompt: "a" })
    tl.result(t0, "tu1", "Invalid cron expression", undefined, true)
    tl.use(t0, "tu2", "CronCreate", { cron: "0 9 * * *", prompt: "b" })
    assert.deepEqual(s.list("s1", running), [])
  })

  it("sin el resultado estructurado, saca el id del texto", () => {
    const tl = timeline()
    const s = new Schedules({ load: () => tl.events, now: () => t0 })
    tl.use(t0, "tu1", "CronCreate", { cron: "0 9 * * *", prompt: "a", recurring: true })
    tl.result(t0, "tu1", "Scheduled recurring job 9f8e7d6c (Every day at 9:00 AM). Session-only.")
    assert.equal(s.list("s1", running)[0]!.id, "9f8e7d6c")
  })

  it("las rutinas en la nube se muestran como tales, sin próxima ejecución local", () => {
    const tl = timeline()
    const s = new Schedules({ load: () => tl.events, now: () => t0 })
    tl.use(t0, "r1", "RemoteTrigger", { action: "create", body: { name: "Informe semanal", cron_expression: "0 12 * * 1", enabled: true } })
    tl.result(t0, "r1", 'HTTP 200\n{"trigger":{"id":"trig_01X","name":"Informe semanal"}}')
    const [r] = s.list("s1", { ...running, running: false })
    assert.equal(r!.kind, "routine")
    assert.equal(r!.id, "trig_01X")
    assert.equal(r!.when, "los lunes a las 12:00 (en la nube)")
    assert.equal(r!.nextAt, null)
    assert.equal(r!.paused, false, "no depende de la sesión")
  })

  it("lee los durables de .claude/scheduled_tasks.json: completa lo visto y suma lo que no", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-sched-"))
    fs.mkdirSync(path.join(dir, ".claude"))
    const write = (tasks: unknown[]) => fs.writeFileSync(path.join(dir, ".claude", "scheduled_tasks.json"), JSON.stringify({ tasks }))
    write([
      { id: "44444444", cron: "0 9 * * *", prompt: "a", createdAt: t0, recurring: true, lastFiredAt: t0 + 5000, createdBySessionId: "c1" },
      { id: "55555555", cron: "0 18 * * *", prompt: "de antes", createdAt: t0 - 1000, recurring: true, createdBySessionId: "c1" },
      { id: "66666666", cron: "0 7 * * *", prompt: "de otra sesión", createdAt: t0, recurring: true, createdBySessionId: "otra" },
      { id: "roto", cron: "0 7 * * *" },
    ])
    assert.equal(readDurable(dir)!.length, 3)
    const tl = timeline()
    tl.use(t0, "tu1", "CronCreate", { cron: "0 9 * * *", prompt: "a", recurring: true, durable: true })
    tl.result(t0, "tu1", "Scheduled recurring job 44444444 (…).", { id: "44444444", recurring: true, durable: true })
    let now = t0 + 10_000
    const s = new Schedules({ load: () => tl.events, now: () => now })
    const opts = { claudeSessionId: "c1", dirs: [dir], running: true, runtimeStartedAt: t0 - 1 }
    const by = Object.fromEntries(s.list("s1", opts).map((i) => [i.id, i]))
    assert.deepEqual(Object.keys(by).sort(), ["44444444", "55555555"])
    assert.equal(by["44444444"]!.lastFiredAt, t0 + 5000)
    assert.equal(by["55555555"]!.durable, true)
    // Si ya no está en el archivo, lo borraron.
    write([])
    now += 5000
    assert.equal(s.list("s1", opts).find((i) => i.id === "44444444")!.status, "cancelled")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("se arma de la base una sola vez y después sigue en vivo", () => {
    const tl = timeline()
    let loads = 0
    const s = new Schedules({ load: () => (loads++, tl.events), now: () => t0 })
    assert.equal(s.observe(tl.user(t0, "hola")), false, "un mensaje suelto no arma nada")
    tl.use(t0, "tu1", "CronCreate", { cron: "0 9 * * *", prompt: "a" })
    assert.equal(s.observe(tl.events.at(-1)!), true)
    s.observe(tl.result(t0, "tu1", "Scheduled recurring job 77777777.", { id: "77777777", recurring: true, durable: false }))
    assert.equal(s.list("s1", running).length, 1)
    assert.equal(loads, 1)
  })
})
