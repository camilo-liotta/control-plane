import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { Compaction } from "../src/compaction.ts"
import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { SessionManager } from "../src/sessions.ts"
import type { CompactMode, TimelineEvent } from "../src/shared/types.ts"
import { writeFakeClaude } from "./fake-claude.ts"

describe("un mensaje que no entra porque el contexto está lleno", () => {
  let dir: string
  let bin: string
  let db: Db
  let sessions: SessionManager
  let compaction: Compaction
  let rec: SessionRecord

  const build = (full: boolean, extra: Record<string, string> = {}) => {
    const env: Record<string, string> = { CLAUDE_CONFIG_DIR: dir, ...(full ? { FAKE_FULL: "1" } : {}), ...extra }
    sessions = new SessionManager({
      db,
      hub: new Hub(),
      attachments: new AttachmentStore(db),
      mcpUrlFor: () => "http://127.0.0.1/mcp",
      hookUrlFor: () => "http://127.0.0.1/hooks",
      launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env, bin, accountId: "acc" }),
      accountIdFor: () => "acc",
      meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
    })
    compaction = new Compaction({ db, hub: new Hub(), sessions, launchFor: () => ({ bin, env, model: null }) })
  }

  const setup = (mode: CompactMode) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-full-"))
    bin = writeFakeClaude(dir)
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: { ...defaultSettings, compactMode: mode }, accountId: null, createdAt: 1, archivedAt: null })
    build(true)
    rec = sessions.create({ projectId: "p1", kind: "worker", name: "DELTA", role: "", cwd: dir, claudeSessionId: "c-1" })
  }

  const events = (): TimelineEvent[] => db.listEvents(rec.id).map((e) => e.event)
  const texts = () => events().flatMap((e) => (e.kind === "text" ? [e.text] : []))
  const notices = () => events().flatMap((e) => (e.kind === "notice" ? [e.text] : []))
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(check(), `no llegó a tiempo: ${what}`)
  }

  afterEach(async () => {
    await sessions.stop(rec.id).catch(() => {})
    compaction.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe("con Claude compactando solo (avisarme)", () => {
    beforeEach(() => setup("notify"))

    it("compacta con /compact y reenvía el mensaje, una sola vez", async () => {
      await sessions.send(rec.id, "## TAREA 1: mergear la rama de migraciones", { origin: "user" })
      await until(() => texts().some((t) => t.startsWith("respuesta a: ## TAREA 1")), "la respuesta al reenvío")
      assert.ok(notices().some((t) => t.startsWith("El contexto se llenó")), "avisa qué pasó")
      assert.ok(events().some((e) => e.kind === "compact"), "compactó")
      assert.ok(notices().includes("Reenvié el mensaje que no había entrado."))
      // En el chat el mensaje aparece una vez: el reenvío se ve como aviso.
      assert.equal(events().filter((e) => e.kind === "user").length, 1)
      const ends = events().filter((e) => e.kind === "turn_end")
      assert.equal(ends.at(-1)?.kind === "turn_end" && ends.at(-1)?.ok, true)
      assert.equal(compaction.view(rec.id).resendPending, false)
    })
  })

  describe("en modo esperarme", () => {
    beforeEach(() => setup("ask"))

    it("no compacta solo: espera y reenvía cuando compactás", async () => {
      await sessions.send(rec.id, "mergeá la rama A", { origin: "user" })
      await until(() => compaction.view(rec.id).resendPending, "que quede pendiente")
      assert.ok(notices().some((t) => t.startsWith("El contexto está lleno")))
      assert.equal(events().some((e) => e.kind === "compact"), false, "no compactó sin preguntar")
      const held = sessions.view(db.getSession(rec.id)!)
      assert.deepEqual([held.status, held.statusDetail], ["needs_input", "Contexto lleno: compactá para seguir"])

      await compaction.direct(rec.id)
      await until(() => texts().some((t) => t === "respuesta a: mergeá la rama A"), "el reenvío después de compactar")
      assert.notEqual(sessions.view(db.getSession(rec.id)!).statusDetail, "Contexto lleno: compactá para seguir")
    })
  })

  describe("si el server se reinició", () => {
    beforeEach(() => setup("ask"))

    it("arma el mensaje desde el historial y lo reenvía con el botón", async () => {
      await sessions.send(rec.id, "mergeá la rama B", { origin: "user" })
      await until(() => compaction.view(rec.id).resendPending, "el fallo")
      // Otro server: sin nada en memoria, solo la base.
      await sessions.stop(rec.id)
      compaction.dispose()
      build(true)
      assert.equal(sessions.hasUnsent(rec.id), true)
      await compaction.compactAndResend(rec.id)
      await until(() => texts().some((t) => t === "respuesta a: mergeá la rama B"), "el reenvío")
    })

    it("si /compact termina sin compactar, avisa y el mensaje queda pendiente", async () => {
      await sessions.stop(rec.id)
      compaction.dispose()
      build(true, { FAKE_NO_COMPACT: "1" })
      await sessions.send(rec.id, "mergeá la rama C", { origin: "user" })
      await until(() => compaction.view(rec.id).resendPending, "el fallo")
      await compaction.compactAndResend(rec.id)
      await until(() => notices().some((t) => t.startsWith("No se pudo compactar")), "el aviso")
      assert.equal(compaction.view(rec.id).resendPending, true, "sigue pendiente para otro intento")
      assert.equal(texts().some((t) => t.startsWith("respuesta a:")), false)
    })

    it("sin un fallo por contexto lleno no hay nada que reenviar", async () => {
      await sessions.stop(rec.id)
      compaction.dispose()
      build(false)
      await sessions.send(rec.id, "hola", { origin: "user" })
      await until(() => texts().some((t) => t === "respuesta a: hola"), "la respuesta")
      await assert.rejects(compaction.compactAndResend(rec.id), /No hay un mensaje sin enviar/)
    })
  })
})
