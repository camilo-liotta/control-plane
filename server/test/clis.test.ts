import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { CATALOG, Clis, installFor, loginHints, scrubSecrets, type CliSpec } from "../src/clis.ts"

describe("catálogo de CLIs", () => {
  it("nunca corre una instalación con sudo: esa se copia", () => {
    const gh = CATALOG.find((c) => c.id === "gh")!
    assert.deepEqual(installFor(gh, "linux"), { command: "sudo apt install gh", runnable: false })
    assert.deepEqual(installFor(gh, "darwin"), { command: "brew install gh", runnable: true })
    const wrangler = CATALOG.find((c) => c.id === "wrangler")!
    assert.deepEqual(installFor(wrangler, "linux"), { command: "npm install -g wrangler", runnable: true })
    for (const c of CATALOG) for (const p of ["linux", "darwin"] as const) {
      const i = installFor(c, p)
      if (i && /\bsudo\b/.test(i.command)) assert.equal(i.runnable, false, c.id)
    }
  })

  it("los tokens que imprima un CLI no llegan a la UI", () => {
    const out = scrubSecrets("Token: gho_abcdefghijklmnopqrstu ya29.a0AfH6SMBx AKIAABCDEFGHIJKLMNOP sk_live_1234567890abcd")
    assert.doesNotMatch(out, /abcdefghijklmnop|a0AfH6|ABCDEFGHIJKLMNOP|1234567890abcd/)
  })

  it("encuentra el link y el código de un login por dispositivo", () => {
    const h = loginHints("! First copy your one-time code: 1A2B-3C4D\nOpen this URL to continue in your web browser: https://github.com/login/device")
    assert.deepEqual(h, { urls: ["https://github.com/login/device"], code: "1A2B-3C4D" })
  })
})

describe("login desde la UI", () => {
  let dir: string
  let clis: Clis
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-clis-"))
    const bin = path.join(dir, "falsocli")
    // Como un login de verdad: muestra código y link, pregunta algo y termina.
    fs.writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "falsocli 1.2.3"; exit 0; fi
if [ "$1" = "status" ]; then if [ -f "${dir}/logueado" ]; then echo "ok como vos@ejemplo.com"; exit 0; fi; echo "token expired"; exit 1; fi
echo "Your one-time code: WXYZ-1234"
echo "Open https://ejemplo.com/device to continue"
echo "Token: gho_abcdefghijklmnopqrstuvwx"
echo "Continue? (Y/n)"
read respuesta
[ "$respuesta" = "Y" ] && touch "${dir}/logueado" && exit 0
exit 3
`,
      { mode: 0o755 }
    )
    const spec: CliSpec = {
      id: "falsocli",
      name: "Falso CLI",
      description: "",
      category: "Pruebas",
      bins: ["falsocli"],
      docs: "https://ejemplo.com",
      install: {},
      auth: [
        {
          label: null,
          login: ["login"],
          check: async (_bin, run) => {
            const r = await run(["status"])
            return r.code === 0 ? { state: "ok", account: "vos@ejemplo.com" } : /expired/.test(r.out) ? { state: "expired" } : { state: "logged_out" }
          },
        },
      ],
    }
    process.env.PATH = `${dir}:${process.env.PATH}`
    clis = new Clis({ catalog: [spec] })
  })
  after(() => {
    clis.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 60 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(check(), "no llegó a tiempo")
  }

  it("detecta que está vencido, loguea con tu respuesta y después lo ve logueado", async () => {
    const before = await clis.view(true)
    assert.equal(before.clis[0]!.version, "1.2.3")
    assert.equal(before.clis[0]!.credentials[0]!.state, "expired")

    const job = clis.login("falsocli")
    await until(() => clis.job(job.id).output.includes("(Y/n)"))
    const live = clis.job(job.id)
    assert.equal(live.code, "WXYZ-1234")
    assert.deepEqual(live.urls, ["https://ejemplo.com/device"])
    assert.doesNotMatch(live.output, /abcdefghijklmnop/)
    assert.equal(clis.login("falsocli").id, job.id, "no arranca dos logins del mismo CLI")

    clis.answer(job.id, "Y")
    await until(() => clis.job(job.id).status !== "running")
    assert.equal(clis.job(job.id).status, "done")
    const after = await clis.view()
    assert.equal(after.clis[0]!.credentials[0]!.state, "ok")
  })
})

describe("qué usan las sesiones", () => {
  it("saca los programas de un comando sin contar heredocs, comillas, funciones propias ni lo básico", async () => {
    const { programsIn } = await import("../src/cli-usage.ts")
    const cmd = [
      "cd repo && FOO=1 gcloud auth list | jq .",
      "timeout 30 bq query 'select * from t'",
      "run() { python x.py; }",
      "run; ID=$(gh run list --json id); echo `date`",
      "python3 - <<'PY'\nimport os\nconst x = 1\nPY",
      "neon \\\n  connection-string main",
      "./scripts/deploy.sh && /usr/bin/doppler run -- npm test",
    ].join("\n")
    assert.deepEqual(programsIn(cmd), ["gcloud", "jq", "bq", "gh", "neon", "doppler"])
  })
})
