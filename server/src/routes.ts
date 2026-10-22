import fs from "node:fs"
import path from "node:path"

import type { FastifyInstance } from "fastify"

import { registerApi, type Deps } from "./api.ts"
import { listLiveSessions } from "./claude/local.ts"
import { registerDesktopShutdown, registerHealth, registerWs, type WsOptions } from "./http.ts"
import { registerMcp } from "./mcp.ts"
import { registerRemoteRoutes, type RemoteRoutesDeps } from "./remote/routes.ts"
import { registerRestart, type Restart } from "./restart.ts"
import { decideSend, SEND_DENIED, type SendDecision, type SendGuardDeps } from "./send-guard.ts"
import type { ServerMessage } from "./shared/types.ts"
import { registerTerminal } from "./terminal/routes.ts"
import type { Terminals } from "./terminal/manager.ts"

export interface RoutesDeps extends Deps {
  health: { version: string; port: number; startedAt: number; launchId: string | null }
  resuming: () => boolean
  restart: Restart
  shutdownToken: string | null
  onShutdown: () => void
  terminals: Terminals
  /** El puerto principal (lo usa el chequeo de Host y Origin de la terminal). */
  port: number
  devOrigins: string[]
  hello: () => ServerMessage
  /** Producción: la terminal no acepta los orígenes de desarrollo. */
  production?: boolean
  remote: RemoteRoutesDeps
  /** Cómo reconoce /ws a los pedidos remotos (ver remote/). */
  ws?: WsOptions
}

/**
 * Todas las rutas del server, en un solo lugar, para poder enumerarlas con `onRoute`
 * (ver remote/policy.ts: cada una tiene que estar clasificada). El orden es el de siempre.
 */
export function registerRoutes(app: FastifyInstance, deps: RoutesDeps) {
  const { db, sessions, accounts, compaction } = deps

  registerWs(app, deps.hub, deps.hello, deps.ws)
  registerHealth(app, deps.health, deps.resuming)
  registerRestart(app, deps.restart)

  registerApi(app, deps)
  registerRemoteRoutes(app, deps.remote)
  registerMcp(app, deps)
  registerDesktopShutdown(app, deps.shutdownToken, deps.onShutdown)
  // La terminal de cada sesión (ver terminal/routes.ts: solo desde el dashboard, con token).
  registerTerminal(app, { db, terminals: deps.terminals, port: deps.port, extraOrigins: deps.production ? [] : deps.devOrigins })

  // Hooks de compactación de las sesiones (los llama compact-hook.mjs, desde esta máquina).
  app.post<{ Params: { token: string }; Body: Record<string, unknown> }>("/hooks/:token/compact", async (req, reply) => {
    const onClose = (cb: () => void) => reply.raw.on("close", () => !reply.raw.writableFinished && cb())
    const text = await compaction
      .hook(req.params.token, req.body && typeof req.body === "object" ? req.body : {}, onClose)
      .catch(() => "")
    return reply.type("text/plain; charset=utf-8").send(text)
  })

  // El cerrojo de SendMessage (PreToolUse): solo deja escribirle a sesiones del propio proyecto.
  // Responde 200 vacío para dejar pasar, o el JSON con el deny; ante cualquier error, deniega.
  const sendGuard: SendGuardDeps = {
    sessions: () => db.listSessions(),
    pids: () => sessions.pids(),
    agentNames: (id) => sessions.agentNames(id),
    live: async (s) => {
      const a = accounts.forProject(s.projectId)
      return listLiveSessions({ bin: accounts.bin(a), env: accounts.env(a), configDir: accounts.dir(a) }, { all: true })
    },
    socketOf: (s, pid) => {
      try {
        const file = path.join(accounts.dir(accounts.forProject(s.projectId)), "sessions", `${pid}.json`)
        const reg = JSON.parse(fs.readFileSync(file, "utf8")) as { messagingSocketPath?: unknown }
        return typeof reg.messagingSocketPath === "string" ? reg.messagingSocketPath : null
      } catch {
        return null
      }
    },
  }
  app.post<{ Params: { token: string }; Body: Record<string, unknown> }>("/hooks/:token/send-message", async (req, reply) => {
    const body = req.body && typeof req.body === "object" ? req.body : {}
    const input = body.tool_input && typeof body.tool_input === "object" ? (body.tool_input as Record<string, unknown>) : {}
    let decision: SendDecision
    try {
      decision = await decideSend(sendGuard, db.getSessionByToken(req.params.token) ?? null, input)
    } catch {
      decision = { allow: false, reason: SEND_DENIED.unresolved(String(input.to ?? "")) }
    }
    if (decision.allow) return reply.type("text/plain; charset=utf-8").send("")
    return reply.type("application/json").send({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason },
    })
  })
}
