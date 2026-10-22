import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

import type { Db, RemoteDeviceRow } from "../db.ts"

/** El nombre de la cookie del dispositivo: `__Host-` obliga a Secure, Path=/ y sin Domain. */
export const COOKIE_NAME = "__Host-cp_device"
export const PAIRING_TTL_MS = 5 * 60_000
export const DEVICE_TTL_MS = 30 * 24 * 3600 * 1000
/** `last_seen_at` se escribe como mucho una vez por minuto. */
export const LAST_SEEN_MS = 60_000
export const COOKIE_MAX_AGE_S = DEVICE_TTL_MS / 1000

const NAME_MAX = 60

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex")

/** Compara dos hashes hexadecimales en tiempo constante. Largos distintos son distintos, sin lanzar. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/** 32 bytes del generador seguro del sistema, en base64url (43 caracteres). */
const secret = () => randomBytes(32).toString("base64url")

/** Un dispositivo, sin su hash. */
export interface Device {
  id: string
  name: string
  tier: RemoteDeviceRow["tier"]
  tsLogin: string | null
  createdAt: number
  expiresAt: number
  lastSeenAt: number | null
}

const toDevice = (r: RemoteDeviceRow): Device => ({ id: r.id, name: r.name, tier: r.tier, tsLogin: r.tsLogin, createdAt: r.createdAt, expiresAt: r.expiresAt, lastSeenAt: r.lastSeenAt })

/** Sin caracteres de control, sin espacios de más y con tope. */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim()
  return name || null
}

export interface PairingOptions {
  db: Pick<Db, "insertRemoteDevice" | "getRemoteDeviceByHash" | "listRemoteDevices" | "touchRemoteDevice" | "revokeRemoteDevice" | "setRemoteDeviceTier" | "revokeAllRemoteDevices" | "replaceRemotePairing" | "getRemotePairingByHash" | "consumeRemotePairing">
  now?: () => number
}

/**
 * Enlaces de pareo y dispositivos. Los secretos (el token del enlace y la cookie) salen del generador seguro,
 * se entregan una vez y en la base queda solo su sha256. Nada de esto se loguea.
 */
export class PairingService {
  private db: PairingOptions["db"]
  private clock: () => number

  constructor(o: PairingOptions) {
    this.db = o.db
    this.clock = o.now ?? Date.now
  }

  /** Un enlace nuevo. Reemplaza al anterior: hay uno solo activo. */
  create(o: { tier: RemoteDeviceRow["tier"]; name?: string }): { id: string; token: string; expiresAt: number } {
    const token = secret()
    const id = randomUUID()
    const expiresAt = this.clock() + PAIRING_TTL_MS
    this.db.replaceRemotePairing({ id, tokenHash: sha256Hex(token), name: cleanName(o.name), tier: o.tier, expiresAt })
    return { id, token, expiresAt }
  }

  /** Canjea el token: crea el dispositivo y devuelve la cookie (única vez que se ve). Null si no sirve. */
  redeem(token: unknown, o: { name?: unknown; tsLogin?: string | null }): { device: Device; secret: string } | null {
    if (typeof token !== "string" || token.length < 16 || token.length > 200) return null
    const hash = sha256Hex(token)
    const row = this.db.getRemotePairingByHash(hash)
    if (!row || !safeEqualHex(row.tokenHash, hash)) return null
    const now = this.clock()
    if (row.usedAt !== null || row.expiresAt <= now) return null
    // Un enlace sirve una vez: solo quien lo gasta primero sigue.
    if (!this.db.consumeRemotePairing(row.id, now)) return null
    const cookie = secret()
    const device: RemoteDeviceRow = {
      id: randomUUID(),
      name: cleanName(o.name) ?? row.name ?? "Dispositivo",
      tier: row.tier,
      tokenHash: sha256Hex(cookie),
      tsLogin: cleanName(o.tsLogin) ?? null,
      createdAt: now,
      expiresAt: now + DEVICE_TTL_MS,
      lastSeenAt: now,
      revokedAt: null,
    }
    this.db.insertRemoteDevice(device)
    return { device: toDevice(device), secret: cookie }
  }

  /** El dispositivo de esta cookie, si es válido: no revocado, no vencido y, si se ató a un usuario de Tailscale, el mismo. */
  authenticate(cookie: unknown, tsLogin: string | null | undefined): Device | null {
    if (typeof cookie !== "string" || cookie.length < 16 || cookie.length > 200) return null
    const hash = sha256Hex(cookie)
    const row = this.db.getRemoteDeviceByHash(hash)
    if (!row || !safeEqualHex(row.tokenHash, hash)) return null
    const now = this.clock()
    if (row.revokedAt !== null || row.expiresAt <= now) return null
    if (row.tsLogin !== null && row.tsLogin !== (cleanName(tsLogin) ?? null)) return null
    if (row.lastSeenAt === null || now - row.lastSeenAt >= LAST_SEEN_MS) {
      this.db.touchRemoteDevice(row.id, now)
      row.lastSeenAt = now
    }
    return toDevice(row)
  }

  /** Los dispositivos vigentes (sin revocados ni vencidos). */
  list(): Device[] {
    const now = this.clock()
    return this.db.listRemoteDevices().filter((r) => r.expiresAt > now).map(toDevice)
  }

  /** Cambia el nivel de un dispositivo vigente. */
  setTier(id: string, tier: RemoteDeviceRow["tier"]): boolean {
    return this.db.setRemoteDeviceTier(id, tier)
  }

  /** Revoca todos los dispositivos vigentes; devuelve sus ids. */
  revokeAll(): string[] {
    return this.db.revokeAllRemoteDevices(this.clock())
  }

  revoke(id: string): boolean {
    return this.db.revokeRemoteDevice(id, this.clock())
  }
}
