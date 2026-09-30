import assert from "node:assert/strict"
import fs from "node:fs"
import { afterEach, describe, it } from "node:test"

import { childEnv } from "../src/claude/env.ts"
import { start } from "../src/start.ts"

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }

describe("start", () => {
  const saved = process.env.NODE_ENV
  afterEach(() => {
    if (saved === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = saved
  })

  it("deja NODE_ENV=production antes de cargar el server", async () => {
    delete process.env.NODE_ENV
    let seen: string | undefined
    await start(async () => {
      seen = process.env.NODE_ENV
    })
    assert.equal(seen, "production")
  })

  it("pisa un NODE_ENV que ya venía del entorno", async () => {
    process.env.NODE_ENV = "development"
    let seen: string | undefined
    await start(async () => {
      seen = process.env.NODE_ENV
    })
    assert.equal(seen, "production")
  })

  it("el script start no usa VAR=valor y apunta a src/start.ts", () => {
    const script = pkg.scripts.start ?? ""
    assert.doesNotMatch(script, /^\s*\w+=/)
    assert.match(script, /src\/start\.ts/)
  })

  it("los procesos hijos no heredan NODE_ENV", () => {
    assert.equal(childEnv({}, { NODE_ENV: "production", PATH: "/bin" }).NODE_ENV, undefined)
  })
})
