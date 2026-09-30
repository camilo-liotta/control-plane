import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const GET_SH = path.join(root, "desktop/scripts/get.sh")
const linux = process.platform === "linux"

/** Un `node` de mentira que solo contesta lo que le pregunta get.sh (su versión). */
function fakeNode(dir: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, "node")
  const major = version.replace(/^v/, "").split(".")[0]
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) echo ${version} ;;\n  -p) echo ${major} ;;\nesac\n`, { mode: 0o755 })
  return bin
}

/** ¿Hay un node ≥ 24 del sistema que get.sh encontraría antes que el de la prueba? */
const systemNode = ["/usr/local/bin/node", "/usr/bin/node"].some((p) => {
  const r = spawnSync(p, ["-p", 'process.versions.node.split(".")[0]'], { encoding: "utf8" })
  return r.status === 0 && Number(r.stdout) >= 24
})

describe("get.sh encuentra Node aunque la app no tenga el PATH de tu shell", { skip: !linux && "los paquetes de prueba son de Linux" }, () => {
  let dir: string
  let home: string
  const run = (env: Record<string, string>) => {
    const r = spawnSync("bash", [GET_SH, "--dry-run", "--from", path.join(dir, "from"), "--appimage", path.join(dir, "target.AppImage")], {
      // Como la abre GNOME: sin nvm en el PATH.
      env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
      encoding: "utf8",
    })
    return r.stdout + r.stderr
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-get-sh-"))
    home = path.join(dir, "home")
    fs.mkdirSync(path.join(dir, "from"), { recursive: true })
    const file = "control-plane_9.9.9_amd64.AppImage"
    fs.writeFileSync(path.join(dir, "from", file), "appimage de prueba")
    const sum = createHash("sha256").update("appimage de prueba").digest("hex")
    fs.writeFileSync(path.join(dir, "from", "SHA256SUMS"), `${sum}  ${file}\n`)
    fs.writeFileSync(path.join(dir, "target.AppImage"), "el de antes")
  })

  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("usa el node que le pasa la app en CONTROL_PLANE_NODE", () => {
    const node = fakeNode(path.join(dir, "de-la-app"), "v24.9.9-de-la-app")
    const out = run({ CONTROL_PLANE_NODE: node })
    assert.match(out, /Node v24\.9\.9-de-la-app · control-plane 9\.9\.9/)
    assert.match(out, /Eso es lo que haría/, "llega al paso de instalar")
  })

  it("si CONTROL_PLANE_NODE no es un ejecutable, lo dice", () => {
    assert.match(run({ CONTROL_PLANE_NODE: path.join(dir, "no-existe") }), /CONTROL_PLANE_NODE=.*no es un ejecutable/)
  })

  it("sin CONTROL_PLANE_NODE, busca en las rutas de respaldo de la app (el nvm más nuevo)", { skip: systemNode && "hay un node ≥ 24 del sistema, que va antes" }, () => {
    fakeNode(path.join(home, ".nvm/versions/node/v24.1.0/bin"), "v24.1.0")
    fakeNode(path.join(home, ".nvm/versions/node/v25.2.0/bin"), "v25.2.0")
    fakeNode(path.join(home, ".nvm/versions/node/v22.0.0/bin"), "v22.0.0")
    const out = run({})
    assert.match(out, /Node v25\.2\.0 · control-plane 9\.9\.9/)
    fs.rmSync(path.join(home, ".nvm"), { recursive: true })
  })

  it("sin ningún node, el error de siempre", { skip: systemNode && "hay un node del sistema" }, () => {
    assert.match(run({}), /No encuentro Node/)
  })
})
