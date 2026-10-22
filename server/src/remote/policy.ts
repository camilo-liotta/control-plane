import type { FastifyInstance } from "fastify"

/**
 * Qué se puede hacer desde el listener remoto (Tailscale). Una sola tabla, con una entrada por ruta:
 * lo que no figura es `never`. Los niveles van de menos a más poder: public < read < respond < control.
 * `never` no se abre nunca desde afuera. El contrato (test/remote-policy.test.ts) falla si una ruta
 * registrada no está acá o si acá queda una entrada sin ruta.
 */
export type Tier = "never" | "public" | "read" | "respond" | "control"

/** Para comparar: una ruta pasa si su nivel es menor o igual al efectivo del dispositivo. `never` no entra en la cuenta. */
export const TIER_RANK: Record<Exclude<Tier, "never">, number> = { public: 0, read: 1, respond: 2, control: 3 }

/** "MÉTODO /patrón" -> nivel. El patrón es el de Fastify (`/api/sessions/:id/events`). */
export const POLICY: Readonly<Record<string, Tier>> = {
  // ---- public: la web estática (sin dispositivo)
  "GET /*": "public",
  // Las únicas rutas de /api/remote que se abren desde afuera: saber en qué modo se entra y canjear el enlace de pareo.
  "GET /api/remote/capabilities": "public",
  "POST /api/remote/pair": "public",

  // ---- read
  "GET /api/snapshot": "read",
  "GET /ws": "read",
  "GET /api/sessions/:id/events": "read",
  "GET /api/sessions/:id/reports": "read",
  "GET /api/sessions/:id/changes": "read",
  "GET /api/sessions/:id/attachments": "read",
  "GET /api/sessions/:id/commands": "read",
  "GET /api/attachments/:id": "read",
  "GET /api/projects/:id/messages": "read",
  "GET /api/projects/:id/scheduled": "read",
  "GET /api/projects/:id/overview": "read",
  "GET /api/projects/:id/archived": "read",
  "GET /api/projects/:id/afk-log": "read",
  "GET /api/projects/archived": "read",

  // ---- respond
  "POST /api/sessions/:id/messages": "respond",
  "POST /api/sessions/:id/answer": "respond",
  "POST /api/sessions/:id/permission": "respond",
  "POST /api/sessions/:id/interrupt": "respond",
  "POST /api/sessions/:id/scheduled/:itemId/cancel": "respond",
  "POST /api/drafts/:id/send": "respond",
  "PATCH /api/drafts/:id": "respond",
  "POST /api/drafts/:id/discard": "respond",
  "POST /api/drafts/:id/plan/pause": "respond",
  "POST /api/drafts/:id/plan/cancel": "respond",
  "DELETE /api/projects/:id/afk": "respond",
  // Cerrar la sesión de este dispositivo (solo existe en el listener remoto).
  "POST /api/remote/logout": "respond",

  // ---- control
  "POST /api/sessions/:id/start": "control",
  "POST /api/sessions/:id/stop": "control",
  "POST /api/projects/:id/afk": "control",
  "POST /api/drafts/:id/plan/resume": "control",

  // ---- never: todo lo demás, a propósito y una por una
  "GET /api/accounts": "never",
  "POST /api/accounts": "never",
  "DELETE /api/accounts/:id": "never",
  "PATCH /api/accounts/:id": "never",
  "POST /api/accounts/:id/engram/install": "never",
  "GET /api/accounts/:id/marketplaces": "never",
  "POST /api/accounts/:id/marketplaces": "never",
  "POST /api/accounts/:id/mcp": "never",
  "DELETE /api/accounts/:id/mcp/:name": "never",
  "POST /api/accounts/:id/mcp/:name/login": "never",
  "POST /api/accounts/:id/plugins/action": "never",
  "GET /api/accounts/:id/plugins/catalog": "never",
  "GET /api/accounts/:id/settings": "never",
  "PATCH /api/accounts/:id/settings": "never",
  "GET /api/accounts/:id/skill-market": "never",
  "POST /api/accounts/:id/skill-market/install": "never",
  "GET /api/accounts/:id/skill-market/preview": "never",
  "POST /api/accounts/:id/skill-market/sources": "never",
  "DELETE /api/accounts/:id/skill-market/sources/:sid": "never",
  "POST /api/accounts/:id/skill-market/sources/:sid/update": "never",
  "POST /api/accounts/:id/skills": "never",
  "DELETE /api/accounts/:id/skills/:name": "never",
  "GET /api/accounts/:id/skills/:name": "never",
  "PUT /api/accounts/:id/skills/:name": "never",
  "POST /api/accounts/:id/skills/:name/ai-edit": "never",
  "POST /api/accounts/:id/skills/:name/state": "never",
  "POST /api/accounts/:id/skills/ai-draft": "never",
  "POST /api/accounts/:id/skills/ai-search": "never",
  "GET /api/accounts/:id/tools": "never",
  "GET /api/accounts/detect": "never",
  "DELETE /api/apps/:id": "never",
  "PATCH /api/apps/:id": "never",
  "GET /api/apps/:id/log": "never",
  "POST /api/apps/:id/restart": "never",
  "POST /api/apps/:id/start": "never",
  "POST /api/apps/:id/stop": "never",
  "GET /api/clis": "never",
  "POST /api/clis/:id/install": "never",
  "POST /api/clis/:id/login": "never",
  "GET /api/clis/jobs/:id": "never",
  "POST /api/clis/jobs/:id/cancel": "never",
  "POST /api/clis/jobs/:id/input": "never",
  "DELETE /api/credentials/:id": "never",
  "PATCH /api/credentials/:id": "never",
  "GET /api/credentials/:id/secret": "never",
  "POST /api/desktop/shutdown": "never",
  "GET /api/editor": "never",
  "PUT /api/editor": "never",
  "DELETE /api/environments/:id": "never",
  "PATCH /api/environments/:id": "never",
  "POST /api/environments/:id/credentials": "never",
  "GET /api/fs/suggest": "never",
  "GET /api/health": "never",
  "POST /api/projects": "never",
  "DELETE /api/projects/:id": "never",
  "PATCH /api/projects/:id": "never",
  "GET /api/projects/:id/apps": "never",
  "POST /api/projects/:id/apps": "never",
  "POST /api/projects/:id/apps/start-all": "never",
  "POST /api/projects/:id/apps/stop-all": "never",
  "GET /api/projects/:id/apps/suggestions": "never",
  "POST /api/projects/:id/delete": "never",
  "POST /api/projects/:id/environments": "never",
  "POST /api/projects/:id/import": "never",
  "GET /api/projects/:id/importable": "never",
  "POST /api/projects/:id/mcp/:name/toggle": "never",
  "POST /api/projects/:id/open-in-editor": "never",
  "POST /api/projects/:id/open-path": "never",
  "POST /api/projects/:id/release": "never",
  "POST /api/projects/:id/resolve-paths": "never",
  "POST /api/projects/:id/restore": "never",
  "POST /api/projects/:id/review-now": "never",
  "POST /api/projects/:id/sessions": "never",
  "POST /api/projects/:id/start-all": "never",
  "POST /api/projects/:id/stop-all": "never",
  "POST /api/projects/:id/tasks": "never",
  "GET /api/remote/status": "never",
  "POST /api/remote/enable": "never",
  "POST /api/remote/disable": "never",
  "POST /api/remote/kill": "never",
  "GET /api/remote/config": "never",
  "PATCH /api/remote/config": "never",
  "POST /api/remote/pairings": "never",
  "GET /api/remote/devices": "never",
  "DELETE /api/remote/devices/:id": "never",
  "PATCH /api/remote/devices/:id": "never",
  "POST /api/remote/devices/revoke-all": "never",
  "GET /api/remote/audit": "never",
  "POST /api/reports/:id/dismiss": "never",
  "POST /api/restart/cancel": "never",
  "POST /api/restart/prepare": "never",
  "GET /api/restart/preview": "never",
  "DELETE /api/sessions/:id": "never",
  "PATCH /api/sessions/:id": "never",
  "POST /api/sessions/:id/attachments": "never",
  "DELETE /api/sessions/:id/compaction": "never",
  "POST /api/sessions/:id/compaction/apply": "never",
  "POST /api/sessions/:id/compaction/direct": "never",
  "POST /api/sessions/:id/compaction/draft": "never",
  "POST /api/sessions/:id/compaction/resend": "never",
  "POST /api/sessions/:id/context": "never",
  "POST /api/sessions/:id/mcp/:name/reconnect": "never",
  "POST /api/sessions/:id/open-file": "never",
  "POST /api/sessions/:id/restore": "never",
  "DELETE /api/sessions/:id/terminal": "never",
  "GET /api/sessions/:id/terminal": "never",
  "POST /api/sessions/:id/terminal": "never",
  "GET /api/sessions/:id/tools": "never",
  "POST /api/sessions/:id/tools/reload": "never",
  "PATCH /api/tasks/:id": "never",
  "POST /api/tasks/:id/cli-login": "never",
  "POST /hooks/:token/compact": "never",
  "POST /hooks/:token/send-message": "never",
  "DELETE /mcp/:token": "never",
  "GET /mcp/:token": "never",
  "POST /mcp/:token": "never",
  "GET /ws/terminal": "never",
}

/** Rutas que solo existen en el listener remoto (en el principal responden 403). */
export const REMOTE_ONLY: ReadonlySet<string> = new Set<string>(["POST /api/remote/pair", "POST /api/remote/logout"])

/** El nivel de una ruta. Sin entrada, o con un método raro, es `never`. HEAD hereda de GET. */
export function tierOf(method: string, pattern: string): Tier {
  let m = method.toUpperCase()
  if (m === "HEAD") m = "GET"
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(m)) return "never"
  return Object.hasOwn(POLICY, `${m} ${pattern}`) ? POLICY[`${m} ${pattern}`]! : "never"
}

/**
 * Copia el nivel de cada ruta en `config.remote` al registrarla (la puerta lo lee del request).
 * Hay que llamarla antes de registrar las rutas. Una ruta con varios métodos tiene que tener el mismo nivel en todos.
 */
export function applyPolicy(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    const tiers = new Set(methods.map((m) => tierOf(m, route.url)))
    if (tiers.size !== 1) throw new Error(`La ruta ${route.url} tiene métodos con niveles distintos: ${methods.join(", ")}`)
    route.config = { ...(route.config as object | undefined), remote: [...tiers][0] }
  })
}
