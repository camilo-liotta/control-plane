import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { BUNDLE_MARKER, checkOut } from "../scripts/out-guard.ts"

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("resguardo de --out del bundle", () => {
  // Todo en carpetas temporales: un home y un "repo" de mentira, así ningún caso toca nada real.
  let dir: string
  let home: string
  let repo: string
  let fakeServer: string
  const check = (out: string) => checkOut(out, { serverDir: fakeServer, home })

  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-out-")))
    home = path.join(dir, "home")
    repo = path.join(home, "repo")
    fakeServer = path.join(repo, "server")
    fs.mkdirSync(path.join(fakeServer, "src", "claude"), { recursive: true })
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("rechaza la raíz, el home y lo que lo contiene", () => {
    assert.match(check(path.parse(dir).root) ?? "", /raíz del sistema/)
    assert.match(check(home) ?? "", /home/)
    assert.match(check(dir) ?? "", /home/)
    assert.match(check(`${home}/.`) ?? "", /home/)
  })

  it("rechaza el repo, lo que contiene a server/ y lo que está en server/src", () => {
    assert.match(check(repo) ?? "", /repo/)
    assert.match(check(fakeServer) ?? "", /repo/)
    assert.match(check(path.join(fakeServer, "src")) ?? "", /repo|server\/src/)
    assert.match(check(path.join(fakeServer, "src", "claude")) ?? "", /server\/src/)
    assert.match(check(path.join(fakeServer, "src", "nueva", "app")) ?? "", /server\/src/)
    assert.match(check(path.join(fakeServer, "src", "claude", "..", "..")) ?? "", /repo/)
  })

  it("resuelve symlinks: un link al repo es el repo", () => {
    const link = path.join(dir, "atajo")
    fs.symlinkSync(repo, link)
    assert.match(check(link) ?? "", /repo/)
    assert.match(check(path.join(link, "server", "src", "x")) ?? "", /server\/src/)
  })

  it("acepta una carpeta nueva, vacía o un bundle anterior; no una con otras cosas", () => {
    const out = path.join(dir, "out")
    assert.equal(check(path.join(out, "app")), null)
    fs.mkdirSync(out)
    assert.equal(check(out), null)
    fs.writeFileSync(path.join(out, "notas.txt"), "no es un bundle")
    assert.match(check(out) ?? "", /no está vacía/)
    fs.writeFileSync(path.join(out, BUNDLE_MARKER), "")
    assert.equal(check(out), null)
    const old = path.join(dir, "viejo")
    fs.mkdirSync(old)
    fs.writeFileSync(path.join(old, "server.mjs"), "")
    fs.writeFileSync(path.join(old, "THIRD_PARTY_LICENSES"), "")
    assert.equal(check(old), null)
    // También dentro de server/ (pero fuera de src) se puede, por ejemplo server/dist.
    assert.equal(check(path.join(fakeServer, "dist")), null)
    const file = path.join(dir, "archivo")
    fs.writeFileSync(file, "")
    assert.match(check(file) ?? "", /no es una carpeta/)
  })

  it("el script no borra nada si la carpeta no es un bundle", async () => {
    const out = path.join(dir, "ajena")
    fs.mkdirSync(out)
    fs.writeFileSync(path.join(out, "importante.txt"), "hola")
    await assert.rejects(
      promisify(execFile)(process.execPath, ["scripts/bundle.mjs", "--out", out], { cwd: serverDir }),
      (err: { code?: number; stderr?: string }) => err.code === 1 && /no está vacía/.test(err.stderr ?? "")
    )
    assert.equal(fs.readFileSync(path.join(out, "importante.txt"), "utf8"), "hola")
  })

  it("el script rechaza el repo de verdad sin tocarlo", async () => {
    await assert.rejects(
      promisify(execFile)(process.execPath, ["scripts/bundle.mjs", "--out", path.resolve(serverDir, "..")], { cwd: serverDir }),
      (err: { code?: number; stderr?: string }) => err.code === 1 && /repo/.test(err.stderr ?? "")
    )
    assert.ok(fs.existsSync(path.join(serverDir, "src", "index.ts")))
  })
})
