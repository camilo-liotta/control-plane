import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { normalizeSubagents } from "../src/orchestration.ts"
import { withSubagents } from "../src/prompts.ts"

describe("subagentes pedidos por la orquestadora", () => {
  it("normaliza nombres, reglas y modelos", () => {
    const [s] = normalizeSubagents([
      { name: "Revisor SQL", role: "revisor de queries", task: "Revisá los índices", rules: "no toques datos\nsolo lectura", model: "gpt-5", readOnly: true },
    ])
    assert.equal(s!.name, "revisor-sql")
    assert.deepEqual(s!.rules, ["no toques datos", "solo lectura"])
    assert.equal(s!.model, null)
    assert.equal(s!.readOnly, true)
  })

  it("descarta subagentes sin tarea", () => {
    assert.equal(normalizeSubagents([{ name: "x", role: "y" }]).length, 0)
  })

  it("arma la sección de subagentes al final del prompt", () => {
    const text = withSubagents("Hacé la migración.", [
      { name: "tests", role: "especialista en tests", task: "Escribí tests de la migración", rules: ["usá la base de prueba"], model: "haiku", background: true, readOnly: false },
    ])
    assert.match(text, /^Hacé la migración\./)
    assert.match(text, /## Subagentes que tenés que lanzar/)
    assert.match(text, /subagent_type: "general-purpose"/)
    assert.match(text, /model: "haiku"/)
    assert.match(text, /run_in_background: true/)
    assert.match(text, /Tarea: Escribí tests de la migración/)
    assert.match(text, /- usá la base de prueba/)
  })

  it("sin subagentes, el prompt queda igual", () => {
    assert.equal(withSubagents("Hola", []), "Hola")
  })
})
