import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { adjacentSession, needsYou, needsYouHref, nextNeedsYou, pushRecent, restorableRoute, scrollSpot, sessionOrder } from "../src/shared/navigation.ts"
import { EscCounter, matchShortcut, shortcutText, type KeyLike } from "../src/shared/shortcuts.ts"
import type { Draft, Session, UserTask } from "../src/shared/types.ts"

const key = (p: Partial<KeyLike>): KeyLike => ({ key: "", code: "", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...p })
const linux = { mac: false, editable: false, terminal: false }
const mac = { mac: true, editable: false, terminal: false }
const inComposer = { ...linux, editable: true }

describe("atajos", () => {
  it("la paleta: Ctrl K en Linux, ⌘K en la Mac, también desde el composer", () => {
    assert.equal(matchShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), linux), "palette")
    assert.equal(matchShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), inComposer), "palette")
    assert.equal(matchShortcut(key({ key: "k", code: "KeyK", metaKey: true }), mac), "palette")
    // En la Mac, Ctrl+K es de los campos de texto (borrar hasta el final de la línea).
    assert.equal(matchShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), mac), null)
  })

  it("en la terminal no hay atajos: Ctrl+K y Alt+flechas son de la shell", () => {
    const term = { ...linux, terminal: true }
    assert.equal(matchShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), term), null)
    assert.equal(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", altKey: true }), term), null)
    assert.equal(matchShortcut(key({ key: "Escape", code: "Escape" }), term), null)
  })

  it("moverse entre sesiones: Alt+flechas en Linux, ⌥⌘ en la Mac (⌥ solo es de los campos de texto)", () => {
    assert.equal(matchShortcut(key({ key: "ArrowUp", code: "ArrowUp", altKey: true }), inComposer), "prev-session")
    assert.equal(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", altKey: true }), inComposer), "next-session")
    assert.equal(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true }), linux), "jump-to-end")
    assert.equal(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", altKey: true, metaKey: true }), mac), "next-session")
    assert.equal(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", altKey: true }), { ...mac, editable: true }), null)
    // AltGr llega como Ctrl+Alt: no es un atajo.
    assert.equal(matchShortcut(key({ key: "ArrowDown", code: "ArrowDown", altKey: true, ctrlKey: true }), linux), null)
  })

  it("la próxima que te necesita se reconoce por la tecla física (⌥N en la Mac es '˜')", () => {
    assert.equal(matchShortcut(key({ key: "n", code: "KeyN", altKey: true }), inComposer), "next-needs-you")
    assert.equal(matchShortcut(key({ key: "˜", code: "KeyN", altKey: true, metaKey: true }), mac), "next-needs-you")
    // Ctrl+N es del navegador (ventana nueva): no se toca.
    assert.equal(matchShortcut(key({ key: "n", code: "KeyN", ctrlKey: true }), linux), null)
  })

  it("? y End solo fuera de un campo de texto; Ctrl / desde cualquier lado", () => {
    assert.equal(matchShortcut(key({ key: "?", code: "Minus", shiftKey: true }), linux), "help")
    assert.equal(matchShortcut(key({ key: "?", code: "Minus", shiftKey: true }), inComposer), null)
    assert.equal(matchShortcut(key({ key: "/", code: "Slash", ctrlKey: true }), inComposer), "help")
    // En un teclado en español, "/" es Shift+7.
    assert.equal(matchShortcut(key({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }), inComposer), "help")
    assert.equal(matchShortcut(key({ key: "End", code: "End" }), linux), "jump-to-end")
    assert.equal(matchShortcut(key({ key: "End", code: "End" }), inComposer), null)
  })

  it("Esc es candidato a interrumpir, pero no si se mantiene apretado", () => {
    assert.equal(matchShortcut(key({ key: "Escape", code: "Escape" }), inComposer), "interrupt")
    assert.equal(matchShortcut(key({ key: "Escape", code: "Escape", repeat: true }), linux), null)
    assert.equal(matchShortcut(key({ key: "Escape", code: "Escape", shiftKey: true }), linux), null)
  })

  it("interrumpir pide dos Esc en menos de un segundo", () => {
    const c = new EscCounter(1000)
    assert.equal(c.press(0), "arm")
    assert.equal(c.press(1500), "arm", "el segundo llegó tarde: vuelve a armar")
    assert.equal(c.press(2200), "fire")
    assert.equal(c.press(2300), "arm", "después de disparar, empieza de cero")
    c.reset()
    assert.equal(c.press(2400), "arm")
  })

  it("el texto de un atajo según el sistema", () => {
    assert.equal(shortcutText("palette", false), "Ctrl+K")
    assert.equal(shortcutText("palette", true), "⌘K")
    assert.equal(shortcutText("next-session", true), "⌥⌘↓")
  })
})

let n = 0
const session = (p: Partial<Session>): Session =>
  ({ id: `s${++n}`, projectId: "p1", kind: "worker", name: `S${n}`, status: "idle", createdAt: n, lastActivityAt: null, archivedAt: null, ...p }) as Session

describe("navegación entre sesiones", () => {
  const orch = session({ kind: "orchestrator", createdAt: 50 })
  const a = session({ createdAt: 10 })
  const b = session({ createdAt: 20 })
  const archived = session({ createdAt: 30, archivedAt: 99 })
  const other = session({ projectId: "p2" })
  const all = [b, archived, other, a, orch]

  it("el orden es el de la barra lateral: la orquestadora y los workers por antigüedad, sin archivadas", () => {
    assert.deepEqual(sessionOrder(all, "p1").map((s) => s.id), [orch.id, a.id, b.id])
  })

  it("anterior y siguiente dan la vuelta; desde el tablero, la primera o la última", () => {
    assert.equal(adjacentSession(all, "p1", a.id, 1)?.id, b.id)
    assert.equal(adjacentSession(all, "p1", b.id, 1)?.id, orch.id)
    assert.equal(adjacentSession(all, "p1", orch.id, -1)?.id, b.id)
    assert.equal(adjacentSession(all, "p1", null, 1)?.id, orch.id)
    assert.equal(adjacentSession(all, "p1", null, -1)?.id, b.id)
    assert.equal(adjacentSession([other], "p2", other.id, 1), null, "con una sola no hay a dónde ir")
  })
})

describe("lo que te necesita", () => {
  const orch = session({ kind: "orchestrator" })
  const asks = session({ status: "needs_input", lastActivityAt: 300 })
  const asksOld = session({ status: "needs_input", lastActivityAt: 100 })
  const elsewhere = session({ status: "needs_input", projectId: "otra-cuenta" })
  const draft = { id: "d1", projectId: "p1", state: "ready", updatedAt: 200 } as Draft
  const staged = { id: "d2", projectId: "p1", state: "staged", updatedAt: 50 } as Draft
  const blocking = { id: "t1", projectId: "p1", status: "open", blocking: true, updatedAt: 400 } as UserTask
  const notBlocking = { id: "t2", projectId: "p1", status: "open", blocking: false, updatedAt: 10 } as UserTask
  const list = needsYou({ sessions: [orch, asks, asksOld, elsewhere], drafts: [draft, staged], tasks: [blocking, notBlocking], projectIds: new Set(["p1"]) })

  it("sesiones que preguntan, propuestas listas y tareas que frenan, lo más viejo primero", () => {
    assert.deepEqual(
      list.map((x) => (x.kind === "session" ? x.session.id : x.kind === "proposals" ? `prop:${x.count}` : `task:${x.task.id}`)),
      [asksOld.id, "prop:1", asks.id, "task:t1"]
    )
    assert.equal(needsYouHref(list[1]!), `/p/p1/s/${orch.id}`)
    assert.equal(needsYouHref(list[3]!), "/p/p1")
  })

  it("la próxima es la que sigue a donde estás, dando la vuelta", () => {
    assert.equal(needsYouHref(nextNeedsYou(list, null)!), `/p/p1/s/${asksOld.id}`)
    assert.equal(needsYouHref(nextNeedsYou(list, `/p/p1/s/${asksOld.id}`)!), `/p/p1/s/${orch.id}`)
    assert.equal(needsYouHref(nextNeedsYou(list, "/p/p1")!), `/p/p1/s/${asksOld.id}`)
    const one = list.slice(0, 1)
    assert.equal(nextNeedsYou(one, `/p/p1/s/${asksOld.id}`), null, "si estás en la única, no hay a dónde ir")
    assert.equal(nextNeedsYou([], null), null)
  })
})

describe("recientes, última ruta y scroll", () => {
  it("las recientes, sin repetir y con tope", () => {
    assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"])
    assert.deepEqual(pushRecent(["a", "b", "c"], "d", 3), ["d", "a", "b"])
  })

  it("solo se vuelve a una ruta que sigue existiendo", () => {
    const alive = { projects: new Set(["p1"]), sessions: new Set(["s1"]) }
    assert.equal(restorableRoute("/p/p1/s/s1", alive), "/p/p1/s/s1")
    assert.equal(restorableRoute("/p/p1", alive), "/p/p1")
    assert.equal(restorableRoute("/p/p1/tools", alive), "/p/p1/tools")
    assert.equal(restorableRoute("/tools", alive), "/tools")
    assert.equal(restorableRoute("/p/p1/s/borrada", alive), null)
    assert.equal(restorableRoute("/p/otro", alive), null)
    assert.equal(restorableRoute("/", alive), null)
    assert.equal(restorableRoute("/cualquier/cosa", alive), null)
    assert.equal(restorableRoute(null, alive), null)
  })

  it("el scroll: pegado al final (con margen) o la posición", () => {
    assert.deepEqual(scrollSpot({ scrollTop: 880, scrollHeight: 1500, clientHeight: 500 }), { atEnd: true })
    assert.deepEqual(scrollSpot({ scrollTop: 200, scrollHeight: 1500, clientHeight: 500 }), { atEnd: false, top: 200 })
  })
})
