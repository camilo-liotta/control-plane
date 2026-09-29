/** El pedido no llegó a tener respuesta del server (se cortó la conexión, el server se reinició…). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(`se cortó la conexión con el server local (${cause instanceof Error ? cause.message : String(cause)})`)
    this.name = "NetworkError"
  }
}

export interface DeliverOptions<T> {
  /** Manda el mensaje. Tiene que ser idempotente (el mismo id de cliente en cada intento). */
  send: () => Promise<T>
  /** Si el eco del mensaje ya llegó por el WS: el server lo aceptó aunque la respuesta se haya perdido. */
  echoed: () => boolean
  retries?: number
  waitMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Manda un mensaje sin dar por fallido lo que el server aceptó. Si el server contesta con un error,
 * ese es el motivo. Si la respuesta no llega, puede que igual lo haya recibido: se fija en el eco del
 * WS y, si no está, reintenta con el mismo id (el server no lo duplica). Devuelve null cuando la
 * confirmación vino por el eco.
 */
export async function deliver<T>(opts: DeliverOptions<T>): Promise<T | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const retries = opts.retries ?? 2
  const waitMs = opts.waitMs ?? 1000
  for (let attempt = 0; ; attempt++) {
    try {
      return await opts.send()
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err
      if (opts.echoed()) return null
      await sleep(waitMs)
      if (opts.echoed()) return null
      if (attempt >= retries) throw err
    }
  }
}
