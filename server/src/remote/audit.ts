import { createHash } from "node:crypto"

import type { FastifyInstance, FastifyRequest } from "fastify"

import type { Db, RemoteAuditRow } from "../db.ts"
import { remoteInfo } from "./gate.ts"
import type { Tier } from "./policy.ts"

/**
 * La auditoría del acceso remoto: una tabla sqlite acotada (30 días o 10.000 filas, podada cada 100 inserciones).
 * Guarda QUÉ pasó y quién lo hizo, nunca el contenido: ni mensajes, ni texto de borradores, ni el input de un permiso,
 * ni cookies, tokens, encabezados o secretos. De un permiso queda la herramienta y una huella corta (16 hex) del input.
 */

export type AuditKind = "request" | "pair" | "revoke" | "tier" | "enable" | "disable" | "kill" | "ws"
export type AuditOutcome = "ok" | "denied" | "unauthenticated" | "rate_limited" | "invalid" | "error"

export const RETENTION_MS = 30 * 24 * 3600 * 1000
export const MAX_ROWS = 10_000
export const PRUNE_EVERY = 100

export interface AuditEntry {
  deviceId?: string | null
  kind: AuditKind
  method?: string | null
  /** El patrón de la ruta (`/api/sessions/:id/messages`), nunca la URL ni la query. */
  route?: string | null
  /** Solo de los parámetros id e itemId. */
  targetId?: string | null
  toolName?: string | null
  inputHash?: string | null
  status?: number | null
  outcome: AuditOutcome
  /** Un código corto (`remote_tier`), nunca texto libre. */
  reason?: string | null
}

/** JSON con las claves ordenadas a cualquier profundidad: el mismo input da siempre los mismos bytes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(v ?? null)
}

/** Los primeros 16 hexadecimales del sha256 del JSON canónico del input (el input en sí no se guarda). */
export const inputHash = (input: unknown): string => createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 16)

/** Del estado HTTP al resultado que se anota. */
export function outcomeOf(status: number): AuditOutcome {
  if (status >= 100 && status < 400) return "ok"
  if (status === 401) return "unauthenticated"
  if (status === 403) return "denied"
  if (status === 429) return "rate_limited"
  if (status >= 400 && status < 500) return "invalid"
  return "error"
}

const clean = (v: string | null | undefined, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null)

export interface AuditOptions {
  db: Pick<Db, "insertRemoteAudit" | "pruneRemoteAudit" | "listRemoteAudit">
  now?: () => number
}

export class RemoteAudit {
  private db: AuditOptions["db"]
  private clock: () => number
  private inserts = 0
  private reads = 0

  constructor(o: AuditOptions) {
    this.db = o.db
    this.clock = o.now ?? Date.now
    this.prune()
  }

  /** Anota un hecho. Nunca lanza: una auditoría que falla no tumba el pedido. */
  record(e: AuditEntry): void {
    try {
      this.db.insertRemoteAudit({
        at: this.clock(),
        deviceId: clean(e.deviceId, /^[A-Za-z0-9-]{1,64}$/),
        kind: e.kind,
        method: clean(e.method, /^[A-Z]{3,7}$/),
        route: clean(e.route, /^\/[\x21-\x7e]{0,199}$/),
        targetId: clean(e.targetId, /^[A-Za-z0-9_-]{1,64}$/),
        toolName: clean(e.toolName, /^[\w .:@/-]{1,100}$/),
        inputHash: clean(e.inputHash, /^[0-9a-f]{16}$/),
        status: Number.isInteger(e.status) ? (e.status as number) : null,
        outcome: e.outcome,
        reason: clean(e.reason, /^[a-z_]{1,40}$/),
      })
      if (++this.inserts % PRUNE_EVERY === 0) this.prune()
    } catch {
      // sin auditoría no se frena nada
    }
  }

  prune(): void {
    try {
      this.db.pruneRemoteAudit(this.clock() - RETENTION_MS, MAX_ROWS)
    } catch {
      // ídem
    }
  }

  /** Las más nuevas primero. */
  list(limit = 200): RemoteAuditRow[] {
    return this.db.listRemoteAudit(Math.max(1, Math.min(1000, Math.floor(limit) || 200)))
  }

  /** Las lecturas no dejan filas: solo se cuentan. */
  countRead(): void {
    this.reads++
  }

  counters(): { reads: number } {
    return { reads: this.reads }
  }
}

const KIND_BY_ROUTE: Record<string, AuditKind> = { "POST /api/remote/pair": "pair", "POST /api/remote/logout": "revoke" }

/**
 * Anota cada pedido remoto que cambia algo al terminar (con el estado final, venga de la puerta, de las reglas o del handler).
 * Las lecturas solo suman un contador; el websocket se anota al conectarse (ver setup.ts).
 */
export function registerRemoteAudit(app: FastifyInstance, o: { audit: RemoteAudit; isRemote: (req: FastifyRequest) => boolean }) {
  // El código del error (remote_tier, remote_needs_local…) sale de la respuesta; el texto nunca se guarda.
  app.addHook("onSend", async (req, reply, payload) => {
    if (!o.isRemote(req) || reply.statusCode < 400) return payload
    const info = remoteInfo(req)
    if (info && typeof payload === "string") {
      try {
        const code = (JSON.parse(payload) as { code?: unknown }).code
        if (typeof code === "string") info.reason = code
      } catch {
        // no era JSON
      }
    }
    return payload
  })

  app.addHook("onResponse", async (req, reply) => {
    if (!o.isRemote(req)) return
    if (req.method === "GET" || req.method === "HEAD") return void o.audit.countRead()
    const info = remoteInfo(req)
    const pattern = req.routeOptions?.url ?? null
    const tier = (req.routeOptions?.config as { remote?: Tier } | undefined)?.remote
    const params = (req.params ?? {}) as Record<string, unknown>
    // El id solo se anota en rutas que se abren: lo que la puerta rechaza como `never` no deja texto del cliente.
    const open = tier !== undefined && tier !== "never"
    const target = open ? (typeof params.itemId === "string" ? params.itemId : typeof params.id === "string" ? params.id : null) : null
    o.audit.record({
      deviceId: info?.device?.id ?? null,
      kind: (pattern && KIND_BY_ROUTE[`${req.method} ${pattern}`]) || "request",
      method: req.method,
      route: pattern,
      targetId: target,
      toolName: info?.toolName ?? null,
      inputHash: info?.inputHash ?? null,
      status: reply.statusCode,
      outcome: outcomeOf(reply.statusCode),
      reason: info?.reason ?? null,
    })
  })
}
