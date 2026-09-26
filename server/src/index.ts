import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import fastifyStatic from "@fastify/static"
import fastifyWebsocket from "@fastify/websocket"
import Fastify from "fastify"

import { Accounts } from "./accounts.ts"
import { registerApi, snapshot } from "./api.ts"
import { AttachmentStore } from "./attachments.ts"
import { Compaction } from "./compaction.ts"
import { config, version } from "./config.ts"
import { listLiveSessions, transcriptDir, type LiveSession } from "./claude/local.ts"
import { Db, type SessionRecord } from "./db.ts"
import type { ExternalSession, Meta } from "./shared/types.ts"
import { Hub } from "./hub.ts"
import { registerMcp } from "./mcp.ts"
import { Orchestration } from "./orchestration.ts"
import { orchestratorProtocol, workerProtocol } from "./prompts.ts"
import { SessionManager } from "./sessions.ts"
import { Overview } from "./overview.ts"
import { CliUsage } from "./cli-usage.ts"
import { Clis } from "./clis.ts"
import { UserTasks } from "./user-tasks.ts"
import { SkillMarket } from "./skill-market.ts"
import { Tools } from "./tools.ts"

async function claudeVersion(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(config.claudeBin, ["--version"], { timeout: 15_000 })
    return stdout.trim().split(" ")[0] ?? null
  } catch {
    return null
  }
}

async function main() {
  const cliVersion = await claudeVersion()
  if (!cliVersion) {
    console.error(`No encontré el binario de Claude Code ("${config.claudeBin}"). Instalalo o definí CLAUDE_BIN.`)
    process.exit(1)
  }

  const db = new Db(path.join(config.home, "control-plane.db"))
  const hub = new Hub()
  const attachments = new AttachmentStore(db)
  const accounts = new Accounts(db)
  await accounts.ensureDefault()
  const baseUrl = `http://${config.host}:${config.port}`

  // Modelos de la última sesión que arrancó: sirven apenas levanta el server.
  const metaFile = path.join(config.home, "meta.json")
  let saved: Partial<Pick<Meta, "models">> = {}
  try {
    saved = JSON.parse(fs.readFileSync(metaFile, "utf8")) as typeof saved
  } catch {
    saved = {}
  }

  const launchFor = (s: SessionRecord) => {
    const project = db.getProject(s.projectId)
    if (!project) throw new Error("Proyecto inexistente")
    const all = db.listSessions().filter((x) => x.projectId === s.projectId)
    const orch = all.find((x) => x.kind === "orchestrator") ?? null
    const workers = all.filter((x) => x.kind === "worker")
    const account = accounts.forProject(s.projectId)
    return {
      protocol:
        s.kind === "orchestrator"
          ? orchestratorProtocol(project, s, workers)
          : workerProtocol(project, s, orch, workers.filter((w) => w.id !== s.id)),
      orchestratorCanEdit: project.settings.orchestratorCanEdit,
      model: s.model ?? project.settings.defaultModel,
      effort: s.effort ?? project.settings.defaultEffort,
      env: accounts.env(account),
      bin: accounts.bin(account),
      accountId: account.id,
    }
  }

  // Sesiones vivas de Claude Code por cuenta (terminales y segundo plano), con una caché corta.
  const liveCache = new Map<string, { at: number; list: Promise<LiveSession[]> }>()
  const liveFor = (accountId: string) => {
    const hit = liveCache.get(accountId)
    if (hit && Date.now() - hit.at < 5000) return hit.list
    const a = accounts.get(accountId) ?? accounts.defaultAccount()
    const list = listLiveSessions({ bin: accounts.bin(a), env: accounts.env(a), configDir: accounts.dir(a) })
    liveCache.set(accountId, { at: Date.now(), list })
    return list
  }
  const asExternal = (l: LiveSession): ExternalSession => ({ pid: l.pid ?? null, kind: l.kind === "background" ? "background" : "interactive", id: l.id ?? null })

  const sessions = new SessionManager({
    db,
    hub,
    attachments,
    mcpUrlFor: (token) => `${baseUrl}/mcp/${token}`,
    hookUrlFor: (token) => `${baseUrl}/hooks/${token}/compact`,
    launchFor,
    accountIdFor: (s) => accounts.forProject(s.projectId).id,
    liveElsewhere: async (s) => {
      liveCache.delete(accounts.forProject(s.projectId).id)
      const live = (await liveFor(accounts.forProject(s.projectId).id)).find((l) => l.sessionId === s.claudeSessionId)
      return live ? asExternal(live) : null
    },
    meta: {
      version,
      claudeVersion: cliVersion,
      models: Array.isArray(saved.models) ? saved.models : [],
      account: null,
      homeDir: os.homedir(),
    },
  })

  // Comandos por cuenta, guardados para autocompletar aunque no haya sesiones corriendo.
  const commandsFile = path.join(config.home, "commands.json")
  let savedCommands: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(fs.readFileSync(commandsFile, "utf8")) as unknown
    // Formato viejo (una lista sola): es de la cuenta por defecto.
    savedCommands = Array.isArray(raw) ? { [accounts.defaultAccount().id]: raw } : ((raw as Record<string, unknown>) ?? {})
    sessions.seedCommands(savedCommands as Record<string, never[]>)
  } catch {
    // primera vez: se completa cuando arranque una sesión
  }
  sessions.on("commands", (accountId, list) => {
    savedCommands = { ...savedCommands, [accountId]: list }
    try {
      fs.writeFileSync(commandsFile, JSON.stringify(savedCommands))
    } catch {
      // no es grave
    }
  })
  sessions.on("meta", (meta) => {
    try {
      fs.writeFileSync(metaFile, JSON.stringify({ models: meta.models }, null, 2))
    } catch {
      // no es grave: se vuelve a completar con la próxima sesión
    }
  })
  sessions.on("account_info", (accountId, info) => {
    accounts.rememberAuth(accountId, info)
    const a = accounts.get(accountId)
    if (a) hub.broadcast({ type: "account", account: accounts.view(a, sessions.usageFor(a.id)) })
  })
  // El login de cada cuenta se consulta en segundo plano al arrancar.
  for (const a of accounts.list()) {
    void accounts.authStatus(a).then(() => hub.broadcast({ type: "account", account: accounts.view(a, sessions.usageFor(a.id)) }))
  }

  // Cada tanto se mira qué conversaciones del dashboard están abiertas en una terminal, para avisarlo.
  const refreshExternal = async () => {
    const candidates = db.listSessions().filter((s) => !s.archivedAt && s.startedOnce && !sessions.isRunning(s.id))
    const found = new Map<string, ExternalSession>()
    const byAccount = new Map<string, SessionRecord[]>()
    for (const s of candidates) {
      const id = accounts.forProject(s.projectId).id
      byAccount.set(id, [...(byAccount.get(id) ?? []), s])
    }
    for (const [accountId, list] of byAccount) {
      const live = await liveFor(accountId).catch(() => [] as LiveSession[])
      for (const s of list) {
        const hit = live.find((l) => l.sessionId === s.claudeSessionId)
        if (hit) found.set(s.id, asExternal(hit))
      }
    }
    sessions.setExternal(found)
  }
  void refreshExternal()
  const externalTimer = setInterval(() => void refreshExternal().catch(() => {}), 45_000)
  externalTimer.unref()

  const orchestration = new Orchestration(db, hub, sessions, accounts)
  const compaction = new Compaction({
    db,
    hub,
    sessions,
    launchFor: (s) => {
      const l = launchFor(s)
      return { bin: l.bin, env: l.env, model: sessions.view(s).currentModel ?? l.model }
    },
  })
  const tools = new Tools({ db, sessions, accounts, home: config.home })
  const skillMarket = new SkillMarket({ db, accounts, tools, home: config.home })
  // Qué usan tus sesiones: los transcripts de todas las cuentas (también las de la terminal).
  const usage = new CliUsage({
    dirs: () => {
      const names = new Map(db.listProjects().map((p) => [path.basename(transcriptDir(p.repoPath)), p.name]))
      return accounts.list().flatMap((a) => {
        const root = path.join(accounts.dir(a), "projects")
        let dirs: string[] = []
        try {
          dirs = fs.readdirSync(root)
        } catch {
          return []
        }
        return dirs.map((d) => ({ dir: path.join(root, d), label: names.get(d) ?? d.replace(/^-home-[^-]+-(projects-)?|^-Users-[^-]+-(projects-)?/, "") }))
      })
    },
  })
  const clis = new Clis({ onChange: () => hub.broadcast({ type: "clis_changed" }), usage })
  const tasks = new UserTasks({ db, hub, sessions })
  const deps = { db, hub, sessions, orchestration, attachments, accounts, compaction, tools, overview: new Overview(db), skillMarket, clis, tasks }

  // Los adjuntos viajan en base64 dentro del JSON: el límite cubre archivos de hasta 30 MB.
  const app = Fastify({ logger: false, bodyLimit: 45 * 1024 * 1024 })

  // Solo para esta máquina: rechaza otros hosts (DNS rebinding) y orígenes ajenos.
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`])
  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...config.devOrigins,
  ])
  app.addHook("onRequest", async (req, reply) => {
    if (!allowedHosts.has(String(req.headers.host ?? ""))) {
      return reply.code(403).send({ error: "host no permitido" })
    }
    const origin = req.headers.origin
    if (origin && !allowedOrigins.has(origin) && !req.url.startsWith("/mcp/")) {
      return reply.code(403).send({ error: "origen no permitido" })
    }
  })

  await app.register(fastifyWebsocket)
  app.get("/ws", { websocket: true }, (socket) => {
    hub.add(socket, { type: "hello", snapshot: snapshot(deps) })
  })

  registerApi(app, deps)
  registerMcp(app, deps)

  // Hooks de compactación de las sesiones (los llama compact-hook.mjs, desde esta máquina).
  app.post<{ Params: { token: string }; Body: Record<string, unknown> }>("/hooks/:token/compact", async (req, reply) => {
    const onClose = (cb: () => void) => reply.raw.on("close", () => !reply.raw.writableFinished && cb())
    const text = await compaction
      .hook(req.params.token, req.body && typeof req.body === "object" ? req.body : {}, onClose)
      .catch(() => "")
    return reply.type("text/plain; charset=utf-8").send(text)
  })

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/mcp")) {
        return reply.sendFile("index.html")
      }
      return reply.code(404).send({ error: "no encontrado" })
    })
  } else if (config.production) {
    console.warn("No encontré web/dist: corré `npm run build` para servir el dashboard.")
  }

  await app.listen({ host: config.host, port: config.port })
  const ui = config.production || fs.existsSync(config.webDist) ? baseUrl : "http://localhost:4701"
  console.log(`control-plane ${version} · Claude Code ${cliVersion}`)
  console.log(`Dashboard: ${config.production ? baseUrl : ui}`)
  console.log(`Datos: ${config.home}`)

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`\n${signal}: cerrando sesiones…`)
    orchestration.dispose()
    compaction.dispose()
    clis.dispose()
    tasks.dispose()
    await sessions.shutdown().catch(() => {})
    await app.close().catch(() => {})
    db.close()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
