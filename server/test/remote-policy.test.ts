import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import type { FastifyInstance } from "fastify"

import { POLICY, tierOf, type Tier } from "../src/remote/policy.ts"
import { collectRoutes, type CollectedRoute } from "./remote-stub.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(here, "../src")

let app: FastifyInstance
let routes: CollectedRoute[]
before(async () => {
  const c = await collectRoutes()
  app = c.app
  routes = c.routes
})
after(async () => app.close())

describe("contrato de rutas (R4.1)", () => {
  it("todas las rutas registradas están clasificadas: sin entrada, falla", () => {
    const missing = routes.filter((r) => r.method !== "HEAD" && !(`${r.method} ${r.url}` in POLICY)).map((r) => `${r.method} ${r.url}`)
    assert.deepEqual(missing, [], `rutas sin clasificar: ${missing.join(", ")}`)
  })

  it("no quedan entradas viejas en la tabla: cada una tiene su ruta", () => {
    const real = new Set(routes.map((r) => `${r.method} ${r.url}`))
    const stale = Object.keys(POLICY).filter((k) => !real.has(k))
    assert.deepEqual(stale, [], `entradas sin ruta: ${stale.join(", ")}`)
  })

  it("la tabla no tiene entradas HEAD: HEAD hereda de GET", () => {
    assert.deepEqual(Object.keys(POLICY).filter((k) => k.startsWith("HEAD ")), [])
  })

  it("onRoute deja en config.remote el nivel de la tabla en cada ruta, HEAD incluido", () => {
    assert.ok(routes.length > 100)
    for (const r of routes) assert.equal(r.remote, tierOf(r.method, r.url), `${r.method} ${r.url}`)
    assert.ok(routes.some((r) => r.method === "HEAD" && r.remote === "read"), "HEAD de un GET de lectura")
  })

  it("sin entrada, el nivel es never; un método desconocido también", () => {
    assert.equal(tierOf("GET", "/api/no-existe"), "never")
    assert.equal(tierOf("POST", "/api/snapshot"), "never")
    assert.equal(tierOf("TRACE", "/api/snapshot"), "never")
    assert.equal(tierOf("PROPFIND", "/*"), "never")
    assert.equal(tierOf("", ""), "never")
  })

  it("HEAD hereda de GET (y el método se compara sin importar mayúsculas)", () => {
    assert.equal(tierOf("HEAD", "/api/snapshot"), "read")
    assert.equal(tierOf("HEAD", "/*"), "public")
    assert.equal(tierOf("HEAD", "/api/credentials/:id/secret"), "never")
    assert.equal(tierOf("head", "/api/snapshot"), "read")
    assert.equal(tierOf("get", "/api/snapshot"), "read")
  })
})

describe("lo que NUNCA se abre desde afuera (R4.3), una prueba por entrada", () => {
  const never: [string, string][] = [
    // terminal
    ["POST", "/api/sessions/:id/terminal"],
    ["GET", "/api/sessions/:id/terminal"],
    ["DELETE", "/api/sessions/:id/terminal"],
    ["GET", "/ws/terminal"],
    // apagado, hooks, mcp, reinicio
    ["POST", "/api/desktop/shutdown"],
    ["POST", "/hooks/:token/compact"],
    ["POST", "/hooks/:token/send-message"],
    ["GET", "/mcp/:token"],
    ["POST", "/mcp/:token"],
    ["DELETE", "/mcp/:token"],
    ["GET", "/api/restart/preview"],
    ["POST", "/api/restart/prepare"],
    ["POST", "/api/restart/cancel"],
    // editor y abrir archivos
    ["GET", "/api/editor"],
    ["PUT", "/api/editor"],
    ["POST", "/api/sessions/:id/open-file"],
    ["POST", "/api/projects/:id/open-in-editor"],
    ["POST", "/api/projects/:id/open-path"],
    ["POST", "/api/projects/:id/resolve-paths"],
    // credenciales y entornos
    ["POST", "/api/projects/:id/environments"],
    ["PATCH", "/api/environments/:id"],
    ["DELETE", "/api/environments/:id"],
    ["POST", "/api/environments/:id/credentials"],
    ["PATCH", "/api/credentials/:id"],
    ["DELETE", "/api/credentials/:id"],
    ["GET", "/api/credentials/:id/secret"],
    ["GET", "/api/fs/suggest"],
    // cuentas y herramientas
    ["GET", "/api/accounts"],
    ["GET", "/api/accounts/detect"],
    ["POST", "/api/accounts"],
    ["PATCH", "/api/accounts/:id"],
    ["DELETE", "/api/accounts/:id"],
    ["GET", "/api/accounts/:id/settings"],
    ["PATCH", "/api/accounts/:id/settings"],
    ["GET", "/api/accounts/:id/tools"],
    ["GET", "/api/accounts/:id/plugins/catalog"],
    ["POST", "/api/accounts/:id/plugins/action"],
    ["POST", "/api/accounts/:id/engram/install"],
    ["GET", "/api/accounts/:id/marketplaces"],
    ["POST", "/api/accounts/:id/marketplaces"],
    ["POST", "/api/accounts/:id/mcp"],
    ["DELETE", "/api/accounts/:id/mcp/:name"],
    ["POST", "/api/accounts/:id/mcp/:name/login"],
    ["POST", "/api/projects/:id/mcp/:name/toggle"],
    ["POST", "/api/sessions/:id/mcp/:name/reconnect"],
    ["GET", "/api/accounts/:id/skills/:name"],
    ["PUT", "/api/accounts/:id/skills/:name"],
    ["POST", "/api/accounts/:id/skills"],
    ["DELETE", "/api/accounts/:id/skills/:name"],
    ["POST", "/api/accounts/:id/skills/:name/state"],
    ["GET", "/api/accounts/:id/skill-market"],
    ["POST", "/api/accounts/:id/skill-market/install"],
    ["GET", "/api/clis"],
    ["POST", "/api/clis/:id/login"],
    ["POST", "/api/clis/:id/install"],
    ["GET", "/api/clis/jobs/:id"],
    ["POST", "/api/clis/jobs/:id/input"],
    ["POST", "/api/clis/jobs/:id/cancel"],
    ["POST", "/api/tasks/:id/cli-login"],
    ["POST", "/api/projects/:id/tasks"],
    // apps
    ["GET", "/api/projects/:id/apps"],
    ["POST", "/api/projects/:id/apps"],
    ["POST", "/api/projects/:id/apps/start-all"],
    ["POST", "/api/projects/:id/apps/stop-all"],
    ["PATCH", "/api/apps/:id"],
    ["DELETE", "/api/apps/:id"],
    ["POST", "/api/apps/:id/start"],
    ["POST", "/api/apps/:id/stop"],
    ["POST", "/api/apps/:id/restart"],
    ["GET", "/api/apps/:id/log"],
    // proyectos
    ["POST", "/api/projects"],
    ["PATCH", "/api/projects/:id"],
    ["DELETE", "/api/projects/:id"],
    ["POST", "/api/projects/:id/restore"],
    ["POST", "/api/projects/:id/delete"],
    // todo lo que no está en las listas
    ["POST", "/api/projects/:id/sessions"],
    ["GET", "/api/projects/:id/importable"],
    ["POST", "/api/projects/:id/import"],
    ["POST", "/api/projects/:id/start-all"],
    ["POST", "/api/projects/:id/stop-all"],
    ["POST", "/api/projects/:id/review-now"],
    ["POST", "/api/projects/:id/release"],
    ["PATCH", "/api/sessions/:id"],
    ["DELETE", "/api/sessions/:id"],
    ["POST", "/api/sessions/:id/restore"],
    ["POST", "/api/sessions/:id/compaction/draft"],
    ["POST", "/api/sessions/:id/compaction/apply"],
    ["POST", "/api/sessions/:id/compaction/direct"],
    ["POST", "/api/sessions/:id/compaction/resend"],
    ["DELETE", "/api/sessions/:id/compaction"],
    ["POST", "/api/sessions/:id/context"],
    ["GET", "/api/sessions/:id/tools"],
    ["POST", "/api/sessions/:id/tools/reload"],
    ["POST", "/api/sessions/:id/attachments"],
    ["POST", "/api/reports/:id/dismiss"],
    ["GET", "/api/health"],
    // todo /api/remote de gestión
    ["GET", "/api/remote/status"],
    ["POST", "/api/remote/enable"],
    ["POST", "/api/remote/disable"],
    ["POST", "/api/remote/kill"],
    ["GET", "/api/remote/config"],
    ["PATCH", "/api/remote/config"],
    ["POST", "/api/remote/pairings"],
    ["GET", "/api/remote/devices"],
    ["DELETE", "/api/remote/devices/:id"],
    ["PATCH", "/api/remote/devices/:id"],
  ]

  for (const [method, pattern] of never) {
    it(`${method} ${pattern} es never`, () => {
      assert.equal(tierOf(method, pattern), "never")
    })
  }

  it("y todas esas rutas existen de verdad (la lista no inventa rutas)", () => {
    const real = new Set(routes.map((r) => `${r.method} ${r.url}`))
    const unknown = never.filter(([m, p]) => !real.has(`${m} ${p}`)).map(([m, p]) => `${m} ${p}`)
    assert.deepEqual(unknown, [])
  })

  it("ninguna ruta de terminal, hooks, mcp, reinicio, editor, credenciales, cuentas, apps o /api/tasks sube de never", () => {
    const sensitive = /^\/(api\/(sessions\/:id\/terminal|desktop|restart|editor|credentials|environments|fs|accounts|clis|apps|tasks|projects\/:id\/(apps|environments|open-|resolve-))|ws\/terminal|hooks|mcp)/
    const bad = routes.filter((r) => sensitive.test(r.url) && tierOf(r.method, r.url) !== "never").map((r) => `${r.method} ${r.url}`)
    assert.deepEqual(bad, [])
  })
})

/** Las claves de la tabla de un nivel, ordenadas. */
const keysOf = (tier: Tier) => Object.entries(POLICY).filter(([, t]) => t === tier).map(([k]) => k).sort()

describe("las listas exactas de cada nivel (R4.4, R5.1)", () => {
  it("public", () => {
    assert.deepEqual(keysOf("public"), ["GET /*", "GET /api/remote/capabilities", "POST /api/remote/pair"].sort())
  })

  it("read", () => {
    assert.deepEqual(
      keysOf("read"),
      [
        "GET /api/snapshot",
        "GET /ws",
        "GET /api/sessions/:id/events",
        "GET /api/sessions/:id/reports",
        "GET /api/sessions/:id/changes",
        "GET /api/sessions/:id/attachments",
        "GET /api/sessions/:id/commands",
        "GET /api/attachments/:id",
        "GET /api/projects/:id/messages",
        "GET /api/projects/:id/scheduled",
        "GET /api/projects/:id/overview",
        "GET /api/projects/:id/archived",
        "GET /api/projects/:id/afk-log",
        "GET /api/projects/archived",
      ].sort(),
    )
  })

  it("respond", () => {
    assert.deepEqual(
      keysOf("respond"),
      [
        "POST /api/sessions/:id/messages",
        "POST /api/sessions/:id/answer",
        "POST /api/sessions/:id/permission",
        "POST /api/sessions/:id/interrupt",
        "POST /api/sessions/:id/scheduled/:itemId/cancel",
        "POST /api/drafts/:id/send",
        "PATCH /api/drafts/:id",
        "POST /api/drafts/:id/discard",
        "POST /api/drafts/:id/plan/pause",
        "POST /api/drafts/:id/plan/cancel",
        "DELETE /api/projects/:id/afk",
        "POST /api/remote/logout",
      ].sort(),
    )
  })

  it("control", () => {
    assert.deepEqual(keysOf("control"), ["POST /api/sessions/:id/start", "POST /api/sessions/:id/stop", "POST /api/projects/:id/afk", "POST /api/drafts/:id/plan/resume"].sort())
  })
})

describe("privilegios (R6.3)", () => {
  const read = (file: string) => fs.readFileSync(path.join(srcDir, file), "utf8")
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []))

  it("respondPermission solo se llama desde la ruta de permiso", () => {
    const callers = walk(srcDir)
      .filter((f) => /\.respondPermission\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(srcDir, f).replaceAll("\\", "/"))
    assert.deepEqual(callers, ["api.ts"])
    const api = read("api.ts")
    assert.equal(api.split(".respondPermission(").length - 1, 1)
    const before = api.slice(Math.max(0, api.indexOf(".respondPermission(") - 400), api.indexOf(".respondPermission("))
    assert.match(before, /"\/api\/sessions\/:id\/permission"/)
  })

  it("ninguna ruta que cambia ajustes, cuentas, MCP, skills o permisos está por encima de never", () => {
    const privileged = routes.filter(
      (r) =>
        r.method !== "GET" &&
        r.method !== "HEAD" &&
        /(\/api\/accounts|\/mcp|\/skills|\/plugins|\/marketplaces|\/settings|\/api\/projects\/:id$|\/api\/editor|\/api\/environments|\/api\/credentials)/.test(r.url),
    )
    assert.ok(privileged.length > 10)
    for (const r of privileged) assert.equal(tierOf(r.method, r.url), "never", `${r.method} ${r.url}`)
  })

  it("el permiso se clasifica respond: la regla dinámica (allow:true = control) la agrega la puerta", () => {
    assert.equal(tierOf("POST", "/api/sessions/:id/permission"), "respond")
  })
})
