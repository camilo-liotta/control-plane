import http from "node:http"
import type net from "node:net"

import type { FastifyInstance } from "fastify"

/** Solo se escucha en el loopback: Tailscale (serve) es lo único que llega hasta acá. */
export const REMOTE_HOST = "127.0.0.1"
export const HEADERS_TIMEOUT_MS = 10_000
export const REQUEST_TIMEOUT_MS = 30_000
/** Tope de conexiones simultáneas: todo el tráfico remoto es de unos pocos dispositivos propios. */
export const MAX_CONNECTIONS = 128
export const DEFAULT_REMOTE_PORT = 4710

/**
 * El puerto de loopback del listener remoto a partir de CONTROL_PLANE_REMOTE_PORT: entero entre 1024 y 65535, nunca 443
 * ni el puerto principal. Un valor inválido no tumba el server (el acceso remoto es opcional): cae al de fábrica.
 */
export function resolveRemotePort(raw: string | undefined, mainPort: number): number {
  const fallback = DEFAULT_REMOTE_PORT === mainPort ? DEFAULT_REMOTE_PORT + 1 : DEFAULT_REMOTE_PORT
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1024 || n > 65535 || n === 443 || n === mainPort) {
    console.warn(`CONTROL_PLANE_REMOTE_PORT inválido (${raw.slice(0, 20)}): se usa ${fallback}.`)
    return fallback
  }
  return n
}

export interface RemoteListenerOptions {
  app: FastifyInstance
  /** El handler de Fastify (lo captura `serverFactory`); se pide recién al abrir. */
  handler: () => http.RequestListener
  /** El puerto principal: el remoto no puede ser el mismo. */
  mainPort: number
}

/**
 * Un segundo `http.Server` sobre el mismo Fastify: mismas rutas, otro socket. Existe solo mientras el acceso
 * remoto está activo. Una petición es remota por el socket que la recibió, nunca por lo que diga el Host.
 */
export class RemoteListener {
  private app: FastifyInstance
  private handler: () => http.RequestListener
  private mainPort: number
  private server: http.Server | null = null
  private sockets = new Set<net.Socket>()
  private remoteSockets = new WeakSet<net.Socket>()
  private boundPort: number | null = null

  constructor(o: RemoteListenerOptions) {
    this.app = o.app
    this.handler = o.handler
    this.mainPort = o.mainPort
  }

  get running(): boolean {
    return this.server !== null
  }

  address(): net.AddressInfo | null {
    const a = this.server?.address()
    return a && typeof a === "object" ? a : null
  }

  timeouts() {
    return { headersTimeout: this.server?.headersTimeout ?? 0, requestTimeout: this.server?.requestTimeout ?? 0, maxConnections: this.server?.maxConnections ?? 0 }
  }

  /** Abre el listener en 127.0.0.1:<port> (0 = cualquiera libre, para los tests). */
  async start(port: number): Promise<void> {
    if (this.server) throw new Error("No se pudo abrir el acceso remoto: ya está abierto.")
    if (port === this.mainPort) throw new Error("No se pudo abrir el acceso remoto: el puerto tiene que ser distinto del principal.")
    const server = http.createServer(this.handler())
    server.headersTimeout = HEADERS_TIMEOUT_MS
    server.requestTimeout = REQUEST_TIMEOUT_MS
    server.maxConnections = MAX_CONNECTIONS
    server.on("connection", (socket) => {
      this.remoteSockets.add(socket)
      this.sockets.add(socket)
      socket.once("close", () => this.sockets.delete(socket))
    })
    // Los websockets entran por acá: se reenvían al mismo plugin que atiende el puerto principal.
    server.on("upgrade", (req, socket, head) => {
      this.app.server.emit("upgrade", req, socket, head)
    })
    await new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => {
        server.removeListener("listening", ok)
        reject(err)
      }
      const ok = () => {
        server.removeListener("error", fail)
        resolve()
      }
      server.once("error", fail)
      server.once("listening", ok)
      server.listen({ host: REMOTE_HOST, port })
    })
    this.server = server
    this.boundPort = (server.address() as net.AddressInfo).port
  }

  /** ¿Entró por el listener remoto? Cualquiera de las dos señales alcanza (falla cerrado). */
  isRemote(socket: net.Socket): boolean {
    if (this.remoteSockets.has(socket)) return true
    return this.boundPort !== null && socket.localPort === this.boundPort
  }

  /**
   * Corta ya, sin esperar a nadie: cierra el listener y destruye todas las conexiones, websockets incluidos.
   * Es síncrono a propósito: el interruptor de corte no puede depender de Tailscale ni de nada que se pueda colgar.
   */
  stopNow(): void {
    const server = this.server
    this.server = null
    if (!server) return
    try {
      server.close()
    } catch {
      // ya estaba cerrado
    }
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.stopNow()
    if (!server) return
    await new Promise<void>((resolve) => (server.listening ? server.once("close", () => resolve()) : resolve()))
  }
}
