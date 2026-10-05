import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { desktopSummary } from "../src/desktop.ts"
import { inboxCounts } from "../src/shared/inbox-count.ts"
import type { Draft, Session, UserTask } from "../src/shared/types.ts"

const sessions = [
  { projectId: "p1", status: "needs_input" },
  { projectId: "p1", status: "working" },
  { projectId: "p2", status: "idle" },
  { projectId: "p3", status: "needs_input" },
] as Session[]
const drafts = [
  { projectId: "p1", state: "ready" },
  { projectId: "p2", state: "staged" },
  { projectId: "p2", state: "ready" },
] as Draft[]
const tasks = [
  { projectId: "p1", status: "open", blocking: true },
  { projectId: "p1", status: "open", blocking: false },
  { projectId: "p2", status: "done", blocking: true },
  { projectId: "p2", status: "open", blocking: true },
] as UserTask[]

describe("lo que te espera (Bandeja e ícono)", () => {
  it("suma sesiones que te necesitan, propuestas listas y tareas que frenan", () => {
    const { total, byProject } = inboxCounts({ sessions, drafts, tasks })
    assert.equal(total, 6)
    assert.deepEqual(Object.fromEntries(byProject), { p1: 3, p2: 2, p3: 1 })
  })

  it("el ícono de la app da el mismo número que la Bandeja", () => {
    const summary = desktopSummary({
      db: {
        listProjects: () => [{ id: "p1", name: "Uno" }, { id: "p2", name: "Dos" }] as never,
        listDrafts: () => drafts.filter((d) => d.state === "ready"),
        listTasks: () => tasks,
      },
      sessions: { list: () => sessions, isRunning: () => false },
    })
    assert.equal(summary.needs, inboxCounts({ sessions, drafts, tasks }).total)
    assert.deepEqual(summary.projects.map((p) => p.needs), [3, 2])
  })

  it("sin nada pendiente da cero", () => {
    assert.equal(inboxCounts({ sessions: [], drafts: [], tasks: [] }).total, 0)
  })
})
