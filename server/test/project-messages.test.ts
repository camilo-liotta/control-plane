import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { Db, defaultSettings, type ProjectMessageRow } from "../src/db.ts"

const msg = (id: string, from: string, to: string, createdAt: number, extra: Partial<ProjectMessageRow> = {}): ProjectMessageRow => ({
  id,
  fromProjectId: from,
  toProjectId: to,
  fromSessionId: `s_${from}`,
  toSessionId: null,
  text: `texto ${id}`,
  replyTo: null,
  createdAt,
  deliveredAt: null,
  ...extra,
})

describe("mensajes entre proyectos: la base", () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-pm-"))
    db = new Db(path.join(dir, "t.db"))
    for (const id of ["a", "b", "c"])
      db.insertProject({ id, name: id.toUpperCase(), repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("guarda, entrega, devuelve a la cola y cuenta por ventana", () => {
    db.insertProjectMessage(msg("m_1", "a", "b", 100))
    db.insertProjectMessage(msg("m_2", "a", "b", 200, { replyTo: "m_0" }))
    db.insertProjectMessage(msg("m_3", "b", "a", 300))
    assert.deepEqual(db.listQueuedProjectMessages("b").map((m) => m.id), ["m_1", "m_2"])
    assert.equal(db.getProjectMessage("m_2")!.replyTo, "m_0")

    db.markProjectMessagesDelivered(["m_1"], "s_orch_b", 400)
    assert.deepEqual(db.listQueuedProjectMessages("b").map((m) => m.id), ["m_2"])
    assert.equal(db.getProjectMessage("m_1")!.toSessionId, "s_orch_b")
    assert.equal(db.getProjectMessage("m_1")!.deliveredAt, 400)
    db.requeueProjectMessages(["m_1"])
    assert.deepEqual(db.listQueuedProjectMessages("b").map((m) => m.id), ["m_1", "m_2"])

    assert.equal(db.countProjectMessagesSince("a", "b", 0), 2)
    assert.equal(db.countProjectMessagesSince("a", "b", 150), 1, "solo cuenta lo que entra en la ventana")
    assert.equal(db.countProjectMessagesSince("b", "a", 0), 1, "cada sentido cuenta aparte")
    assert.equal(db.countProjectMessagesSince("a", "c", 0), 0)
  })

  it("los de un proyecto, enviados y recibidos, más nuevos primero", () => {
    db.insertProjectMessage(msg("m_1", "a", "b", 100))
    db.insertProjectMessage(msg("m_2", "b", "a", 200))
    db.insertProjectMessage(msg("m_3", "b", "c", 300))
    assert.deepEqual(db.listProjectMessages("a").map((m) => m.id), ["m_2", "m_1"])
    assert.deepEqual(db.listProjectMessages("b").map((m) => m.id), ["m_3", "m_2", "m_1"])
    assert.deepEqual(db.listProjectMessages("b", 2).map((m) => m.id), ["m_3", "m_2"])
  })

  it("borrar un proyecto borra los mensajes que mandó y los que recibió, y deja los de los otros", () => {
    db.insertProjectMessage(msg("m_1", "a", "b", 100))
    db.insertProjectMessage(msg("m_2", "b", "a", 200))
    db.insertProjectMessage(msg("m_3", "b", "c", 300))
    db.purgeProject("a")
    assert.equal(db.getProjectMessage("m_1"), null)
    assert.equal(db.getProjectMessage("m_2"), null)
    assert.ok(db.getProjectMessage("m_3"))
  })
})
