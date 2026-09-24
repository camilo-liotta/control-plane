import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import { version } from "./config.ts"
import type { Db, SessionRecord } from "./db.ts"
import type { Orchestration } from "./orchestration.ts"
import type { SessionManager } from "./sessions.ts"
import type { SessionStatus } from "./shared/types.ts"
import { errorMessage } from "./util.ts"

const STATUS_ES: Record<SessionStatus, string> = {
  stopped: "detenida",
  starting: "iniciando",
  idle: "esperando",
  working: "trabajando",
  needs_input: "esperando al usuario",
  error: "con error",
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const fail = (err: unknown): ToolResult => ({ content: [{ type: "text", text: errorMessage(err) }], isError: true })

function wrap<A>(fn: (args: A) => string | Promise<string>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args))
    } catch (err) {
      return fail(err)
    }
  }
}

/** Herramientas de control-plane que ve cada sesión según su rol. */
function buildServer(
  self: SessionRecord,
  deps: { db: Db; sessions: SessionManager; orchestration: Orchestration }
): McpServer {
  const { db, sessions, orchestration } = deps
  const server = new McpServer({ name: "control-plane", version })

  server.registerTool(
    "list_sessions",
    {
      title: "Sesiones del proyecto",
      description:
        "Lista las sesiones del proyecto con su rol, estado actual, tarea asignada y último resultado reportado. Sirve para saber quién está haciendo qué antes de coordinar.",
      annotations: { readOnlyHint: true },
    },
    wrap(() => {
      const list = db.listSessions().filter((s) => s.projectId === self.projectId)
      return list
        .map((s) => {
          const last = db.listReports({ sessionId: s.id, limit: 1 })[0]
          const parts = [
            `${s.name}${s.id === self.id ? " (vos)" : ""} · ${s.kind === "orchestrator" ? "orquestadora" : "worker"}`,
            s.role ? `rol: ${s.role}` : null,
            `estado: ${STATUS_ES[sessions.statusOf(s.id)]}`,
            s.taskTitle ? `tarea: ${s.taskTitle}` : null,
            s.worktree ? "worktree propio" : null,
            last ? `último resultado: ${last.status} — ${last.summary.split("\n")[0]}` : null,
          ].filter(Boolean)
          return "- " + parts.join(" | ")
        })
        .join("\n")
    })
  )

  if (self.kind === "worker") {
    server.registerTool(
      "report_result",
      {
        title: "Reportar resultado",
        description:
          "Entrega el resultado final de tu tarea a la orquestadora (entra a su cola de revisión). Llamala una vez al terminar, o si quedaste bloqueado y necesitás una decisión. No la uses para reportar avances intermedios.",
        inputSchema: {
          status: z
            .enum(["done", "blocked", "partial"])
            .describe("done: terminaste; blocked: necesitás una decisión o algo externo; partial: avanzaste pero quedó algo pendiente."),
          summary: z.string().min(1).describe("De 2 a 5 líneas: qué hiciste y cómo quedó."),
          details: z
            .string()
            .optional()
            .describe("Lo que otras sesiones necesitan saber: archivos tocados, cambios de interfaces/schemas, decisiones, pendientes, cómo probar."),
        },
      },
      wrap((args: { status: "done" | "blocked" | "partial"; summary: string; details?: string }) => {
        const fresh = db.getSession(self.id) ?? self
        return orchestration.report(fresh, args)
      })
    )
  }

  if (self.kind === "orchestrator") {
    server.registerTool(
      "propose_prompt",
      {
        title: "Proponer prompt",
        description:
          "Propone un prompt para una sesión worker existente. Queda en preparación mientras revisás y después lo aprueba el usuario (o se envía solo si el proyecto tiene auto-envío).",
        inputSchema: {
          session: z.string().describe("Nombre de la sesión destino, tal como aparece en list_sessions."),
          title: z.string().describe("Título corto de la tarea (se muestra en el dashboard)."),
          prompt: z.string().min(1).describe("Prompt completo y autocontenido para la sesión."),
        },
      },
      wrap((args: { session: string; title: string; prompt: string }) => orchestration.proposePrompt(self, args))
    )

    server.registerTool(
      "propose_session",
      {
        title: "Proponer sesión nueva",
        description:
          "Propone crear una sesión worker nueva con su primer prompt. Solo se crea si el usuario la aprueba.",
        inputSchema: {
          name: z.string().describe("Nombre corto en mayúsculas, sin espacios (ej. BACKEND, TESTS-E2E)."),
          role: z.string().describe("Rol o responsabilidad de la sesión."),
          title: z.string().describe("Título corto de la primera tarea."),
          prompt: z.string().min(1).describe("Primer prompt, completo y autocontenido."),
        },
      },
      wrap((args: { name: string; role: string; title: string; prompt: string }) => orchestration.proposeSession(self, args))
    )

    server.registerTool(
      "update_proposal",
      {
        title: "Actualizar propuesta",
        description: "Modifica una propuesta que todavía no se envió (título, prompt o sesión destino).",
        inputSchema: {
          id: z.string().describe("Id de la propuesta (ej. d_ab12cd)."),
          title: z.string().optional(),
          prompt: z.string().optional(),
          session: z.string().optional().describe("Nueva sesión destino."),
        },
      },
      wrap((args: { id: string; title?: string; prompt?: string; session?: string }) => orchestration.updateProposal(self, args))
    )

    server.registerTool(
      "discard_proposal",
      {
        title: "Descartar propuesta",
        description: "Descarta una propuesta que ya no tiene sentido (por ejemplo, porque un resultado nuevo la dejó desactualizada).",
        inputSchema: {
          id: z.string(),
          reason: z.string().optional(),
        },
      },
      wrap((args: { id: string; reason?: string }) => orchestration.discardProposal(self, args))
    )

    server.registerTool(
      "list_proposals",
      {
        title: "Propuestas abiertas",
        description: "Lista tus propuestas que siguen sin enviar, con su estado y el prompt completo.",
        annotations: { readOnlyHint: true },
      },
      wrap(() => orchestration.listProposals(self.projectId))
    )

    server.registerTool(
      "read_results",
      {
        title: "Leer la cola de resultados",
        description:
          "Trae los resultados de los workers que llegaron a la cola y todavía no leíste. Usala si te avisan que hay resultados nuevos mientras estás revisando.",
      },
      wrap(() => orchestration.readResults(db.getSession(self.id) ?? self))
    )
  }

  return server
}

function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value))
  }
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url}`
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE"
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body ?? null) : undefined,
  })
}

export function registerMcp(
  app: FastifyInstance,
  deps: { db: Db; sessions: SessionManager; orchestration: Orchestration }
) {
  const handler = async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const self = deps.db.getSessionByToken(req.params.token)
    if (!self || self.archivedAt) return reply.code(404).send({ error: "sesión desconocida" })
    const server = buildServer(self, deps)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    try {
      await server.connect(transport)
      const res = await transport.handleRequest(toWebRequest(req))
      reply.code(res.status)
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "content-length") reply.header(key, value)
      })
      const body = await res.text()
      return reply.send(body)
    } finally {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    }
  }
  app.route({ method: ["GET", "POST", "DELETE"], url: "/mcp/:token", handler })
}
