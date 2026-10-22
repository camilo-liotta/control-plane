import { execFile } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import fastifyStatic from "@fastify/static"
import fastifyWebsocket from "@fastify/websocket"
import Fastify from "fastify"

import { Accounts } from "./accounts.ts"
import { snapshot } from "./api.ts"
import { AttachmentStore } from "./attachments.ts"
import { Compaction } from "./compaction.ts"
import { config, repoUrl, version } from "./config.ts"
import { missingClaudeMessage } from "./claude/bin.ts"
import { listLiveSessions, transcriptDir, type LiveSession } from "./claude/local.ts"
import { cleanRunRoot, runRootOf } from "./claude/run-files.ts"
import { Db, type SessionRecord } from "./db.ts"
import { desktopSummary } from "./desktop.ts"
import { Apps } from "./apps.ts"
import { Editor } from "./editor.ts"
import { localOnly } from "./http.ts"
import { acquireLock, LockError } from "./lock.ts"
import { Restart, resumeSummary } from "./restart.ts"
import { sessionChoice } from "./shared/models.ts"
import type { ExternalSession, Meta } from "./shared/types.ts"
import { Hub } from "./hub.ts"
import { Terminals } from "./terminal/manager.ts"
import { Afk } from "./afk.ts"
import { Orchestration } from "./orchestration.ts"
import { orchestratorProtocol, workerProtocol } from "./prompts.ts"
import { SessionManager } from "./sessions.ts"
import { Overview } from "./overview.ts"
import { CliUsage } from "./cli-usage.ts"
import { Clis } from "./clis.ts"
import { UserTasks } from "./user-tasks.ts"
import { Environments } from "./environments.ts"
import { SkillMarket } from "./skill-market.ts"
import { Tools } from "./tools.ts"
import { registerRemoteHeaders } from "./remote/gate.ts"
import { applyPolicy } from "./remote/policy.ts"
import { createRemote } from "./remote/setup.ts"
import { registerRoutes } from "./routes.ts"
import { defaultRunner, locateTailscale, Tailscale } from "./tailscale.ts"

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
    console.error(missingClaudeMessage(config.claudeBin))
    process.exit(1)
  }

  // Antes de abrir la base: dos servers sobre la misma carpeta de datos la pisarían.
  const startedAt = Date.now()
  const lock = await acquireLock(config.home, { pid: process.pid, port: config.port, startedAt })
  process.on("exit", () => lock.release())

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
      ...sessionChoice(project.settings, s),
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
  // Los archivos con los tokens de cada lanzamiento (0600, ver claude/run-files.ts): ninguna sesión corre
  // todavía, así que lo que haya quedado de antes (un corte, un proceso que no pudo limpiar) sobra.
  const runRoot = runRootOf(config.home)
  cleanRunRoot(runRoot)
  const asExternal = (l: LiveSession): ExternalSession => ({ pid: l.pid ?? null, kind: l.kind === "background" ? "background" : "interactive", id: l.id ?? null })

  const sessions = new SessionManager({
    db,
    hub,
    attachments,
    mcpUrlFor: (token) => `${baseUrl}/mcp/${token}`,
    hookUrlFor: (token) => `${baseUrl}/hooks/${token}`,
    runRoot,
    launchFor,
    accountIdFor: (s) => accounts.forProject(s.projectId).id,
    liveElsewhere: async (s) => {
      liveCache.delete(accounts.forProject(s.projectId).id)
      const live = (await liveFor(accounts.forProject(s.projectId).id)).find((l) => l.sessionId === s.claudeSessionId)
      return live ? asExternal(live) : null
    },
    meta: {
      version,
      repoUrl,
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
  const afk = new Afk({ db, hub, sessions, orchestration })
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
  const tasks = new UserTasks({ db, hub, sessions, clis })
  // Los entornos toman la URL de su app levantada; si la app se borra, quedan con la suya.
  const apps: Apps = new Apps({ db, hub, home: config.home, onRemove: (a) => environments.appRemoved(a.projectId) })
  const appView = (id: string) => {
    const a = db.getApp(id)
    return a ? apps.view(a) : null
  }
  const environments = new Environments({ db, hub, sessions, app: appView })
  const deps = { db, hub, sessions, orchestration, afk, attachments, accounts, compaction, tools, overview: new Overview(db), skillMarket, clis, tasks, environments, editor: new Editor({ home: config.home }), apps }
  // `remote` se crea más abajo: se lee recién al armar cada resumen.
  hub.setSummary(() => desktopSummary({ ...deps, remote: () => remote.control.active }))

  // El listener remoto (solo mientras el acceso remoto está activo) reusa el handler de este Fastify.
  let requestHandler: http.RequestListener | null = null
  const app = Fastify({
    logger: false,
    // Los adjuntos viajan en base64 dentro del JSON: el límite cubre archivos de hasta 30 MB.
    bodyLimit: 45 * 1024 * 1024,
    serverFactory: (handler) => {
      requestHandler = handler as http.RequestListener
      return http.createServer(handler as http.RequestListener)
    },
  })
  const tailscale = new Tailscale({ run: defaultRunner, locate: () => locateTailscale(), mainPort: config.port })
  const remote = createRemote({
    app,
    handler: () => requestHandler!,
    db,
    hub,
    tailscale,
    mainPort: config.port,
    localPort: config.remotePort,
    snapshot: () => snapshot(deps),
    pendingPermission: (sid, rid) => sessions.pendingPermission(sid, rid),
  })

  // Lo que entra por el listener remoto pasa por la puerta de remote/gate.ts; el resto, por el chequeo local de siempre.
  localOnly(app, config.port, config.devOrigins, { isRemote: remote.isRemote, gate: remote.gate })
  registerRemoteHeaders(app, remote.isRemote)
  // Antes de registrar las rutas: cada una lleva su nivel de acceso remoto en config.remote.
  applyPolicy(app)

  await app.register(fastifyWebsocket)
  const terminals = new Terminals({ sessionAlive: (id) => !!db.getSession(id) && !db.getSession(id)!.archivedAt })
  const restart = new Restart({ home: config.home, version, sessions, hub, apps })
  // Cada ruta del server, en un solo lugar (routes.ts): así se pueden enumerar y clasificar (remote/policy.ts).
  registerRoutes(app, {
    ...deps,
    isRemote: remote.isRemote,
    health: { version, port: config.port, startedAt, launchId: config.launchId },
    resuming: () => restart.resuming,
    restart,
    shutdownToken: config.shutdownToken,
    onShutdown: () => void shutdown("desktop"),
    terminals,
    port: config.port,
    devOrigins: config.devOrigins,
    production: config.production,
    hello: () => ({ type: "hello", snapshot: snapshot(deps) }),
    remote: remote.routes,
    ws: remote.ws,
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

  // El apagado va antes de escuchar: la ruta de escritorio y las señales lo comparten.
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`\n${signal}: cerrando sesiones…`)
    // Si la app pidió reiniciar para actualizar, anota qué sesiones retomar antes de cerrarlas.
    const saved = restart.onShutdown()
    if (saved) console.log(`Guardé ${saved.sessions.length} sesiones${saved.apps?.length ? ` y ${saved.apps.length} apps` : ""} para retomar al volver.`)
    // Las apps levantadas desde el dashboard se bajan ordenadas (su comando de bajar, o SIGTERM y SIGKILL).
    await apps.shutdown().catch(() => {})
    orchestration.dispose()
    afk.dispose()
    compaction.dispose()
    clis.dispose()
    tasks.dispose()
    hub.dispose()
    // El acceso remoto primero: nadie entra mientras se cierra lo demás (y `enabled` queda guardado para el próximo arranque).
    await remote.control.shutdown().catch(() => {})
    await terminals.closeAll().catch(() => {})
    await sessions.shutdown().catch(() => {})
    await app.close().catch(() => {})
    db.close()
    lock.release()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  // Ctrl+Break es lo más parecido a SIGTERM que hay en Windows.
  if (process.platform === "win32") process.on("SIGBREAK", () => void shutdown("SIGBREAK"))

  await app.listen({ host: config.host, port: config.port })
  // Si el acceso remoto quedó prendido, se retoma ahora (un problema con Tailscale no frena el arranque).
  void remote.control.reconcile()
  const ui = config.production || fs.existsSync(config.webDist) ? baseUrl : "http://localhost:4701"
  console.log(`control-plane ${version} · Claude Code ${cliVersion}`)
  console.log(`Dashboard: ${config.production ? baseUrl : ui}`)
  console.log(`Datos: ${config.home}`)
  // Las que un /clear de antes de 0.4.3 dejó apuntando a una conversación que no existe.
  for (const r of sessions.repairConversations()) console.log(`Recuperé la conversación de ${r.name}: ${r.from} → ${r.to}.`)
  // Las sesiones que estaban vivas antes de reiniciar para actualizar.
  void restart
    .resumePending()
    .then((outcome) => {
      const line = resumeSummary(outcome)
      if (line) console.log(line)
    })
    // Después de retomar las sesiones: los planes que se cortaron entre un paso y el siguiente siguen.
    .finally(() => orchestration.plans.recover())
}

main().catch((err) => {
  console.error(err instanceof LockError ? err.message : err)
  process.exit(1)
})
