import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ClaudeProcess, type ExitInfo } from "../src/claude/process.ts"

describe("sin Claude Code instalado", () => {
  it("la sesión termina con un motivo en palabras, no con spawn ENOENT", async () => {
    const proc = new ClaudeProcess("/no/existe/claude", [], process.cwd(), process.env)
    const exit = new Promise<ExitInfo>((resolve) => proc.on("exit", resolve))
    proc.start()
    const info = await exit
    assert.match(info.stderr, /No se encontró Claude Code \(\/no\/existe\/claude\)/)
    assert.doesNotMatch(info.stderr, /ENOENT/)
  })
})

describe("una sesión cuya carpeta se borró", () => {
  it("dice que falta la carpeta, no Claude Code", async () => {
    const proc = new ClaudeProcess(process.execPath, ["-e", ""], "/no/existe/la/carpeta", process.env)
    const exit = new Promise<ExitInfo>((resolve) => proc.on("exit", resolve))
    proc.start()
    const info = await exit
    assert.match(info.stderr, /No existe la carpeta de la sesión \(\/no\/existe\/la\/carpeta\)/)
  })
})
