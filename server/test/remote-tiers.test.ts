import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { fakeApi } from "./remote-fakes.ts"
import { harness, ORIGIN, type Harness, type Res } from "./remote-harness.ts"

let h: Harness
afterEach(async () => {
  const done = h
  h = undefined as never
  await done?.close()
})

const json = (r: Res) => JSON.parse(r.body) as Record<string, any>

type TierName = "read" | "respond" | "control"

/** Prende el acceso, sube el techo si hace falta y vincula un dispositivo del nivel pedido. */
async function setup(device: TierName, ceiling: TierName = device) {
  const api = fakeApi()
  h = await harness({ deps: api.deps })
  await h.enable()
  if (ceiling !== "read") {
    const res = await h.local("PATCH", "/api/remote/config", { tier: ceiling, ...(ceiling === "control" ? { confirm: "control" } : {}) })
    assert.equal(res.status, 200, res.body)
  }
  const dev = await h.pairDevice({ name: "Celu", tier: device })
  return { api, cookie: dev.cookie, deviceId: dev.deviceId }
}

/** Las rutas de respond, con un cuerpo válido, y lo que tiene que haberse llamado. */
const RESPOND: { method: string; path: string; body: unknown; fn: string }[] = [
  { method: "POST", path: "/api/sessions/s1/messages", body: { text: "hola", clientId: "c1" }, fn: "sessions.send" },
  { method: "POST", path: "/api/sessions/s1/answer", body: { requestId: "r1", answers: { "¿Seguimos?": "Sí" } }, fn: "sessions.answerQuestion" },
  { method: "POST", path: "/api/sessions/s1/permission", body: { requestId: "r1", allow: false, message: "no" }, fn: "sessions.respondPermission" },
  { method: "POST", path: "/api/sessions/s1/interrupt", body: {}, fn: "sessions.interrupt" },
  { method: "POST", path: "/api/sessions/s1/scheduled/i1/cancel", body: { clientId: "c1" }, fn: "sessions.requestCancelScheduled" },
  { method: "POST", path: "/api/drafts/d1/send", body: { title: "T", prompt: "P" }, fn: "orchestration.sendDraft" },
  { method: "PATCH", path: "/api/drafts/d1", body: { title: "T", prompt: "P" }, fn: "orchestration.editDraft" },
  { method: "POST", path: "/api/drafts/d1/discard", body: {}, fn: "orchestration.discardDraft" },
  { method: "POST", path: "/api/drafts/d1/plan/pause", body: {}, fn: "plans.userPause" },
  { method: "POST", path: "/api/drafts/d1/plan/cancel", body: {}, fn: "plans.cancel" },
  { method: "DELETE", path: "/api/projects/p1/afk", body: {}, fn: "afk.stop" },
]

describe("respond: el orden de la puerta (R5.1, pasos 4-7)", () => {
  it("un dispositivo de lectura recibe 403 remote_tier en cada ruta de respond, y nada se ejecuta", async () => {
    const { api, cookie } = await setup("read")
    for (const r of RESPOND) {
      const res = await h.remoteRequest(r.method, r.path, { cookie, body: r.body })
      assert.equal(res.status, 403, `${r.method} ${r.path}`)
      assert.equal(json(res).code, "remote_tier", `${r.method} ${r.path}`)
    }
    assert.equal(api.calls.length, 0)
  })

  it("el techo manda: un dispositivo de respond con techo de lectura recibe 403 remote_tier", async () => {
    const { api, cookie } = await setup("respond", "read")
    const res = await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} })
    assert.equal(res.status, 403)
    assert.equal(json(res).code, "remote_tier")
    assert.equal(api.calls.length, 0)
  })

  it("con nivel suficiente cada ruta de respond funciona y llega a su handler", async () => {
    const { api, cookie } = await setup("respond")
    for (const r of RESPOND) {
      const res = await h.remoteRequest(r.method, r.path, { cookie, body: r.body })
      assert.equal(res.status, 200, `${r.method} ${r.path}: ${res.body}`)
      assert.equal(api.count(r.fn), 1, `${r.method} ${r.path} debería llamar a ${r.fn}`)
    }
  })

  it("sin Origin o con uno ajeno: 403 remote_origin, y no se ejecuta nada", async () => {
    const { api, cookie } = await setup("respond")
    for (const origin of [null, "https://evil.example", "http://127.0.0.1:4700", `${ORIGIN}/`]) {
      const res = await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {}, origin })
      assert.equal(res.status, 403, String(origin))
      assert.equal(json(res).code, "remote_origin", String(origin))
    }
    assert.equal(api.calls.length, 0)
  })

  it("un cuerpo que no es JSON es 415", async () => {
    const { api, cookie } = await setup("respond")
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
      const res = await h.request(h.remotePort, {
        method: "POST",
        path: "/api/sessions/s1/messages",
        headers: { cookie, origin: ORIGIN, "content-type": contentType, "content-length": "9" },
        body: "text=hola",
      })
      assert.equal(res.status, 415, contentType)
    }
    assert.equal(api.calls.length, 0)
  })

  it("una clave de más en el cuerpo es 400 en cada ruta (y no se ejecuta nada)", async () => {
    const { api, cookie } = await setup("respond")
    for (const r of RESPOND) {
      const res = await h.remoteRequest(r.method, r.path, { cookie, body: { ...(r.body as object), extra: 1 } })
      assert.equal(res.status, 400, `${r.method} ${r.path}`)
      assert.equal(json(res).code, "remote_body", `${r.method} ${r.path}`)
    }
    assert.equal(api.calls.length, 0)
  })

  it("un cuerpo que no es un objeto es 400", async () => {
    const { api, cookie } = await setup("respond")
    for (const body of [[], "texto", 7, [1]]) {
      const res = await h.remoteRequest("POST", "/api/sessions/s1/messages", { cookie, body })
      assert.equal(res.status, 400, JSON.stringify(body))
    }
    assert.equal(api.calls.length, 0)
  })
})

describe("respond: lo que acepta cada ruta (R5.1, R5.2)", () => {
  const post = (cookie: string, path: string, body: unknown, method = "POST") => h.remoteRequest(method, path, { cookie, body })

  it("mensajes: texto de 1 a 20000, adjuntos ausentes o vacíos", async () => {
    const { api, cookie } = await setup("respond")
    const send = (body: unknown) => post(cookie, "/api/sessions/s1/messages", body)
    assert.equal((await send({ text: "a" })).status, 200)
    assert.equal((await send({ text: "x".repeat(20_000) })).status, 200)
    assert.equal((await send({ text: "ok", attachmentIds: [] })).status, 200)
    assert.equal(api.count("sessions.send"), 3)
    for (const bad of [{}, { text: "" }, { text: "x".repeat(20_001) }, { text: 5 }, { text: "ok", attachmentIds: ["a1"] }, { text: "ok", attachmentIds: "a1" }, { text: "ok", clientId: 5 }, { text: "ok", clientId: "x".repeat(101) }]) {
      assert.equal((await send(bad)).status, 400, JSON.stringify(bad).slice(0, 60))
    }
    assert.equal(api.count("sessions.send"), 3)
  })

  it("mensajes: el handler recibe solo el texto (sin adjuntos); una sesión que no existe es 400", async () => {
    const { api, cookie } = await setup("respond")
    await post(cookie, "/api/sessions/s1/messages", { text: "hola" })
    const args = api.last("sessions.send")!
    assert.equal(args[0], "s1")
    assert.equal(args[1], "hola")
    assert.deepEqual((args[2] as { attachments: unknown[] }).attachments, [])
    const res = await post(cookie, "/api/sessions/nope/messages", { text: "hola" })
    assert.equal(res.status, 400)
    assert.equal(api.count("sessions.send"), 1)
  })

  it("respuesta a una pregunta: requestId y answers de texto", async () => {
    const { api, cookie } = await setup("respond")
    const answer = (body: unknown) => post(cookie, "/api/sessions/s1/answer", body)
    assert.equal((await answer({ requestId: "r1", answers: { a: "b" } })).status, 200)
    for (const bad of [{ answers: { a: "b" } }, { requestId: "r1" }, { requestId: "", answers: {} }, { requestId: "r1", answers: { a: 1 } }, { requestId: "r1", answers: [] }, { requestId: 5, answers: {} }]) {
      assert.equal((await answer(bad)).status, 400, JSON.stringify(bad))
    }
    assert.equal(api.count("sessions.answerQuestion"), 1)
  })

  it("permiso con allow:false: requestId, allow booleano y mensaje de hasta 500; nada más", async () => {
    const { api, cookie } = await setup("respond")
    const deny = (body: unknown) => post(cookie, "/api/sessions/s1/permission", body)
    assert.equal((await deny({ requestId: "r1", allow: false })).status, 200)
    assert.equal((await deny({ requestId: "r1", allow: false, message: "x".repeat(500) })).status, 200)
    for (const bad of [
      { requestId: "r1", allow: false, message: "x".repeat(501) },
      { requestId: "r1", allow: false, message: 5 },
      { requestId: "r1", allow: false, input: { command: "ls" } },
      { requestId: "r1", allow: "no" },
      { requestId: "r1" },
      { allow: false },
      { requestId: "", allow: false },
    ]) {
      assert.equal((await deny(bad)).status, 400, JSON.stringify(bad))
    }
    assert.equal(api.count("sessions.respondPermission"), 2)
    assert.deepEqual(api.last("sessions.respondPermission"), ["s1", "r1", false, "x".repeat(500)])
  })

  it("cancelar lo programado: solo clientId opcional", async () => {
    const { api, cookie } = await setup("respond")
    assert.equal((await post(cookie, "/api/sessions/s1/scheduled/i1/cancel", {})).status, 200)
    assert.equal((await post(cookie, "/api/sessions/s1/scheduled/i1/cancel", { clientId: "c" })).status, 200)
    assert.equal((await post(cookie, "/api/sessions/s1/scheduled/i1/cancel", { clientId: 5 })).status, 400)
    assert.equal(api.count("sessions.requestCancelScheduled"), 2)
  })

  it("las rutas sin cuerpo aceptan {} y rechazan cualquier clave", async () => {
    const { api, cookie } = await setup("respond")
    for (const r of RESPOND.filter((x) => ["interrupt", "discard", "pause", "cancel"].some((k) => x.path.endsWith(k)) && !x.path.includes("scheduled"))) {
      assert.equal((await post(cookie, r.path, {}, r.method)).status, 200, r.path)
      assert.equal((await post(cookie, r.path, { x: 1 }, r.method)).status, 400, r.path)
    }
    assert.equal((await post(cookie, "/api/projects/p1/afk", {}, "DELETE")).status, 200)
    assert.equal((await post(cookie, "/api/projects/p1/afk", { until: 5 }, "DELETE")).status, 400)
    assert.equal(api.count("afk.stop"), 1)
  })

  it("un cuerpo vacío (sin tipo ni contenido) también vale en las rutas sin cuerpo", async () => {
    const { api, cookie } = await setup("respond")
    const res = await h.request(h.remotePort, { method: "POST", path: "/api/sessions/s1/interrupt", headers: { cookie, origin: ORIGIN, "content-length": "0" } })
    assert.equal(res.status, 200)
    assert.equal(api.count("sessions.interrupt"), 1)
  })
})

describe("respond: los borradores no cambian la autoridad de ejecución (R5.3)", () => {
  const FORBIDDEN_KEYS = ["model", "effort", "fresh", "subagents", "steps", "name", "role", "permissionMode", "mode", "cwd", "allowedTools", "account", "accountId", "env", "kind", "state"]

  it("enviar o editar solo admite title y prompt: cualquiera de las otras claves es 400 y no llega al handler", async () => {
    const { api, cookie } = await setup("respond")
    for (const [method, path, fn] of [
      ["POST", "/api/drafts/d1/send", "orchestration.sendDraft"],
      ["PATCH", "/api/drafts/d1", "orchestration.editDraft"],
    ] as const) {
      for (const key of FORBIDDEN_KEYS) {
        const res = await h.remoteRequest(method, path, { cookie, body: { title: "T", prompt: "P", [key]: "x" } })
        assert.equal(res.status, 400, `${method} ${path} con ${key}`)
      }
      assert.equal(api.count(fn), 0)
      assert.equal((await h.remoteRequest(method, path, { cookie, body: { title: "Otro" } })).status, 200)
      assert.equal((await h.remoteRequest(method, path, { cookie, body: {} })).status, 200)
      assert.equal((await h.remoteRequest(method, path, { cookie, body: { title: 5 } })).status, 400)
      assert.equal((await h.remoteRequest(method, path, { cookie, body: { prompt: null } })).status, 400)
      assert.deepEqual(api.last(fn), ["d1", {}])
    }
  })

  it("el handler recibe exactamente lo que se permitió (título y prompt)", async () => {
    const { api, cookie } = await setup("respond")
    await h.remoteRequest("POST", "/api/drafts/d1/send", { cookie, body: { title: "T", prompt: "P" } })
    assert.deepEqual(api.last("orchestration.sendDraft"), ["d1", { title: "T", prompt: "P" }])
  })

  it("un plan se puede pausar y cancelar con respond, pero reanudar es de control", async () => {
    const { api, cookie } = await setup("respond")
    assert.equal((await h.remoteRequest("POST", "/api/drafts/d1/plan/pause", { cookie, body: {} })).status, 200)
    assert.equal((await h.remoteRequest("POST", "/api/drafts/d1/plan/cancel", { cookie, body: {} })).status, 200)
    const resume = await h.remoteRequest("POST", "/api/drafts/d1/plan/resume", { cookie, body: {} })
    assert.equal(resume.status, 403)
    assert.equal(json(resume).code, "remote_tier")
    assert.equal(api.count("plans.resume"), 0)
  })
})

describe("respond: el permiso se clasifica por su cuerpo (R5.1)", () => {
  it("allow:true con un dispositivo de respond es 403 remote_tier y respondPermission no se llama", async () => {
    const { api, cookie } = await setup("respond")
    api.pending.set("s1:r1", { toolName: "Read", input: { file: "a" } })
    const res = await h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body: { requestId: "r1", allow: true } })
    assert.equal(res.status, 403)
    assert.equal(json(res).code, "remote_tier")
    assert.equal(api.count("sessions.respondPermission"), 0)
  })

  it("allow:false con respond sí pasa", async () => {
    const { api, cookie } = await setup("respond")
    api.pending.set("s1:r1", { toolName: "Bash", input: { command: "ls" } })
    const res = await h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body: { requestId: "r1", allow: false } })
    assert.equal(res.status, 200)
    assert.equal(api.count("sessions.respondPermission"), 1)
  })
})

describe("respond: límites de uso (R5.5)", () => {
  const msg = (cookie: string) => h.remoteRequest("POST", "/api/sessions/s1/messages", { cookie, body: { text: "hola" } })

  it("mensajes: 20 por minuto por dispositivo; el 21 es 429 con Retry-After, y al pasar el minuto vuelve a andar", async () => {
    const { api, cookie } = await setup("respond")
    for (let i = 0; i < 20; i++) assert.equal((await msg(cookie)).status, 200, `mensaje ${i + 1}`)
    const over = await msg(cookie)
    assert.equal(over.status, 429)
    assert.equal(json(over).code, "remote_rate_limited")
    assert.ok(Number(over.headers["retry-after"]) >= 1)
    assert.equal(api.count("sessions.send"), 20)
    h.clock.now += 61_000
    assert.equal((await msg(cookie)).status, 200)
  })

  it("el envío de borradores cuenta junto con los mensajes", async () => {
    const { cookie } = await setup("respond")
    for (let i = 0; i < 10; i++) assert.equal((await msg(cookie)).status, 200)
    for (let i = 0; i < 10; i++) assert.equal((await h.remoteRequest("POST", "/api/drafts/d1/send", { cookie, body: {} })).status, 200)
    assert.equal((await msg(cookie)).status, 429)
    assert.equal((await h.remoteRequest("POST", "/api/drafts/d1/send", { cookie, body: {} })).status, 429)
  })

  it("mensajes: 200 por hora aunque cada minuto esté libre", async () => {
    const { cookie } = await setup("respond")
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 20; i++) assert.equal((await msg(cookie)).status, 200, `lote ${batch} mensaje ${i}`)
      h.clock.now += 61_000
    }
    const over = await msg(cookie)
    assert.equal(over.status, 429)
    assert.ok(Number(over.headers["retry-after"]) > 60)
  })

  it("editar y descartar borradores: 60 por minuto por dispositivo", async () => {
    const { cookie } = await setup("respond")
    for (let i = 0; i < 30; i++) {
      assert.equal((await h.remoteRequest("PATCH", "/api/drafts/d1", { cookie, body: { title: "x" } })).status, 200)
      assert.equal((await h.remoteRequest("POST", "/api/drafts/d1/discard", { cookie, body: {} })).status, 200)
    }
    assert.equal((await h.remoteRequest("PATCH", "/api/drafts/d1", { cookie, body: { title: "x" } })).status, 429)
    assert.equal((await h.remoteRequest("POST", "/api/drafts/d1/discard", { cookie, body: {} })).status, 429)
  })

  it("respuestas a permisos: 30 por minuto por dispositivo", async () => {
    const { cookie } = await setup("respond")
    const deny = () => h.remoteRequest("POST", "/api/sessions/s1/permission", { cookie, body: { requestId: "r1", allow: false } })
    for (let i = 0; i < 30; i++) assert.equal((await deny()).status, 200, `permiso ${i + 1}`)
    assert.equal((await deny()).status, 429)
  })

  it("escrituras en total: 60 por minuto entre todos los dispositivos", async () => {
    const { cookie } = await setup("respond")
    const other = await h.pairDevice({ name: "Otro", tier: "respond" })
    const stop = (c: string) => h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie: c, body: {} })
    for (let i = 0; i < 40; i++) assert.equal((await stop(cookie)).status, 200)
    for (let i = 0; i < 20; i++) assert.equal((await stop(other.cookie)).status, 200)
    const over = await stop(other.cookie)
    assert.equal(over.status, 429)
    assert.ok(Number(over.headers["retry-after"]) >= 1)
  })

  it("un pedido con el cuerpo inválido no gasta el cupo", async () => {
    const { cookie } = await setup("respond")
    for (let i = 0; i < 30; i++) assert.equal((await h.remoteRequest("POST", "/api/sessions/s1/messages", { cookie, body: { text: "" } })).status, 400)
    for (let i = 0; i < 20; i++) assert.equal((await msg(cookie)).status, 200)
  })
})

describe("respond: cerrar la sesión de este dispositivo (POST /api/remote/logout)", () => {
  it("revoca al dispositivo, expira la cookie y el próximo pedido es 401", async () => {
    const { cookie, deviceId } = await setup("respond")
    const res = await h.remoteRequest("POST", "/api/remote/logout", { cookie, body: {} })
    assert.equal(res.status, 200)
    assert.match(String(res.headers["set-cookie"]), /^__Host-cp_device=; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=0$/)
    assert.equal((await h.remoteRequest("GET", "/api/remote/capabilities", { cookie })).body.includes('"paired":true'), false)
    assert.equal((await h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} })).status, 401)
    assert.equal(h.remote.pairing.list().some((d) => d.id === deviceId), false)
  })

  it("un dispositivo de lectura no puede (es de respond); y desde esta máquina no existe", async () => {
    const { cookie } = await setup("read")
    assert.equal(json(await h.remoteRequest("POST", "/api/remote/logout", { cookie, body: {} })).code, "remote_tier")
    const local = await h.local("POST", "/api/remote/logout", {})
    assert.equal(local.status, 403)
  })

  it("el cuerpo tiene que estar vacío", async () => {
    const { cookie } = await setup("respond")
    assert.equal((await h.remoteRequest("POST", "/api/remote/logout", { cookie, body: { x: 1 } })).status, 400)
  })
})

describe("el corte sigue valiendo en cada nivel (R2.12)", () => {
  for (const tier of ["read", "respond", "control"] as const) {
    it(`con un dispositivo de ${tier}, "cortar" cierra el listener y el próximo pedido se rechaza`, async () => {
      const { cookie } = await setup(tier)
      assert.equal((await h.remoteRequest("GET", "/api/projects/archived", { cookie })).status !== 0, true)
      assert.equal((await h.local("POST", "/api/remote/kill")).status, 200)
      assert.equal(h.db.getRemoteConfig().enabled, false)
      await assert.rejects(h.remoteRequest("POST", "/api/sessions/s1/interrupt", { cookie, body: {} }), /ECONNREFUSED/)
    })
  }
})

describe("contrato de reglas de cuerpo", () => {
  it("cada ruta de respond y de control tiene su regla, y no hay reglas sin ruta", async () => {
    const { RULE_KEYS, RULED_ROUTES } = await import("../src/remote/rules.ts")
    assert.deepEqual([...RULE_KEYS].sort(), [...RULED_ROUTES].sort())
  })

  it("las rutas remotas de respond y control no tocan nada que no esté en su lista cerrada de claves", async () => {
    const { checkBody } = await import("../src/remote/rules.ts")
    // Una ruta sin regla (o inexistente) nunca valida, aunque el cuerpo esté vacío.
    assert.equal(checkBody("POST", "/api/accounts", {}).ok, false)
    assert.equal(checkBody("GET", "/api/snapshot", undefined).ok, false)
    assert.equal(checkBody("POST", "/api/sessions/:id/interrupt", undefined).ok, true)
    assert.equal(checkBody("POST", "/api/sessions/:id/interrupt", null).ok, true)
  })
})
