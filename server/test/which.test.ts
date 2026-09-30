import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { which as cliWhich } from "../src/clis.ts"
import { which } from "../src/which.ts"

const fs = (...files: string[]) => {
  const set = new Set(files)
  return (f: string) => set.has(f)
}

describe("which (win32)", () => {
  const base = { platform: "win32" as const, env: { PATH: "C:\\a;C:\\b", PATHEXT: ".EXE;.CMD" } }

  it("recorre PATH x PATHEXT", () => {
    assert.deepEqual(which("claude", { ...base, exists: fs("C:\\b\\claude.cmd") }), ["C:\\b\\claude.cmd"])
  })

  it("descarta el shim sin extensión", () => {
    const exists = fs("C:\\a\\claude", "C:\\a\\claude.exe")
    assert.deepEqual(which("claude", { ...base, exists }), ["C:\\a\\claude.exe"])
  })

  it("acepta la clave Path en cualquier capitalización", () => {
    const env = { Path: "C:\\a", PATHEXT: ".EXE" }
    assert.deepEqual(which("gh", { platform: "win32", env, exists: fs("C:\\a\\gh.exe") }), ["C:\\a\\gh.exe"])
  })

  it("usa los PATHEXT por defecto, sin comillas ni entradas vacías", () => {
    const env = { PATH: '"C:\\a";;C:\\b' }
    assert.deepEqual(which("gh", { platform: "win32", env, exists: fs("C:\\a\\gh.com", "C:\\b\\gh.bat") }), ["C:\\a\\gh.com", "C:\\b\\gh.bat"])
  })

  it("si el nombre ya trae una extensión de PATHEXT, la chequea tal cual", () => {
    assert.deepEqual(which("gh.exe", { ...base, exists: fs("C:\\a\\gh.exe") }), ["C:\\a\\gh.exe"])
  })
})

describe("which (posix)", () => {
  it("busca el nombre exacto en PATH", () => {
    const env = { PATH: "/x:/y" }
    assert.deepEqual(which("claude", { platform: "linux", env, exists: fs("/y/claude") }), ["/y/claude"])
  })

  it("no repite candidatos", () => {
    const env = { PATH: "/x:/x" }
    assert.deepEqual(which("claude", { platform: "linux", env, exists: fs("/x/claude") }), ["/x/claude"])
  })
})

describe("which (extraDirs)", () => {
  it("escanea los extras después de PATH", () => {
    const env = { PATH: "/x" }
    const exists = fs("/x/e", "/extra/e")
    assert.deepEqual(which("e", { platform: "linux", env, exists, extraDirs: ["/extra"] }), ["/x/e", "/extra/e"])
  })

  it("devuelve el hit de los extras si PATH no tiene nada", () => {
    assert.deepEqual(which("e", { platform: "linux", env: { PATH: "/x" }, exists: fs("/extra/e"), extraDirs: ["/extra"] }), ["/extra/e"])
  })

  it("sin hits devuelve vacío", () => {
    assert.deepEqual(which("e", { platform: "linux", env: { PATH: "/x" }, exists: fs(), extraDirs: ["/extra"] }), [])
  })
})

describe("which de Integraciones (clis.ts)", () => {
  it("en win32 encuentra el .exe del PATH", () => {
    assert.equal(cliWhich("gh", "C:\\a;C:\\b", { platform: "win32", exists: fs("C:\\b\\gh.exe") }), "C:\\b\\gh.exe")
  })

  it("sin hits devuelve null; fuera de win32 sigue buscando el nombre exacto", () => {
    assert.equal(cliWhich("gh", "C:\\a", { platform: "win32", exists: fs() }), null)
    assert.equal(cliWhich("gh", "/x:/y", { platform: "linux", exists: fs("/y/gh") }), "/y/gh")
  })

  it("mira las carpetas extra después del PATH", () => {
    assert.equal(cliWhich("gh", "/x", { platform: "darwin", exists: fs("/opt/homebrew/bin/gh") }), "/opt/homebrew/bin/gh")
  })
})
