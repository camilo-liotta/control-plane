import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { buildLaunch } from "../src/claude/args.ts"
import { cleanRunRoot, removeSessionRunDir, runRootOf, sessionRunDir, writePrivateFile } from "../src/claude/run-files.ts"
import type { SessionRecord } from "../src/db.ts"
import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { SessionManager } from "../src/sessions.ts"
import { writeFakeClaude } from "./fake-claude.ts"
import { tmpRunRoot } from "./run-root.ts"

const mode = (p: string) => fs.statSync(p).mode & 0o777
const TOKEN = "tok-secreto-1234"

const rec = (): SessionRecord => ({
  id: "s_1", projectId: "p1", kind: "worker", name: "W", processName: "W", role: "", claudeSessionId: "c-1", startedOnce: false, mcpToken: TOKEN, model: null,
  effort: null, worktree: false, cwd: "/tmp", status: "idle", taskTitle: null, taskState: "none", lastActivity: null, lastActivityAt: null,
  costUsd: 0, costByModel: {}, tokens: null, context: null, createdAt: 1, archivedAt: null,
})

describe("archivos de lanzamiento: los tokens no van en los argumentos", () => {
  it("buildLaunch pasa --mcp-config y --settings como rutas a archivos 0600 en una carpeta 0700", () => {
    const root = tmpRunRoot()
    const runDir = sessionRunDir(root, "s_1")
    const { args } = buildLaunch(rec(), { mcpUrl: `http://127.0.0.1:4700/mcp/${TOKEN}`, hookUrl: `http://127.0.0.1:4700/hooks/${TOKEN}`, runDir, protocol: "p", orchestratorCanEdit: false, model: null, effort: null })

    assert.ok(!args.join("\n").includes(TOKEN), "ningún argumento lleva el token")
    const mcp = args[args.indexOf("--mcp-config") + 1]!
    const settings = args[args.indexOf("--settings") + 1]!
    assert.equal(mcp, path.join(runDir, "mcp.json"))
    assert.equal(settings, path.join(runDir, "settings.json"))
    assert.deepEqual(JSON.parse(fs.readFileSync(mcp, "utf8")), { mcpServers: { "control-plane": { type: "http", url: `http://127.0.0.1:4700/mcp/${TOKEN}` } } })
    assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).crossSessionInbound, "accept")

    assert.equal(mode(root), 0o700)
    assert.equal(mode(runDir), 0o700)
    for (const f of fs.readdirSync(runDir)) assert.equal(mode(path.join(runDir, f)), 0o600, f)
    // Los hooks leen su URL de archivos propios, y el settings no lleva el token.
    assert.deepEqual(fs.readdirSync(runDir).sort(), ["hook-compact.url", "hook-send-message.url", "mcp.json", "settings.json"])
    assert.ok(!fs.readFileSync(settings, "utf8").includes(TOKEN))
  })

  it("al lanzar de nuevo se reescriben (y quedan 0600 aunque el archivo viejo tuviera otros permisos)", () => {
    const runDir = sessionRunDir(tmpRunRoot(), "s_1")
    const file = path.join(runDir, "mcp.json")
    fs.writeFileSync(file, "viejo", { mode: 0o644 })
    fs.chmodSync(runDir, 0o755)
    const again = sessionRunDir(path.dirname(runDir), "s_1")
    assert.equal(mode(again), 0o700)
    writePrivateFile(file, "nuevo")
    assert.equal(fs.readFileSync(file, "utf8"), "nuevo")
    assert.equal(mode(file), 0o600)
  })

  it("la limpieza: una sesión, y todo lo que quedó al arrancar", () => {
    const root = tmpRunRoot()
    for (const id of ["s_a", "s_b", "s_c"]) writePrivateFile(path.join(sessionRunDir(root, id), "mcp.json"), "x")
    removeSessionRunDir(root, "s_a")
    removeSessionRunDir(root, "s_que-no-existe")
    assert.deepEqual(fs.readdirSync(root).sort(), ["s_b", "s_c"])
    assert.equal(cleanRunRoot(root), 2)
    assert.deepEqual(fs.readdirSync(root), [])
    assert.equal(cleanRunRoot(path.join(root, "no-existe")), 0)
    assert.equal(runRootOf("/datos"), "/datos/run")
  })

  it("un id de sesión con '..' o '/' no sale de la carpeta", () => {
    const root = tmpRunRoot()
    sessionRunDir(root, "s_ok")
    for (const bad of ["../afuera", "a/b", "..", "."]) assert.throws(() => sessionRunDir(root, bad), /inválido/, bad)
    for (const bad of ["../..", "..", "."]) removeSessionRunDir(root, bad)
    assert.ok(fs.existsSync(path.join(root, "s_ok")))
    assert.ok(fs.existsSync(path.dirname(root)))
  })
})

describe("archivos de lanzamiento: el ciclo de vida de la sesión", () => {
  let dir: string
  let root: string
  let db: Db
  let sessions: SessionManager
  let id: string

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-runfiles-"))
    root = path.join(dir, "run")
    const bin = writeFakeClaude(dir)
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: (t) => `http://127.0.0.1/mcp/${t}`,
      hookUrlFor: (t) => `http://127.0.0.1/hooks/${t}`,
      runRoot: root,
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    id = sessions.create({ projectId: "p1", kind: "worker", name: "ALFA", role: "", cwd: dir, claudeSessionId: "c-1" }).id
  })

  after(async () => {
    await sessions.stop(id).catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("se escriben al arrancar (con el token de la sesión), se borran al detenerla y vuelven al relanzarla", async () => {
    await sessions.start(id)
    const token = db.getSession(id)!.mcpToken
    const mcp = path.join(root, id, "mcp.json")
    assert.ok(JSON.parse(fs.readFileSync(mcp, "utf8")).mcpServers["control-plane"].url.endsWith(`/mcp/${token}`))
    assert.equal(mode(mcp), 0o600)
    assert.equal(mode(path.join(root, id)), 0o700)

    await sessions.stop(id)
    assert.ok(!fs.existsSync(path.join(root, id)), "sin proceso no quedan archivos con tokens")

    await sessions.start(id)
    assert.ok(fs.existsSync(mcp))
  })

  it("cada lanzamiento usa un token nuevo, y el anterior deja de valer (MCP y hooks consultan db.getSessionByToken)", async () => {
    await sessions.stop(id)
    const tokens: string[] = []
    const urlOf = () => JSON.parse(fs.readFileSync(path.join(root, id, "mcp.json"), "utf8")).mcpServers["control-plane"].url as string
    for (let i = 0; i < 3; i++) {
      await sessions.start(id)
      const t = db.getSession(id)!.mcpToken
      tokens.push(t)
      assert.ok(urlOf().endsWith(`/mcp/${t}`), "el archivo lleva el token vigente")
      assert.equal(fs.readFileSync(path.join(root, id, "hook-compact.url"), "utf8"), `http://127.0.0.1/hooks/${t}/compact`)
      await sessions.stop(id)
    }
    assert.equal(new Set(tokens).size, 3)
    for (const t of tokens.slice(0, -1)) assert.equal(db.getSessionByToken(t), null)
    assert.equal(db.getSessionByToken(tokens.at(-1)!)?.id, id)
  })

  it("al archivar la sesión no queda nada, también si ya estaba detenida", async () => {
    await sessions.stop(id)
    writePrivateFile(path.join(sessionRunDir(root, id), "mcp.json"), "resto")
    await sessions.archive(id)
    assert.ok(!fs.existsSync(path.join(root, id)))
  })
})
