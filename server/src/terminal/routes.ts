// Las rutas de la terminal. Una terminal es ejecutar comandos en tu máquina, así que acá no hay
// excepciones: además de lo de localOnly (Host de esta máquina), se exige un Origin del propio
// dashboard (sin Origin no hay terminal: un navegador siempre lo manda) y un token que solo da el
// POST de abrirla, que ninguna página ajena puede leer.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { Db } from "../db.ts"
import type { TerminalServerMessage, Terminals } from "./manager.ts"

export interface TerminalRoutesOptions {
  db: Db
  terminals: Terminals
  port: number
  /** Los de desarrollo (vite en 4701); en producción, ninguno. */
  extraOrigins?: string[]
}

export function terminalOrigins(port: number, extra: string[] = []) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra])
}

export function registerTerminal(app: FastifyInstance, { db, terminals, port, extraOrigins = [] }: TerminalRoutesOptions) {
  const origins = terminalOrigins(port, extraOrigins)
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  const strict = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!hosts.has(String(req.headers.host ?? "")) || !origins.has(String(req.headers.origin ?? ""))) {
      return reply.code(403).send({ error: "la terminal solo se abre desde el dashboard" })
    }
  }

  const session = (id: string) => {
    const s = db.getSession(id)
    if (!s || s.archivedAt) throw new Error("La sesión no existe o está archivada")
    return s
  }

  app.post<{ Params: { id: string }; Body: { cols?: number; rows?: number } }>("/api/sessions/:id/terminal", { preValidation: strict }, async (req, reply) => {
    try {
      const s = session(req.params.id)
      // Solo JSON: desde otro origen, eso obliga al navegador a preguntar antes (CORS) y no hay
      // respuesta que lo deje pasar.
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply.code(415).send({ error: "hace falta JSON" })
      return terminals.open(s.id, s.cwd, Number(req.body?.cols) || 100, Number(req.body?.rows) || 30)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete<{ Params: { id: string } }>("/api/sessions/:id/terminal", { preValidation: strict }, async (req) => {
    await terminals.close(req.params.id)
    return { ok: true }
  })

  app.get<{ Querystring: { session?: string; token?: string } }>("/ws/terminal", { websocket: true, preValidation: strict }, (socket, req) => {
    const send = (msg: TerminalServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
    }
    const link = terminals.attach(String(req.query.session ?? ""), String(req.query.token ?? ""), { send })
    if (!link) {
      socket.close(4403, "terminal cerrada o token inválido")
      return
    }
    socket.on("message", (raw: Buffer) => {
      try {
        link.receive(JSON.parse(raw.toString("utf8")))
      } catch {
        // mensaje inválido: se ignora
      }
    })
    socket.on("close", () => link.detach())
  })
}
