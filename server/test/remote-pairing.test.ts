import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { Db } from "../src/db.ts"
import { COOKIE_NAME, DEVICE_TTL_MS, LAST_SEEN_MS, PAIRING_TTL_MS, PairingService, safeEqualHex, sha256Hex } from "../src/remote/pairing.ts"
import { WindowLimiter } from "../src/remote/rate-limit.ts"

let dir: string
let file: string
let db: Db
let clock: number
const now = () => clock
let svc: PairingService

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-pairing-"))
  file = path.join(dir, "control-plane.db")
  db = new Db(file)
  clock = 1_700_000_000_000
  svc = new PairingService({ db, now })
})
afterEach(() => {
  try {
    db.close()
  } catch {
    // ya cerrada
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("tablas (6.1)", () => {
  it("remote_devices y remote_pairings existen, vacías", () => {
    assert.deepEqual(db.listRemoteDevices(), [])
  })

  it("en disco no queda ningún token ni cookie en claro, solo los hashes", () => {
    const { token } = svc.create({ tier: "read" })
    const paired = svc.redeem(token, { name: "Telefono de prueba", tsLogin: "ana@example.com" })
    assert.ok(paired)
    db.close()
    const raw = [file, `${file}-wal`, `${file}-shm`]
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f).toString("latin1"))
      .join("\n")
    assert.ok(!raw.includes(token), "el token del enlace está en claro")
    assert.ok(!raw.includes(paired.secret), "la cookie está en claro")
    assert.ok(raw.includes(sha256Hex(paired.secret)), "debería estar el hash de la cookie")
    assert.ok(raw.includes(sha256Hex(token)), "debería estar el hash del token")
  })
})

describe("token de pareo (R3.1)", () => {
  it("32 bytes o más, en base64url, del generador seguro: Math.random no se llama nunca", () => {
    const original = Math.random
    let calls = 0
    Math.random = () => {
      calls++
      return original()
    }
    try {
      const { token } = svc.create({ tier: "read" })
      assert.match(token, /^[A-Za-z0-9_-]{43,}$/)
      const paired = svc.redeem(token, {})
      assert.ok(paired)
      assert.match(paired.secret, /^[A-Za-z0-9_-]{43,}$/)
      svc.authenticate(paired.secret, null)
      svc.create({ tier: "read" })
    } finally {
      Math.random = original
    }
    assert.equal(calls, 0)
  })

  it("dos tokens no se repiten", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(svc.create({ tier: "read" }).token)
    assert.equal(seen.size, 50)
  })

  it("se usa una sola vez: el segundo canje es null", () => {
    const { token } = svc.create({ tier: "read" })
    assert.ok(svc.redeem(token, { name: "uno" }))
    assert.equal(svc.redeem(token, { name: "dos" }), null)
    assert.equal(db.listRemoteDevices().length, 1)
  })

  it("vence a los 5 minutos", () => {
    const { token, expiresAt } = svc.create({ tier: "read" })
    assert.equal(expiresAt, clock + PAIRING_TTL_MS)
    assert.equal(PAIRING_TTL_MS, 5 * 60_000)
    clock += PAIRING_TTL_MS + 1
    assert.equal(svc.redeem(token, {}), null)
  })

  it("justo antes de vencer todavía sirve", () => {
    const { token } = svc.create({ tier: "read" })
    clock += PAIRING_TTL_MS - 1
    assert.ok(svc.redeem(token, {}))
  })

  it("hay un solo token activo: crear otro invalida el anterior", () => {
    const a = svc.create({ tier: "read" })
    const b = svc.create({ tier: "read" })
    assert.equal(svc.redeem(a.token, {}), null)
    assert.ok(svc.redeem(b.token, {}))
  })

  it("tokens inventados, vacíos o de otro largo: null y sin lanzar", () => {
    svc.create({ tier: "read" })
    for (const t of ["", "x", "a".repeat(43), "a".repeat(500), "../../etc/passwd", "%00"]) assert.equal(svc.redeem(t, {}), null)
    assert.equal(svc.redeem(undefined as never, {}), null)
    assert.equal(svc.redeem(42 as never, {}), null)
  })

  it("el nivel del dispositivo es el que se eligió al crear el enlace (read por defecto)", () => {
    const { token } = svc.create({ tier: "read" })
    assert.equal(svc.redeem(token, {})!.device.tier, "read")
  })

  it("el nombre: el que manda el dispositivo, recortado y limpio; si no, el del enlace; si no, uno genérico", () => {
    const a = svc.create({ tier: "read", name: "Del enlace" })
    assert.equal(svc.redeem(a.token, {})!.device.name, "Del enlace")
    const b = svc.create({ tier: "read" })
    assert.equal(svc.redeem(b.token, { name: "  Mi\u0007 celu  " })!.device.name, "Mi celu")
    const c = svc.create({ tier: "read" })
    assert.equal(svc.redeem(c.token, { name: "x".repeat(200) })!.device.name.length, 60)
    const d = svc.create({ tier: "read" })
    assert.equal(svc.redeem(d.token, {})!.device.name, "Dispositivo")
  })
})

describe("comparación en tiempo constante (R3.2)", () => {
  it("safeEqualHex compara digests del mismo largo y nunca lanza", () => {
    const a = sha256Hex("uno")
    assert.equal(safeEqualHex(a, a), true)
    assert.equal(safeEqualHex(a, sha256Hex("dos")), false)
    assert.equal(safeEqualHex(a, a.slice(1)), false)
    assert.equal(safeEqualHex(a, ""), false)
    assert.equal(safeEqualHex("zz", "zz"), true)
  })

  it("el hash guardado es sha256 hex del valor", () => {
    const { token } = svc.create({ tier: "read" })
    const paired = svc.redeem(token, {})!
    assert.equal(createHash("sha256").update(paired.secret).digest("hex"), sha256Hex(paired.secret))
    assert.equal(db.getRemoteDeviceByHash(sha256Hex(paired.secret))?.id, paired.device.id)
  })
})

describe("dispositivo: autenticación y vida (R3.3, R3.4)", () => {
  const pair = (login: string | null = null) => {
    const { token } = svc.create({ tier: "read" })
    return svc.redeem(token, { name: "Celu", tsLogin: login })!
  }

  it("la cookie válida identifica al dispositivo", () => {
    const p = pair()
    assert.equal(svc.authenticate(p.secret, null)?.id, p.device.id)
    assert.equal(COOKIE_NAME, "__Host-cp_device")
  })

  it("sin cookie, vacía, inventada o de otro largo: null", () => {
    pair()
    for (const s of ["", "x", "a".repeat(43), "a".repeat(1000)]) assert.equal(svc.authenticate(s, null), null)
    assert.equal(svc.authenticate(undefined as never, null), null)
  })

  it("revocado: null de inmediato", () => {
    const p = pair()
    assert.equal(svc.revoke(p.device.id), true)
    assert.equal(svc.authenticate(p.secret, null), null)
    assert.equal(svc.revoke(p.device.id), false)
    assert.equal(svc.revoke("no-existe"), false)
  })

  it("vence a los 30 días, absolutos", () => {
    const p = pair()
    assert.equal(p.device.expiresAt, clock + DEVICE_TTL_MS)
    assert.equal(DEVICE_TTL_MS, 30 * 24 * 3600 * 1000)
    clock += DEVICE_TTL_MS - 1000
    assert.ok(svc.authenticate(p.secret, null))
    clock += 2000
    assert.equal(svc.authenticate(p.secret, null), null)
  })

  it("atado al usuario de Tailscale: si se registró y ahora cambia, null; si coincide o no se registró, pasa", () => {
    const bound = pair("ana@example.com")
    assert.ok(svc.authenticate(bound.secret, "ana@example.com"))
    assert.equal(svc.authenticate(bound.secret, "otro@example.com"), null)
    assert.equal(svc.authenticate(bound.secret, null), null)
    const free = pair(null)
    assert.ok(svc.authenticate(free.secret, "cualquiera@example.com"))
  })

  it("last_seen se escribe como mucho una vez por minuto", () => {
    const p = pair()
    svc.authenticate(p.secret, null)
    const first = db.getRemoteDeviceByHash(sha256Hex(p.secret))!.lastSeenAt
    assert.equal(first, clock)
    clock += LAST_SEEN_MS - 1
    svc.authenticate(p.secret, null)
    assert.equal(db.getRemoteDeviceByHash(sha256Hex(p.secret))!.lastSeenAt, first)
    clock += 2
    svc.authenticate(p.secret, null)
    assert.equal(db.getRemoteDeviceByHash(sha256Hex(p.secret))!.lastSeenAt, clock)
  })

  it("la lista no incluye revocados ni vencidos, y nunca el hash", () => {
    const a = pair()
    const b = pair()
    svc.revoke(b.device.id)
    const list = svc.list()
    assert.deepEqual(list.map((d) => d.id), [a.device.id])
    assert.ok(!JSON.stringify(list).includes("token"))
    assert.ok(!JSON.stringify(list).includes(sha256Hex(a.secret)))
  })
})

describe("límites en memoria (R3.5, R5.5)", () => {
  it("WindowLimiter: hasta N por ventana; el siguiente da Retry-After; la ventana se desliza", () => {
    let t = 0
    const l = new WindowLimiter({ limit: 3, windowMs: 60_000, now: () => t })
    assert.equal(l.take("a"), null)
    assert.equal(l.take("a"), null)
    assert.equal(l.take("a"), null)
    const retry = l.take("a")
    assert.ok(retry !== null && retry >= 1 && retry <= 60)
    assert.equal(l.take("b"), null, "otra clave tiene su propia cuenta")
    t += 60_001
    assert.equal(l.take("a"), null)
  })

  it("peek no cuenta; record sí", () => {
    let t = 0
    const l = new WindowLimiter({ limit: 2, windowMs: 1000, now: () => t })
    assert.equal(l.peek("k"), null)
    l.record("k")
    l.record("k")
    assert.ok(l.peek("k") !== null)
    t += 1001
    assert.equal(l.peek("k"), null)
  })

  it("no crece sin tope: las claves viejas se olvidan", () => {
    let t = 0
    const l = new WindowLimiter({ limit: 1, windowMs: 1000, now: () => t })
    for (let i = 0; i < 2000; i++) l.take(`k${i}`)
    t += 5000
    l.take("nueva")
    assert.ok(l.size() < 10)
  })
})

describe("el código del acceso remoto no usa generadores débiles", () => {
  it("ningún archivo de remote/ ni tailscale.ts llama a Math.random", async () => {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
    const srcDir = path.resolve(here, "../src")
    const files = [...fs.readdirSync(path.join(srcDir, "remote")).map((f) => path.join(srcDir, "remote", f)), path.join(srcDir, "tailscale.ts")]
    assert.ok(files.length > 8)
    for (const f of files) assert.ok(!/Math\.random\s*\(/.test(fs.readFileSync(f, "utf8")), `${path.basename(f)} usa Math.random`)
  })
})
