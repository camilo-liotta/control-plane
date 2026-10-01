import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import type { Apps } from "./apps.ts"
import { version } from "./config.ts"
import type { Clis } from "./clis.ts"
import type { UserTasks } from "./user-tasks.ts"
import type { Environments } from "./environments.ts"
import type { Db, SessionRecord } from "./db.ts"
import type { Orchestration } from "./orchestration.ts"
import type { SessionManager } from "./sessions.ts"
import type { AppInput, AppStatus, AppView, ContextUsage, SessionStatus } from "./shared/types.ts"
import { errorMessage } from "./util.ts"

const STATUS_ES: Record<SessionStatus, string> = {
  stopped: "detenida",
  starting: "iniciando",
  idle: "esperando",
  working: "trabajando",
  needs_input: "esperando al usuario",
  error: "con error",
}


const subagentSchema = z
  .array(
    z.object({
      name: z.string().describe("Nombre corto del subagente, en minúsculas y con guiones (ej. revisor-sql)."),
      role: z.string().describe("Quién es y en qué se especializa."),
      task: z.string().describe("Qué tiene que hacer, concreto."),
      rules: z.array(z.string()).optional().describe("Cláusulas o restricciones que tiene que respetar."),
      model: z.enum(["haiku", "sonnet", "opus", "fable"]).optional().describe("Modelo del subagente (si no, usa el del worker)."),
      background: z.boolean().optional().describe("true: corre en paralelo mientras el worker sigue con otra cosa."),
      readOnly: z.boolean().optional().describe("true: solo lee y analiza, no edita archivos."),
    })
  )
  .optional()
  .describe("Subagentes específicos que el worker tiene que lanzar para esta tarea.")

const freshSchema = z
  .boolean()
  .optional()
  .describe(
    "true: la sesión empieza de cero (/clear) antes de este prompt. Para una tarea que no necesita lo que la sesión trae en contexto, con lo anterior cerrado. El prompt tiene que ser autocontenido."
  )

const taskCliSchema = z
  .object({
    id: z.string().min(1).describe("El id del CLI en el catálogo, tal como lo da list_clis (gh, gcloud, aws, vercel…)."),
    credential: z.number().int().min(0).optional().describe("Qué credencial, si el CLI tiene más de una (gcloud: 0 tu usuario, 1 las credenciales de aplicación). Por defecto, 0."),
  })
  .optional()
  .describe("Si la tarea es loguearse o reautenticarse en un CLI del catálogo: cuál. La tarea muestra el botón para hacerlo ahí mismo y, si sale bien, se cierra sola y te aviso.")

const prioritySchema = z
  .number()
  .int()
  .min(1)
  .max(999)
  .optional()
  .describe("En qué orden hacerla, sobre todo si hay varias: 1 = primero, 2 = después, y así. Número menor = va primero. Sin prioridad va después de las que tienen.")

const tagsSchema = z
  .array(z.string().min(1).max(32))
  .max(4)
  .optional()
  .describe("Etiquetas cortas, en minúsculas y con guiones (ej. postmark-dominios). Solo para relacionar dos o más tareas que van juntas; no etiquetes una tarea sola ni para clasificar.")

/** Cuánto contexto usa una sesión, para que la orquestadora sepa si conviene empezar de cero. */
function contextLine(ctx: ContextUsage | null): string | null {
  if (!ctx || !ctx.max) return null
  return `contexto: ${Math.round((ctx.tokens / ctx.max) * 100)}% (${Math.round(ctx.tokens / 1000)}k de ${Math.round(ctx.max / 1000)}k tokens)`
}

const APP_STATUS_ES: Record<AppStatus, string> = {
  stopped: "detenida",
  starting: "arrancando",
  up: "levantada",
  unresponsive: "sin responder (el proceso vive pero la salud no contesta)",
  crashed: "se cayó",
  external: "levantada afuera del dashboard (no la toca)",
}

/** Una app en una línea (y, si se cayó, las últimas líneas de su log). */
function appLine(a: AppView): string {
  const st = a.state
  const health = a.health ? (a.health.kind === "http" ? `salud ${a.health.url}` : `puerto ${a.health.port}`) : "sin salud"
  const crash =
    st.status === "crashed"
      ? ` (${st.error ?? (st.exitCode !== null ? `código ${st.exitCode}` : st.signal ?? "")})${st.tail.length ? `\n    últimas líneas:\n${st.tail.slice(-8).map((l) => `    | ${l}`).join("\n")}` : ""}`
      : ""
  return `- ${a.name} [${a.id}] · ${APP_STATUS_ES[st.status]}${crash} · \`${a.command}\`${a.shell ? " (shell)" : ""} en ${a.cwd || "."} · ${health}${a.url ? ` · ${a.url}` : ""}`
}

const healthSchema = z
  .union([
    z.object({ kind: z.literal("http"), url: z.string().describe("URL que responde cuando la app está levantada (ej. http://127.0.0.1:3000/health).") }),
    z.object({ kind: z.literal("tcp"), port: z.number().int().describe("Puerto que acepta conexiones cuando está levantada."), host: z.string().optional() }),
  ])
  .nullable()
  .optional()
  .describe("Cómo saber que está levantada: una URL (http) o un puerto (tcp). Sin esto, cuenta como levantada si el proceso sigue vivo.")

const appFields = {
  command: z.string().describe("El comando, por ejemplo `npm run dev` o `uvicorn app:main --port 8000`. Corre sin shell: para && o pipes, poné shell: true."),
  shell: z.boolean().optional().describe("true: el comando corre en /bin/sh -c (para &&, pipes o redirecciones)."),
  cwd: z.string().optional().describe("Carpeta donde corre, relativa a la del proyecto (\"\" o sin poner: la raíz). Puede ser un subrepo o un worktree del proyecto."),
  env: z.record(z.string(), z.string()).optional().describe("Variables de entorno extra."),
  health: healthSchema,
  url: z.string().nullable().optional().describe("La URL para abrir en el navegador, si no es la de salud."),
  stopCommand: z.string().nullable().optional().describe("Cómo bajarla si no alcanza con terminar el proceso (ej. `docker compose down`)."),
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
  deps: { db: Db; sessions: SessionManager; orchestration: Orchestration; clis?: Clis; tasks?: UserTasks; environments?: Environments; apps?: Apps }
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
            contextLine(sessions.contextOf(s.id)),
            s.worktree ? "worktree propio" : null,
            last ? `último resultado: ${last.status} — ${last.summary.split("\n")[0]}` : null,
          ].filter(Boolean)
          return "- " + parts.join(" | ")
        })
        .join("\n")
    })
  )

  if (deps.tasks) {
    const tasks = deps.tasks
    server.registerTool(
      "create_user_task",
      {
        title: "Crear una tarea para el usuario",
        description:
          "Deja en el tablero del proyecto algo que necesitás que haga el usuario y no podés hacer vos (loguearse en un CLI o una web, aprobar o configurar algo en otro sistema, conseguir un dato). Mejor que pedírselo en el chat: ahí se pierde. Si ya hay una abierta para lo mismo, se suma a esa. Si es loguearse en un CLI, mirá su id con list_clis y pasalo en `cli`: la tarea trae el botón para loguearlo y se cierra sola cuando sale bien.",
        inputSchema: {
          title: z.string().min(1).describe("Qué hay que hacer, en pocas palabras (ej. \"Reautenticar gcloud\")."),
          steps: z.array(z.string().min(1)).min(1).max(12).describe("Pasos cortos y en orden: qué abrir, qué comando correr (entre `backticks`: el dashboard lo lleva a su terminal con un clic), qué elegir. Si el comando tiene un valor que pone el usuario, marcalo con {{NOMBRE: qué es}} o {{NOMBRE: qué es = sugerido}}, sin comillas alrededor. Sin explicaciones largas."),
          why: z.string().optional().describe("Para qué hace falta, en una línea."),
          blocking: z.boolean().optional().describe("true si estás frenado esperando esto. Cuando el usuario la marque hecha, te llega un aviso."),
          due: z.string().optional().describe("Para cuándo, si tiene fecha (ISO 8601, ej. 2026-09-30T23:40:00Z)."),
          cli: taskCliSchema,
          priority: prioritySchema,
          tags: tagsSchema,
        },
      },
      wrap((args: { title: string; steps: string[]; why?: string; blocking?: boolean; due?: string; cli?: { id: string; credential?: number }; priority?: number; tags?: string[] }) => {
        const due = args.due ? Date.parse(args.due) : null
        if (args.due && (due === null || Number.isNaN(due))) throw new Error("La fecha no se entiende: usá ISO 8601 (2026-09-30T23:40:00Z)")
        const { task, existing } = tasks.create(self.projectId, { ...args, due }, self)
        return existing
          ? `Ya había una tarea abierta para eso: ${task.id} "${task.title}". Sumé tu pedido; no hace falta crear otra.`
          : `Tarea ${task.id} creada en el tablero del proyecto.${task.cli ? ` Tiene el botón para loguear ${task.cli.id}: si el login sale bien, se cierra sola y te aviso.` : ""} ${task.blocking ? "Cuando el usuario la marque hecha te llega un aviso." : "Seguí con lo que no dependa de esto."}`
      })
    )
    server.registerTool(
      "list_user_tasks",
      {
        title: "Tareas para el usuario",
        description: "Las tareas para el usuario del proyecto: las abiertas (con sus pasos) y las cerradas hace poco. Miralas antes de crear una, o para ver si algo que pediste ya está hecho.",
        annotations: { readOnlyHint: true },
      },
      wrap(() => tasks.summary(self.projectId))
    )
    server.registerTool(
      "update_user_task",
      {
        title: "Actualizar una tarea para el usuario",
        description:
          "Cerrá una tarea si ves que ya está hecha (por ejemplo, el login ya anda) o que dejó de hacer falta, con una nota que diga cómo te diste cuenta. También sirve para corregir sus pasos, marcar que te está frenando, cambiar su prioridad (1 = primero) o sus etiquetas.",
        inputSchema: {
          id: z.string().describe("Id de la tarea (ej. t_ab12cd)."),
          status: z.enum(["done", "dismissed", "open"]).optional().describe("done: ya está hecha; dismissed: ya no hace falta; open: volverla a abrir."),
          note: z.string().optional().describe("Por qué la cerrás o qué cambió, en una línea."),
          steps: z.array(z.string().min(1)).max(12).optional(),
          blocking: z.boolean().optional(),
          cli: taskCliSchema.nullable(),
          priority: prioritySchema.nullable().describe("En qué orden hacerla: 1 = primero, 2 = después… null la deja sin prioridad."),
          tags: tagsSchema.describe("Reemplaza las etiquetas de la tarea ([] las saca). Solo para relacionar dos o más tareas que van juntas; no etiquetes una tarea sola ni para clasificar."),
        },
      },
      wrap((args: {
        id: string
        status?: "done" | "dismissed" | "open"
        note?: string
        steps?: string[]
        blocking?: boolean
        cli?: { id: string; credential?: number } | null
        priority?: number | null
        tags?: string[]
      }) => {
        const t = tasks.update(args.id, args, self)
        return `Tarea ${t.id} ${t.status === "open" ? "actualizada" : t.status === "done" ? "cerrada como hecha" : "descartada"}.`
      })
    )
  }

  if (deps.clis) {
    const clis = deps.clis
    server.registerTool(
      "list_clis",
      {
        title: "CLIs de la máquina",
        description:
          "Qué CLIs del catálogo están instalados (gh, gcloud, aws, wrangler, vercel, psql…), su versión y si están logueados o con la sesión vencida. Consultalo antes de depender de uno, o si uno te falla por credenciales.",
        annotations: { readOnlyHint: true },
      },
      wrap(() => clis.summary())
    )
  }

  if (deps.environments) {
    const envs = deps.environments
    const testOnly =
      "Solo para entornos locales o de staging con credenciales de prueba que creaste vos o que existen para probar: nunca de producción ni personales."
    const credentialFields = {
      username: z.string().optional().describe("Usuario, email o id con que se entra."),
      secret: z.string().optional().describe("Contraseña o token. Se guarda en el dashboard (el usuario lo ve si lo pide); no lo repitas en el chat."),
      loginUrl: z.string().optional().describe("URL de login, si no es la del entorno."),
      notes: z.string().optional().describe("Qué permisos tiene, con qué datos viene, en una línea."),
    }
    server.registerTool(
      "set_environment",
      {
        title: "Crear o actualizar un entorno",
        description: `Deja en el dashboard un entorno del proyecto ("Local", "Staging") con su URL. Si ya hay uno con ese nombre, lo actualiza (no se duplica). Con app, lo conecta a una app levantable del proyecto (ver list_apps): su URL pasa a ser la de la app y en el dashboard se ve si está levantada. ${testOnly}`,
        inputSchema: {
          name: z.string().min(1).describe('Nombre del entorno (ej. "Local", "Staging"). Sin distinguir mayúsculas.'),
          url: z.string().optional().describe("URL donde se abre (ej. http://localhost:3000). Si está conectado a una app, queda como respaldo."),
          app: z.string().optional().describe('Id o nombre de una app del proyecto (list_apps) que le da la URL. "" lo desconecta.'),
          notes: z.string().optional().describe("Cómo se levanta o algo que haga falta saber, en una línea."),
        },
      },
      wrap((args: { name: string; url?: string; app?: string; notes?: string }) => {
        const { environment, created } = envs.setEnvironment(self.projectId, args, self)
        const app = environment.appId ? deps.db.getApp(environment.appId) : null
        return `Entorno "${environment.name}" ${created ? "creado" : "actualizado"} [${environment.id}]${app ? `, conectado a la app "${app.name}"` : ""}.`
      })
    )
    server.registerTool(
      "add_credential",
      {
        title: "Dejar una credencial de prueba",
        description: `Guarda en el dashboard una credencial de prueba de un entorno (un usuario que creaste, un admin, un inquilino), para que el usuario la vea y la copie sin buscarla en el chat. Si el entorno no existe, se crea. Si ya hay una credencial con ese nombre en el entorno, se actualiza (no se duplica). ${testOnly}`,
        inputSchema: {
          environment: z.string().min(1).describe('Nombre (o id) del entorno, ej. "Local".'),
          name: z.string().min(1).describe('Para qué es, ej. "Inquilino", "Usuario admin".'),
          ...credentialFields,
        },
      },
      wrap((args: { environment: string; name: string; username?: string; secret?: string; loginUrl?: string; notes?: string }) => {
        const { environment, ...input } = args
        const res = envs.addCredential(self.projectId, environment, input, self)
        return `Credencial "${res.credential.name}" ${res.created ? "guardada" : "actualizada"} en "${res.environment.name}" [${res.credential.id}]. Ya se ve en el dashboard: no hace falta repetirla en el chat.`
      })
    )
    server.registerTool(
      "update_credential",
      {
        title: "Actualizar una credencial",
        description: `Cambia una credencial guardada (por ejemplo, si reseteaste la contraseña). Indicá el id, o el entorno y el nombre. Solo cambia los campos que pases; un secreto vacío lo borra. ${testOnly}`,
        inputSchema: {
          id: z.string().optional().describe("Id de la credencial (ej. k_ab12cd)."),
          environment: z.string().optional().describe("Entorno, si no pasás el id."),
          name: z.string().optional().describe("Nombre actual de la credencial, si no pasás el id."),
          newName: z.string().optional().describe("Nombre nuevo, si cambia."),
          ...credentialFields,
        },
      },
      wrap((args: { id?: string; environment?: string; name?: string; newName?: string; username?: string; secret?: string; loginUrl?: string; notes?: string }) => {
        const { id, environment, name, newName, ...patch } = args
        const c = envs.updateCredential(self.projectId, { id, environment, name }, { ...patch, ...(newName ? { name: newName } : {}) }, self)
        return `Credencial "${c.name}" actualizada [${c.id}].`
      })
    )
    server.registerTool(
      "remove_credential",
      {
        title: "Borrar una credencial",
        description: "Borra una credencial que ya no sirve (el usuario de prueba se borró, el entorno se bajó). Indicá el id, o el entorno y el nombre.",
        inputSchema: {
          id: z.string().optional(),
          environment: z.string().optional(),
          name: z.string().optional(),
        },
      },
      wrap((args: { id?: string; environment?: string; name?: string }) => {
        const r = envs.removeCredential(self.projectId, args, self)
        return `Borré la credencial "${r.name}" de "${r.environment}".`
      })
    )
    server.registerTool(
      "list_environments",
      {
        title: "Entornos y credenciales del proyecto",
        description:
          "Los entornos del proyecto (locales o de staging) con su URL y sus credenciales de prueba, con usuario y secreto para que puedas usarlas. Miralo antes de crear un usuario de prueba nuevo: puede que ya haya uno.",
        annotations: { readOnlyHint: true },
      },
      wrap(() => envs.summary(self.projectId))
    )
  }

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
          subagents: subagentSchema,
          fresh: freshSchema,
        },
      },
      wrap((args: { session: string; title: string; prompt: string; subagents?: unknown; fresh?: boolean }) =>
        orchestration.proposePrompt(self, args)
      )
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
          subagents: subagentSchema,
        },
      },
      wrap((args: { name: string; role: string; title: string; prompt: string; subagents?: unknown }) =>
        orchestration.proposeSession(self, args)
      )
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
          fresh: freshSchema,
          subagents: subagentSchema,
        },
      },
      wrap((args: { id: string; title?: string; prompt?: string; session?: string; subagents?: unknown; fresh?: boolean }) =>
        orchestration.updateProposal(self, args)
      )
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

  if (deps.apps) {
    const apps = deps.apps
    server.registerTool(
      "list_apps",
      {
        title: "Apps del proyecto",
        description: "Las apps del proyecto que se levantan localmente (backend, frontend, workers): su comando, carpeta, salud, URL y si están levantadas.",
        annotations: { readOnlyHint: true },
      },
      wrap(() => {
        const list = apps.list(self.projectId)
        return list.length ? list.map(appLine).join("\n") : "El proyecto no tiene apps registradas. Si armaste algo que se levanta localmente, registralo con register_app."
      })
    )
    server.registerTool(
      "register_app",
      {
        title: "Registrar una app que se levanta localmente",
        description:
          "Registra una app del proyecto que se levanta localmente (un backend, un frontend, un worker) para que el usuario la levante y la baje con un botón y vea si está arriba. Registrala cuando armes algo así, con su salud (URL o puerto) para que se sepa cuándo está levantada.",
        inputSchema: { name: z.string().describe("Nombre corto (ej. backend, web, worker)."), ...appFields },
      },
      wrap(async (args: AppInput & { name: string; command: string }) => {
        const a = await apps.create(self.projectId, args, self.id)
        return `App ${a.name} registrada (${a.id}). Para levantarla: start_app.`
      })
    )
    server.registerTool(
      "update_app",
      {
        title: "Cambiar una app",
        description: "Cambia la definición de una app (vale desde el próximo levantar si ya está corriendo).",
        inputSchema: {
          app: z.string().describe("Nombre o id de la app."),
          name: z.string().optional(),
          ...appFields,
          command: appFields.command.optional(),
        },
      },
      wrap(async ({ app, ...args }: AppInput & { app: string }) => {
        const a = await apps.update(apps.find(self.projectId, app).id, args)
        return `App ${a.name} actualizada.`
      })
    )
    server.registerTool(
      "remove_app",
      {
        title: "Quitar una app",
        description: "Quita una app del proyecto (si el dashboard la tenía levantada, primero la baja).",
        inputSchema: { app: z.string().describe("Nombre o id de la app.") },
      },
      wrap(async ({ app }: { app: string }) => {
        const a = apps.find(self.projectId, app)
        await apps.remove(a.id)
        return `App ${a.name} quitada.`
      })
    )
    server.registerTool(
      "start_app",
      {
        title: "Levantar una app",
        description: "Levanta una app del proyecto (por ejemplo, el backend antes de probar algo) y espera a que su salud responda, hasta 60 segundos.",
        inputSchema: { app: z.string().describe("Nombre o id de la app.") },
      },
      wrap(async ({ app }: { app: string }) => {
        const a = apps.find(self.projectId, app)
        await apps.start(a.id)
        for (let i = 0; i < 120; i++) {
          const st = apps.view(apps.find(self.projectId, a.id)).state.status
          if (st !== "starting") break
          await new Promise((r) => setTimeout(r, 500))
        }
        return appLine(apps.view(apps.find(self.projectId, a.id)))
      })
    )
    server.registerTool(
      "stop_app",
      {
        title: "Bajar una app",
        description: "Baja una app que levantó el dashboard (con su comando de bajar, o terminando el proceso). Las levantadas afuera del dashboard no se tocan.",
        inputSchema: { app: z.string().describe("Nombre o id de la app.") },
      },
      wrap(async ({ app }: { app: string }) => appLine(await apps.stop(apps.find(self.projectId, app).id)))
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
  deps: { db: Db; sessions: SessionManager; orchestration: Orchestration; clis?: Clis; tasks?: UserTasks; environments?: Environments; apps?: Apps }
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
