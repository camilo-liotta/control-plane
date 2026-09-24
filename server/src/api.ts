import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { FastifyInstance, FastifyReply } from "fastify"

import type { Accounts } from "./accounts.ts"
import { toRef, type AttachmentStore } from "./attachments.ts"
import { readSettings, writeSetting } from "./claude/config-settings.ts"
import type { Compaction, CompactionSelection } from "./compaction.ts"
import { listLiveSessions, listTranscripts } from "./claude/local.ts"
import { defaultSettings, type Db } from "./db.ts"
import type { Hub } from "./hub.ts"
import { importSession, type Orchestration } from "./orchestration.ts"
import type { SessionManager } from "./sessions.ts"
import type { McpInput, McpScope, PluginAction, Tools } from "./tools.ts"
import type { ClaudeSettingValue, ProjectSettings, SkillState, Snapshot } from "./shared/types.ts"
import { errorMessage, now, sanitizeSessionName, shortId, slug } from "./util.ts"

interface Deps {
  db: Db
  hub: Hub
  sessions: SessionManager
  orchestration: Orchestration
  attachments: AttachmentStore
  accounts: Accounts
  compaction: Compaction
  tools: Tools
}

/** Tipos que se pueden mostrar en el navegador sin riesgo; el resto se descarga o se ve como texto. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])
const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript|sql|csv))/

const DAY = 24 * 60 * 60 * 1000

export function snapshot({ db, sessions, orchestration, accounts, compaction }: Deps): Snapshot {
  return {
    projects: db.listProjects().map((p) => orchestration.projectView(p)),
    sessions: sessions.list(),
    drafts: db.listRecentDrafts(now() - DAY),
    reports: db.listRecentReports(now() - 2 * DAY).map((r) => orchestration.reportView(r)),
    accounts: accounts.list().map((a) => accounts.view(a, sessions.usageFor(a.id))),
    compactions: compaction.list(),
    meta: sessions.meta,
  }
}

async function guard(reply: FastifyReply, fn: () => unknown | Promise<unknown>) {
  try {
    const result = await fn()
    return reply.send(result ?? { ok: true })
  } catch (err) {
    return reply.code(400).send({ error: errorMessage(err) })
  }
}

function expandHome(p: string) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

function isGitRepo(dir: string) {
  return fs.existsSync(path.join(dir, ".git"))
}

export function registerApi(app: FastifyInstance, deps: Deps) {
  const { db, sessions, orchestration, attachments, accounts, compaction, tools } = deps

  const broadcastAccount = (id: string) => {
    const a = accounts.get(id)
    if (a) deps.hub.broadcast({ type: "account", account: accounts.view(a, sessions.usageFor(a.id)) })
  }

  const requireAccount = (id: string) => {
    const a = accounts.get(id)
    if (!a) throw new Error("La cuenta no existe")
    return a
  }

  const settingsFiles = (id: string) => {
    const a = requireAccount(id)
    return { user: accounts.settingsFile(a), global: accounts.globalConfigFile(a) }
  }

  // ---------------------------------------------------------------- accounts

  app.get<{ Querystring: { refresh?: string } }>("/api/accounts", (req, reply) =>
    guard(reply, async () => {
      const list = accounts.list()
      if (req.query.refresh) await Promise.all(list.map((a) => accounts.authStatus(a, true)))
      return list.map((a) => accounts.view(a, sessions.usageFor(a.id)))
    })
  )

  app.get("/api/accounts/detect", (_req, reply) =>
    guard(reply, async () => {
      const found = accounts.detect()
      // Para cada directorio encontrado, con qué cuenta está logueado.
      return Promise.all(
        found.map(async (f) => {
          const probe = { id: `probe:${f.configDir}`, name: f.name, configDir: f.configDir, bin: null, createdAt: 0 }
          return { ...f, auth: await accounts.authStatus(probe, true) }
        })
      )
    })
  )

  app.post<{ Body: { name: string; configDir: string; bin?: string | null } }>("/api/accounts", (req, reply) =>
    guard(reply, async () => {
      const rec = accounts.create(req.body)
      await accounts.authStatus(rec, true)
      broadcastAccount(rec.id)
      return accounts.view(rec, null)
    })
  )

  app.patch<{ Params: { id: string }; Body: { name?: string; bin?: string | null } }>("/api/accounts/:id", (req, reply) =>
    guard(reply, async () => {
      const a = requireAccount(req.params.id)
      accounts.update(a.id, req.body ?? {})
      if (req.body?.bin !== undefined) await accounts.authStatus(accounts.get(a.id)!, true)
      broadcastAccount(a.id)
      return accounts.view(accounts.get(a.id)!, sessions.usageFor(a.id))
    })
  )

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", (req, reply) =>
    guard(reply, () => {
      accounts.remove(req.params.id)
      deps.hub.broadcast({ type: "account_removed", id: req.params.id })
    })
  )

  // Opciones del /config de Claude Code para una cuenta.
  app.get<{ Params: { id: string } }>("/api/accounts/:id/settings", (req, reply) =>
    guard(reply, () => {
      const files = settingsFiles(req.params.id)
      return { files, items: readSettings(files, sessions.meta.models) }
    })
  )

  app.patch<{ Params: { id: string }; Body: { key: string; value: ClaudeSettingValue } }>(
    "/api/accounts/:id/settings",
    (req, reply) => guard(reply, () => writeSetting(settingsFiles(req.params.id), req.body.key, req.body.value, sessions.meta.models))
  )

  const requireSession = (id: string) => {
    const s = db.getSession(id)
    if (!s || s.archivedAt) throw new Error("La sesión no existe")
    return s
  }

  const requireProject = (id: string) => {
    const p = db.getProject(id)
    if (!p || p.archivedAt) throw new Error("El proyecto no existe")
    return p
  }

  app.get("/api/snapshot", async () => snapshot(deps))

  // Autocompletado de carpetas para elegir el repo.
  app.get<{ Querystring: { path?: string } }>("/api/fs/suggest", async (req) => {
    const raw = expandHome(req.query.path?.trim() || "~/")
    const resolved = path.resolve(raw)
    const exists = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    const dir = exists ? resolved : path.dirname(resolved)
    const prefix = exists ? "" : path.basename(resolved).toLowerCase()
    let dirs: string[] = []
    try {
      dirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name.toLowerCase().startsWith(prefix))
        .map((d) => path.join(dir, d.name))
        .sort()
        .slice(0, 30)
    } catch {
      dirs = []
    }
    return {
      path: resolved,
      exists,
      isGitRepo: exists && isGitRepo(resolved),
      dirs: dirs.map((d) => ({ path: d, isGitRepo: isGitRepo(d) })),
      home: os.homedir(),
    }
  })

  // ---------------------------------------------------------------- projects

  app.post<{
    Body: { name?: string; repoPath: string; orchestratorName?: string; accountId?: string; settings?: Partial<ProjectSettings> }
  }>(
    "/api/projects",
    (req, reply) =>
      guard(reply, async () => {
        const repoPath = path.resolve(expandHome(req.body.repoPath?.trim() ?? ""))
        if (!repoPath || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory())
          throw new Error("La carpeta del repo no existe")
        const name = req.body.name?.trim() || path.basename(repoPath)
        const account = req.body.accountId ? requireAccount(req.body.accountId) : accounts.defaultAccount()
        const project = {
          id: shortId("p_"),
          name,
          repoPath,
          settings: { ...defaultSettings, ...(req.body.settings ?? {}) },
          accountId: account.id,
          createdAt: now(),
          archivedAt: null,
        }
        db.insertProject(project)
        const taken = new Set(db.listSessions().map((s) => s.name.toLowerCase()))
        let orchName = sanitizeSessionName(req.body.orchestratorName ?? "").toUpperCase() || `ORQ-${slug(name)}`
        for (let i = 2; taken.has(orchName.toLowerCase()); i++) orchName = `ORQ-${slug(name)}-${i}`
        const orch = sessions.create({
          projectId: project.id,
          kind: "orchestrator",
          name: orchName,
          role: "Orquestadora",
          cwd: repoPath,
        })
        void sessions.start(orch.id).catch(() => {})
        const view = orchestration.projectView(project)
        deps.hub.broadcast({ type: "project", project: view })
        broadcastAccount(account.id)
        return view
      })
  )

  app.patch<{ Params: { id: string }; Body: { name?: string; settings?: Partial<ProjectSettings> } }>(
    "/api/projects/:id",
    (req, reply) =>
      guard(reply, () => {
        const p = requireProject(req.params.id)
        const settings = req.body.settings ? { ...p.settings, ...req.body.settings } : undefined
        if (settings) {
          settings.batchWindowSec = Math.min(600, Math.max(0, Number(settings.batchWindowSec) || 0))
          if (!["auto", "notify", "ask"].includes(settings.compactMode)) settings.compactMode = defaultSettings.compactMode
          settings.compactWaitMin = Math.min(45, Math.max(1, Math.round(Number(settings.compactWaitMin) || defaultSettings.compactWaitMin)))
        }
        db.updateProject(p.id, { name: req.body.name?.trim() || undefined, settings })
        const view = orchestration.projectView(db.getProject(p.id)!)
        deps.hub.broadcast({ type: "project", project: view })
        orchestration.schedule(p.id)
        return view
      })
  )

  app.delete<{ Params: { id: string } }>("/api/projects/:id", (req, reply) =>
    guard(reply, async () => {
      const p = requireProject(req.params.id)
      for (const s of db.listSessions().filter((s) => s.projectId === p.id)) await sessions.archive(s.id)
      db.updateProject(p.id, { archivedAt: now() })
      const view = orchestration.projectView(db.getProject(p.id)!)
      deps.hub.broadcast({ type: "project", project: view })
      return view
    })
  )

  app.post<{
    Params: { id: string }
    Body: { name: string; role?: string; prompt?: string; model?: string | null; effort?: string | null; worktree?: boolean }
  }>("/api/projects/:id/sessions", (req, reply) =>
    guard(reply, async () => {
      const p = requireProject(req.params.id)
      const rec = await orchestration.createWorker(p.id, {
        name: req.body.name,
        role: req.body.role ?? "",
        prompt: req.body.prompt,
        model: req.body.model,
        effort: req.body.effort,
        worktree: req.body.worktree,
      })
      return sessions.view(db.getSession(rec.id)!)
    })
  )

  // Conversaciones de Claude Code en la carpeta del repo que se pueden traer al dashboard.
  app.get<{ Params: { id: string } }>("/api/projects/:id/importable", (req, reply) =>
    guard(reply, async () => {
      const p = requireProject(req.params.id)
      const target = orchestration.targetFor(p.id)
      const live = await listLiveSessions(target)
      const ours = new Set(db.listSessions().map((s) => s.claudeSessionId))
      return listTranscripts(p.repoPath, target?.configDir).map((t) => {
        const running = live.find((l) => l.sessionId === t.sessionId)
        return {
          ...t,
          name: running?.name ?? t.name,
          running: running ? { kind: running.kind, pid: running.pid ?? null, id: running.id ?? null } : null,
          imported: ours.has(t.sessionId),
        }
      })
    })
  )

  app.post<{ Params: { id: string }; Body: { claudeSessionId: string; name: string; role?: string } }>(
    "/api/projects/:id/import",
    (req, reply) =>
      guard(reply, async () => {
        const p = requireProject(req.params.id)
        const rec = await importSession(db, sessions, orchestration, p.id, {
          claudeSessionId: req.body.claudeSessionId,
          name: req.body.name,
          role: req.body.role ?? "",
        })
        return sessions.view(db.getSession(rec.id)!)
      })
  )

  app.get<{ Params: { id: string } }>("/api/projects/:id/archived", (req, reply) =>
    guard(reply, () => db.listArchivedSessions(requireProject(req.params.id).id).map((s) => sessions.view(s)))
  )

  app.post<{ Params: { id: string } }>("/api/projects/:id/review-now", (req, reply) =>
    guard(reply, () => orchestration.reviewNow(requireProject(req.params.id).id))
  )

  app.post<{ Params: { id: string } }>("/api/projects/:id/release", (req, reply) =>
    guard(reply, () => orchestration.forceRelease(requireProject(req.params.id).id))
  )

  app.post<{ Params: { id: string } }>("/api/projects/:id/start-all", (req, reply) =>
    guard(reply, async () => {
      const p = requireProject(req.params.id)
      const list = db.listSessions().filter((s) => s.projectId === p.id)
      await Promise.allSettled(list.map((s) => sessions.start(s.id)))
    })
  )

  app.post<{ Params: { id: string } }>("/api/projects/:id/stop-all", (req, reply) =>
    guard(reply, async () => {
      const p = requireProject(req.params.id)
      const list = db.listSessions().filter((s) => s.projectId === p.id)
      await Promise.allSettled(list.map((s) => sessions.stop(s.id)))
    })
  )

  // ---------------------------------------------------------------- sessions

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/sessions/:id/events",
    (req, reply) =>
      guard(reply, () => {
        requireSession(req.params.id)
        return db.listEvents(req.params.id, {
          before: req.query.before ? Number(req.query.before) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        })
      })
  )

  app.get<{ Params: { id: string } }>("/api/sessions/:id/reports", (req, reply) =>
    guard(reply, () => {
      requireSession(req.params.id)
      return db.listReports({ sessionId: req.params.id, limit: 50 }).map((r) => orchestration.reportView(r))
    })
  )

  app.post<{ Params: { id: string }; Body: { text: string; attachmentIds?: string[] } }>("/api/sessions/:id/messages", (req, reply) =>
    guard(reply, async () => {
      const s = requireSession(req.params.id)
      const text = req.body.text?.trim() ?? ""
      const files = (req.body.attachmentIds ?? []).map((aid) => {
        const a = attachments.get(aid)
        if (!a || a.sessionId !== s.id) throw new Error("Un adjunto ya no existe: volvé a subirlo")
        return a
      })
      if (!text && !files.length) throw new Error("El mensaje está vacío")
      // Si la sesión no tenía tarea, tu primer mensaje directo pasa a ser su tarea.
      if (s.kind === "worker" && s.taskState === "none" && text)
        sessions.update(s.id, { taskTitle: text.split("\n")[0]!.slice(0, 80), taskState: "assigned" })
      return sessions.send(s.id, text, { origin: "user", attachments: files })
    })
  )

  app.post<{ Params: { id: string }; Body: { name: string; mime?: string; data: string } }>(
    "/api/sessions/:id/attachments",
    (req, reply) =>
      guard(reply, () => {
        const s = requireSession(req.params.id)
        if (!req.body?.data) throw new Error("El archivo está vacío")
        const rec = attachments.save(s.id, {
          name: req.body.name || "archivo",
          mime: req.body.mime || "application/octet-stream",
          data: Buffer.from(req.body.data, "base64"),
          source: "user",
        })
        return { ...toRef(rec), source: rec.source, createdAt: rec.createdAt, sessionId: rec.sessionId }
      })
  )

  app.get<{ Params: { id: string } }>("/api/sessions/:id/attachments", (req, reply) =>
    guard(reply, () => {
      requireSession(req.params.id)
      return db.listAttachments(req.params.id).map(({ path: _p, ...a }) => a)
    })
  )

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/attachments/:id", async (req, reply) => {
    const a = attachments.get(req.params.id)
    if (!a || !fs.existsSync(a.path)) return reply.code(404).send({ error: "El adjunto no existe" })
    const inline = !req.query.download && (INLINE_TYPES.has(a.mime) || TEXT_TYPES.test(a.mime))
    const type = INLINE_TYPES.has(a.mime) ? a.mime : TEXT_TYPES.test(a.mime) ? "text/plain; charset=utf-8" : a.mime
    reply
      .header("content-type", type)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox")
      .header("cache-control", "private, max-age=31536000, immutable")
      .header(
        "content-disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`
      )
    return reply.send(fs.createReadStream(a.path))
  })

  app.get<{ Params: { id: string } }>("/api/sessions/:id/commands", (req, reply) =>
    guard(reply, () => sessions.commandsFor(requireSession(req.params.id).id))
  )

  app.post<{ Params: { id: string } }>("/api/sessions/:id/start", (req, reply) =>
    guard(reply, () => sessions.start(requireSession(req.params.id).id))
  )

  app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", (req, reply) =>
    guard(reply, () => sessions.stop(requireSession(req.params.id).id))
  )

  app.post<{ Params: { id: string } }>("/api/sessions/:id/interrupt", (req, reply) =>
    guard(reply, () => sessions.interrupt(requireSession(req.params.id).id))
  )

  // ------------------------------------------------------------ herramientas

  type AccountParams = { Params: { id: string } }
  const pid = (v: unknown) => (typeof v === "string" && v ? v : null)

  app.get<AccountParams & { Querystring: { projectId?: string; refresh?: string } }>("/api/accounts/:id/tools", (req, reply) =>
    guard(reply, () => tools.view(requireAccount(req.params.id).id, pid(req.query.projectId), req.query.refresh === "1"))
  )

  app.get<{ Params: { id: string } }>("/api/sessions/:id/tools", (req, reply) =>
    guard(reply, () => tools.sessionView(requireSession(req.params.id).id))
  )

  app.post<{ Params: { id: string } }>("/api/sessions/:id/tools/reload", (req, reply) =>
    guard(reply, async () => {
      const id = requireSession(req.params.id).id
      await sessions.control(id, "reload_plugins", {}, 60_000)
      await sessions.control(id, "reload_skills", {}, 60_000).catch(() => null)
      return tools.sessionView(id)
    })
  )

  app.get<AccountParams & { Querystring: { refresh?: string } }>("/api/accounts/:id/plugins/catalog", (req, reply) =>
    guard(reply, () => tools.catalog(requireAccount(req.params.id).id, req.query.refresh === "1"))
  )

  app.post<AccountParams & { Body: { id: string; action: PluginAction; projectId?: string; scope?: string; acceptCommand?: string } }>(
    "/api/accounts/:id/plugins/action",
    (req, reply) =>
      guard(reply, () => {
        const b = req.body
        if (!["enable", "disable", "install", "uninstall", "update"].includes(b.action)) throw new Error("Acción inválida")
        return tools.pluginAction(requireAccount(req.params.id).id, pid(b.projectId), String(b.id ?? ""), b.action, {
          scope: b.scope,
          acceptCommand: b.acceptCommand,
        })
      })
  )

  app.get<AccountParams>("/api/accounts/:id/marketplaces", (req, reply) =>
    guard(reply, () => tools.marketplaces(requireAccount(req.params.id).id))
  )

  app.post<AccountParams & { Body: { action: "add" | "remove" | "update"; target?: string } }>("/api/accounts/:id/marketplaces", (req, reply) =>
    guard(reply, () => {
      if (!["add", "remove", "update"].includes(req.body.action)) throw new Error("Acción inválida")
      return tools.marketplaceAction(requireAccount(req.params.id).id, req.body.action, req.body.target)
    })
  )

  app.post<AccountParams & { Body: McpInput & { projectId?: string } }>("/api/accounts/:id/mcp", (req, reply) =>
    guard(reply, () => tools.mcpAdd(requireAccount(req.params.id).id, pid(req.body.projectId), req.body))
  )

  app.delete<{ Params: { id: string; name: string }; Querystring: { scope?: McpScope; projectId?: string } }>(
    "/api/accounts/:id/mcp/:name",
    (req, reply) =>
      guard(reply, () => tools.mcpRemove(requireAccount(req.params.id).id, pid(req.query.projectId), req.params.name, req.query.scope ?? "user"))
  )

  app.post<{ Params: { id: string; name: string } }>("/api/accounts/:id/mcp/:name/login", (req, reply) =>
    guard(reply, () => tools.mcpLogin(requireAccount(req.params.id).id, req.params.name))
  )

  app.post<{ Params: { id: string; name: string }; Body: { enabled: boolean } }>("/api/projects/:id/mcp/:name/toggle", (req, reply) =>
    guard(reply, () => {
      const p = requireProject(req.params.id)
      return tools.mcpToggle(accounts.forProject(p.id).id, p.id, req.params.name, Boolean(req.body.enabled))
    })
  )

  app.post<{ Params: { id: string; name: string } }>("/api/sessions/:id/mcp/:name/reconnect", (req, reply) =>
    guard(reply, () => tools.mcpReconnect(requireSession(req.params.id).id, req.params.name))
  )

  app.get<{ Params: { id: string; name: string }; Querystring: { projectId?: string } }>("/api/accounts/:id/skills/:name", (req, reply) =>
    guard(reply, () => tools.readSkill(requireAccount(req.params.id).id, pid(req.query.projectId), req.params.name))
  )

  app.put<{ Params: { id: string; name: string }; Body: { projectId?: string; content: string } }>("/api/accounts/:id/skills/:name", (req, reply) =>
    guard(reply, () => tools.saveSkill(requireAccount(req.params.id).id, pid(req.body.projectId), req.params.name, String(req.body.content ?? "")))
  )

  app.post<AccountParams & { Body: { projectId?: string; scope: "user" | "project"; name: string; description: string; body?: string } }>(
    "/api/accounts/:id/skills",
    (req, reply) =>
      guard(reply, () =>
        tools.createSkill(requireAccount(req.params.id).id, pid(req.body.projectId), {
          scope: req.body.scope === "project" ? "project" : "user",
          name: String(req.body.name ?? ""),
          description: String(req.body.description ?? ""),
          body: String(req.body.body ?? ""),
        })
      )
  )

  app.delete<{ Params: { id: string; name: string }; Querystring: { projectId?: string } }>("/api/accounts/:id/skills/:name", (req, reply) =>
    guard(reply, () => tools.deleteSkill(requireAccount(req.params.id).id, pid(req.query.projectId), req.params.name))
  )

  app.post<{ Params: { id: string; name: string }; Body: { projectId?: string; state: SkillState; scope: "user" | "local" } }>(
    "/api/accounts/:id/skills/:name/state",
    (req, reply) =>
      guard(reply, () =>
        tools.setSkillState(requireAccount(req.params.id).id, pid(req.body.projectId), req.params.name, req.body.state, req.body.scope === "local" ? "local" : "user")
      )
  )

  // ------------------------------------------------------------ compactación

  app.post<{ Params: { id: string } }>("/api/sessions/:id/compaction/draft", (req, reply) =>
    guard(reply, () => {
      // Tarda (Claude lee toda la conversación): el resultado llega por WebSocket.
      void compaction.draft(requireSession(req.params.id).id)
      return compaction.view(req.params.id)
    })
  )

  app.post<{ Params: { id: string }; Body: CompactionSelection }>("/api/sessions/:id/compaction/apply", (req, reply) =>
    guard(reply, () => {
      const body = req.body
      if (!body || !Array.isArray(body.sections)) throw new Error("Falta la selección")
      const sections = body.sections.map((s) => ({
        title: String(s?.title ?? ""),
        points: (Array.isArray(s?.points) ? s.points : []).map((p) => ({ text: String(p?.text ?? ""), keep: Boolean(p?.keep) })),
      }))
      return compaction.apply(requireSession(req.params.id).id, { sections, extra: typeof body.extra === "string" ? body.extra : undefined })
    })
  )

  app.post<{ Params: { id: string } }>("/api/sessions/:id/compaction/direct", (req, reply) =>
    guard(reply, () => compaction.direct(requireSession(req.params.id).id))
  )

  app.delete<{ Params: { id: string } }>("/api/sessions/:id/compaction", (req, reply) =>
    guard(reply, () => compaction.discard(requireSession(req.params.id).id))
  )

  app.post<{ Params: { id: string } }>("/api/sessions/:id/context", (req, reply) =>
    guard(reply, async () => {
      const id = requireSession(req.params.id).id
      await sessions.refreshContext(id)
      return sessions.contextOf(id)
    })
  )

  app.post<{ Params: { id: string }; Body: { requestId: string; answers: Record<string, string> } }>(
    "/api/sessions/:id/answer",
    (req, reply) =>
      guard(reply, () => sessions.answerQuestion(requireSession(req.params.id).id, req.body.requestId, req.body.answers ?? {}))
  )

  app.post<{ Params: { id: string }; Body: { requestId: string; allow: boolean; message?: string } }>(
    "/api/sessions/:id/permission",
    (req, reply) =>
      guard(reply, () =>
        sessions.respondPermission(requireSession(req.params.id).id, req.body.requestId, Boolean(req.body.allow), req.body.message)
      )
  )

  app.patch<{ Params: { id: string }; Body: { name?: string; role?: string; model?: string | null; effort?: string | null } }>(
    "/api/sessions/:id",
    (req, reply) =>
      guard(reply, async () => {
        const s = requireSession(req.params.id)
        if (req.body.name !== undefined) {
          const name = sanitizeSessionName(req.body.name).toUpperCase()
          if (!name) throw new Error("El nombre no es válido")
          const clash = db.listSessions().some((x) => x.id !== s.id && x.name.toLowerCase() === name.toLowerCase())
          if (clash) throw new Error(`Ya existe una sesión llamada ${name}`)
          await sessions.rename(s.id, name)
        }
        if (req.body.role !== undefined) sessions.update(s.id, { role: req.body.role.trim() })
        if (req.body.model !== undefined) await sessions.setModel(s.id, req.body.model || null)
        if (req.body.effort !== undefined) await sessions.setEffort(s.id, req.body.effort || null)
        return sessions.view(db.getSession(s.id)!)
      })
  )

  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>("/api/sessions/:id", (req, reply) =>
    guard(reply, async () => {
      if (req.query.purge) {
        // Eliminar definitivamente: solo sesiones ya archivadas.
        const s = db.getSession(req.params.id)
        if (!s) throw new Error("La sesión no existe")
        if (!s.archivedAt) throw new Error("Primero archivá la sesión")
        db.purgeSession(s.id)
        attachments.removeSession(s.id)
        deps.hub.broadcast({ type: "project", project: orchestration.projectView(db.getProject(s.projectId)!) })
        return { ok: true }
      }
      const s = requireSession(req.params.id)
      if (s.kind === "orchestrator") throw new Error("La orquestadora no se puede archivar sola: archivá el proyecto")
      await sessions.archive(s.id)
    })
  )

  app.post<{ Params: { id: string } }>("/api/sessions/:id/restore", (req, reply) =>
    guard(reply, () => {
      const s = db.getSession(req.params.id)
      if (!s) throw new Error("La sesión no existe")
      const clash = db.listSessions().some((x) => x.id !== s.id && x.name.toLowerCase() === s.name.toLowerCase())
      if (clash) throw new Error(`Ya hay otra sesión llamada ${s.name}: renombrala antes de restaurar esta`)
      sessions.update(s.id, { archivedAt: null, status: "stopped" })
      return sessions.view(db.getSession(s.id)!)
    })
  )

  // ------------------------------------------------------------------ drafts

  app.post<{ Params: { id: string }; Body: { title?: string; prompt?: string; name?: string; role?: string; subagents?: unknown } }>(
    "/api/drafts/:id/send",
    (req, reply) => guard(reply, () => orchestration.sendDraft(req.params.id, req.body ?? {}))
  )

  app.post<{ Params: { id: string } }>("/api/drafts/:id/discard", (req, reply) =>
    guard(reply, () => orchestration.discardDraft(req.params.id))
  )

  app.patch<{ Params: { id: string }; Body: { title?: string; prompt?: string; subagents?: unknown } }>("/api/drafts/:id", (req, reply) =>
    guard(reply, () => orchestration.editDraft(req.params.id, req.body ?? {}))
  )

  // ----------------------------------------------------------------- reports

  app.post<{ Params: { id: string } }>("/api/reports/:id/dismiss", (req, reply) =>
    guard(reply, () => orchestration.dismissReport(req.params.id))
  )
}
