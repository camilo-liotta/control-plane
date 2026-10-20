import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { kindOfLimit, parseLimitError, parseResetText } from "../src/claude/limit-text.ts"
import { StreamNormalizer, rejectedFrom } from "../src/claude/normalize.ts"

/** Los textos reales del error, con otra zona horaria (el repo es público). */
const SESSION = "You've hit your session limit · resets 10pm (America/New_York)"
const WEEKLY = "You've hit your weekly limit · resets 9am (America/New_York)"
const SPEND =
  "You've hit your individual spend limit · run /usage-credits to raise it, or visit claude.ai/admin-settings/usage · your weekly limit resets 9am (America/New_York)"

/** El instante en que el reloj de Nueva York marca esa hora (sin depender de la zona de la máquina que corre el test). */
const ny = (iso: string, offset: "-04:00" | "-05:00") => Date.parse(`${iso}${offset}`)

describe("reconocer que se acabó el uso por el texto del error", () => {
  it("el de 5 horas, el semanal y el tope de gasto, con lo que sigue a «resets»", () => {
    assert.deepEqual(parseLimitError(SESSION), { kind: "five_hour", message: SESSION, resetText: "10pm (America/New_York)" })
    assert.deepEqual(parseLimitError(WEEKLY), { kind: "seven_day", message: WEEKLY, resetText: "9am (America/New_York)" })
    // En el tope de gasto el «resets» que vale es el del final (el del semanal, que es cuando se renueva).
    assert.deepEqual(parseLimitError(SPEND), { kind: "spend", message: SPEND, resetText: "9am (America/New_York)" })
  })

  it("un límite que no se conoce es «other» (por ejemplo, el de un modelo) y lo que no es un límite no se reconoce", () => {
    assert.equal(parseLimitError("You've hit your Opus limit · resets 3pm (America/New_York)")?.kind, "other")
    assert.equal(parseLimitError("You've hit your monthly spend limit.")?.kind, "spend")
    assert.equal(parseLimitError("You've hit your usage credit limit · resets Nov 1")?.kind, "spend")
    assert.equal(parseLimitError("You've hit your session limit")?.resetText, null)
    for (const text of ["API Error: 529 Overloaded", "Prompt is too long", "Failed to refresh OAuth token: another Claude Code process is refreshing it", "", null, undefined]) {
      assert.equal(parseLimitError(text), null, String(text))
    }
    assert.equal(kindOfLimit("5-hour limit"), "five_hour")
  })
})

describe("cuándo se renueva según el texto", () => {
  it("«10pm»: la próxima vez que llega esa hora en esa zona", () => {
    // 19:30 en Nueva York (EDT, -04:00): faltan 2 h 30 min.
    assert.equal(parseResetText("10pm (America/New_York)", ny("2026-10-19T19:30:00", "-04:00")), ny("2026-10-19T22:00:00", "-04:00"))
    // 22:30: ya pasó, es mañana.
    assert.equal(parseResetText("10pm (America/New_York)", ny("2026-10-19T22:30:00", "-04:00")), ny("2026-10-20T22:00:00", "-04:00"))
    // «9am» con la hora ya pasada del día: mañana.
    assert.equal(parseResetText("9am (America/New_York)", ny("2026-10-19T09:00:01", "-04:00")), ny("2026-10-20T09:00:00", "-04:00"))
    assert.equal(parseResetText("12am (America/New_York)", ny("2026-10-19T23:00:00", "-04:00")), ny("2026-10-20T00:00:00", "-04:00"))
    assert.equal(parseResetText("12pm (America/New_York)", ny("2026-10-19T10:00:00", "-04:00")), ny("2026-10-19T12:00:00", "-04:00"))
    assert.equal(parseResetText("10:30pm (America/New_York)", ny("2026-10-19T19:30:00", "-04:00")), ny("2026-10-19T22:30:00", "-04:00"))
  })

  it("con fecha: Oct 24, 9am (y el año que viene si el día ya pasó hace tiempo)", () => {
    const now = ny("2026-10-19T19:30:00", "-04:00")
    assert.equal(parseResetText("Oct 24, 9am (America/New_York)", now), ny("2026-10-24T09:00:00", "-04:00"))
    assert.equal(parseResetText("Oct 24 at 9am (America/New_York)", now), ny("2026-10-24T09:00:00", "-04:00"))
    // Después del cambio de horario de noviembre ya es -05:00.
    assert.equal(parseResetText("Nov 9, 9am (America/New_York)", now), ny("2026-11-09T09:00:00", "-05:00"))
    assert.equal(parseResetText("Jan 3, 9am (America/New_York)", ny("2026-12-20T10:00:00", "-05:00")), ny("2027-01-03T09:00:00", "-05:00"))
  })

  it("por día de la semana y «tomorrow»", () => {
    const monday = ny("2026-10-19T19:30:00", "-04:00") // lunes
    assert.equal(parseResetText("Fri 9am (America/New_York)", monday), ny("2026-10-23T09:00:00", "-04:00"))
    assert.equal(parseResetText("Monday 9am (America/New_York)", monday), ny("2026-10-26T09:00:00", "-04:00"))
    assert.equal(parseResetText("tomorrow 9am (America/New_York)", monday), ny("2026-10-20T09:00:00", "-04:00"))
  })

  it("cruza el cambio de horario sin correrse una hora", () => {
    // El domingo 1/11/2026 a las 2:00 EDT se vuelve a las 1:00 EST: «9am» del lunes ya es -05:00.
    assert.equal(parseResetText("9am (America/New_York)", ny("2026-11-01T20:00:00", "-05:00")), ny("2026-11-02T09:00:00", "-05:00"))
    assert.equal(parseResetText("9am (America/New_York)", ny("2026-10-31T20:00:00", "-04:00")), ny("2026-11-01T09:00:00", "-05:00"))
  })

  it("otras zonas, y sin zona o con una que no existe usa la de esta máquina", () => {
    const now = Date.parse("2026-10-19T11:00:00Z")
    assert.equal(parseResetText("9am (America/Argentina/Buenos_Aires)", now), Date.parse("2026-10-19T12:00:00Z"))
    assert.equal(parseResetText("9am (UTC)", now), Date.parse("2026-10-20T09:00:00Z"))
    const local = parseResetText("10pm", now)!
    assert.equal(new Date(local).getHours(), 22)
    assert.equal(new Date(local).getMinutes(), 0)
    assert.ok(local > now && local - now <= 24 * 3_600_000)
    assert.equal(new Date(parseResetText("10pm (No/Existe)", now)!).getHours(), 22)
  })

  it("lo que no se entiende da null", () => {
    for (const text of ["", null, undefined, "pronto (America/New_York)", "soon", "99pm"]) assert.equal(parseResetText(text, Date.now()), null, String(text))
  })
})

describe("rate_limit_event y el fin de turno con el límite", () => {
  const event = (info: Record<string, unknown>) => new StreamNormalizer(() => false).handle({ type: "rate_limit_event", rate_limit_info: info })

  it("status rejected: de qué ventana es y cuándo se renueva (resetsAt llega en segundos)", () => {
    assert.deepEqual(rejectedFrom({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000 }), { kind: "five_hour", resetsAt: 1_900_000_000_000 })
    // Sin resetsAt arriba, el de la ventana.
    assert.deepEqual(rejectedFrom({ status: "rejected", rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1_900_000_100 } } }), { kind: "seven_day", resetsAt: 1_900_000_100_000 })
    assert.equal(rejectedFrom({ status: "rejected", rateLimitType: "seven_day_opus" })?.kind, "other")
    assert.equal(rejectedFrom({ status: "rejected", rateLimitType: "overage" })?.kind, "spend")
    assert.equal(rejectedFrom({ status: "rejected" })?.resetsAt, null)
  })

  it("allowed, allowed_warning y un rechazo cubierto por uso extra pago no frenan nada", () => {
    assert.equal(rejectedFrom({ status: "allowed", rateLimitType: "five_hour" }), null)
    assert.equal(rejectedFrom({ status: "allowed_warning", rateLimitType: "five_hour" }), null)
    assert.equal(rejectedFrom({ status: "rejected", rateLimitType: "five_hour", isUsingOverage: true }), null)
    assert.equal(rejectedFrom({ status: "rejected", rateLimitType: "five_hour", overageStatus: "allowed" }), null)
    assert.equal(rejectedFrom(undefined), null)
  })

  it("el evento sigue dando el uso del plan, ahora con lo que se rechazó", () => {
    const [a] = event({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1_900_000_000 } } })
    assert.equal(a!.type, "usage")
    if (a!.type !== "usage") return
    assert.equal(a.usage.status, "rejected")
    assert.equal(a.usage.fiveHour?.resetsAt, 1_900_000_000_000)
    assert.deepEqual(a.rejected, { kind: "five_hour", resetsAt: 1_900_000_000_000 })
    const [b] = event({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 1_900_000_000 } } })
    assert.equal(b!.type === "usage" ? b!.rejected : "x", null)
  })

  const result = (message: string, extra: Record<string, unknown> = {}) =>
    new StreamNormalizer(() => false).handle({ type: "result", subtype: "success", is_error: true, result: message, terminal_reason: "api_error", errors: [], total_cost_usd: 0, usage: {}, modelUsage: {}, ...extra })

  it("el turn_end trae el límite (en la acción y en el evento del chat) y sigue siendo un error", () => {
    for (const [text, kind] of [[SESSION, "five_hour"], [WEEKLY, "seven_day"], [SPEND, "spend"]] as const) {
      const actions = result(text)
      const end = actions.find((a) => a.type === "turn_end")
      assert.ok(end && end.type === "turn_end")
      assert.equal(end.ok, false)
      assert.equal(end.limit?.kind, kind)
      assert.equal(end.terminalReason, "api_error")
      const ev = actions.find((a) => a.type === "event" && a.event.kind === "turn_end")
      assert.ok(ev && ev.type === "event" && ev.event.kind === "turn_end")
      assert.equal(ev.event.limit, kind)
      assert.equal(ev.event.ok, false)
      assert.equal(ev.event.terminalReason, "api_error")
      assert.match(ev.event.error ?? "", /hit your/)
    }
  })

  it("un error que no es de uso no trae límite, ni un turno interrumpido", () => {
    const end = (actions: ReturnType<typeof result>) => actions.find((a) => a.type === "turn_end")
    assert.equal((end(result("API Error: 529 Overloaded")) as { limit: unknown }).limit, null)
    assert.equal((end(result("Prompt is too long", { terminal_reason: "blocking_limit" })) as { limit: unknown }).limit, null)
    assert.equal((end(result(SESSION, { terminal_reason: "aborted_streaming" })) as { limit: unknown }).limit, null)
    const ok = new StreamNormalizer(() => false).handle({ type: "result", subtype: "success", is_error: false, result: SESSION, total_cost_usd: 0, usage: {}, modelUsage: {} })
    assert.equal((ok.find((a) => a.type === "turn_end") as { limit: unknown }).limit, null)
  })
})
