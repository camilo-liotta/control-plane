import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { noticeHref, noticeOpen } from "../src/shared/notice.ts"

describe("a dónde lleva un aviso", () => {
  it("a la sesión si viene, si no al proyecto", () => {
    assert.equal(noticeHref({ projectId: "p1", sessionId: "s1" }), "/p/p1/s/s1")
    assert.equal(noticeHref({ projectId: "p1", sessionId: "s1", open: "proposals" }), "/p/p1/s/s1")
    assert.equal(noticeHref({ projectId: "p1", sessionId: "s1", open: "compaction" }), "/p/p1/s/s1")
    assert.equal(noticeHref({ projectId: "p1" }), "/p/p1")
    assert.equal(noticeHref({ sessionId: "s1" }), null)
    assert.equal(noticeHref({}), null)
  })

  it("las tareas van al tablero aunque venga la sesión que la pidió", () => {
    assert.equal(noticeHref({ projectId: "p1", sessionId: "s1", open: "tasks" }), "/p/p1")
  })

  it("solo acepta los open que conoce (la app de escritorio lo pasa como texto)", () => {
    for (const v of ["compaction", "proposals", "tasks"]) assert.equal(noticeOpen(v), v)
    for (const v of [undefined, null, "", "Proposals", "algo", 1, {}]) assert.equal(noticeOpen(v), undefined)
  })
})
