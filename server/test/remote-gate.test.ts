import assert from "node:assert/strict"
import { describe, it } from "node:test"

import Fastify from "fastify"

import { decide, MAX_BODY_BYTES, securityHeaders, type GateContext, type GateRequest } from "../src/remote/gate.ts"
import { applyPolicy, type Tier } from "../src/remote/policy.ts"

const ORIGIN = "https://example-host.tailnet-name.ts.net:8443"
const device = (tier: Tier = "read") => ({ id: "dev1", tier })

const req = (over: Partial<GateRequest> = {}): GateRequest => ({
  method: "GET",
  tier: "read",
  pattern: "/api/snapshot",
  path: "/api/snapshot",
  contentLength: undefined,
  transferEncoding: undefined,
  origin: undefined,
  contentType: undefined,
  upgrade: false,
  ...over,
})

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  authenticate: () => null,
  expectedOrigin: ORIGIN,
  ceiling: "read",
  ...over,
})

const denied = (d: ReturnType<typeof decide>) => {
  assert.equal(d.allow, false)
  return d as Extract<ReturnType<typeof decide>, { allow: false }>
}

describe("decide(): orden de la puerta remota (R4.2, R5.1 1-3)", () => {
  it("1. tamaño: más de 256 KiB es 413, y un POST sin largo es 411, antes que cualquier otra cosa", () => {
    const big = denied(decide(req({ method: "POST", tier: "never", contentLength: String(MAX_BODY_BYTES + 1) }), ctx()))
    assert.equal(big.status, 413)
    const noLen = denied(decide(req({ method: "POST", tier: "never" }), ctx()))
    assert.equal(noLen.status, 411)
    const chunked = denied(decide(req({ method: "POST", tier: "read", transferEncoding: "chunked" }), ctx({ authenticate: () => device() })))
    assert.equal(chunked.status, 411)
    assert.equal(denied(decide(req({ method: "PATCH", tier: "never" }), ctx())).status, 411)
    // GET sin largo está bien; y justo en el tope pasa este paso.
    assert.equal(decide(req({ tier: "public", pattern: "/*", path: "/index.html" }), ctx()).allow, true)
    assert.notEqual(denied(decide(req({ method: "POST", tier: "never", contentLength: String(MAX_BODY_BYTES) }), ctx())).status, 413)
  })

  it("2. nivel never o sin entrada: 403 remote_forbidden, aunque haya cookie válida", () => {
    for (const tier of ["never", undefined] as const) {
      const d = denied(decide(req({ tier, pattern: tier ? "/api/accounts" : null, path: "/api/accounts" }), ctx({ authenticate: () => device("control") })))
      assert.equal(d.status, 403)
      assert.equal(d.code, "remote_forbidden")
    }
  })

  it("2. una ruta desconocida (sin patrón) también es 403: no se filtra qué existe", () => {
    const d = denied(decide(req({ tier: undefined, pattern: null, path: "/api/lo-que-sea" }), ctx()))
    assert.equal(d.status, 403)
    assert.equal(d.code, "remote_forbidden")
  })

  it("2. el comodín de la web estática no abre /api, /mcp, /hooks ni /ws (el 404 se trata como never)", () => {
    for (const path of ["/api/nada", "/api", "/mcp/abc", "/hooks/x/compact", "/ws/terminal", "/ws", "/API/x"]) {
      const d = denied(decide(req({ tier: "public", pattern: "/*", path }), ctx()))
      assert.equal(d.code, "remote_forbidden", path)
    }
    for (const path of ["/", "/index.html", "/assets/app.js", "/apiary.png", "/p/abc"]) {
      assert.equal(decide(req({ tier: "public", pattern: "/*", path }), ctx()).allow, true, path)
    }
  })

  it("3. public pasa sin dispositivo y sin consultar la autenticación", () => {
    let asked = 0
    const d = decide(req({ tier: "public", pattern: "/*", path: "/index.html" }), ctx({ authenticate: () => (asked++, null) }))
    assert.equal(d.allow, true)
    assert.equal(asked, 0)
  })

  it("4. lo demás sin dispositivo: 401 remote_unpaired", () => {
    const d = denied(decide(req(), ctx()))
    assert.equal(d.status, 401)
    assert.equal(d.code, "remote_unpaired")
    assert.equal(denied(decide(req({ tier: "respond", method: "POST", contentLength: "2", contentType: "application/json", origin: ORIGIN }), ctx())).status, 401)
  })

  it("5. con dispositivo, un nivel insuficiente es 403 remote_tier", () => {
    const d = denied(decide(req({ tier: "respond", method: "POST", contentLength: "2", contentType: "application/json", origin: ORIGIN }), ctx({ ceiling: "control", authenticate: () => device("read") })))
    assert.equal(d.status, 403)
    assert.equal(d.code, "remote_tier")
  })

  it("5. el nivel efectivo es el menor entre el techo y el del dispositivo", () => {
    const get = (tier: Tier) => decide(req({ tier }), ctx({ ceiling: "read", authenticate: () => device("control") }))
    assert.equal(get("read").allow, true)
    assert.equal(denied(get("respond")).code, "remote_tier")
    assert.equal(denied(get("control")).code, "remote_tier")
  })

  it("5. con techo y dispositivo de respond, una ruta de respond pasa (las reglas de cuerpo las aplica después el preHandler)", () => {
    const post = req({ tier: "respond", method: "POST", contentLength: "2", contentType: "application/json", origin: ORIGIN })
    assert.equal(decide(post, ctx({ ceiling: "respond", authenticate: () => device("respond") })).allow, true)
    assert.equal(denied(decide(post, ctx({ ceiling: "read", authenticate: () => device("respond") }))).code, "remote_tier")
    assert.equal(denied(decide(post, ctx({ ceiling: "respond", authenticate: () => device("read") }))).code, "remote_tier")
  })

  it("6. un pedido que cambia algo exige el Origin exacto: ajeno o ausente, 403", () => {
    const base = { method: "POST", tier: "public" as Tier, pattern: "/api/remote/pair", path: "/api/remote/pair", contentLength: "2", contentType: "application/json" }
    assert.equal(decide(req({ ...base, origin: ORIGIN }), ctx()).allow, true)
    for (const origin of ["https://evil.example", "https://example-host.tailnet-name.ts.net", "http://example-host.tailnet-name.ts.net:8443", `${ORIGIN}/`, "null", "", undefined]) {
      const d = denied(decide(req({ ...base, origin }), ctx()))
      assert.equal(d.status, 403, String(origin))
      assert.equal(d.code, "remote_origin", String(origin))
    }
  })

  it("6. sin origen guardado (acceso apagado) no hay Origin válido", () => {
    const d = denied(decide(req({ method: "POST", tier: "public", contentLength: "2", contentType: "application/json", origin: ORIGIN }), ctx({ expectedOrigin: null })))
    assert.equal(d.code, "remote_origin")
  })

  it("6. el cuerpo tiene que ser JSON: otro tipo es 415", () => {
    const base = { method: "POST", tier: "public" as Tier, contentLength: "2", origin: ORIGIN }
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", undefined]) {
      assert.equal(denied(decide(req({ ...base, contentType }), ctx())).status, 415, String(contentType))
    }
    assert.equal(decide(req({ ...base, contentType: "application/json; charset=utf-8" }), ctx()).allow, true)
    // Un POST vacío no necesita tipo.
    assert.equal(decide(req({ ...base, contentLength: "0", contentType: undefined }), ctx()).allow, true)
  })

  it("6. la subida a websocket también exige el Origin exacto", () => {
    const ws = { tier: "read" as Tier, pattern: "/ws", path: "/ws", upgrade: true }
    assert.equal(decide(req({ ...ws, origin: ORIGIN }), ctx({ authenticate: () => device() })).allow, true)
    assert.equal(denied(decide(req({ ...ws, origin: "https://evil.example" }), ctx({ authenticate: () => device() }))).code, "remote_origin")
    assert.equal(denied(decide(req({ ...ws }), ctx({ authenticate: () => device() }))).code, "remote_origin")
  })

  it("un GET con dispositivo y nivel suficiente pasa sin Origin", () => {
    assert.equal(decide(req(), ctx({ authenticate: () => device() })).allow, true)
  })
})

describe("encabezados de seguridad (R5.6)", () => {
  it("siempre: sin marcos, sin referrer, sin sniffing", () => {
    const h = securityHeaders("/index.html")
    assert.equal(h["x-frame-options"], "DENY")
    assert.equal(h["content-security-policy"], "frame-ancestors 'none'")
    assert.equal(h["referrer-policy"], "no-referrer")
    assert.equal(h["x-content-type-options"], "nosniff")
    assert.equal(h["cache-control"], undefined)
  })

  it("en /api, además, sin caché; y nunca encabezados CORS", () => {
    for (const p of ["/api/snapshot", "/api/remote/capabilities"]) {
      const h = securityHeaders(p)
      assert.equal(h["cache-control"], "no-store")
      assert.ok(!Object.keys(h).some((k) => k.startsWith("access-control-")))
    }
  })

  it("applyPolicy: una ruta con métodos de distinto nivel es un error de programación", async () => {
    const app = Fastify({ logger: false })
    applyPolicy(app)
    assert.throws(() => app.route({ method: ["GET", "POST"], url: "/api/snapshot", handler: async () => ({}) }))
    await app.close().catch(() => {})
  })
})
