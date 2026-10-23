import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { Db, type RemoteConfig } from "../src/db.ts"
import { RemoteControl } from "../src/remote/control.ts"
import type { TailscaleState } from "../src/tailscale.ts"

const HOST = "example-host.tailnet-name.ts.net"
const READY: TailscaleState = { kind: "ready", version: "1.76.1", tailnet: "tailnet-name.ts.net", host: HOST, ips: ["100.64.0.10"] }
const TARGET = "http://127.0.0.1:4710"

const never = () => new Promise<never>(() => {})

/** Un Tailscale falso: anota cada llamada en `events`, y se puede colgar o fallar. */
class FakeTailscale {
  events: string[]
  state: TailscaleState = READY
  entries = new Map<number, string>()
  hang = false
  failServeOn: TailscaleState | null = null
  /** serveOn "anda" pero no deja la entrada (para probar la verificación). */
  swallowServeOn = false
  /** Después de serveOn, "serve status" devuelve algo ilegible (otra forma que la esperada). */
  unreadableAfterOn = false
  /** serveOff falla (el CLI no responde o rechaza). */
  failServeOff = false
  private created = false
  constructor(events: string[]) {
    this.events = events
  }
  async status() {
    this.events.push("status")
    if (this.hang) return never()
    return this.state
  }
  async serveEntry(port: number) {
    this.events.push(`serveEntry ${port}`)
    if (this.hang) return never()
    if (this.unreadableAfterOn && this.created) return { ok: false as const, state: { kind: "error" as const, message: "No se pudo leer lo que Tailscale tiene publicado." } }
    return { ok: true as const, target: this.entries.get(port) ?? null }
  }
  async serveOn(port: number, target: string) {
    this.events.push(`serveOn ${port} ${target}`)
    if (this.hang) return never()
    if (this.failServeOn) return { ok: false as const, state: this.failServeOn }
    this.created = true
    if (!this.swallowServeOn) this.entries.set(port, target)
    return { ok: true as const }
  }
  async serveOff(port: number) {
    this.events.push(`serveOff ${port}`)
    if (this.hang) return never()
    if (this.failServeOff) return { ok: false as const, state: { kind: "timeout" as const, message: "No se pudo hablar con Tailscale: tardó demasiado." } }
    this.entries.delete(port)
    return { ok: true as const }
  }
}

class FakeListener {
  events: string[]
  running = false
  failBind = false
  constructor(events: string[]) {
    this.events = events
  }
  async start(port: number) {
    this.events.push(`bind ${port}`)
    if (this.failBind) throw new Error("EADDRINUSE")
    this.running = true
  }
  stopNow() {
    this.events.push("stopNow")
    this.running = false
  }
  async stop() {
    this.events.push("stop")
    this.running = false
  }
}

let dir: string
let file: string
let db: Db
let events: string[]
let ts: FakeTailscale
let listener: FakeListener

/** La base con cada guardado anotado, para ver el orden contra lo que corre Tailscale. */
const spyDb = (real: Db) => ({
  getRemoteConfig: () => real.getRemoteConfig(),
  updateRemoteConfig: (patch: Partial<RemoteConfig>) => {
    events.push(`persist ${Object.keys(patch).sort().join(",")}`)
    return real.updateRemoteConfig(patch)
  },
})

const make = (over: { shutdownBudgetMs?: number } = {}) => {
  const control = new RemoteControl({
    db: spyDb(db),
    tailscale: ts as never,
    listener: listener as never,
    localPort: 4710,
    mainPort: 4700,
    now: () => 1_700_000_000_000,
    onCut: () => events.push("terminate ws"),
    onChange: () => events.push("changed"),
    ...over,
  })
  return control
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-remote-control-"))
  file = path.join(dir, "control-plane.db")
  db = new Db(file)
  events = []
  ts = new FakeTailscale(events)
  listener = new FakeListener(events)
})
afterEach(() => {
  try {
    db.close()
  } catch {
    // ya cerrada
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Los eventos sin los avisos a la web (no importan para el orden). */
const trace = () => events.filter((e) => e !== "changed")

describe("remote_config (R2.1)", () => {
  it("valores de fábrica: apagado, nivel read, confirmación local de comandos, puertos 8443 y 4710", () => {
    const c = db.getRemoteConfig()
    assert.equal(c.enabled, false)
    assert.equal(c.tier, "read")
    assert.equal(c.requireLocalForDangerous, true)
    assert.equal(c.httpsPort, 8443)
    assert.equal(c.localPort, 4710)
    assert.equal(c.origin, null)
    assert.equal(c.serveOwned, false)
    assert.equal(c.serveTarget, null)
    assert.equal(c.serveCreatedAt, null)
  })

  it("se guarda y sobrevive a reabrir la base", () => {
    db.updateRemoteConfig({ enabled: true, origin: `https://${HOST}:8443`, serveOwned: true, serveTarget: TARGET, serveCreatedAt: 5, requireLocalForDangerous: false })
    db.close()
    db = new Db(file)
    const c = db.getRemoteConfig()
    assert.equal(c.enabled, true)
    assert.equal(c.origin, `https://${HOST}:8443`)
    assert.equal(c.serveOwned, true)
    assert.equal(c.serveTarget, TARGET)
    assert.equal(c.serveCreatedAt, 5)
    assert.equal(c.requireLocalForDangerous, false)
  })

  it("instalación nueva: el arranque no abre listener ni corre ningún comando de Tailscale", async () => {
    const control = make()
    await control.reconcile()
    assert.deepEqual(trace(), [])
    assert.equal(control.active, false)
  })
})

describe("prender (R2.6)", () => {
  it("el orden: estado listo, abrir el listener, leer la entrada, guardar la propiedad, serve, verificar, guardar lo prendido", async () => {
    const control = make()
    const r = await control.enable()
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(trace(), [
      "status",
      "bind 4710",
      "serveEntry 8443",
      "persist httpsPort,localPort,serveCreatedAt,serveOwned,serveTarget",
      `serveOn 8443 ${TARGET}`,
      "serveEntry 8443",
      "persist enabled,origin",
    ])
    const c = db.getRemoteConfig()
    assert.equal(c.enabled, true)
    assert.equal(c.origin, `https://${HOST}:8443`)
    assert.equal(c.serveOwned, true)
    assert.equal(c.serveTarget, TARGET)
    assert.equal(c.serveCreatedAt, 1_700_000_000_000)
    assert.equal(control.active, true)
  })

  it("Tailscale no está listo: no se abre nada, no se corre ningún comando que cambie algo, no se guarda nada", async () => {
    ts.state = { kind: "stopped", message: "No se pudo usar Tailscale: está apagado." }
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.state.kind, "stopped")
    assert.deepEqual(trace(), ["status"])
    assert.equal(db.getRemoteConfig().enabled, false)
  })

  it("la entrada del puerto es de otro: port_in_use, sin comandos que cambien algo, listener cerrado, nada guardado", async () => {
    ts.entries.set(8443, "http://127.0.0.1:9999")
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.state.kind, "port_in_use")
    assert.deepEqual(trace(), ["status", "bind 4710", "serveEntry 8443", "stopNow"])
    const c = db.getRemoteConfig()
    assert.equal(c.enabled, false)
    assert.equal(c.serveOwned, false)
    assert.equal(control.active, false)
  })

  it("una entrada con el mismo destino pero que no creamos también se trata como ajena", async () => {
    ts.entries.set(8443, TARGET)
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    assert.ok(!trace().some((e) => e.startsWith("serveOn") || e.startsWith("serveOff")))
  })

  it("si no se puede abrir el puerto local, se informa y no se toca Tailscale más allá del estado", async () => {
    listener.failBind = true
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.state.kind, "port_in_use")
    assert.deepEqual(trace(), ["status", "bind 4710"])
    assert.equal(db.getRemoteConfig().enabled, false)
  })

  it("puertos inválidos (443, el principal, menos de 1024): se rechazan sin llamar a nada", async () => {
    const control = make()
    for (const httpsPort of [443, 4700, 80, 70000, 8443.5]) {
      const r = await control.enable({ httpsPort })
      assert.equal(r.ok, false, String(httpsPort))
    }
    assert.deepEqual(trace(), [])
  })

  it("si serve falla: se deshace (sin serve off, porque la entrada no quedó), el listener se cierra y la propiedad se borra", async () => {
    ts.failServeOn = { kind: "serve_denied", message: "No se pudo publicar con Tailscale: sin permiso." }
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.state.kind, "serve_denied")
    assert.ok(trace().includes("stopNow"))
    assert.ok(!trace().includes("serveOff 8443"))
    const c = db.getRemoteConfig()
    assert.equal(c.enabled, false)
    assert.equal(c.serveOwned, false)
    assert.equal(c.serveTarget, null)
  })

  it("si serve falló a medias y la entrada quedó nuestra, el deshacer corre serve off", async () => {
    ts.failServeOn = { kind: "timeout", message: "No se pudo hablar con Tailscale: tardó demasiado." }
    const original = ts.serveOn.bind(ts)
    ts.serveOn = async (p: number, t: string) => {
      ts.entries.set(p, t)
      return original(p, t)
    }
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    assert.ok(trace().includes("serveOff 8443"))
    assert.equal(ts.entries.has(8443), false)
  })

  it("si serve dice que sí pero la entrada no aparece al verificar, se deshace y falla", async () => {
    ts.swallowServeOn = true
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    assert.equal(db.getRemoteConfig().enabled, false)
    assert.equal(db.getRemoteConfig().serveOwned, false)
    assert.equal(control.active, false)
  })

  it("F1: si tras serve la lectura es ilegible, igual se corre serve off (la entrada es nuestra) y se limpia la propiedad", async () => {
    ts.unreadableAfterOn = true
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    assert.ok(trace().includes("serveOff 8443"))
    assert.equal(ts.entries.has(8443), false)
    assert.equal(db.getRemoteConfig().serveOwned, false)
  })

  it("F1: si serve off falla al deshacer, se conserva la propiedad, se informa un problema y el próximo arranque reintenta", async () => {
    ts.unreadableAfterOn = true
    ts.failServeOff = true
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    const c = db.getRemoteConfig()
    assert.equal(c.serveOwned, true)
    assert.equal(c.serveTarget, TARGET)
    assert.equal(c.enabled, false)
    assert.equal(control.problem()?.kind, "error")
    assert.equal(ts.entries.get(8443), TARGET)
    // Arranque siguiente: Tailscale responde bien y la entrada es nuestra: se saca.
    ts.unreadableAfterOn = false
    ts.failServeOff = false
    events.length = 0
    await make().reconcile()
    assert.ok(trace().includes("serveOff 8443"))
    assert.equal(ts.entries.has(8443), false)
    assert.equal(db.getRemoteConfig().serveOwned, false)
  })

  it("F1: si serve off falla pero la lectura prueba que la entrada ya no está, se limpia la propiedad", async () => {
    ts.failServeOff = true
    ts.swallowServeOn = true
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    assert.equal(db.getRemoteConfig().serveOwned, false)
  })

  it("F1: si tras serve la entrada pasó a apuntar a otra cosa, no se toca y se borra solo el registro", async () => {
    const original = ts.serveOn.bind(ts)
    ts.serveOn = async (p: number, t: string) => {
      await original(p, t)
      ts.entries.set(p, "http://127.0.0.1:9999")
      return { ok: true as const }
    }
    const control = make()
    const r = await control.enable()
    assert.equal(r.ok, false)
    assert.ok(!trace().includes("serveOff 8443"))
    assert.equal(ts.entries.get(8443), "http://127.0.0.1:9999")
    assert.equal(db.getRemoteConfig().serveOwned, false)
  })

  it("prender dos veces no repite serve: la entrada ya es nuestra", async () => {
    const control = make()
    await control.enable()
    events.length = 0
    const r = await control.enable()
    assert.deepEqual(r, { ok: true })
    assert.ok(!trace().some((e) => e.startsWith("serveOn")))
  })

  it("si lo cortan mientras se está prendiendo, lo que sigue no lo vuelve a prender", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const original = ts.serveOn.bind(ts)
    ts.serveOn = async (p: number, t: string) => {
      await gate
      return original(p, t)
    }
    const control = make()
    const pending = control.enable()
    await new Promise((r) => setTimeout(r, 20))
    control.kill()
    release()
    const r = await pending
    assert.equal(r.ok, false)
    assert.equal(db.getRemoteConfig().enabled, false)
    assert.equal(control.active, false)
  })
})

describe("apagar y la propiedad de la entrada (R2.7)", () => {
  it("apagar saca solo lo que creamos y sigue siendo nuestro", async () => {
    const control = make()
    await control.enable()
    events.length = 0
    const r = await control.disable()
    assert.equal(r.removed, true)
    assert.deepEqual(trace(), ["persist enabled", "stopNow", "terminate ws", "serveEntry 8443", "serveOff 8443", "persist serveCreatedAt,serveOwned,serveTarget"])
    const c = db.getRemoteConfig()
    assert.equal(c.enabled, false)
    assert.equal(c.serveOwned, false)
    assert.equal(ts.entries.has(8443), false)
    assert.equal(control.active, false)
  })

  it("sin propiedad y con una entrada ajena: nunca serve off", async () => {
    ts.entries.set(8443, "http://127.0.0.1:9999")
    const control = make()
    const r = await control.disable()
    assert.equal(r.removed, false)
    assert.ok(!trace().includes("serveOff 8443"))
    assert.equal(ts.entries.get(8443), "http://127.0.0.1:9999")
  })

  it("con propiedad pero la entrada ahora apunta a otra cosa: no se toca, y se borra el registro", async () => {
    db.updateRemoteConfig({ serveOwned: true, serveTarget: TARGET, serveCreatedAt: 1 })
    ts.entries.set(8443, "http://127.0.0.1:9999")
    const control = make()
    const r = await control.disable()
    assert.equal(r.removed, false)
    assert.equal(r.reason, "foreign")
    assert.ok(!trace().includes("serveOff 8443"))
    assert.equal(db.getRemoteConfig().serveOwned, false)
    assert.equal(ts.entries.get(8443), "http://127.0.0.1:9999")
  })

  it("con propiedad pero sin entrada: solo se borra el registro", async () => {
    db.updateRemoteConfig({ serveOwned: true, serveTarget: TARGET, serveCreatedAt: 1 })
    const control = make()
    const r = await control.disable()
    assert.equal(r.reason, "stale")
    assert.ok(!trace().includes("serveOff 8443"))
    assert.equal(db.getRemoteConfig().serveOwned, false)
  })

  it("sin propiedad no corre ni el comando de lectura", async () => {
    const control = make()
    const r = await control.disable()
    assert.equal(r.reason, "no_ownership")
    assert.deepEqual(trace(), ["persist enabled", "stopNow", "terminate ws"])
  })
})

describe("al arrancar (R2.8, R2.10)", () => {
  it("prendido: vuelve a prenderse solo, y lo guardado ya estaba", async () => {
    db.updateRemoteConfig({ enabled: true, origin: `https://${HOST}:8443` })
    const control = make()
    await control.reconcile()
    assert.equal(control.active, true)
    assert.ok(trace().includes("bind 4710"))
    assert.ok(trace().includes(`serveOn 8443 ${TARGET}`))
    assert.equal(db.getRemoteConfig().enabled, true)
  })

  it("prendido pero Tailscale no está listo: sigue prendido, sin exposición, con el motivo, y el server arranca", async () => {
    db.updateRemoteConfig({ enabled: true })
    ts.state = { kind: "needs_login", message: "No se pudo usar Tailscale: falta iniciar sesión." }
    const control = make()
    await control.reconcile()
    assert.equal(db.getRemoteConfig().enabled, true)
    assert.equal(control.active, false)
    assert.equal(control.problem()?.kind, "needs_login")
    assert.ok(!trace().includes("bind 4710"))
  })

  it("prendido y el CLI lanza una excepción: no se propaga", async () => {
    db.updateRemoteConfig({ enabled: true })
    ts.status = async () => {
      throw new Error("boom")
    }
    const control = make()
    await assert.doesNotReject(() => control.reconcile())
    assert.equal(control.active, false)
    assert.equal(db.getRemoteConfig().enabled, true)
  })

  it("apagado pero con propiedad, y la entrada sigue siendo nuestra: se saca", async () => {
    db.updateRemoteConfig({ serveOwned: true, serveTarget: TARGET, serveCreatedAt: 1 })
    ts.entries.set(8443, TARGET)
    const control = make()
    await control.reconcile()
    assert.ok(trace().includes("serveOff 8443"))
    assert.equal(db.getRemoteConfig().serveOwned, false)
    assert.equal(ts.entries.has(8443), false)
  })

  it("apagado, con propiedad y una entrada ajena: no se toca y se borra el registro", async () => {
    db.updateRemoteConfig({ serveOwned: true, serveTarget: TARGET, serveCreatedAt: 1 })
    ts.entries.set(8443, "http://127.0.0.1:9999")
    const control = make()
    await control.reconcile()
    assert.ok(!trace().includes("serveOff 8443"))
    assert.equal(db.getRemoteConfig().serveOwned, false)
  })

  it("propiedad vieja sin entrada: se borra el registro", async () => {
    db.updateRemoteConfig({ serveOwned: true, serveTarget: TARGET, serveCreatedAt: 1 })
    const control = make()
    await control.reconcile()
    assert.equal(db.getRemoteConfig().serveOwned, false)
    assert.ok(!trace().includes("serveOff 8443"))
  })

  it("persiste entre reinicios: lo prendido en una corrida se retoma en la siguiente", async () => {
    const first = make()
    await first.enable()
    await first.shutdown()
    db.close()
    db = new Db(file)
    events.length = 0
    ts = new FakeTailscale(events)
    listener = new FakeListener(events)
    const second = make()
    await second.reconcile()
    assert.equal(second.active, true)
    assert.equal(db.getRemoteConfig().enabled, true)
  })
})

describe("al apagar el server (R2.9)", () => {
  it("cierra el listener, saca la entrada y deja enabled en 1", async () => {
    const control = make()
    await control.enable()
    events.length = 0
    await control.shutdown()
    assert.deepEqual(trace().slice(0, 3), ["stop", "terminate ws", "serveEntry 8443"])
    assert.ok(trace().includes("serveOff 8443"))
    const c = db.getRemoteConfig()
    assert.equal(c.enabled, true)
    assert.equal(c.serveOwned, false)
  })

  it("con el CLI colgado no se cuelga: vence el plazo y sigue", async () => {
    const control = make({ shutdownBudgetMs: 100 })
    await control.enable()
    ts.hang = true
    const t0 = Date.now()
    await control.shutdown()
    assert.ok(Date.now() - t0 < 1500, `tardó ${Date.now() - t0} ms`)
    assert.equal(db.getRemoteConfig().enabled, true)
    assert.equal(listener.running, false)
  })
})

describe("interruptor de corte (R2.12)", () => {
  it("con el CLI colgado: persiste enabled=0, cierra el listener y los websockets ANTES de cualquier llamada a Tailscale", async () => {
    const control = make()
    await control.enable()
    ts.hang = true
    events.length = 0
    const { done } = control.kill()
    // Sincrónico: apenas vuelve kill(), el acceso ya está cortado y el CLI todavía no se tocó.
    assert.deepEqual(trace(), ["persist enabled", "stopNow", "terminate ws"])
    assert.equal(db.getRemoteConfig().enabled, false)
    assert.equal(control.active, false)
    assert.equal(listener.running, false)
    await new Promise((r) => setTimeout(r, 30))
    // Recién después arranca el CLI (y se queda colgado sin molestar a nadie).
    assert.equal(trace()[3], "serveEntry 8443")
    void done
  })

  it("kill sin Tailscale instalado también corta: no depende del CLI", async () => {
    const control = make()
    await control.enable()
    ts.status = async () => {
      throw new Error("sin tailscale")
    }
    ts.serveEntry = async () => {
      throw new Error("sin tailscale")
    }
    const { done } = control.kill()
    assert.equal(control.active, false)
    await assert.doesNotReject(done)
  })
})
