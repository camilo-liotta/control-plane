import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { loginCommands } from "../src/shared/account-login.ts"

describe("loginCommands: el comando para loguear una cuenta desde una terminal", () => {
  it("la cuenta de siempre es solo `claude`", () => {
    assert.deepEqual(loginCommands("/home/ana/.claude", true), [{ command: "claude" }])
    assert.deepEqual(loginCommands("C:\\Users\\Ana\\.claude", true), [{ command: "claude" }])
  })

  it("en Linux y macOS: una variable de entorno con el home como ~", () => {
    assert.deepEqual(loginCommands("/home/ana/.claude-trabajo", false), [{ command: "CLAUDE_CONFIG_DIR=~/.claude-trabajo claude" }])
    assert.deepEqual(loginCommands("/Users/ana/.claude-trabajo", false), [{ command: "CLAUDE_CONFIG_DIR=~/.claude-trabajo claude" }])
  })

  it("en Linux y macOS, una ruta con espacios va entre comillas simples", () => {
    assert.deepEqual(loginCommands("/opt/mis cuentas/.claude-x", false), [{ command: "CLAUDE_CONFIG_DIR='/opt/mis cuentas/.claude-x' claude" }])
  })

  it("en Windows: un comando por terminal, con la ruta entera y sin barras que se coma la shell", () => {
    const list = loginCommands("C:\\Users\\Ana\\.claude-trabajo", false)
    const byLabel = Object.fromEntries(list.map((c) => [c.label, c.command]))
    assert.deepEqual(Object.keys(byLabel), ["PowerShell", "Git Bash", "CMD"])
    assert.equal(byLabel.PowerShell, '$env:CLAUDE_CONFIG_DIR="C:\\Users\\Ana\\.claude-trabajo"; claude')
    // Git Bash trata la barra invertida como escape: con ella `C:\Users\…` se rompe y claude crea una carpeta relativa.
    assert.equal(byLabel["Git Bash"], 'CLAUDE_CONFIG_DIR="C:/Users/Ana/.claude-trabajo" claude')
    assert.equal(byLabel.CMD, 'set "CLAUDE_CONFIG_DIR=C:\\Users\\Ana\\.claude-trabajo" && claude')
  })

  it("en Windows también reconoce las rutas con barras normales y las que tienen espacios", () => {
    const list = loginCommands("C:/Users/Ana Maria/.claude-x", false)
    const gitBash = list.find((c) => c.label === "Git Bash")!.command
    assert.equal(gitBash, 'CLAUDE_CONFIG_DIR="C:/Users/Ana Maria/.claude-x" claude')
    assert.equal(list.find((c) => c.label === "PowerShell")!.command, '$env:CLAUDE_CONFIG_DIR="C:\\Users\\Ana Maria\\.claude-x"; claude')
  })

  it("ningún comando de Windows deja una barra invertida en la versión de Git Bash", () => {
    for (const dir of ["C:\\Users\\Ana\\.claude-d", "D:\\cuentas\\g", "C:/x/y"]) {
      const gitBash = loginCommands(dir, false).find((c) => c.label === "Git Bash")!.command
      assert.ok(!gitBash.includes("\\"), gitBash)
    }
  })

  it("una ruta de Windows con una comilla doble no arma un comando (no es una ruta válida)", () => {
    assert.deepEqual(loginCommands('C:\\Users\\An"a\\.claude-x', false), [])
  })
})
