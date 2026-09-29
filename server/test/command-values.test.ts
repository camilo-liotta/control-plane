import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"

import { blockCommand, commandValues, fillCommand, isShellBlock, quoteValue } from "../src/shared/command-values.ts"

test("encuentra los valores con descripción y sugerido, cada uno una vez", () => {
  assert.deepEqual(commandValues("gcloud config set project {{PROYECTO_GCP: el id de tu proyecto de GCP}} && echo {{PROYECTO_GCP: otra vez}}"), [
    { name: "PROYECTO_GCP", description: "el id de tu proyecto de GCP", suggested: null },
  ])
  assert.deepEqual(commandValues("gsutil ls gs://{{BUCKET: el bucket = mi-backup}}/{{RUTA: carpeta}}"), [
    { name: "BUCKET", description: "el bucket", suggested: "mi-backup" },
    { name: "RUTA", description: "carpeta", suggested: null },
  ])
})

test("no confunde plantillas reales de la shell", () => {
  for (const cmd of [
    "docker inspect --format '{{.State.Status}}' web",
    "helm template x --set a={{ .Values.a }}",
    "echo {{ VAR }}",
    "echo {a,b}{c,d}",
    "kubectl get pods -o go-template='{{range .items}}{{.metadata.name}}{{end}}'",
    "echo {{lower: x}}",
  ]) {
    assert.deepEqual(commandValues(cmd), [], cmd)
    assert.equal(fillCommand(cmd, { VAR: "x", lower: "y" }), cmd)
  }
})

test("cita el valor según las comillas donde cae", () => {
  const cmd = `a {{A: x}} '{{B: x}}' "{{C: x}}" \\'{{D: x}}`
  const v = "it's $(rm -rf ~) `x` \"q\" !! \\"
  const out = fillCommand(cmd, { A: v, B: v, C: v, D: v })
  // Lo que ve la shell: cada argumento es el texto tal cual, sin ejecutar nada.
  const args = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${out.slice(2)}`], { encoding: "utf8" }).split("\n").slice(0, -1)
  assert.deepEqual(args, [v, v, v, `'${v}`])
})

test("los valores simples van sin comillas, y los raros siempre citados", () => {
  assert.equal(quoteValue("mi-proyecto-123", "none"), "mi-proyecto-123")
  assert.equal(quoteValue("gs://b/c.txt", "none"), "gs://b/c.txt")
  assert.equal(quoteValue("", "none"), "''")
  assert.equal(quoteValue("a b", "none"), "'a b'")
  assert.equal(quoteValue("~/x", "none"), "'~/x'")
  assert.equal(quoteValue("*", "none"), "'*'")
})

test("un valor con saltos de línea no agrega un Enter", () => {
  assert.equal(fillCommand("echo {{A: x}}", { A: "uno\ndos\r\u0003" }), "echo unodos")
})

test("un marcador sin valor queda como está", () => {
  assert.equal(fillCommand("echo {{A: x}} {{B: y}}", { A: "1" }), "echo 1 {{B: y}}")
})

test("reconoce bloques de shell y les saca los prompts", () => {
  assert.ok(isShellBlock("bash", "ls"))
  assert.ok(isShellBlock("console", "$ ls"))
  assert.ok(!isShellBlock("ts", "const a = 1"))
  assert.ok(isShellBlock(undefined, "$ npm test\n> ok"))
  assert.ok(!isShellBlock(undefined, "npm test"))
  assert.equal(blockCommand("$ cd x\nsalida\n$ ls\n"), "cd x\nls")
  assert.equal(blockCommand("cd x\nls\n"), "cd x\nls")
})
