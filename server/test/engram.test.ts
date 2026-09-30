import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { detectEngram, engramBinary, installEngram, type EngramDeps, type EngramSteps } from "../src/engram.ts"
import { canInstallEngram, ENGRAM_ABOUT, ENGRAM_LABEL, summarizeEngram } from "../src/shared/engram.ts"
import type { EngramInstallResult, EngramState, EngramStatus } from "../src/shared/types.ts"

const STATES: EngramState[] = ["ready", "no-binary", "partial", "missing"]

const HOME = "C:\\Users\\me"
const CFG = "C:\\cfg"
const GLOBAL = "C:\\cfg\\.claude.json"
const PLUGINS = `${CFG}\\plugins\\installed_plugins.json`
const SETTINGS = `${CFG}\\settings.json`
const MCP = `${CFG}\\mcp\\engram.json`
const EXE = `${HOME}\\go\\bin\\engram.exe`

/** Deps en memoria: `files` son los archivos que existen (con su contenido); `bins` los ejecutables. */
function deps(files: Record<string, string>, bins: string[] = [], platform: NodeJS.Platform = "win32"): EngramDeps {
  return {
    platform,
    homedir: HOME,
    env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD", LOCALAPPDATA: `${HOME}\\AppData\\Local` },
    exists: (f) => bins.includes(f),
    readFile: (f) => files[f] ?? null,
  }
}

const installed = JSON.stringify({ version: 2, plugins: { "engram@engram": [{ scope: "user" }] } })
const detect = (files: Record<string, string>, bins: string[] = []) => detectEngram({ configDir: CFG, globalConfig: GLOBAL }, deps(files, bins))

describe("copy de Engram", () => {
  it("explica qué es, en pocas oraciones y con lo local", () => {
    assert.ok(ENGRAM_ABOUT.length > 0)
    assert.match(ENGRAM_ABOUT, /tu máquina/)
    assert.match(ENGRAM_ABOUT, /engram\.db/)
    assert.ok(ENGRAM_ABOUT.split(/[.:]\s/).length <= 4)
  })

  it("tiene una etiqueta distinta por estado", () => {
    assert.equal(new Set(STATES.map((s) => ENGRAM_LABEL[s])).size, STATES.length)
    assert.equal(ENGRAM_LABEL.ready, "Engram listo")
    assert.equal(ENGRAM_LABEL.missing, "Sin Engram")
  })

  it("el botón de instalar se esconde solo cuando está listo", () => {
    assert.equal(canInstallEngram("ready"), false)
    assert.equal(canInstallEngram("partial"), true)
    assert.equal(canInstallEngram("missing"), true)
    assert.equal(canInstallEngram("no-binary"), true)
  })
})

describe("summarizeEngram", () => {
  it("cuenta las cuentas con Engram listo", () => {
    assert.deepEqual(summarizeEngram(["ready", "missing", "ready"]), { ready: 2, total: 3, allReady: false })
  })

  it("allReady solo cuando todas están listas", () => {
    assert.equal(summarizeEngram(["ready", "ready"]).allReady, true)
    assert.equal(summarizeEngram(["ready", "partial"]).allReady, false)
  })

  it("sin cuentas no hay nada listo", () => {
    assert.deepEqual(summarizeEngram([]), { ready: 0, total: 0, allReady: false })
  })
})

describe("engramBinary", () => {
  it("en win32 solo devuelve un .exe, nunca un .cmd", () => {
    assert.equal(engramBinary(deps({}, ["C:\\bin\\engram.cmd"])), null)
    assert.equal(engramBinary(deps({}, ["C:\\bin\\engram.cmd", "C:\\bin\\engram.exe"])), "C:\\bin\\engram.exe")
  })

  it("mira ~\\go\\bin y %LOCALAPPDATA%\\engram\\bin", () => {
    assert.equal(engramBinary(deps({}, [EXE])), EXE)
    const local = `${HOME}\\AppData\\Local\\engram\\bin\\engram.exe`
    assert.equal(engramBinary(deps({}, [local])), local)
  })

  it("fuera de win32 devuelve el primer candidato (el PATH antes que los extras)", () => {
    const d: EngramDeps = { ...deps({}, ["/opt/homebrew/bin/engram", "/usr/bin/engram"], "linux"), homedir: "/home/me", env: { PATH: "/usr/bin" } }
    assert.equal(engramBinary(d), "/usr/bin/engram")
    assert.equal(engramBinary({ ...d, exists: () => false }), null)
  })
})

describe("detectEngram", () => {
  it("ready: plugin, MCP y programa", () => {
    const s = detect({ [PLUGINS]: installed, [MCP]: "{}" }, [EXE])
    assert.equal(s.state, "ready")
    assert.deepEqual([s.plugin, s.mcp, s.binary], ["ok", true, EXE])
    assert.equal(s.binaryHint, undefined)
  })

  it("no-binary: plugin y MCP, sin programa (con la pista para conseguirlo)", () => {
    const s = detect({ [PLUGINS]: installed, [MCP]: "{}" })
    assert.equal(s.state, "no-binary")
    assert.equal(s.binary, null)
    assert.ok(s.binaryHint?.command)
    assert.match(s.binaryHint!.url, /^https:\/\/github\.com\/.*engram/i)
  })

  it("partial: solo un MCP a mano en .claude.json", () => {
    const s = detect({ [GLOBAL]: JSON.stringify({ mcpServers: { engram: { command: "engram" } } }) }, [EXE])
    assert.equal(s.state, "partial")
    assert.deepEqual([s.plugin, s.mcp], ["missing", true])
  })

  it("partial: plugin deshabilitado aunque haya MCP y programa", () => {
    const s = detect({ [PLUGINS]: installed, [MCP]: "{}", [SETTINGS]: JSON.stringify({ enabledPlugins: { "engram@engram": false } }) }, [EXE])
    assert.equal(s.state, "partial")
    assert.equal(s.plugin, "disabled")
  })

  it("partial: plugin sin MCP registrado", () => {
    assert.equal(detect({ [PLUGINS]: installed }, [EXE]).state, "partial")
  })

  it("missing: directorio vacío", () => {
    const s = detect({})
    assert.equal(s.state, "missing")
    assert.deepEqual([s.plugin, s.mcp], ["missing", false])
  })

  it("sin la clave en enabledPlugins cuenta como habilitado", () => {
    const s = detect({ [PLUGINS]: installed, [MCP]: "{}", [SETTINGS]: JSON.stringify({ enabledPlugins: { otro: false } }) }, [EXE])
    assert.equal(s.state, "ready")
  })

  it("acepta la clave del plugin al tope del archivo", () => {
    assert.equal(detect({ [PLUGINS]: JSON.stringify({ "engram@engram": [{}] }) }).plugin, "ok")
  })

  it("un JSON roto cuenta como pieza ausente y no tira", () => {
    const s = detect({ [PLUGINS]: "{no es json", [MCP]: "tampoco", [SETTINGS]: "{", [GLOBAL]: "[" })
    assert.equal(s.state, "missing")
  })
})

describe("installEngram", () => {
  const status = (over: Partial<EngramStatus>): EngramStatus => ({ state: "missing", plugin: "missing", mcp: false, binary: EXE, ...over })
  const ok: EngramInstallResult = { ok: true, message: "Listo" }

  function steps(calls: string[], over: Partial<EngramSteps> = {}): EngramSteps {
    return {
      addMarketplace: async () => void calls.push("add"),
      plugin: async (a) => (calls.push(a), ok),
      setup: async (bin) => void calls.push(`setup:${bin}`),
      ...over,
    }
  }

  it("con el programa: marketplace, plugin y setup, en ese orden", async () => {
    const calls: string[] = []
    const r = await installEngram(status({}), steps(calls))
    assert.deepEqual(calls, ["add", "install", `setup:${EXE}`])
    assert.deepEqual(r, { ok: true, message: "Engram instalado" })
  })

  it("tolera un marketplace ya agregado, pero no otros errores", async () => {
    const calls: string[] = []
    const already = steps(calls, { addMarketplace: async () => Promise.reject(new Error("Marketplace 'engram' is already added")) })
    assert.deepEqual(await installEngram(status({}), already), { ok: true, message: "Engram instalado" })
    assert.deepEqual(calls, ["install", `setup:${EXE}`])
    const broken = steps([], { addMarketplace: async () => Promise.reject(new Error("sin red")) })
    await assert.rejects(installEngram(status({}), broken), /sin red/)
  })

  it("sin programa: instala el plugin, no corre setup y avisa", async () => {
    const calls: string[] = []
    const r = await installEngram(status({ binary: null }), steps(calls))
    assert.deepEqual(calls, ["add", "install"])
    assert.ok("ok" in r && /falta instalar el programa engram/.test(r.message))
  })

  it("si el plugin falla, no corre setup", async () => {
    const calls: string[] = []
    await assert.rejects(installEngram(status({}), steps(calls, { plugin: async () => Promise.reject(new Error("falló")) })), /falló/)
    assert.deepEqual(calls, ["add"])
  })

  it("si pide confirmar el comando, corta ahí", async () => {
    const calls: string[] = []
    const confirm: EngramInstallResult = { needsConfirm: { command: "make", sha256: "a".repeat(64) } }
    const r = await installEngram(status({}), steps(calls, { plugin: async () => confirm }))
    assert.deepEqual(r, confirm)
    assert.deepEqual(calls, ["add"])
  })

  it("con el plugin deshabilitado, lo habilita sin tocar el marketplace", async () => {
    const calls: string[] = []
    await installEngram(status({ plugin: "disabled", state: "partial" }), steps(calls))
    assert.deepEqual(calls, ["enable", `setup:${EXE}`])
  })

  it("con el plugin ya andando, solo registra el MCP", async () => {
    const calls: string[] = []
    await installEngram(status({ plugin: "ok", state: "partial" }), steps(calls))
    assert.deepEqual(calls, [`setup:${EXE}`])
  })
})
