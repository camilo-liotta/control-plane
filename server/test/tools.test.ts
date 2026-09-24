import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { Accounts } from "../src/accounts.ts"
import { lastJsonLine, parseFrontmatter, parsePluginDetails, toMcpInfo } from "../src/claude/tool-parsers.ts"
import { Db, defaultSettings } from "../src/db.ts"
import type { SessionManager } from "../src/sessions.ts"
import { Tools } from "../src/tools.ts"

describe("lo que devuelve el CLI", () => {
  it("lee el inventario de `claude plugin details`", () => {
    const text = `engineering 1.2.0
  Description: Streamline engineering workflows.
  Source: engineering@synced

Component inventory
  Skills (3)  architecture, code-review, debug
  Agents (0)
  Hooks (2)
  MCP servers (2)  slack, github  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~1.2k tok   added to every session`
    const d = parsePluginDetails(text)
    assert.equal(d.description, "Streamline engineering workflows.")
    assert.deepEqual(d.components.skills, ["architecture", "code-review", "debug"])
    assert.deepEqual(d.components.mcpServers, ["slack", "github"])
    assert.equal(d.components.hooks, 2)
    assert.equal(d.alwaysOnTokens, 1200)
  })

  it("toma la línea JSON de los comandos --json aunque haya texto después", () => {
    const out = '{"command":"install","outcome":"failed","message":"not found"}\n✘ Failed to install plugin'
    assert.equal(lastJsonLine(out)?.outcome, "failed")
    assert.equal(lastJsonLine("sin json"), null)
  })

  it("frontmatter con descripción en bloque", () => {
    const fm = parseFrontmatter('---\nname: revisar\ndescription: >\n  Revisa migraciones\n  antes de aplicarlas\n---\n# Cuerpo')
    assert.equal(fm.name, "revisar")
    assert.equal(fm.description, "Revisa migraciones antes de aplicarlas")
  })

  it("normaliza un servidor de mcp_status", () => {
    const s = toMcpInfo({
      name: "claude.ai Claude Docs",
      status: "connected",
      config: { type: "claudeai-proxy", url: "https://api.anthropic.com/v1/pages/mcp" },
      scope: "claudeai",
      source: "claudeai",
      tools: [{ name: "read", annotations: { readOnly: true } }, { name: "delete", annotations: { destructive: true } }],
    })
    assert.equal(s.transport, "claudeai-proxy")
    assert.equal(s.target, "https://api.anthropic.com/v1/pages/mcp")
    assert.deepEqual(s.tools, [{ name: "read", readOnly: true }, { name: "delete", destructive: true }])
    assert.equal(toMcpInfo({ name: "control-plane", status: "connected" }).internal, true)
  })
})

describe("skills en disco", () => {
  let home: string
  let prevHome: string | undefined
  let db: Db
  let tools: Tools
  let repo: string
  let accountId: string

  before(() => {
    prevHome = process.env.HOME
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tools-"))
    process.env.HOME = home
    delete process.env.CLAUDE_CONFIG_DIR
    fs.mkdirSync(path.join(home, ".claude"))
    repo = path.join(home, "repo")
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true })
    db = new Db(path.join(home, "cp.db"))
    const accounts = new Accounts(db)
    db.insertAccount({ id: "acc", name: "Prueba", configDir: null, bin: "false", createdAt: 1 })
    accountId = "acc"
    db.insertProject({ id: "p1", name: "P", repoPath: repo, settings: defaultSettings, accountId, createdAt: 1, archivedAt: null })
    const sessions = { isRunning: () => false, control: async () => ({}) } as unknown as SessionManager
    tools = new Tools({ db, sessions, accounts, home: path.join(home, ".control-plane") })
  })

  after(() => {
    db.close()
    process.env.HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("crea una skill con su frontmatter y no pisa una existente", () => {
    const { path: file } = tools.createSkill(accountId, null, { scope: "user", name: "revisar-sql", description: 'Revisa SQL "peligroso"', body: "Mirá los DROP." })
    assert.equal(file, path.join(home, ".claude", "skills", "revisar-sql", "SKILL.md"))
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"))
    assert.equal(fm.name, "revisar-sql")
    assert.match(fs.readFileSync(file, "utf8"), /Mirá los DROP\./)
    assert.throws(() => tools.createSkill(accountId, null, { scope: "user", name: "revisar-sql", description: "x", body: "" }), /Ya hay/)
    assert.throws(() => tools.createSkill(accountId, null, { scope: "user", name: "Con Espacios", description: "x", body: "" }), /minúsculas/)
  })

  it("el estado va a skillOverrides (cuenta o solo este proyecto) y 'activa' lo borra", async () => {
    await tools.setSkillState(accountId, null, "revisar-sql", "name-only", "user")
    const user = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"))
    assert.deepEqual(user.skillOverrides, { "revisar-sql": "name-only" })
    await tools.setSkillState(accountId, "p1", "revisar-sql", "off", "local")
    const local = JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.local.json"), "utf8"))
    assert.deepEqual(local.skillOverrides, { "revisar-sql": "off" })
    assert.match(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"), /\.claude\/settings\.local\.json/)
    await tools.setSkillState(accountId, null, "revisar-sql", "on", "user")
    assert.equal("skillOverrides" in JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")), false)
    await assert.rejects(tools.setSkillState(accountId, null, "engineering:debug", "off", "user"), /plugin/)
  })

  it("quitar una skill la mueve a la papelera del dashboard", () => {
    const { movedTo } = tools.deleteSkill(accountId, null, "revisar-sql")
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "revisar-sql")), false)
    assert.equal(fs.existsSync(path.join(movedTo, "SKILL.md")), true)
  })
})
