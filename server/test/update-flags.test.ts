import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const GET_SH = path.join(root, "desktop/scripts/get.sh")
const linux = process.platform === "linux"

/**
 * Qué le pide get.sh a la app abierta al actualizar, según lo que sabe el binario instalado. El
 * "binario" es un archivo con el texto de `--help` de cada versión (lo que busca get.sh), y la
 * "app abierta", un proceso cuya línea de comando empieza con esa ruta (`exec -a`), como la de
 * verdad.
 */
describe("al actualizar, get.sh reinicia app y server juntos", { skip: !linux && "los paquetes de prueba son de Linux" }, () => {
  let dir: string
  const running: ChildProcess[] = []

  const node = () => {
    const bin = path.join(dir, "node-bin", "node")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in\n  --version) echo v24.0.0 ;;\n  -p) echo 24 ;;\nesac\n', { mode: 0o755 })
    return bin
  }

  /** Una "app" abierta en `target` que sabe (o no) cada flag. */
  const openApp = async (name: string, help: string) => {
    const target = path.join(dir, name)
    fs.writeFileSync(target, `binario de prueba\n${help}\n`, { mode: 0o755 })
    const p = spawn("bash", ["-c", 'exec -a "$0" python3 -c "import time; time.sleep(300)"', target], { stdio: "ignore" })
    running.push(p)
    await new Promise((r) => setTimeout(r, 200))
    return target
  }

  const update = (target: string, extra: string[] = []) => {
    const r = spawnSync("bash", [GET_SH, "--dry-run", "--from", path.join(dir, "from"), "--appimage", target, ...extra], {
      env: { HOME: path.join(dir, "home"), PATH: "/usr/bin:/bin", CONTROL_PLANE_NODE: node() },
      encoding: "utf8",
    })
    return r.stdout + r.stderr
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-update-flags-"))
    fs.mkdirSync(path.join(dir, "from"), { recursive: true })
    const file = "control-plane_9.9.9_amd64.AppImage"
    fs.writeFileSync(path.join(dir, "from", file), "appimage de prueba")
    fs.writeFileSync(path.join(dir, "from", "SHA256SUMS"), `${createHash("sha256").update("appimage de prueba").digest("hex")}  ${file}\n`)
  })

  after(() => {
    for (const p of running) p.kill("SIGKILL")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("una app que sabe reiniciarse: --quit --restart-for-update, nunca --keep-server", async () => {
    const target = await openApp("nueva.AppImage", "control-plane-desktop --quit --restart-for-update  para actualizar")
    const out = update(target)
    assert.match(out, /\(haría\) \S+nueva\.AppImage --quit --restart-for-update/)
    assert.match(out, /el server guarda las sesiones activas y se detiene/)
    assert.doesNotMatch(out, /--keep-server/)
  })

  it("con --app-pid (lo lanza la propia app, de esta versión) usa el flag nuevo sin revisar el binario", async () => {
    const target = await openApp("comprimida.AppImage", "")
    const out = update(target, ["--app-pid", String(running.at(-1)!.pid)])
    assert.match(out, /--quit --restart-for-update/)
  })

  it("una app de antes (solo --keep-server): no la cierra dejando el server viejo, explica cómo", async () => {
    const target = await openApp("vieja.AppImage", "control-plane-desktop --quit --keep-server  sale sin preguntar y deja el server corriendo")
    const out = update(target)
    assert.doesNotMatch(out, /\(haría\) \S+ --quit/)
    assert.match(out, /versión anterior, que no sabe reiniciarse para actualizar: no se cierra/)
    assert.match(out, /Detener y salir/)
  })
})
