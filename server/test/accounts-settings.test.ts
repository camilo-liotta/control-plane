import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { Accounts } from "../src/accounts.ts"
import { readSettings, writeSetting } from "../src/claude/config-settings.ts"
import { Db } from "../src/db.ts"

describe("opciones de /config", () => {
  let dir: string
  let files: { user: string; global: string }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-settings-"))
    files = { user: path.join(dir, "settings.json"), global: path.join(dir, ".claude.json") }
    fs.writeFileSync(files.user, JSON.stringify({ theme: "dark", permissions: { defaultMode: "auto" }, remoteControlAtStartup: true }))
    fs.writeFileSync(files.global, JSON.stringify({ oauthAccount: { x: 1 }, projects: {} }), { mode: 0o600 })
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("lee valores guardados y defaults", () => {
    const items = readSettings(files, [])
    const theme = items.find((i) => i.key === "theme")!
    assert.equal(theme.value, "dark")
    assert.equal(theme.isSet, true)
    const auto = items.find((i) => i.key === "autoCompactEnabled")!
    assert.equal(auto.value, true)
    assert.equal(auto.isSet, false)
    assert.equal(items.find((i) => i.key === "remoteControlAtStartup")!.value, "true")
  })

  it("escribe sin tocar el resto del archivo", () => {
    writeSetting(files, "editorMode", "vim", [])
    const data = JSON.parse(fs.readFileSync(files.user, "utf8"))
    assert.equal(data.editorMode, "vim")
    assert.deepEqual(data.permissions, { defaultMode: "auto" })
  })

  it("'por defecto' borra la clave y las listas booleanas guardan booleanos", () => {
    writeSetting(files, "remoteControlAtStartup", "false", [])
    assert.equal(JSON.parse(fs.readFileSync(files.user, "utf8")).remoteControlAtStartup, false)
    writeSetting(files, "remoteControlAtStartup", "default", [])
    assert.equal("remoteControlAtStartup" in JSON.parse(fs.readFileSync(files.user, "utf8")), false)
  })

  it("claves anidadas y config global con sus permisos", () => {
    writeSetting(files, "worktree.baseRef", "head", [])
    assert.deepEqual(JSON.parse(fs.readFileSync(files.user, "utf8")).worktree, { baseRef: "head" })
    writeSetting(files, "copyOnSelect", false, [])
    const g = JSON.parse(fs.readFileSync(files.global, "utf8"))
    assert.equal(g.copyOnSelect, false)
    assert.deepEqual(g.oauthAccount, { x: 1 })
    assert.equal(fs.statSync(files.global).mode & 0o777, 0o600)
  })

  it("rechaza valores inválidos", () => {
    assert.throws(() => writeSetting(files, "editorMode", "emacs", []), /inválido/)
    assert.throws(() => writeSetting(files, "autoCompactEnabled", "si", []), /verdadero o falso/)
    assert.throws(() => writeSetting(files, "noExiste", true, []), /No conozco/)
  })

  it("no pisa un archivo que no es JSON válido", () => {
    const broken = { user: path.join(dir, "roto.json"), global: files.global }
    const raw = '{ "hooks": { "Stop": [] }, }\n'
    fs.writeFileSync(broken.user, raw)
    assert.throws(() => writeSetting(broken, "editorMode", "vim", []), /no es JSON válido/)
    assert.equal(fs.readFileSync(broken.user, "utf8"), raw)
  })

  it("escribe a través de un symlink sin reemplazarlo", () => {
    const real = path.join(dir, "dotfiles-settings.json")
    const link = path.join(dir, "enlace.json")
    fs.writeFileSync(real, JSON.stringify({ env: { A: "1" } }))
    fs.symlinkSync(real, link)
    writeSetting({ user: link, global: files.global }, "editorMode", "vim", [])
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")), { env: { A: "1" }, editorMode: "vim" })
  })
})

describe("cuentas", () => {
  let home: string
  let prevHome: string | undefined
  let db: Db

  before(() => {
    prevHome = process.env.HOME
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"))
    process.env.HOME = home
    delete process.env.CLAUDE_CONFIG_DIR
    fs.mkdirSync(path.join(home, ".claude"))
    fs.mkdirSync(path.join(home, ".claude-personal"))
    fs.writeFileSync(path.join(home, ".claude-personal", "settings.json"), "{}")
    fs.mkdirSync(path.join(home, ".claude-vacia"))
    db = new Db(path.join(home, "cp.db"))
  })
  after(() => {
    db.close()
    process.env.HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("la cuenta de siempre no define CLAUDE_CONFIG_DIR; las otras sí", () => {
    const accounts = new Accounts(db)
    const main = { id: "a1", name: "Trabajo", configDir: null, bin: null, createdAt: 1 }
    const personal = { id: "a2", name: "Personal", configDir: "~/.claude-personal", bin: null, createdAt: 2 }
    assert.deepEqual(accounts.env(main), {})
    assert.deepEqual(accounts.env(personal), { CLAUDE_CONFIG_DIR: path.join(home, ".claude-personal") })
    assert.equal(accounts.settingsFile(personal), path.join(home, ".claude-personal", "settings.json"))
    assert.equal(accounts.globalConfigFile(main), path.join(home, ".claude.json"))
    assert.equal(accounts.globalConfigFile(personal), path.join(home, ".claude-personal", ".claude.json"))
  })

  it("detecta ~/.claude-* con configuración y deja afuera los vacíos", () => {
    const accounts = new Accounts(db)
    db.insertAccount({ id: "a1", name: "Trabajo", configDir: null, bin: null, createdAt: 1 })
    const found = accounts.detect()
    assert.deepEqual(found, [{ configDir: path.join(home, ".claude-personal"), name: "Personal" }])
  })

  it("no deja agregar dos veces el mismo directorio", () => {
    const accounts = new Accounts(db)
    accounts.create({ name: "Personal", configDir: "~/.claude-personal" })
    assert.throws(() => accounts.create({ name: "Otra", configDir: path.join(home, ".claude-personal") }), /Ya hay una cuenta/)
  })
})
