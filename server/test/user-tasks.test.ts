import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import type { Hub } from "../src/hub.ts"
import type { SendOptions, SessionManager } from "../src/sessions.ts"
import type { ServerMessage, TimelineEvent } from "../src/shared/types.ts"
import { sameTask, UserTasks } from "../src/user-tasks.ts"

function session(name: string): SessionRecord {
  return {
    id: `s_${name.toLowerCase()}`, projectId: "p1", kind: "worker", name, role: "", claudeSessionId: `c-${name}`, startedOnce: true,
    mcpToken: `tok-${name}`, model: null, effort: null, worktree: false, cwd: "/tmp", status: "idle", taskTitle: null, taskState: "none",
    lastActivity: null, lastActivityAt: null, costUsd: 0, tokens: null, context: null, createdAt: 1, archivedAt: null,
  }
}

describe("tareas para vos", () => {
  let dir: string
  let db: Db
  let tasks: UserTasks
  const messages: ServerMessage[] = []
  const events: { id: string; event: TimelineEvent }[] = []
  const sent: { id: string; text: string; opts: SendOptions }[] = []
  const alfa = session("ALFA")
  const beta = session("BETA")

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tasks-"))
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    db.insertSession(alfa)
    db.insertSession(beta)
    const hub = { broadcast: (m: ServerMessage) => messages.push(m) } as unknown as Hub
    const sessions = {
      addEvent: (id: string, event: TimelineEvent) => events.push({ id, event }),
      send: async (id: string, text: string, opts: SendOptions) => void sent.push({ id, text, opts }),
    } as unknown as SessionManager
    tasks = new UserTasks({ db, hub, sessions })
  })
  after(() => {
    tasks.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("reconoce dos pedidos del mismo trabajo", () => {
    assert.equal(sameTask("Reautenticar gcloud", "reautenticar GCloud (tu usuario)"), true)
    assert.equal(sameTask("Loguear vercel", "Loguear gcloud"), false)
  })

  it("una sesión crea una tarea: queda en el tablero, avisa y se ve en su chat", () => {
    const { task, existing } = tasks.create("p1", { title: "Reautenticar gcloud", steps: ["Herramientas → CLIs", "Reautenticar en Google Cloud CLI"], blocking: false }, alfa)
    assert.equal(existing, false)
    assert.equal(task.createdBy, alfa.id)
    // El aviso lleva al tablero, a "Tareas para vos" (la sesión viaja igual, para agrupar los avisos).
    const toast = messages.find((m) => m.type === "toast" && m.event === "task")
    assert.ok(toast && toast.type === "toast")
    assert.deepEqual([toast.projectId, toast.sessionId, toast.open], ["p1", alfa.id, "tasks"])
    assert.ok(events.some((e) => e.id === alfa.id && e.event.kind === "notice" && e.event.text.includes("Creó una tarea")))
    assert.throws(() => tasks.create("p1", { title: "Algo", steps: [] }, alfa), /pasos/)
  })

  it("si otra sesión pide lo mismo, se suma a la que ya estaba", () => {
    const { task, existing } = tasks.create("p1", { title: "reautenticar gcloud ya", steps: ["x"], blocking: true }, beta)
    assert.equal(existing, true)
    assert.deepEqual(task.alsoBy, [beta.id])
    assert.equal(task.blocking, true, "ahora frena a alguien")
    assert.equal(tasks.list("p1").filter((t) => t.status === "open").length, 1)
  })

  it("cuando la marcás hecha, les avisa a las sesiones que la pidieron", async () => {
    const [t] = tasks.list("p1")
    tasks.update(t!.id, { status: "done", note: "listo, con la cuenta de siempre" }, "user")
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(sent.map((s) => s.id).sort(), [alfa.id, beta.id])
    assert.match(sent[0]!.text, /ya hizo la tarea "Reautenticar gcloud".*Nota: listo/)
    assert.equal(tasks.list("p1")[0]!.closedBy, "user")
  })

  it("una sesión la cierra si ya no hace falta, sin mandarle nada a nadie", () => {
    sent.length = 0
    const { task } = tasks.create("p1", { title: "Pedir acceso a la base de Emissa", steps: ["Escribirle a soporte"] }, alfa)
    tasks.update(task.id, { status: "dismissed", note: "ya tengo acceso con dwh_reader" }, beta)
    assert.equal(sent.length, 0)
    assert.equal(db.getTask(task.id)!.closedBy, beta.id)
    assert.ok(events.some((e) => e.id === beta.id && e.event.kind === "notice" && e.event.text.includes("Descartó")))
    assert.throws(() => tasks.update(task.id, { status: "done" }, { ...beta, projectId: "otro" }), /otro proyecto/)
  })

  it("las que tienen fecha avisan un rato antes, una sola vez", () => {
    const { task } = tasks.create("p1", { title: "Correr el workflow de fin de mes", steps: ["`gh workflow run extractor.yml`"], due: Date.now() + 5 * 60_000 }, null)
    assert.deepEqual(db.dueTasks(Date.now() + 15 * 60_000).map((t) => t.id), [task.id])
    ;(tasks as unknown as { remind(): void }).remind()
    const toast = messages.findLast((m) => m.type === "toast" && m.title === "Una tarea tuya vence en un rato")
    assert.ok(toast && toast.type === "toast")
    assert.deepEqual([toast.projectId, toast.open], ["p1", "tasks"])
    assert.equal(db.dueTasks(Date.now() + 15 * 60_000).length, 0)
  })

  it("las sesiones ven las abiertas con sus pasos y las cerradas", () => {
    const text = tasks.summary("p1")
    assert.match(text, /Abiertas:[\s\S]*Correr el workflow[\s\S]*1\. `gh workflow run/)
    assert.match(text, /Cerradas[\s\S]*Reautenticar gcloud · hecha por el usuario/)
  })
})
