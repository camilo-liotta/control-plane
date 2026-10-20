import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, afterEach, before, beforeEach, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { lastCostState } from "../src/claude/local.ts"
import { SessionManager } from "../src/sessions.ts"
import type { ExternalSession } from "../src/shared/types.ts"
import { writeFakeClaude } from "./fake-claude.ts"
import { tmpRunRoot } from "./run-root.ts"

describe("una conversación abierta en otro lado", () => {
  let dir: string
  let db: Db
  let live: ExternalSession | null
  let launched: number
  let sessions: SessionManager
  let rec: SessionRecord

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-sessions-"))
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    live = { pid: 12345, kind: "interactive", id: null }
    launched = 0
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      runRoot: tmpRunRoot(),
      launchFor: () => {
        launched++
        throw new Error("no debería lanzarse")
      },
      accountIdFor: () => "acc",
      liveElsewhere: async () => live,
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    rec = sessions.create({ projectId: "p1", kind: "worker", name: "BETA", role: "", cwd: dir, claudeSessionId: "c-123" })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("no se reanuda mientras siga abierta en una terminal, y lo dice", async () => {
    await assert.rejects(sessions.start(rec.id), /abierta en una terminal \(pid 12345\).*\/exit/)
    assert.equal(launched, 0, "no lanzó un segundo proceso sobre la misma conversación")
    assert.deepEqual(sessions.view(db.getSession(rec.id)!).external, live)
  })

  it("en segundo plano, dice cómo detenerla", async () => {
    live = { pid: 99, kind: "background", id: "5e1c0a2b" }
    await assert.rejects(sessions.start(rec.id), /claude stop 5e1c0a2b/)
  })

  it("cuando se cierra, arranca normalmente", async () => {
    live = null
    await assert.rejects(sessions.start(rec.id), /no debería lanzarse/)
    assert.equal(launched, 1)
  })
})

describe("lo gastado en una sesión", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  let rec: SessionRecord

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-spend-"))
    const bin = writeFakeClaude(dir)
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      runRoot: tmpRunRoot(),
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    rec = sessions.create({ projectId: "p1", kind: "worker", name: "ALFA", role: "", cwd: dir, claudeSessionId: "c-1" })
  })

  after(async () => {
    await sessions.stop(rec.id).catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(check(), "no llegó a tiempo")
  }

  it("se suma entre procesos sin contar dos veces lo que Claude Code restaura al reanudar", async () => {
    await sessions.send(rec.id, "uno", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd === 0.25)
    await sessions.send(rec.id, "dos", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd === 0.5)
    assert.equal(db.getSession(rec.id)!.tokens?.total, 230)

    // Al cerrarse guarda su cost-state; el proceso nuevo sigue desde ahí (0,5 + 0,25), como Claude Code.
    await sessions.stop(rec.id)
    await sessions.send(rec.id, "tres", { origin: "user" })
    await until(() => db.getSession(rec.id)!.costUsd !== 0.5)
    assert.equal(db.getSession(rec.id)!.costUsd, 0.75)
    const t = db.getSession(rec.id)!.tokens!
    assert.deepEqual([t.input, t.output, t.cacheRead, t.total], [30, 15, 300, 345])
    const ends = db.listEvents(rec.id).map((e) => e.event).filter((e) => e.kind === "turn_end")
    assert.deepEqual(ends.map((e) => e.kind === "turn_end" && e.costUsd), [0.25, 0.5, 0.75], "el acumulado del fin de turno sigue al de la sesión")
    assert.deepEqual(db.getSession(rec.id)!.costByModel, { "claude-x": 0.75 })
  })

  it("cuenta lo de cada modelo por turno y en la sesión, aunque se reinicie o empiece de cero", async () => {
    const s = sessions.create({ projectId: "p1", kind: "worker", name: "DELTA", role: "", cwd: dir, claudeSessionId: "c-4" })
    const r6 = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]))
    const turnModels = () =>
      db.listEvents(s.id).map((e) => e.event).flatMap((e) => (e.kind === "turn_end" ? [(e.models ?? []).map((m) => `${m.model} ${Math.round(m.usd * 100) / 100}`)] : []))
    await sessions.send(s.id, "uno", { origin: "user" })
    await until(() => db.getSession(s.id)!.costUsd === 0.25)
    await sessions.send(s.id, "usá HAIKU", { origin: "user" })
    await until(() => db.getSession(s.id)!.costUsd > 0.5)
    assert.deepEqual(r6(db.getSession(s.id)!.costByModel), { "claude-x": 0.5, "claude-y": 0.05 })
    // Proceso nuevo: Claude Code restaura los totales; el turno cuenta solo lo suyo.
    await sessions.stop(s.id)
    await sessions.send(s.id, "tres", { origin: "user" })
    await until(() => db.getSession(s.id)!.costUsd > 0.75)
    assert.deepEqual(r6(db.getSession(s.id)!.costByModel), { "claude-x": 0.75, "claude-y": 0.05 })
    // /clear: los totales vuelven a cero, lo de antes queda.
    await until(() => sessions.statusOf(s.id) === "idle")
    await sessions.clearConversation(s.id)
    await sessions.send(s.id, "otra vez HAIKU", { origin: "user" })
    await until(() => db.getSession(s.id)!.costUsd > 1)
    assert.deepEqual(r6(db.getSession(s.id)!.costByModel), { "claude-x": 1, "claude-y": 0.1 })
    assert.deepEqual(turnModels(), [["claude-x 0.25"], ["claude-x 0.25", "claude-y 0.05"], ["claude-x 0.25"], [], ["claude-x 0.25", "claude-y 0.05"]])
    // Después del /clear el CLI informó su modelo (init): el fin de turno dice cuál es el de la sesión.
    const last = db.listEvents(s.id).map((e) => e.event).filter((e) => e.kind === "turn_end").at(-1)
    assert.equal(last?.kind === "turn_end" && last.model, "claude-x")
    await sessions.stop(s.id)
  })

  it("/clear empieza una conversación nueva sin perder lo gastado antes", async () => {
    const s = sessions.create({ projectId: "p1", kind: "worker", name: "GAMMA", role: "", cwd: dir, claudeSessionId: "c-3" })
    await sessions.send(s.id, "uno", { origin: "user" })
    await until(() => db.getSession(s.id)!.costUsd === 0.25 && sessions.statusOf(s.id) === "idle")
    await sessions.clearConversation(s.id)
    assert.notEqual(db.getSession(s.id)!.claudeSessionId, "c-3", "sigue con el id nuevo")
    // Claude Code arranca los totales de la conversación nueva en cero: lo de antes queda como base.
    await sessions.send(s.id, "dos", { origin: "user" })
    await until(() => db.getSession(s.id)!.costUsd !== 0.25)
    assert.equal(db.getSession(s.id)!.costUsd, 0.5)
    assert.equal(db.getSession(s.id)!.tokens?.total, 230)
    await sessions.stop(s.id)
  })

  it("una conversación importada arranca con lo que ya había gastado y suma solo lo nuevo", async () => {
    const other = sessions.create({ projectId: "p1", kind: "worker", name: "BETA", role: "", cwd: dir, claudeSessionId: "c-2" })
    const tdir = path.join(dir, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"))
    fs.mkdirSync(tdir, { recursive: true })
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 }
    fs.writeFileSync(path.join(tdir, "c-2.jsonl"), JSON.stringify({ type: "cost-state", sessionId: "c-2", totalCostUSD: 10, modelUsage: { "claude-x": usage } }) + "\n")
    const spent = lastCostState(dir, "c-2", dir)
    assert.deepEqual(spent, { usd: 10, tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, total: 1150 }, byModel: {} })
    db.updateSession(other.id, { costUsd: spent!.usd, tokens: spent!.tokens })
    await sessions.send(other.id, "hola", { origin: "user" })
    await until(() => db.getSession(other.id)!.costUsd !== 10)
    assert.equal(db.getSession(other.id)!.costUsd, 10.25)
    assert.equal(db.getSession(other.id)!.tokens?.total, 1265)
    await sessions.stop(other.id)
  })
})

describe("el último cost-state del transcript", () => {
  it("lo encuentra aunque haya líneas enormes después y lo ignora si es de otra conversación", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-cost-"))
    const tdir = path.join(dir, "projects", "-repo")
    fs.mkdirSync(tdir, { recursive: true })
    const line = (o: object) => JSON.stringify(o) + "\n"
    fs.writeFileSync(
      path.join(tdir, "s1.jsonl"),
      line({ type: "cost-state", sessionId: "s1", totalCostUSD: 1, modelUsage: {} }) +
        line({ type: "cost-state", sessionId: "s1", totalCostUSD: 2.5, modelUsage: { m: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } } }) +
        line({ type: "assistant", message: { content: "x".repeat(3 * 1024 * 1024) } }) +
        line({ type: "cost-state", sessionId: "otra", totalCostUSD: 99, modelUsage: {} })
    )
    assert.deepEqual(lastCostState("/repo", "s1", dir), { usd: 2.5, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, byModel: {} })
    assert.equal(lastCostState("/repo", "no-existe", dir), null)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("el nombre del proceso (--name) de cada sesión", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  let argsFile: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-procname-"))
    db = new Db(path.join(dir, "t.db"))
    for (const [id, name] of [["p1", "Alfa"], ["p2", "Beta"]] as const)
      db.insertProject({ id, name, repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    // Un "claude" que solo anota con qué argumentos lo lanzaron.
    argsFile = path.join(dir, "args.json")
    const bin = path.join(dir, "claude-args.mjs")
    fs.writeFileSync(bin, `#!/usr/bin/env node\nimport fs from "node:fs"\nfs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 })
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      runRoot: tmpRunRoot(),
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
  })
  afterEach(async () => {
    await sessions.shutdown().catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const make = (projectId: string, name: string) => sessions.create({ projectId, kind: "worker", name, role: "", cwd: dir })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(check(), "no llegó a tiempo")
  }
  const launchedName = async (id: string) => {
    fs.rmSync(argsFile, { force: true })
    await sessions.start(id).catch(() => {})
    await until(() => fs.existsSync(argsFile))
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[]
    return args[args.indexOf("--name") + 1]
  }

  it("sin choque, el --name es el nombre tal cual; con una de otro proyecto, el segundo se califica", async () => {
    const a = make("p1", "INFRA")
    const web = make("p2", "WEB")
    assert.equal(a.processName, "INFRA")
    assert.equal(web.processName, "WEB")
    const b = make("p2", "INFRA")
    assert.equal(b.name, "INFRA", "el nombre que se ve sigue siendo el corto")
    assert.equal(b.processName, "INFRA·beta")
    assert.equal(db.getSession(a.id)!.processName, "INFRA", "la que ya estaba no cambia")
    assert.equal(await launchedName(a.id), "INFRA")
    assert.equal(await launchedName(b.id), "INFRA·beta")
  })

  it("el choque que aparece después: el que ya existe se queda con el nombre; al lanzar se recalcula", async () => {
    const b = make("p2", "INFRA")
    assert.equal(b.processName, "INFRA")
    const a = make("p1", "INFRA")
    assert.equal(a.processName, "INFRA·alfa", "la más nueva se califica")
    await sessions.stop(b.id)
    assert.equal(await launchedName(b.id), "INFRA", "la que ya existía sigue sin calificar")
    // Si la que tenía el nombre se archiva, la otra lo recupera la próxima vez que se lance (y al restaurarse).
    await sessions.archive(b.id)
    assert.equal(await launchedName(a.id), "INFRA")
    assert.equal(db.getSession(a.id)!.processName, "INFRA")
    sessions.update(b.id, { archivedAt: null })
    assert.equal(sessions.refreshProcessName(b.id), "INFRA·beta", "al restaurarse, la que llega después se califica")
  })

  it("renombrar recalcula el nombre del proceso; el nombre que se ve es el elegido", async () => {
    make("p1", "INFRA")
    const w = make("p2", "OTRA")
    await sessions.rename(w.id, "INFRA")
    assert.equal(db.getSession(w.id)!.name, "INFRA")
    assert.equal(db.getSession(w.id)!.processName, "INFRA·beta")
    await sessions.rename(w.id, "BACK")
    assert.equal(db.getSession(w.id)!.processName, "BACK")
  })
})
