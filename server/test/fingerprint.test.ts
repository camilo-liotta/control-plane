import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { fingerprintNotice, sectionHashes, type Fingerprint } from "../src/fingerprint.ts"
import { Hub } from "../src/hub.ts"
import { toolHashes } from "../src/mcp.ts"
import { SessionManager } from "../src/sessions.ts"
import { writeFakeClaude } from "./fake-claude.ts"
import { tmpRunRoot } from "./run-root.ts"

const fp = (tools: Record<string, string>, sections: Record<string, string>, version = "1.2.3"): Fingerprint => ({ version, tools, sections })

describe("huella: el aviso de lo que cambió", () => {
  it("las secciones salen de los títulos ##, sin lo que va antes del primero", () => {
    const h = sectionHashes("# Título\nSesiones: A, B\n\n## Uno\ntexto 1\n\n## Dos\ntexto 2")
    assert.deepEqual(Object.keys(h), ["Uno", "Dos"])
    assert.notEqual(h.Uno, h.Dos)
    assert.deepEqual(sectionHashes("# T\nSesiones: C\n\n## Uno\ntexto 1\n\n## Dos\ntexto 2"), h, "lo de antes del primer título no cuenta")
    assert.notEqual(sectionHashes("## Uno\ntexto 1b")["Uno"], h.Uno)
  })

  it("sin cambios no hay aviso", () => {
    const a = fp({ propose_prompt: "h1" }, { Rol: "s1" })
    assert.equal(fingerprintNotice(a, fp({ propose_prompt: "h1" }, { Rol: "s1" }, "9.9.9")), null)
  })

  it("lista las herramientas nuevas y las que cambiaron, y las secciones nuevas o cambiadas", () => {
    const prev = fp({ propose_prompt: "h1", list_sessions: "l1", viejo: "x" }, { Rol: "s1", Planes: "p1" })
    const cur = fp({ propose_prompt: "h2", list_sessions: "l1", propose_plan: "n1", resume_plan: "n2" }, { Rol: "s1", Planes: "p2", "Modo AFK": "a1" }, "0.8.0")
    assert.equal(
      fingerprintNotice(prev, cur),
      [
        "[control-plane] control-plane se actualizó a v0.8.0.",
        "- Herramientas nuevas: propose_plan, resume_plan.",
        "- Herramientas que cambiaron: propose_prompt.",
        "Volvé a cargarlas con ToolSearch (select:mcp__control-plane__propose_plan,mcp__control-plane__resume_plan,mcp__control-plane__propose_prompt) antes de usarlas: el esquema que tenés en la conversación es el viejo.",
        "- Secciones nuevas o cambiadas de tu protocolo: «Modo AFK», «Planes». Releelas.",
      ].join("\n")
    )
  })

  it("una herramienta que se sacó no avisa", () => {
    assert.equal(fingerprintNotice(fp({ a: "1", b: "2" }, {}), fp({ a: "1" }, {})), null)
  })

  it("sin huella previa, da por cambiado todo lo que existe hoy", () => {
    const text = fingerprintNotice(null, fp({ propose_prompt: "h", propose_plan: "p" }, { Rol: "s", Planes: "p" }, "0.8.0"))!
    assert.match(text, /^\[control-plane\] control-plane se actualizó a v0\.8\.0\./)
    assert.match(text, /Herramientas de control-plane \(puede que tengas guardado el esquema viejo\): propose_prompt, propose_plan\./)
    assert.match(text, /select:mcp__control-plane__propose_prompt,mcp__control-plane__propose_plan\)/)
    assert.match(text, /«Rol», «Planes»\. Releelas\./)
  })
})

describe("huella: lo que recibe cada sesión", () => {
  let dir: string
  let db: Db
  let sessions: SessionManager
  let log: string
  let protocol = "# P\n\n## Rol\nUno\n"
  let tools: Record<string, string> = { propose_prompt: "v1" }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-fp-"))
    log = path.join(dir, "input.log")
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
      launchFor: () => ({ protocol, orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir, FAKE_LOG_INPUT: log }, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    sessions.toolHashes = () => tools
  })

  after(async () => {
    for (const s of db.listSessions()) await sessions.stop(s.id).catch(() => {})
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const received = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string) : [])
  const idle = async (id: string) => {
    for (let i = 0; i < 100 && sessions.statusOf(id) !== "idle"; i++) await new Promise((r) => setTimeout(r, 50))
  }
  const notices = (id: string) => db.listEvents(id).map((e) => e.event).filter((e) => e.kind === "notice" && /se actualizó/.test(e.text))

  it("una sesión nueva arranca con la huella al día y no recibe aviso", async () => {
    const rec = sessions.create({ projectId: "p1", kind: "worker", name: "NUEVA", role: "", cwd: dir })
    await sessions.start(rec.id)
    assert.deepEqual(db.getFingerprint(rec.id)?.tools, tools)
    await sessions.send(rec.id, "hola nueva", { origin: "user" })
    await idle(rec.id)
    assert.ok(received().includes("hola nueva"), "llega tal cual")
    assert.equal(notices(rec.id).length, 0)
  })

  it("una sesión de antes (con historia y sin huella) recibe el bloque una sola vez, y no se ve en el chat", async () => {
    const rec = sessions.create({ projectId: "p1", kind: "worker", name: "VIEJA", role: "", cwd: dir })
    db.updateSession(rec.id, { startedOnce: true })
    assert.equal(db.getFingerprint(rec.id), null)
    await sessions.send(rec.id, "primero", { origin: "user" })
    await idle(rec.id)
    const first = received().find((t) => t.endsWith("primero"))!
    assert.match(first, /^\[control-plane\] control-plane se actualizó a v/)
    assert.match(first, /Herramientas de control-plane .*propose_prompt\./)
    assert.match(first, /select:mcp__control-plane__propose_prompt\)/)
    assert.match(first, /«Rol»\. Releelas\./)
    assert.ok(first.endsWith("\n\nprimero"))
    // En el chat, el mensaje original; solo una línea discreta.
    const user = db.listEvents(rec.id).map((e) => e.event).filter((e) => e.kind === "user")
    assert.equal(user[0]!.kind === "user" && user[0]!.text, "primero")
    assert.equal(notices(rec.id).length, 1)
    // Una sola vez.
    await sessions.send(rec.id, "segundo", { origin: "user" })
    await idle(rec.id)
    assert.equal(received().find((t) => t.endsWith("segundo")), "segundo")
    assert.equal(notices(rec.id).length, 1)
    assert.deepEqual(db.getFingerprint(rec.id)?.tools, tools)
  })

  it("un cambio en una herramienta o en el protocolo lo dispara de nuevo después del próximo lanzamiento", async () => {
    const rec = db.listSessions().find((s) => s.name === "VIEJA")!
    await sessions.stop(rec.id)
    tools = { propose_prompt: "v2", propose_plan: "n1" }
    protocol = "# P\n\n## Rol\nUno\n\n## Planes\nNuevo\n"
    await sessions.send(rec.id, "tercero", { origin: "user" })
    await idle(rec.id)
    const third = received().find((t) => t.endsWith("tercero"))!
    assert.match(third, /- Herramientas nuevas: propose_plan\./)
    assert.match(third, /- Herramientas que cambiaron: propose_prompt\./)
    assert.match(third, /«Planes»\. Releelas\./)
    assert.doesNotMatch(third, /«Rol»/)
    assert.equal(notices(rec.id).length, 2)
  })

  it("los comandos (/clear, /compact) no llevan el aviso: espera al primer mensaje de verdad", async () => {
    const rec = sessions.create({ projectId: "p1", kind: "worker", name: "VIEJA2", role: "", cwd: dir })
    db.updateSession(rec.id, { startedOnce: true })
    await sessions.send(rec.id, "/compact", { origin: "control" })
    await idle(rec.id)
    assert.equal(received().includes("/compact"), true)
    assert.equal(notices(rec.id).length, 0)
    await sessions.send(rec.id, "después", { origin: "user" })
    await idle(rec.id)
    assert.match(received().find((t) => t.endsWith("después"))!, /^\[control-plane\] control-plane se actualizó/)
  })
})

describe("huella: el esquema de las herramientas MCP", () => {
  const deps = { db: {}, sessions: {}, orchestration: {} } as unknown as Parameters<typeof toolHashes>[1]
  const rec = (kind: "orchestrator" | "worker") => ({ kind }) as SessionRecord

  it("cada rol ve las suyas, con un hash por herramienta", () => {
    const orq = toolHashes(rec("orchestrator"), deps)
    const worker = toolHashes(rec("worker"), deps)
    for (const t of ["propose_prompt", "propose_session", "propose_plan", "update_proposal", "resume_plan", "cancel_plan"]) assert.match(orq[t] ?? "", /^[0-9a-f]{12}$/, t)
    for (const t of ["propose_prompt", "propose_plan"]) assert.equal(worker[t], undefined, `un worker no ve ${t}`)
    assert.ok(worker.report_result)
    assert.equal(toolHashes(rec("orchestrator"), deps), orq, "se calcula una vez")
  })
})
