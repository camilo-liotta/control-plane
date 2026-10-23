import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { Accounts } from "../src/accounts.ts"
import { cachedResolver, missingClaudeMessage, resolveClaudeBin } from "../src/claude/bin.ts"
import { config } from "../src/config.ts"
import { Db } from "../src/db.ts"

const files = (...list: string[]) => {
  const set = new Set(list)
  return (f: string) => set.has(f)
}

const win = { platform: "win32" as const, homedir: "C:\\Users\\me", env: { PATH: "C:\\a;C:\\npm", PATHEXT: ".EXE;.CMD" } }
const NPM_EXE = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"

describe("resolveClaudeBin", () => {
  it("no toca nada fuera de win32", () => {
    assert.equal(resolveClaudeBin("claude", { platform: "linux", exists: files("/usr/bin/claude") }), "claude")
  })

  it("respeta una ruta explícita, aunque sea un .cmd", () => {
    const exists = files("D:\\tools\\claude.cmd")
    assert.equal(resolveClaudeBin("D:\\tools\\claude.cmd", { ...win, exists }), "D:\\tools\\claude.cmd")
    assert.equal(resolveClaudeBin("tools\\claude", { ...win, exists }), "tools\\claude")
  })

  it("prefiere un .exe del PATH", () => {
    const exists = files("C:\\a\\claude.exe", "C:\\npm\\claude.cmd", NPM_EXE)
    assert.equal(resolveClaudeBin("claude", { ...win, exists }), "C:\\a\\claude.exe")
  })

  it("pasa del shim .cmd de npm al claude.exe de al lado", () => {
    const exists = files("C:\\npm\\claude.cmd", NPM_EXE)
    assert.equal(resolveClaudeBin("claude", { ...win, exists }), NPM_EXE)
  })

  it("un .cmd sin claude.exe al lado no se devuelve: queda el nombre", () => {
    assert.equal(resolveClaudeBin("claude", { ...win, exists: files("C:\\npm\\claude.cmd") }), "claude")
  })

  it("cae a la instalación nativa en ~/.local/bin", () => {
    const exists = files("C:\\Users\\me\\.local\\bin\\claude.exe")
    assert.equal(resolveClaudeBin("claude", { ...win, exists }), "C:\\Users\\me\\.local\\bin\\claude.exe")
  })

  it("sin nada, devuelve el nombre", () => {
    assert.equal(resolveClaudeBin("claude", { ...win, exists: files() }), "claude")
  })
})

describe("cachedResolver", () => {
  it("recuerda lo que resolvió", () => {
    let calls = 0
    const resolve = cachedResolver({
      ...win,
      exists: (f) => {
        calls++
        return f === "C:\\a\\claude.exe"
      },
    })
    assert.equal(resolve("claude"), "C:\\a\\claude.exe")
    const after = calls
    assert.equal(resolve("claude"), "C:\\a\\claude.exe")
    assert.equal(calls, after)
  })

  it("reintenta lo que no encontró, por si se instaló después", () => {
    const present = new Set<string>()
    const resolve = cachedResolver({ ...win, exists: (f) => present.has(f) })
    assert.equal(resolve("claude"), "claude")
    present.add("C:\\a\\claude.exe")
    assert.equal(resolve("claude"), "C:\\a\\claude.exe")
  })
})

describe("missingClaudeMessage", () => {
  it("menciona CLAUDE_BIN y claude.exe solo en win32", () => {
    const w = missingClaudeMessage("claude", "win32")
    assert.match(w, /CLAUDE_BIN/)
    assert.match(w, /claude\.exe/)
    const l = missingClaudeMessage("claude", "linux")
    assert.match(l, /CLAUDE_BIN/)
    assert.doesNotMatch(l, /claude\.exe/)
    assert.equal(l, 'No encontré el binario de Claude Code ("claude"). Instalalo o definí CLAUDE_BIN.')
  })
})

describe("Accounts.bin", () => {
  let dir: string
  let db: Db

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-bin-"))
    db = new Db(path.join(dir, "cp.db"))
  })
  after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("resuelve el binario propio de la cuenta", () => {
    const accounts = new Accounts(db, { resolveBin: (b) => `resolved:${b}` })
    assert.equal(accounts.bin({ id: "a", name: "A", configDir: null, bin: " claude ", createdAt: 1 }), "resolved:claude")
  })

  it("sin binario propio usa config.claudeBin", () => {
    const accounts = new Accounts(db, { resolveBin: () => "no debería llamarse" })
    assert.equal(accounts.bin({ id: "a", name: "A", configDir: null, bin: null, createdAt: 1 }), config.claudeBin)
  })
})
