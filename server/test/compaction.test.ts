import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { StreamNormalizer } from "../src/claude/normalize.ts"
import { Compaction, compactInstructions, parseDraft } from "../src/compaction.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import type { Hub } from "../src/hub.ts"
import type { SendOptions, SessionManager } from "../src/sessions.ts"
import type { ServerMessage } from "../src/shared/types.ts"

describe("borrador de compactación", () => {
  it("lee el JSON aunque venga en un bloque de código y numera los puntos", () => {
    const raw = 'Acá va:\n```json\n{"sections":[{"title":"Archivos y código","points":["server/db.ts: tabla attachments"," "]},{"title":"Tareas pendientes","points":["Tests de la cola"]},{"title":"Vacía","points":[]}]}\n```'
    const sections = parseDraft(raw)
    assert.equal(sections.length, 2)
    assert.deepEqual(
      sections.map((s) => s.points.map((p) => p.id)),
      [["p1"], ["p2"]]
    )
    assert.equal(sections[0]!.points[0]!.text, "server/db.ts: tabla attachments")
  })

  it("rechaza respuestas que no son el borrador", () => {
    assert.throws(() => parseDraft("No puedo hacer eso."), /formato/)
    assert.throws(() => parseDraft('{"sections":[]}'), /vacío/)
  })

  it("las instrucciones conservan lo elegido y prohíben lo descartado", () => {
    const { text, kept, dropped } = compactInstructions({
      sections: [
        { title: "Pedido e intención", points: [{ text: "Armar el dashboard", keep: true }, { text: "Mi auto es rojo", keep: false }] },
        { title: "Tareas pendientes", points: [{ text: "Tests de la cola", keep: true }] },
      ],
      extra: "Mantené los nombres de sesión en mayúsculas.",
    })
    assert.equal(kept, 2)
    assert.equal(dropped, 1)
    assert.match(text, /<curated_summary>\n## Pedido e intención\n- Armar el dashboard\n\n## Tareas pendientes\n- Tests de la cola\n<\/curated_summary>/)
    assert.match(text, /copy the text between <curated_summary> tags exactly/)
    assert.match(text, /must not appear anywhere[^\n]*\n- Mi auto es rojo/)
    assert.match(text, /Additional instructions from the user:\nMantené los nombres/)
    assert.doesNotMatch(text.split("removed these facts")[0]!, /Mi auto es rojo/)
  })
})

describe("instrucciones sin borrador", () => {
  it("van tal cual, como las de /compact, sin reemplazar el resumen de Claude Code", () => {
    const r = compactInstructions({ sections: [], extra: "Conservá la lista de pendientes y los nombres de las tablas" })
    assert.deepEqual(r, { text: "Conservá la lista de pendientes y los nombres de las tablas", kept: 0, dropped: 0 })
  })
})

describe("stream de una compactación", () => {
  it("guarda métricas, toma el resumen y oculta el 'Compacted' de los hooks", () => {
    const n = new StreamNormalizer(() => false)
    const [boundary] = n.handle({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 29522, post_tokens: 5572, duration_ms: 4583 },
    })
    assert.deepEqual(boundary, {
      type: "event",
      event: { kind: "compact", trigger: "manual", preTokens: 29522, postTokens: 5572, durationMs: 4583 },
    })
    const [summary] = n.handle({
      type: "user",
      isSynthetic: true,
      message: {
        role: "user",
        content:
          "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n## Tareas pendientes\n- Tests de la cola\n\nIf you need specific details from before compaction (like exact code snippets), read the full transcript at: /x.jsonl\nContinue the conversation from where it left off.",
      },
    })
    assert.deepEqual(summary, { type: "compact_summary", text: "## Tareas pendientes\n- Tests de la cola" })
    const hidden = n.handle({
      type: "user",
      isReplay: true,
      uuid: "u1",
      message: { role: "user", content: "<local-command-stdout>Compacted PreCompact [hook] completed successfully: …</local-command-stdout>" },
    })
    assert.deepEqual(hidden, [])
  })
})

class FakeSessions extends EventEmitter {
  holds: (string | null)[] = []
  sent: { id: string; text: string; opts: SendOptions }[] = []
  setHold(_id: string, reason: string | null) {
    this.holds.push(reason)
  }
  contextOf() {
    return { tokens: 150_000, max: 200_000, threshold: 167_000, autoCompact: true, categories: [], updatedAt: 0 }
  }
  addEvent() {}
  async send(id: string, text: string, opts: SendOptions) {
    this.sent.push({ id, text, opts })
  }
  async holdUnsent() {
    return 0
  }
  async control() {
    return { response: '{"sections":[{"title":"Tareas pendientes","points":["Tests de la cola"]}]}' }
  }
}

describe("modo esperarme", () => {
  let dir: string
  let db: Db
  let sessions: FakeSessions
  let messages: ServerMessage[]
  let compaction: Compaction
  let rec: SessionRecord

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-compact-"))
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({
      id: "p1",
      name: "P",
      repoPath: dir,
      settings: { ...defaultSettings, compactMode: "ask", compactWaitMin: 5 },
      accountId: null,
      createdAt: 1,
      archivedAt: null,
    })
    rec = {
      id: "s1",
      projectId: "p1",
      kind: "worker",
      name: "ALFA",
      role: "",
      claudeSessionId: "c1",
      startedOnce: true,
      mcpToken: "tok",
      model: null,
      effort: null,
      worktree: false,
      cwd: dir,
      status: "working",
      taskTitle: null,
      taskState: "none",
      lastActivity: null,
      lastActivityAt: null,
      costUsd: 0,
      tokens: null,
      context: null,
      createdAt: 1,
      archivedAt: null,
    }
    db.insertSession(rec)
    sessions = new FakeSessions()
    messages = []
    const hub = { broadcast: (m: ServerMessage) => messages.push(m) } as unknown as Hub
    compaction = new Compaction({
      db,
      hub,
      sessions: sessions as unknown as SessionManager,
      launchFor: () => ({ bin: "false", env: {}, model: null }),
    })
  })

  afterEach(() => {
    compaction.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("frena la compactación automática hasta que elegís, y le pasa tu selección", async () => {
    const pending = compaction.hook("tok", { hook_event_name: "PreCompact", trigger: "auto" }, () => {})
    assert.equal(compaction.view("s1").waiting !== null, true)
    assert.equal(sessions.holds.at(-1), "Por compactar: elegí qué conservar")
    assert.ok(messages.some((m) => m.type === "toast" && m.open === "compaction"))
    await compaction.apply("s1", {
      sections: [{ title: "Tareas pendientes", points: [{ text: "Tests de la cola", keep: true }, { text: "El auto es rojo", keep: false }] }],
    })
    const text = await pending
    assert.match(text, /- Tests de la cola/)
    assert.match(text, /removed these facts[^\n]*\n- El auto es rojo/)
    assert.equal(sessions.holds.at(-1), null)
    assert.equal(sessions.sent.length, 0, "no manda /compact: la compactación ya estaba en curso")
  })

  it("las compactaciones manuales y los otros modos no esperan", async () => {
    assert.equal(await compaction.hook("tok", { hook_event_name: "PreCompact", trigger: "manual" }, () => {}), "")
    db.updateProject("p1", { settings: { ...defaultSettings, compactMode: "notify" } })
    assert.equal(await compaction.hook("tok", { hook_event_name: "PreCompact", trigger: "auto" }, () => {}), "")
    assert.equal(await compaction.hook("otro", { hook_event_name: "PreCompact", trigger: "auto" }, () => {}), "")
  })

  it("si Claude Code corta el hook, deja de esperar", async () => {
    let close: () => void = () => {}
    const pending = compaction.hook("tok", { hook_event_name: "PreCompact", trigger: "auto" }, (cb) => (close = cb))
    close()
    assert.equal(await pending, "")
    assert.equal(compaction.view("s1").waiting, null)
  })

  it("si la compactación con tu selección falla, el próximo intento la usa sin volver a preguntar", async () => {
    const first = compaction.hook("tok", { hook_event_name: "PreCompact", trigger: "auto" }, () => {})
    await compaction.apply("s1", { sections: [{ title: "Pendientes", points: [{ text: "Tests", keep: true }, { text: "El auto", keep: false }] }] })
    const text = await first
    sessions.emit("compactFailed", "s1", "too_few_groups")
    const again = await compaction.hook("tok", { hook_event_name: "PreCompact", trigger: "auto" }, () => {})
    assert.equal(again, text)
    assert.equal(compaction.view("s1").waiting, null, "no queda esperando")
  })

  it("compactar a mano manda /compact con las instrucciones", async () => {
    await compaction.apply("s1", { sections: [{ title: "Pendientes", points: [{ text: "Tests", keep: true }] }] })
    const last = sessions.sent.at(-1)!
    assert.match(last.text, /^\/compact \[control-plane\]/)
    assert.equal(last.opts.event?.kind, "notice")
    assert.equal(compaction.view("s1").applying, true)
  })
})
