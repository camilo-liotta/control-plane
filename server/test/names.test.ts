import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { SessionRecord } from "../src/db.ts"
import { assertNotReserved, displayName, isReservedName, nameTaken, pickProcessName, projectQualifier, shortName } from "../src/names.ts"

let n = 0
function rec(projectId: string, name: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  n++
  return {
    id: `s_${n}`, projectId, kind: "worker", name, processName: name, role: "", claudeSessionId: `c-${n}`, startedOnce: true, mcpToken: `tok-${n}`, model: null,
    effort: null, worktree: false, cwd: "/tmp", status: "idle", taskTitle: null, taskState: "none", lastActivity: null,
    lastActivityAt: null, costUsd: 0, costByModel: {}, tokens: null, context: null, createdAt: n, archivedAt: null, ...extra,
  }
}

describe("nombres de sesión", () => {
  it("nameTaken: solo dentro del proyecto, sin distinguir mayúsculas y sin contar archivadas ni a la misma sesión", () => {
    const infraA = rec("a", "INFRA")
    const list = [infraA, rec("b", "WEB"), rec("a", "VIEJA", { archivedAt: 5 })]
    assert.equal(nameTaken(list, "a", "infra"), true)
    assert.equal(nameTaken(list, "b", "INFRA"), false, "otro proyecto")
    assert.equal(nameTaken(list, "a", "WEB"), false, "WEB es de b")
    assert.equal(nameTaken(list, "a", "vieja"), false, "archivada")
    assert.equal(nameTaken(list, "a", "INFRA", infraA.id), false, "ella misma")
  })

  it("pickProcessName: sin choque es el nombre tal cual; con choque, calificado con el proyecto", () => {
    const infraB = rec("b", "INFRA")
    const mine = rec("a", "INFRA")
    assert.equal(pickProcessName([], mine, "Alfa"), "INFRA")
    assert.equal(pickProcessName([rec("b", "WEB")], mine, "Alfa"), "INFRA")
    assert.equal(pickProcessName([infraB], mine, "Alfa"), "INFRA·alfa")
    assert.equal(pickProcessName([infraB], mine, "Mi Proyecto Ñ!"), "INFRA·mi-proyecto-n", "el proyecto, como lo aceptan los nombres")
    assert.equal(pickProcessName([infraB], mine, ""), "INFRA·proyecto")
    assert.equal(pickProcessName([rec("b", "infra")], mine, "Alfa"), "INFRA·alfa", "sin distinguir mayúsculas")
  })

  it("pickProcessName: el que tiene el nombre se queda con él, también si es el más nuevo; no cuenta archivadas ni a sí misma", () => {
    const old = rec("b", "INFRA", { createdAt: 1 })
    const later = rec("a", "INFRA", { createdAt: 99, processName: "INFRA·alfa" })
    assert.equal(pickProcessName([old, later], old, "Beta"), "INFRA", "el que ya corre con INFRA no lo pierde")
    assert.equal(pickProcessName([old, later], later, "Alfa"), "INFRA·alfa")
    assert.equal(pickProcessName([rec("b", "INFRA", { archivedAt: 3 })], later, "Alfa"), "INFRA")
    // Si el nombre calificado también estaba tomado (dos proyectos que se llaman igual), sigue con un número.
    const q = rec("c", "INFRA", { processName: "INFRA·alfa" })
    assert.equal(pickProcessName([old, q], later, "Alfa"), "INFRA·alfa·2")
  })

  it("displayName y shortName: del nombre del proceso al que se muestra", () => {
    const list = [rec("a", "INFRA", { processName: "INFRA·a" }), rec("b", "INFRA")]
    assert.equal(displayName(list, "INFRA·a"), "INFRA")
    assert.equal(displayName(list, "infra"), "INFRA")
    assert.equal(displayName(list, "INFRA·archivada"), "INFRA", "sin la sesión, se le saca el proyecto")
    assert.equal(displayName(list, "una-de-afuera"), "una-de-afuera")
    assert.equal(shortName("INFRA·a·2"), "INFRA")
    assert.equal(shortName("INFRA"), "INFRA")
    assert.equal(projectQualifier("Inmos"), "inmos")
  })

  it("nombres reservados de Claude Code: main, team-lead, user y system, sin distinguir mayúsculas", () => {
    for (const n of ["main", "MAIN", " Main ", "team-lead", "TEAM-LEAD", "user", "System"]) {
      assert.ok(isReservedName(n), n)
      assert.throws(() => assertNotReserved(n), /es un nombre reservado de Claude Code: elegí otro\./)
    }
    assert.throws(() => assertNotReserved("main"), /^Error: MAIN es un nombre reservado/)
    for (const n of ["MAIN-2", "mainframe", "users", "ORQ-main", "SERVER"]) {
      assert.ok(!isReservedName(n), n)
      assertNotReserved(n)
    }
  })
})
