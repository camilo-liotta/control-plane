import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { inputHash } from "./audit.ts"
import { effectiveTier, MESSAGES, remoteInfo } from "./gate.ts"
import { TIER_RANK, type Tier } from "./policy.ts"
import type { WriteLimiter } from "./rate-limit.ts"
import { checkBody, hasRule, isDangerousTool } from "./rules.ts"

export interface EnforceOptions {
  isRemote: (req: FastifyRequest) => boolean
  /** El techo global de nivel. */
  ceiling: () => Exclude<Tier, "never">
  requireLocalForDangerous: () => boolean
  /** El permiso que la CLI dejó pendiente: la herramienta sale de acá, nunca del cliente. */
  pendingPermission: (sessionId: string, requestId: string) => { toolName: string; input: Record<string, unknown> } | null
  writes: WriteLimiter
}

const refuse = (reply: FastifyReply, status: number, code: string, error: string) => reply.code(status).send({ error, code })

/**
 * Las reglas que dependen del cuerpo, después de que la puerta ya dejó pasar el pedido (ya hay dispositivo, nivel de la ruta,
 * Origin y JSON): lista cerrada de claves por ruta, el nivel que pide el cuerpo (un permiso con allow:true es control),
 * la confirmación local de las herramientas peligrosas y los topes de uso. Solo mira pedidos remotos de respond y control.
 */
export function registerRemoteEnforcement(app: FastifyInstance, o: EnforceOptions) {
  app.addHook("preHandler", async (req, reply) => {
    if (!o.isRemote(req)) return
    const info = remoteInfo(req)
    if (!info?.device) return
    const tier = (req.routeOptions?.config as { remote?: Tier } | undefined)?.remote
    if (tier !== "respond" && tier !== "control") return

    const pattern = req.routeOptions?.url ?? ""
    // Falla cerrado: una ruta de respond o control sin regla de cuerpo no se ejecuta.
    if (!hasRule(req.method, pattern)) return refuse(reply, 403, "remote_forbidden", MESSAGES.forbidden)
    const rule = checkBody(req.method, pattern, req.body)
    if (!rule.ok) return refuse(reply, 400, "remote_body", MESSAGES.body)

    const effective = effectiveTier(o.ceiling(), info.device.tier)
    if (TIER_RANK[rule.needs] > TIER_RANK[effective]) return refuse(reply, 403, "remote_tier", MESSAGES.tier)

    if (rule.permission) {
      const sessionId = (req.params as { id?: string } | undefined)?.id ?? ""
      const pending = o.pendingPermission(sessionId, rule.permission.requestId)
      if (pending) {
        info.toolName = pending.toolName
        info.inputHash = inputHash(pending.input)
      }
      if (rule.permission.allow) {
        // Sin un pedido pendiente no se aprueba nada.
        if (!pending) return refuse(reply, 400, "remote_not_pending", MESSAGES.notPending)
        if (o.requireLocalForDangerous() && isDangerousTool(pending.toolName)) return refuse(reply, 403, "remote_needs_local", MESSAGES.needsLocal)
      }
    }

    const wait = o.writes.take(info.device.id, rule.limit)
    if (wait !== null) return reply.header("retry-after", String(wait)).code(429).send({ error: MESSAGES.rateLimited, code: "remote_rate_limited" })
  })
}
