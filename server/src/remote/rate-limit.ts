/**
 * Límites en memoria, sin dependencias. Todo el tráfico remoto llega desde 127.0.0.1 (lo trae Tailscale), así que
 * los límites son por listener o por dispositivo, nunca por IP de origen.
 */

export interface WindowLimiterOptions {
  /** Cuántos eventos entran por ventana. */
  limit: number
  windowMs: number
  now?: () => number
}

/** Ventana deslizante por clave: hasta `limit` eventos en los últimos `windowMs`. */
export class WindowLimiter {
  private limit: number
  private windowMs: number
  private clock: () => number
  private hits = new Map<string, number[]>()

  constructor(o: WindowLimiterOptions) {
    this.limit = o.limit
    this.windowMs = o.windowMs
    this.clock = o.now ?? Date.now
  }

  private live(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (list.length) this.hits.set(key, list)
    else this.hits.delete(key)
    return list
  }

  /** Segundos hasta que se libere un lugar, o null si todavía hay. No cuenta. */
  peek(key = ""): number | null {
    const now = this.clock()
    const list = this.live(key, now)
    if (list.length < this.limit) return null
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 1000))
  }

  /** Anota un evento, haya lugar o no. */
  record(key = "") {
    const now = this.clock()
    const list = this.live(key, now)
    list.push(now)
    this.hits.set(key, list)
    this.sweep(now)
  }

  /** Cuenta un evento si hay lugar (devuelve null); si no, devuelve los segundos de espera y no cuenta. */
  take(key = ""): number | null {
    const wait = this.peek(key)
    if (wait !== null) return wait
    this.record(key)
    return null
  }

  /** Claves en memoria (para saber que no crece sin tope). */
  size(): number {
    return this.hits.size
  }

  /** De vez en cuando se olvidan las claves que ya no tienen nada dentro de la ventana. */
  private sweep(now: number) {
    if (this.hits.size < 512) return
    for (const [k, list] of this.hits) {
      if (!list.some((t) => now - t < this.windowMs)) this.hits.delete(k)
    }
  }
}

/** De qué tipo de escritura se trata (ver rules.ts). */
export type WriteClass = "messages" | "draft" | "permission" | "control" | "other"

/**
 * Los topes de las escrituras remotas, sin dependencias:
 *  - mensajes y envío de borradores: 20 por minuto y 200 por hora, por dispositivo
 *  - editar y descartar borradores: 60 por minuto, por dispositivo
 *  - respuestas a permisos: 30 por minuto, por dispositivo
 *  - acciones de control: 10 por minuto, por dispositivo
 *  - todas las escrituras: 60 por minuto en total (el tráfico remoto sale de una sola IP)
 * Un pedido cuenta solo si pasa todos los topes que le tocan: si uno lo frena, ninguno anota nada.
 */
export class WriteLimiter {
  private messagesMinute: WindowLimiter
  private messagesHour: WindowLimiter
  private draft: WindowLimiter
  private permission: WindowLimiter
  private control: WindowLimiter
  private all: WindowLimiter

  constructor(o: { now?: () => number } = {}) {
    const minute = 60_000
    this.messagesMinute = new WindowLimiter({ limit: 20, windowMs: minute, now: o.now })
    this.messagesHour = new WindowLimiter({ limit: 200, windowMs: 60 * minute, now: o.now })
    this.draft = new WindowLimiter({ limit: 60, windowMs: minute, now: o.now })
    this.permission = new WindowLimiter({ limit: 30, windowMs: minute, now: o.now })
    this.control = new WindowLimiter({ limit: 10, windowMs: minute, now: o.now })
    this.all = new WindowLimiter({ limit: 60, windowMs: minute, now: o.now })
  }

  /** Cuenta la escritura si hay lugar (devuelve null); si no, los segundos hasta que lo haya, sin anotar nada. */
  take(deviceId: string, cls: WriteClass): number | null {
    const own: [WindowLimiter, string][] = [[this.all, ""]]
    if (cls === "messages") own.push([this.messagesMinute, deviceId], [this.messagesHour, deviceId])
    else if (cls === "draft") own.push([this.draft, deviceId])
    else if (cls === "permission") own.push([this.permission, deviceId])
    else if (cls === "control") own.push([this.control, deviceId])
    let wait: number | null = null
    for (const [limiter, key] of own) {
      const w = limiter.peek(key)
      if (w !== null) wait = Math.max(wait ?? 0, w)
    }
    if (wait !== null) return wait
    for (const [limiter, key] of own) limiter.record(key)
    return null
  }
}
