import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { Accounts } from "../src/accounts.ts"
import { Db, defaultSettings } from "../src/db.ts"
import type { SessionManager } from "../src/sessions.ts"
import { extractSkillMd, parseSourceInput, scanSkillTree, SkillMarket, skillDirName } from "../src/skill-market.ts"
import { Tools } from "../src/tools.ts"

describe("fuentes de skills", () => {
  it("entiende usuario/repo, URLs https y carpetas", () => {
    assert.deepEqual(parseSourceInput("anthropics/skills"), { kind: "git", url: "https://github.com/anthropics/skills.git", name: "anthropics/skills" })
    assert.equal(parseSourceInput("https://github.com/acme/skills.git").kind, "git")
    assert.deepEqual(parseSourceInput("/tmp/mis-skills/"), { kind: "local", path: "/tmp/mis-skills/", name: "mis-skills" })
    assert.throws(() => parseSourceInput("file:///etc"), /Solo repos/)
    assert.throws(() => parseSourceInput("ssh://x"), /Solo repos/)
  })

  it("nombres de carpeta seguros", () => {
    assert.equal(skillDirName("Revisar Migraciones (Postgres)"), "revisar-migraciones-postgres")
    assert.equal(skillDirName("../../etc"), "etc")
  })

  it("lee el SKILL.md que devuelve Claude aunque venga en un bloque de código", () => {
    const md = extractSkillMd("Acá va:\n```markdown\n---\nname: revisar-sql\ndescription: Revisa SQL\n---\n\n# Pasos\n```")
    assert.match(md, /^---\nname: revisar-sql/)
    assert.throws(() => extractSkillMd("# sin frontmatter"), /frontmatter/)
    assert.throws(() => extractSkillMd("---\nname: x\n---\n"), /description/)
  })
})

describe("instalar una skill de una fuente", () => {
  let home: string
  let prevHome: string | undefined
  let db: Db
  let market: SkillMarket
  let source: string

  before(() => {
    prevHome = process.env.HOME
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-market-"))
    process.env.HOME = home
    delete process.env.CLAUDE_CONFIG_DIR
    fs.mkdirSync(path.join(home, ".claude", "skills", "ya-la-tengo"), { recursive: true })
    fs.writeFileSync(path.join(home, ".claude", "skills", "ya-la-tengo", "SKILL.md"), "---\nname: ya-la-tengo\ndescription: x\n---\n")
    source = path.join(home, "fuente")
    for (const [dir, name] of [["docs/pdf", "pdf"], ["docs/pdf/nested", "no-deberia"], ["web/ya-la-tengo", "ya-la-tengo"]] as const) {
      fs.mkdirSync(path.join(source, dir), { recursive: true })
      fs.writeFileSync(path.join(source, dir, "SKILL.md"), `---\nname: ${name}\ndescription: Skill ${name}\n---\n\nCuerpo`)
    }
    fs.writeFileSync(path.join(source, "docs/pdf/script.py"), "print('hola')")
    db = new Db(path.join(home, "cp.db"))
    db.insertAccount({ id: "acc", name: "Prueba", configDir: null, bin: "false", createdAt: 1 })
    db.insertProject({ id: "p1", name: "P", repoPath: path.join(home, "repo"), settings: defaultSettings, accountId: "acc", createdAt: 1, archivedAt: null })
    const accounts = new Accounts(db)
    const sessions = { isRunning: () => false, control: async () => ({}) } as unknown as SessionManager
    const tools = new Tools({ db, sessions, accounts, home: path.join(home, ".control-plane") })
    market = new SkillMarket({ db, accounts, tools, home: path.join(home, ".control-plane") })
  })

  after(() => {
    db.close()
    process.env.HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("no entra en una skill buscando otra", () => {
    assert.deepEqual(scanSkillTree(source).map((s) => s.name).sort(), ["pdf", "ya-la-tengo"])
  })

  it("agrega la fuente, lista sus skills y marca las que ya tenés", async () => {
    await market.addSource(source)
    const view = await market.view("acc", null)
    const mine = view.skills.filter((s) => s.sourceName === "fuente")
    assert.deepEqual(mine.map((s) => [s.name, s.installed]), [["pdf", null], ["ya-la-tengo", "user"]])
    await assert.rejects(market.addSource(source), /ya está agregada/)
  })

  it("instala copiando la carpeta entera, y nunca pisa", async () => {
    const view = await market.view("acc", null)
    const pdf = view.skills.find((s) => s.name === "pdf")!
    const { path: target } = await market.install("acc", null, pdf.id, "user")
    assert.equal(target, path.join(home, ".claude", "skills", "pdf"))
    assert.equal(fs.readFileSync(path.join(target, "script.py"), "utf8"), "print('hola')")
    await assert.rejects(market.install("acc", null, pdf.id, "user"), /no la piso/)
    const mine = view.skills.find((s) => s.name === "ya-la-tengo")!
    await assert.rejects(market.install("acc", null, mine.id, "user"), /no la piso/)
    await assert.rejects(market.install("acc", null, "fuente::../../.claude", "user"), /inválida|no está/)
  })

  it("quitar una fuente local no borra la carpeta", async () => {
    const view = await market.view("acc", null)
    const src = view.sources.find((s) => s.name === "fuente")!
    market.removeSource(src.id)
    assert.equal(fs.existsSync(path.join(source, "docs/pdf/SKILL.md")), true)
  })
})
