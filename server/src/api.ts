import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { FastifyInstance, FastifyReply } from "fastify"

import { listLiveSessions, listTranscripts } from "./claude/local.ts"
import { defaultSettings, type Db } from "./db.ts"
import type { Hub } from "./hub.ts"
import { importSession, type Orchestration } from "./orchestration.ts"
import type { SessionManager } from "./sessions.ts"
import type { ProjectSettings, Snapshot } from "./shared/types.ts"
import { errorMessage, now, sanitizeSessionName, shortId, slug } from "./util.ts"

interface Deps {
  db: Db
  hub: Hub
  sessions: SessionManager
  orchestration: Orchestration
}

const DAY = 24 * 60 * 60 * 1000

export function snapshot({ db, sessions, orchestration }: Deps): Snapshot {
  return {
    projects: db.listProjects().map((p) => orchestration.projectView(p)),
    sessions: sessions.list(),
    drafts: db.listRecentDrafts(now() - DAY),
    reports: db.listRecentReports(now() - 2 * DAY).map((r) => orchestration.reportView(r)),
    usage: sessions.usage,
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
  const { db, sessions, orchestration } = deps

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

  app.post<{ Body: { name?: string; repoPath: string; orchestratorName?: string; settings?: Partial<ProjectSettings> } }>(
    "/api/projects",
    (req, reply) =>
      guard(reply, async () => {
        const repoPath = path.resolve(expandHome(req.body.repoPath?.trim() ?? ""))
        if (!repoPath || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory())
          throw new Error("La carpeta del repo no existe")
        const name = req.body.name?.trim() || path.basename(repoPath)
        const project = {
          id: shortId("p_"),
          name,
          repoPath,
          settings: { ...defaultSettings, ...(req.body.settings ?? {}) },
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
        return view
      })
  )

  app.patch<{ Params: { id: string }; Body: { name?: string; settings?: Partial<ProjectSettings> } }>(
    "/api/projects/:id",
    (req, reply) =>
      guard(reply, () => {
        const p = requireProject(req.params.id)
        const settings = req.body.settings ? { ...p.settings, ...req.body.settings } : undefined
        if (settings) settings.batchWindowSec = Math.min(600, Math.max(0, Number(settings.batchWindowSec) || 0))
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
      const live = await listLiveSessions()
      const ours = new Set(db.listSessions().map((s) => s.claudeSessionId))
      return listTranscripts(p.repoPath).map((t) => {
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

  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/sessions/:id/messages", (req, reply) =>
    guard(reply, async () => {
      const s = requireSession(req.params.id)
      const text = req.body.text?.trim()
      if (!text) throw new Error("El mensaje está vacío")
      // Si la sesión no tenía tarea, tu primer mensaje directo pasa a ser su tarea.
      if (s.kind === "worker" && s.taskState === "none")
        sessions.update(s.id, { taskTitle: text.split("\n")[0]!.slice(0, 80), taskState: "assigned" })
      return sessions.send(s.id, text, { origin: "user" })
    })
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
        const patch: Record<string, unknown> = {}
        if (req.body.role !== undefined) patch.role = req.body.role.trim()
        if (req.body.model !== undefined) patch.model = req.body.model || null
        if (req.body.effort !== undefined) patch.effort = req.body.effort || null
        if (Object.keys(patch).length) sessions.update(s.id, patch)
        return sessions.view(db.getSession(s.id)!)
      })
  )

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", (req, reply) =>
    guard(reply, async () => {
      const s = requireSession(req.params.id)
      if (s.kind === "orchestrator") throw new Error("La orquestadora no se puede archivar sola: archivá el proyecto")
      await sessions.archive(s.id)
    })
  )

  // ------------------------------------------------------------------ drafts

  app.post<{ Params: { id: string }; Body: { title?: string; prompt?: string; name?: string; role?: string } }>(
    "/api/drafts/:id/send",
    (req, reply) => guard(reply, () => orchestration.sendDraft(req.params.id, req.body ?? {}))
  )

  app.post<{ Params: { id: string } }>("/api/drafts/:id/discard", (req, reply) =>
    guard(reply, () => orchestration.discardDraft(req.params.id))
  )

  app.patch<{ Params: { id: string }; Body: { title?: string; prompt?: string } }>("/api/drafts/:id", (req, reply) =>
    guard(reply, () => orchestration.editDraft(req.params.id, req.body ?? {}))
  )

  // ----------------------------------------------------------------- reports

  app.post<{ Params: { id: string } }>("/api/reports/:id/dismiss", (req, reply) =>
    guard(reply, () => orchestration.dismissReport(req.params.id))
  )
}
