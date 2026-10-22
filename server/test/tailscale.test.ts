import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import {
  classify,
  cleanStderr,
  defaultRunner,
  locateTailscale,
  MIN_VERSION,
  parseServeStatus,
  parseStatus,
  serveArgs,
  serveOffArgs,
  Tailscale,
  tailscaleCandidates,
  type Runner,
  type RunResult,
} from "../src/tailscale.ts"

// Fixtures con nombres de ejemplo: nada de esta máquina.
const statusJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    Version: "1.76.1-tabc123-gdef456",
    BackendState: "Running",
    Self: { DNSName: "example-host.tailnet-name.ts.net.", TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::1"] },
    CurrentTailnet: { Name: "tailnet-name.ts.net", MagicDNSSuffix: "tailnet-name.ts.net" },
    MagicDNSSuffix: "tailnet-name.ts.net",
    CertDomains: ["example-host.tailnet-name.ts.net"],
    ...over,
  })

describe("parseStatus (R1.3)", () => {
  it("lee un estado en marcha", () => {
    const p = parseStatus(statusJson())
    assert.ok(!("error" in p))
    assert.equal(p.backendState, "Running")
    assert.equal(p.version, "1.76.1-tabc123-gdef456")
    assert.equal(p.dnsName, "example-host.tailnet-name.ts.net.")
    assert.deepEqual(p.ips, ["100.64.0.10", "fd7a:115c:a1e0::1"])
    assert.equal(p.tailnet, "tailnet-name.ts.net")
    assert.equal(p.certDomains.length, 1)
  })

  it("lee los estados Stopped, NeedsLogin y NeedsMachineAuth", () => {
    for (const s of ["Stopped", "NeedsLogin", "NeedsMachineAuth"]) {
      const p = parseStatus(statusJson({ BackendState: s }))
      assert.ok(!("error" in p))
      assert.equal(p.backendState, s)
    }
  })

  it("lee una versión vieja", () => {
    const p = parseStatus(statusJson({ Version: "1.50.1" }))
    assert.ok(!("error" in p))
    assert.equal(p.version, "1.50.1")
  })

  it("JSON mal formado y vacío: error tipado, sin lanzar", () => {
    assert.ok("error" in parseStatus("{not json"))
    assert.ok("error" in parseStatus(""))
    assert.ok("error" in parseStatus("   \n"))
    assert.ok("error" in parseStatus("null"))
    assert.ok("error" in parseStatus("[1,2]"))
    assert.ok("error" in parseStatus('"texto"'))
  })

  it("salta un banner que no es JSON antes del objeto", () => {
    const p = parseStatus("# Health check: algo\n" + statusJson())
    assert.ok(!("error" in p))
    assert.equal(p.backendState, "Running")
  })

  it("tolera campos de tipo inesperado", () => {
    const p = parseStatus(JSON.stringify({ Version: 5, BackendState: ["x"], Self: "no", CertDomains: "no" }))
    assert.ok(!("error" in p))
    assert.equal(p.version, null)
    assert.equal(p.backendState, "")
    assert.deepEqual(p.ips, [])
    assert.deepEqual(p.certDomains, [])
  })
})

describe("classify (R1.4)", () => {
  const parsed = (over: Record<string, unknown> = {}) => {
    const p = parseStatus(statusJson(over))
    assert.ok(!("error" in p))
    return p
  }

  it("ready: tailnet, IPs y host sin el punto final", () => {
    const s = classify(parsed())
    assert.equal(s.kind, "ready")
    if (s.kind !== "ready") return
    assert.equal(s.host, "example-host.tailnet-name.ts.net")
    assert.equal(s.tailnet, "tailnet-name.ts.net")
    assert.deepEqual(s.ips, ["100.64.0.10", "fd7a:115c:a1e0::1"])
    assert.equal(s.version, "1.76.1-tabc123-gdef456")
  })

  it("versión 1.50.1: outdated con el mensaje exacto", () => {
    const s = classify(parsed({ Version: "1.50.1" }))
    assert.equal(s.kind, "outdated")
    assert.equal(s.message, "No se pudo usar Tailscale: se necesita la versión 1.52 o superior.")
    assert.deepEqual([...MIN_VERSION], [1, 52])
  })

  it("1.52.0 alcanza; 1.9 y 0.99 no", () => {
    assert.equal(classify(parsed({ Version: "1.52.0" })).kind, "ready")
    assert.equal(classify(parsed({ Version: "1.100.2" })).kind, "ready")
    assert.equal(classify(parsed({ Version: "1.9.3" })).kind, "outdated")
    assert.equal(classify(parsed({ Version: "0.99.0" })).kind, "outdated")
  })

  it("sin versión legible: error, no ready", () => {
    assert.equal(classify(parsed({ Version: "" })).kind, "error")
  })

  it("Stopped, NeedsLogin y NeedsMachineAuth", () => {
    assert.equal(classify(parsed({ BackendState: "Stopped" })).kind, "stopped")
    assert.equal(classify(parsed({ BackendState: "NeedsLogin" })).kind, "needs_login")
    assert.equal(classify(parsed({ BackendState: "NeedsMachineAuth" })).kind, "needs_machine_auth")
  })

  it("Running sin dominios de certificado: https_disabled", () => {
    assert.equal(classify(parsed({ CertDomains: [] })).kind, "https_disabled")
  })

  it("estado desconocido o Starting: error", () => {
    assert.equal(classify(parsed({ BackendState: "Starting" })).kind, "error")
    assert.equal(classify(parsed({ BackendState: "Algo" })).kind, "error")
  })

  it("error de parseo: error tipado", () => {
    assert.equal(classify({ error: "vacío" }).kind, "error")
  })

  it("cada estado que no es ready tiene un mensaje distinto que empieza con \"No se pudo\"", () => {
    const states = [
      classify(parsed({ BackendState: "Stopped" })),
      classify(parsed({ BackendState: "NeedsLogin" })),
      classify(parsed({ BackendState: "NeedsMachineAuth" })),
      classify(parsed({ Version: "1.50.1" })),
      classify(parsed({ CertDomains: [] })),
      classify({ error: "x" }),
    ]
    const messages = states.map((s) => s.message ?? "")
    for (const m of messages) assert.match(m, /^No se pudo /)
    assert.equal(new Set(messages).size, messages.length)
  })
})

describe("cleanStderr", () => {
  it("quita caracteres de control y recorta a 200", () => {
    const dirty = "\u001b[31mfallo\u0007\u0000 raro\r\n" + "x".repeat(500)
    const out = cleanStderr(dirty)
    assert.ok(out.length <= 200)
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out))
    assert.match(out, /^\[31mfallo raro/)
  })
})

describe("serveArgs / serveOffArgs (R2.5)", () => {
  it("argv exacto", () => {
    assert.deepEqual(serveArgs(8443, "http://127.0.0.1:4710", 4700), ["serve", "--bg", "--https=8443", "http://127.0.0.1:4710"])
    assert.deepEqual(serveOffArgs(8443), ["serve", "--https=8443", "off"])
  })

  it("rechaza el 443 con el mensaje exacto", () => {
    assert.throws(() => serveArgs(443, "http://127.0.0.1:4710", 4700), /No se pudo usar el puerto 443 para el acceso remoto\./)
    assert.throws(() => serveOffArgs(443), /No se pudo usar el puerto 443 para el acceso remoto\./)
  })

  it("rechaza puertos menores a 1024, mayores a 65535 y no enteros", () => {
    for (const p of [0, 1, 80, 1023, 65536, 70000, -1, 8443.5, NaN, Infinity]) {
      assert.throws(() => serveArgs(p, "http://127.0.0.1:4710", 4700), /./, `puerto ${p}`)
      assert.throws(() => serveOffArgs(p), /./, `puerto ${p}`)
    }
    assert.doesNotThrow(() => serveArgs(1024, "http://127.0.0.1:4710", 4700))
    assert.doesNotThrow(() => serveArgs(65535, "http://127.0.0.1:4710", 4700))
  })

  it("rechaza el puerto principal del server", () => {
    assert.throws(() => serveArgs(4700, "http://127.0.0.1:4710", 4700), /No se pudo usar el puerto 4700/)
  })

  it("el destino debe ser http://127.0.0.1:<puerto>", () => {
    for (const t of ["http://localhost:4710", "https://127.0.0.1:4710", "http://127.0.0.1", "http://127.0.0.1:4710/x", "http://0.0.0.0:4710", "http://127.0.0.1:4710 --funnel", "http://127.0.0.1:47a0", "", "http://127.0.0.1:4710\n"]) {
      assert.throws(() => serveArgs(8443, t, 4700), /./, `destino ${JSON.stringify(t)}`)
    }
  })

  it("propiedad: nunca emite reset, funnel, sudo ni el 443, para ninguna entrada", () => {
    const ports: unknown[] = [8443, 443, 1024, 65535, 0, -5, "8443", "443", 8443.2, NaN, null, undefined, {}, [], "reset", "--funnel"]
    for (let p = 1000; p < 1100; p++) ports.push(p)
    ports.push(443, 4443, 44300, 8080)
    const targets: unknown[] = ["http://127.0.0.1:4710", "http://127.0.0.1:443", "funnel", "reset", "sudo", "http://127.0.0.1:1; reset", null, undefined, 5]
    const mains: unknown[] = [4700, 8443, 0, NaN, undefined]
    const bad = /^(reset|funnel|sudo)$|funnel|reset|sudo/i
    let built = 0
    for (const p of ports) {
      for (const t of targets) {
        for (const m of mains) {
          let argv: string[] | null = null
          try {
            argv = serveArgs(p as number, t as string, m as number)
          } catch {
            argv = null
          }
          if (argv) {
            built++
            for (const a of argv) assert.ok(!bad.test(a), `argumento prohibido: ${a}`)
            assert.ok(!argv.includes("--https=443"))
            assert.ok(argv.includes("--bg"))
          }
        }
      }
      let off: string[] | null = null
      try {
        off = serveOffArgs(p as number)
      } catch {
        off = null
      }
      if (off) {
        for (const a of off) assert.ok(!bad.test(a), `argumento prohibido: ${a}`)
        assert.ok(!off.includes("--https=443"))
      }
    }
    assert.ok(built > 50, "la propiedad tiene que ejercitar casos válidos también")
  })
})

describe("tailscaleCandidates / locateTailscale (R1.1)", () => {
  it("candidatos por plataforma", () => {
    const win = tailscaleCandidates("win32", { ProgramFiles: "C:\\Program Files" })
    assert.deepEqual(win, ["C:\\Program Files\\Tailscale\\tailscale.exe"])
    const mac = tailscaleCandidates("darwin")
    assert.ok(mac[0]!.endsWith("Tailscale.app/Contents/MacOS/Tailscale"))
    assert.ok(mac.includes("/opt/homebrew/bin/tailscale") && mac.includes("/usr/local/bin/tailscale"))
    assert.deepEqual(tailscaleCandidates("linux"), ["/usr/bin/tailscale", "/usr/sbin/tailscale"])
  })

  const has = (...files: string[]) => (f: string) => files.includes(f)

  it("orden: variable de entorno, después PATH, después las carpetas del sistema", () => {
    const env = { CONTROL_PLANE_TAILSCALE_BIN: "/custom/ts", PATH: "/p" }
    const all = has("/custom/ts", "/p/tailscale", "/usr/bin/tailscale")
    assert.equal(locateTailscale({ platform: "linux", env, exists: all })?.bin, "/custom/ts")
    assert.equal(locateTailscale({ platform: "linux", env: { PATH: "/p" }, exists: all })?.bin, "/p/tailscale")
    assert.equal(locateTailscale({ platform: "linux", env: { PATH: "/p" }, exists: has("/usr/bin/tailscale") })?.bin, "/usr/bin/tailscale")
  })

  it("la variable apunta a algo que no existe: sigue con PATH", () => {
    const env = { CONTROL_PLANE_TAILSCALE_BIN: "/nada", PATH: "/p" }
    assert.equal(locateTailscale({ platform: "linux", env, exists: has("/p/tailscale") })?.bin, "/p/tailscale")
  })

  it("sin binario: null", () => {
    assert.equal(locateTailscale({ platform: "linux", env: { PATH: "/p" }, exists: () => false }), null)
  })

  it("el bundle de macOS corre con TAILSCALE_BE_CLI=1", () => {
    const bundle = tailscaleCandidates("darwin")[0]!
    const found = locateTailscale({ platform: "darwin", env: { PATH: "" }, exists: has(bundle) })
    assert.equal(found?.bin, bundle)
    assert.equal(found?.env?.TAILSCALE_BE_CLI, "1")
    const brew = locateTailscale({ platform: "darwin", env: { PATH: "" }, exists: has("/opt/homebrew/bin/tailscale") })
    assert.equal(brew?.env?.TAILSCALE_BE_CLI, undefined)
  })
})

describe("parseServeStatus", () => {
  it("devuelve puerto -> destino", () => {
    const json = JSON.stringify({
      TCP: { "8443": { HTTPS: true }, "9443": { HTTPS: true } },
      Web: {
        "example-host.tailnet-name.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4710" } } },
        "example-host.tailnet-name.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } },
      },
    })
    const m = parseServeStatus(json)
    assert.equal(m.get(8443), "http://127.0.0.1:4710")
    assert.equal(m.get(9443), "http://127.0.0.1:9999")
    assert.equal(m.size, 2)
  })

  it("un puerto en TCP sin destino conocido igual figura (es ajeno)", () => {
    const m = parseServeStatus(JSON.stringify({ TCP: { "8443": { TCPForward: "127.0.0.1:22" } } }))
    assert.ok(m.has(8443))
    assert.notEqual(m.get(8443), "http://127.0.0.1:4710")
  })

  it("vacío, {} y basura: mapa vacío, sin lanzar", () => {
    assert.equal(parseServeStatus("{}").size, 0)
    assert.equal(parseServeStatus("").size, 0)
    assert.equal(parseServeStatus("no json").size, 0)
  })
})

/** Runner falso: guarda las llamadas y contesta lo que le digan. */
function fakeRunner(answer: (args: string[]) => Partial<RunResult> | Promise<Partial<RunResult>>) {
  const calls: string[][] = []
  const run: Runner = async (_file, args) => {
    calls.push(args)
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...(await answer(args)) }
  }
  return { run, calls }
}
const located = () => ({ bin: "/fake/tailscale" })

describe("Tailscale (clase)", () => {
  it("sin binario: not_installed con el mensaje exacto, sin correr nada", async () => {
    const { run, calls } = fakeRunner(() => ({}))
    const ts = new Tailscale({ run, locate: () => null, mainPort: 4700 })
    const s = await ts.status()
    assert.equal(s.kind, "not_installed")
    assert.equal(s.message, "No se pudo encontrar Tailscale en este equipo.")
    assert.equal(calls.length, 0)
  })

  it("status: corre solo `status --json` y clasifica", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: statusJson() }))
    const ts = new Tailscale({ run, locate: located, mainPort: 4700 })
    const s = await ts.status()
    assert.equal(s.kind, "ready")
    assert.deepEqual(calls, [["status", "--json"]])
  })

  it("status: timeout y daemon apagado", async () => {
    const t = new Tailscale({ run: fakeRunner(() => ({ code: null, timedOut: true })).run, locate: located, mainPort: 4700 })
    assert.equal((await t.status()).kind, "timeout")
    const d = new Tailscale({ run: fakeRunner(() => ({ code: 1, stderr: "failed to connect to local tailscaled; is the daemon running?" })).run, locate: located, mainPort: 4700 })
    assert.equal((await d.status()).kind, "stopped")
    const e = new Tailscale({ run: fakeRunner(() => ({ code: 1, stderr: "algo raro\u0007" })).run, locate: located, mainPort: 4700 })
    const es = await e.status()
    assert.equal(es.kind, "error")
    assert.match(es.message, /^No se pudo /)
    assert.ok(!es.message.includes("\u0007"))
  })

  it("serveEntry: lee `serve status --json` y devuelve el destino del puerto", async () => {
    const json = JSON.stringify({ TCP: { "8443": { HTTPS: true } }, Web: { "h.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4710" } } } } })
    const { run, calls } = fakeRunner(() => ({ stdout: json }))
    const ts = new Tailscale({ run, locate: located, mainPort: 4700 })
    const hit = await ts.serveEntry(8443)
    assert.deepEqual(hit, { ok: true, target: "http://127.0.0.1:4710" })
    assert.deepEqual(await ts.serveEntry(9000), { ok: true, target: null })
    assert.deepEqual(calls[0], ["serve", "status", "--json"])
  })

  it("serveEntry: salida ilegible no cuenta como \"sin entrada\"", async () => {
    const ts = new Tailscale({ run: fakeRunner(() => ({ stdout: "basura" })).run, locate: located, mainPort: 4700 })
    const r = await ts.serveEntry(8443)
    assert.equal(r.ok, false)
  })

  it("serveOn / serveOff usan el argv exacto", async () => {
    const { run, calls } = fakeRunner(() => ({}))
    const ts = new Tailscale({ run, locate: located, mainPort: 4700 })
    assert.deepEqual(await ts.serveOn(8443, "http://127.0.0.1:4710"), { ok: true })
    assert.deepEqual(await ts.serveOff(8443), { ok: true })
    assert.deepEqual(calls, [
      ["serve", "--bg", "--https=8443", "http://127.0.0.1:4710"],
      ["serve", "--https=8443", "off"],
    ])
  })

  it("serveOn con puerto inválido no corre nada y devuelve error", async () => {
    const { run, calls } = fakeRunner(() => ({}))
    const ts = new Tailscale({ run, locate: located, mainPort: 4700 })
    const r = await ts.serveOn(443, "http://127.0.0.1:4710")
    assert.equal(r.ok, false)
    assert.equal(calls.length, 0)
  })

  it("errores de serve: https desactivado, permiso, puerto ocupado, timeout", async () => {
    const mk = (res: Partial<RunResult>) => new Tailscale({ run: fakeRunner(() => res).run, locate: located, mainPort: 4700 })
    const kind = async (res: Partial<RunResult>) => {
      const r = await mk(res).serveOn(8443, "http://127.0.0.1:4710")
      assert.equal(r.ok, false)
      return r.ok ? "" : r.state.kind
    }
    assert.equal(await kind({ code: 1, stderr: "HTTPS is not enabled on your tailnet; enable it at https://login.tailscale.com/admin/dns" }), "https_disabled")
    assert.equal(await kind({ code: 1, stderr: "Access denied: serve config denied; use 'sudo tailscale set --operator=$USER'" }), "serve_denied")
    assert.equal(await kind({ code: 1, stderr: "listen tcp :8443: bind: address already in use" }), "port_in_use")
    assert.equal(await kind({ code: null, timedOut: true }), "timeout")
    assert.equal(await kind({ code: 1, stderr: "otra cosa" }), "error")
  })

  it("los timeouts son 5 s para status y 15 s para serve", async () => {
    const seen: number[] = []
    const run: Runner = async (_f, _a, o) => {
      seen.push(o.timeoutMs)
      return { code: 0, stdout: statusJson(), stderr: "", timedOut: false }
    }
    const ts = new Tailscale({ run, locate: located, mainPort: 4700 })
    await ts.status()
    await ts.serveEntry(8443)
    await ts.serveOn(8443, "http://127.0.0.1:4710")
    await ts.serveOff(8443)
    assert.deepEqual(seen, [5000, 15000, 15000, 15000])
  })
})

describe("defaultRunner (R1.2)", () => {
  let dir: string
  const script = (name: string, body: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-ts-runner-"))
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("un binario que se cuelga: timedOut dentro de timeout + 1 s, y el hijo muere", { timeout: 20_000 }, async () => {
    const hang = script("hang.mjs", "console.log(process.pid)\nsetInterval(() => {}, 1000)\n")
    const t0 = Date.now()
    const r = await defaultRunner(process.execPath, [hang], { timeoutMs: 400 })
    assert.equal(r.timedOut, true)
    assert.ok(Date.now() - t0 <= 1400, `tardó ${Date.now() - t0} ms`)
    const pid = Number(r.stdout.trim())
    assert.ok(pid > 0)
    await new Promise((res) => setTimeout(res, 800))
    assert.throws(() => process.kill(pid, 0))
  })

  it("stdin está cerrado: un binario que lo lee recibe EOF enseguida", { timeout: 20_000 }, async () => {
    const reader = script("reader.mjs", "let n = 0\nprocess.stdin.on('data', (d) => (n += d.length))\nprocess.stdin.on('end', () => console.log('eof ' + n))\n")
    const r = await defaultRunner(process.execPath, [reader], { timeoutMs: 5000 })
    assert.equal(r.timedOut, false)
    assert.equal(r.stdout.trim(), "eof 0")
    assert.equal(r.code, 0)
  })

  it("los argumentos con ; & y espacios llegan literales, y stdout y stderr van separados", { timeout: 20_000 }, async () => {
    const echo = script("echo.mjs", "console.log(JSON.stringify(process.argv.slice(2)))\nconsole.error('err')\n")
    const args = ["a;b", "c&d", "e f", "$(x)", "`y`", "--https=8443"]
    const r = await defaultRunner(process.execPath, [echo, ...args], { timeoutMs: 5000 })
    assert.deepEqual(JSON.parse(r.stdout), args)
    assert.equal(r.stderr.trim(), "err")
  })

  it("tope de salida de 1 MiB", { timeout: 20_000 }, async () => {
    const big = script("big.mjs", "process.stdout.write('x'.repeat(3 * 1024 * 1024))\n")
    const r = await defaultRunner(process.execPath, [big], { timeoutMs: 8000 })
    assert.ok(r.stdout.length <= 1024 * 1024)
  })

  it("un binario que no existe no lanza: devuelve error", async () => {
    const r = await defaultRunner(path.join(dir, "no-existe"), [], { timeoutMs: 2000 })
    assert.equal(r.code, null)
    assert.equal(r.timedOut, false)
    assert.ok(r.stderr.length > 0)
  })
})
