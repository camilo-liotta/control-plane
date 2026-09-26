import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import type { Accounts } from "./accounts.ts"
import { readSettingsFile, updateSettingsFile } from "./claude/config-settings.ts"
import { childEnv } from "./claude/env.ts"
import { parseCommands } from "./claude/normalize.ts"
import { ClaudeProcess } from "./claude/process.ts"
import { lastJsonLine, parseFrontmatter, parsePluginDetails, SKILL_STATES, toMcpInfo } from "./claude/tool-parsers.ts"
import type { AccountRecord, Db, ProjectRecord, SessionRecord } from "./db.ts"
import type { SessionManager } from "./sessions.ts"
import type { CatalogPlugin, Marketplace, McpServerInfo, PluginInfo, SkillInfo, SkillState, ToolsView } from "./shared/types.ts"
import { errorMessage, now, oneLine } from "./util.ts"

const run = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type McpScope = "user" | "local" | "project"

export interface McpInput {
  name: string
  scope: McpScope
  transport: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export type PluginAction = "enable" | "disable" | "install" | "uninstall" | "update"

interface Inspection {
  mcp: McpServerInfo[]
  skills: { name: string; source: string; tokens: number }[]
  descriptions: Map<string, string>
  via: ToolsView["via"]
}

interface InstalledPlugin {
  id: string
  version?: string
  scope?: string
  enabled?: boolean
  installPath?: string
}

export interface ToolsDeps {
  db: Db
  sessions: SessionManager
  accounts: Accounts
  /** Directorio del dashboard (para la carpeta neutra de consulta y la papelera). */
  home: string
}

const VIEW_TTL = 30_000
const CATALOG_TTL = 10 * 60_000
const SOURCE_ORDER = ["user", "project", "plugin", "bundled", "managed"]

/**
 * Skills, plugins y MCP de una cuenta (y, si hay proyecto, lo que aplica en su carpeta). Lee lo
 * que Claude Code tiene cargado y cambia las cosas con sus propios mecanismos: `claude plugin`,
 * `claude mcp`, `mcp_toggle` (lo guarda el CLI por proyecto) y `skillOverrides` en los settings.
 */
export class Tools {
  private deps: ToolsDeps
  private views = new Map<string, { at: number; value: Promise<ToolsView> }>()
  private details = new Map<string, Promise<ReturnType<typeof parsePluginDetails> | null>>()
  private catalogs = new Map<string, { at: number; value: Promise<CatalogPlugin[]> }>()

  constructor(deps: ToolsDeps) {
    this.deps = deps
  }

  // ---------------------------------------------------------------- base

  private account(id: string): AccountRecord {
    const a = this.deps.accounts.get(id)
    if (!a) throw new Error("La cuenta no existe")
    return a
  }

  private project(id: string | null): ProjectRecord | null {
    if (!id) return null
    const p = this.deps.db.getProject(id)
    if (!p || p.archivedAt) throw new Error("El proyecto no existe")
    return p
  }

  /** Carpeta neutra para consultar lo de la cuenta sin que aplique la config de ningún proyecto. */
  private inspectDir(): string {
    const dir = path.join(this.deps.home, "inspect")
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  private cwdFor(project: ProjectRecord | null) {
    return project?.repoPath ?? this.inspectDir()
  }

  private async cli(account: AccountRecord, args: string[], cwd: string, timeout = 90_000) {
    try {
      return await run(this.deps.accounts.bin(account), args, {
        cwd,
        env: childEnv(this.deps.accounts.env(account)),
        timeout,
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string }
      const detail = lastJsonLine(e.stdout ?? "")?.message ?? (e.stderr || e.stdout || errorMessage(err))
      throw new Error(oneLine(String(detail).replace(/^✘\s*/, ""), 400))
    }
  }

  private invalidate(accountId: string) {
    for (const key of [...this.views.keys()]) if (key.startsWith(`${accountId}|`)) this.views.delete(key)
    this.catalogs.delete(accountId)
  }

  /** Sesiones del dashboard corriendo con esa cuenta (en esa carpeta, si se indica). */
  private liveSessions(accountId: string, cwd?: string): SessionRecord[] {
    const target = cwd ? path.resolve(cwd) : null
    return this.deps.db
      .listSessions()
      .filter(
        (s) =>
          !s.archivedAt &&
          this.deps.sessions.isRunning(s.id) &&
          this.deps.accounts.forProject(s.projectId).id === accountId &&
          (!target || path.resolve(s.cwd) === target)
      )
  }

  /** Después de un cambio, las sesiones abiertas recargan plugins o skills (sin reiniciarse). */
  private async reloadSessions(accountId: string, what: "plugins" | "skills", cwd?: string) {
    await Promise.all(
      this.liveSessions(accountId, cwd).map((s) =>
        this.deps.sessions.control(s.id, what === "plugins" ? "reload_plugins" : "reload_skills", {}, 60_000).catch(() => null)
      )
    )
  }

  // ---------------------------------------------------------------- vista

  view(accountId: string, projectId: string | null, refresh = false): Promise<ToolsView> {
    const key = `${accountId}|${projectId ?? ""}`
    const cached = this.views.get(key)
    if (cached && !refresh && now() - cached.at < VIEW_TTL) return cached.value
    const value = this.build(accountId, projectId)
    this.views.set(key, { at: now(), value })
    value.catch(() => this.views.delete(key))
    return value
  }

  /** Lo que tiene cargado una sesión en particular (su estado en vivo). */
  async sessionView(sessionId: string): Promise<ToolsView> {
    const rec = this.deps.db.getSession(sessionId)
    if (!rec) throw new Error("La sesión no existe")
    const account = this.deps.accounts.forProject(rec.projectId)
    const project = this.project(rec.projectId)
    const [insp, plugins] = await Promise.all([this.inspectSession(rec), this.plugins(account, rec.cwd)])
    return {
      accountId: account.id,
      projectId: rec.projectId,
      cwd: rec.cwd,
      mcp: insp.mcp,
      plugins,
      skills: this.skills(account, project, insp, plugins),
      via: insp.via,
      at: now(),
    }
  }

  private async build(accountId: string, projectId: string | null): Promise<ToolsView> {
    const account = this.account(accountId)
    const project = this.project(projectId)
    const cwd = this.cwdFor(project)
    const [insp, plugins] = await Promise.all([this.inspect(account, cwd), this.plugins(account, cwd)])
    return { accountId, projectId, cwd, mcp: insp.mcp, plugins, skills: this.skills(account, project, insp, plugins), via: insp.via, at: now() }
  }

  private async inspect(account: AccountRecord, cwd: string): Promise<Inspection> {
    const live = this.liveSessions(account.id, cwd)
    const pick = live.find((s) => this.deps.sessions.statusOf(s.id) === "idle") ?? live[0]
    if (pick) {
      try {
        return await this.inspectSession(pick)
      } catch {
        // si la sesión no responde, se consulta aparte
      }
    }
    return this.inspectProcess(account, cwd)
  }

  private async inspectSession(rec: SessionRecord): Promise<Inspection> {
    const [status, ctx] = await Promise.all([
      this.deps.sessions.control(rec.id, "mcp_status", {}, 20_000),
      this.deps.sessions.control(rec.id, "get_context_usage", { detail: "summary" }, 20_000).catch(() => null),
    ])
    return this.inspection(status, ctx, this.deps.sessions.commandsFor(rec.id), { kind: "session", sessionId: rec.id, name: rec.name })
  }

  /**
   * Claude Code sin conversación: carga la configuración de esa carpeta, conecta los MCP, responde
   * y se cierra. No guarda nada (--no-session-persistence) ni corre los hooks del usuario.
   */
  private async withInspector<T>(account: AccountRecord, cwd: string, fn: (proc: ClaudeProcess, init: Record<string, unknown>) => Promise<T>): Promise<T> {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--settings",
      JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
    ]
    const proc = new ClaudeProcess(this.deps.accounts.bin(account), args, cwd, childEnv(this.deps.accounts.env(account)))
    proc.start()
    try {
      return await fn(proc, await proc.request("initialize", {}, 60_000))
    } finally {
      await proc.close(1500)
    }
  }

  private inspectProcess(account: AccountRecord, cwd: string): Promise<Inspection> {
    return this.withInspector(account, cwd, async (proc, init) => {
      // Los conectores de claude.ai llegan unos segundos después de arrancar: se espera a que la
      // lista deje de crecer y nadie siga "conectando" (con un mínimo y un máximo).
      let status: Record<string, unknown> = {}
      const started = now()
      let lastCount = -1
      let stable = 0
      for (;;) {
        status = await proc.request("mcp_status", {}, 20_000)
        const list = (status.mcpServers ?? []) as { status?: string }[]
        stable = list.length === lastCount ? stable + 1 : 0
        lastCount = list.length
        const settled = stable >= 2 && !list.some((s) => s.status === "pending")
        if ((settled && now() - started > 4000) || now() - started > 15_000) break
        await sleep(1000)
      }
      const ctx = await proc.request("get_context_usage", { detail: "summary" }, 20_000).catch(() => null)
      return this.inspection(status, ctx, parseCommands(init.commands), { kind: "inspector" })
    })
  }

  private inspection(
    status: Record<string, unknown>,
    ctx: Record<string, unknown> | null,
    commands: { name: string; description: string }[],
    via: ToolsView["via"]
  ): Inspection {
    const mcp = ((status.mcpServers ?? []) as Record<string, unknown>[]).map(toMcpInfo).sort((a, b) => Number(a.internal ?? false) - Number(b.internal ?? false) || a.name.localeCompare(b.name))
    const skills = ((ctx?.skills as { skillFrontmatter?: unknown } | undefined)?.skillFrontmatter ?? []) as { name: string; source: string; tokens: number }[]
    const descriptions = new Map(commands.map((c) => [c.name, c.description.replace(/\s*\((user|project|plugin|bundled|managed)\)\s*$/i, "")]))
    return { mcp, skills: Array.isArray(skills) ? skills : [], descriptions, via }
  }

  // ---------------------------------------------------------------- plugins

  private async installed(account: AccountRecord, cwd: string): Promise<InstalledPlugin[]> {
    const { stdout } = await this.cli(account, ["plugin", "list", "--json"], cwd, 60_000)
    const list = JSON.parse(stdout) as InstalledPlugin[]
    return Array.isArray(list) ? list.filter((p) => typeof p.id === "string") : []
  }

  private async plugins(account: AccountRecord, cwd: string): Promise<PluginInfo[]> {
    let list: InstalledPlugin[] = []
    try {
      list = await this.installed(account, cwd)
    } catch {
      return []
    }
    return Promise.all(
      list.map(async (p): Promise<PluginInfo> => {
        const [name, marketplace] = p.id.split("@")
        const details = await this.pluginDetails(account, p.id, p.version ?? "")
        return {
          id: p.id,
          name: name ?? p.id,
          marketplace: marketplace ?? "",
          version: p.version ?? null,
          scope: p.scope ?? null,
          enabled: p.enabled !== false,
          description: details?.description ?? manifestDescription(p.installPath),
          components: details?.components ?? null,
          alwaysOnTokens: details?.alwaysOnTokens ?? null,
        }
      })
    ).then((out) => out.sort((a, b) => a.name.localeCompare(b.name)))
  }

  private pluginDetails(account: AccountRecord, id: string, version: string) {
    const key = `${account.id}|${id}|${version}`
    let p = this.details.get(key)
    if (!p) {
      p = this.cli(account, ["plugin", "details", id], this.inspectDir(), 60_000)
        .then(({ stdout }) => parsePluginDetails(stdout))
        .catch(() => null)
      this.details.set(key, p)
    }
    return p
  }

  catalog(accountId: string, refresh = false): Promise<CatalogPlugin[]> {
    const cached = this.catalogs.get(accountId)
    if (cached && !refresh && now() - cached.at < CATALOG_TTL) return cached.value
    const account = this.account(accountId)
    const value = this.cli(account, ["plugin", "list", "--json", "--available"], this.inspectDir(), 180_000).then(({ stdout }) => {
      const data = JSON.parse(stdout) as {
        installed?: { id?: string }[]
        available?: { pluginId?: string; name?: string; description?: string; marketplaceName?: string; installCount?: number }[]
      }
      const installed = new Set((data.installed ?? []).map((p) => p.id))
      return (data.available ?? [])
        .filter((p) => p.pluginId)
        .map((p) => ({
          id: p.pluginId!,
          name: p.name ?? p.pluginId!,
          description: p.description ?? "",
          marketplace: p.marketplaceName ?? "",
          installs: typeof p.installCount === "number" ? p.installCount : null,
          installed: installed.has(p.pluginId!),
        }))
    })
    this.catalogs.set(accountId, { at: now(), value })
    value.catch(() => this.catalogs.delete(accountId))
    return value
  }

  /**
   * Instalar, habilitar, deshabilitar, actualizar o desinstalar con `claude plugin`. Si el
   * marketplace declara un comando para instalar, primero se te muestra y lo tenés que aceptar.
   */
  async pluginAction(
    accountId: string,
    projectId: string | null,
    id: string,
    action: PluginAction,
    opts: { scope?: string; acceptCommand?: string } = {}
  ): Promise<{ ok: true; message: string } | { needsConfirm: { command: string; sha256: string } }> {
    const account = this.account(accountId)
    const project = this.project(projectId)
    if (!/^[\w.:-]+@[\w.:-]+$/.test(id)) throw new Error("Plugin inválido")
    const scope = opts.scope ?? (project ? "project" : "user")
    if (!["user", "project", "local"].includes(scope)) throw new Error("Alcance inválido")
    if ((scope === "project" || scope === "local") && !project) throw new Error("Elegí un proyecto para ese alcance")
    const cwd = scope === "user" ? this.inspectDir() : project!.repoPath
    // El CLI no valida que exista: solo se tocan plugins instalados (salvo para instalarlos).
    if (action !== "install") {
      const list = await this.installed(account, cwd)
      if (!list.some((p) => p.id === id)) throw new Error("Ese plugin no está instalado")
    }
    const args = ["plugin", action, id, "--json"]
    if (action !== "update") args.push("--scope", scope)
    if (opts.acceptCommand) {
      if (!/^[a-f0-9]{64}$/i.test(opts.acceptCommand)) throw new Error("Confirmación inválida")
      args.push("--accept-command", opts.acceptCommand)
    }
    const out = (await this.cli(account, args, cwd, 300_000)).stdout
    const result = lastJsonLine(out) ?? {}
    const shown = result.shownCommand as { sha256?: string; command?: string; display?: string; text?: string } | undefined
    if (result.outcome !== "ok" && shown?.sha256) {
      return { needsConfirm: { sha256: shown.sha256, command: String(shown.command ?? shown.display ?? shown.text ?? JSON.stringify(shown)) } }
    }
    if (result.outcome && result.outcome !== "ok") throw new Error(String(result.message ?? `No se pudo (${String(result.failureCode ?? result.outcome)})`))
    if (scope === "local" && project) excludeFromGit(project.repoPath, ".claude/settings.local.json")
    this.invalidate(account.id)
    void this.reloadSessions(account.id, "plugins", scope === "user" ? undefined : cwd)
    return { ok: true, message: String(result.message ?? "Listo") }
  }

  async marketplaces(accountId: string): Promise<Marketplace[]> {
    const account = this.account(accountId)
    const { stdout } = await this.cli(account, ["plugin", "marketplace", "list", "--json"], this.inspectDir(), 60_000)
    const list = JSON.parse(stdout) as Marketplace[]
    return Array.isArray(list) ? list : []
  }

  async marketplaceAction(accountId: string, action: "add" | "remove" | "update", target?: string) {
    const account = this.account(accountId)
    const args = ["plugin", "marketplace", action]
    if (action === "add") {
      if (!target?.trim()) throw new Error("Falta la dirección del marketplace")
      args.push(target.trim())
    } else if (target) {
      if (!/^[\w.:@/-]+$/.test(target)) throw new Error("Marketplace inválido")
      args.push(target)
    }
    await this.cli(account, args, this.inspectDir(), 300_000)
    this.invalidate(account.id)
  }

  // ---------------------------------------------------------------- MCP

  /** Activa o desactiva un servidor en un proyecto (lo guarda Claude Code en la config de ese proyecto). */
  async mcpToggle(accountId: string, projectId: string, name: string, enabled: boolean): Promise<{ warning?: string }> {
    const account = this.account(accountId)
    const project = this.project(projectId)!
    if (name === "control-plane") throw new Error("El MCP del dashboard no se puede desactivar")
    // Se guarda con un Claude Code recién abierto (ve la config actual, incluidos servidores nuevos)…
    let warning: string | undefined
    await this.withInspector(account, project.repoPath, async (proc) => {
      // Al activarlo intenta conectar: si falla o pide login, igual quedó activado.
      await proc.request("mcp_toggle", { serverName: name, enabled }, 60_000).catch((err: Error) => {
        if (!enabled) throw err
        warning = err.message
      })
    })
    // …y se aplica en vivo en las sesiones abiertas del proyecto que lo conocen.
    await Promise.all(
      this.liveSessions(account.id, project.repoPath).map((s) =>
        this.deps.sessions.control(s.id, "mcp_toggle", { serverName: name, enabled }, 60_000).catch(() => null)
      )
    )
    this.invalidate(account.id)
    return warning ? { warning: oneLine(warning, 200) } : {}
  }

  async mcpReconnect(sessionId: string, name: string) {
    await this.deps.sessions.control(sessionId, "mcp_reconnect", { serverName: name }, 60_000)
    const rec = this.deps.db.getSession(sessionId)
    if (rec) this.invalidate(this.deps.accounts.forProject(rec.projectId).id)
  }

  async mcpAdd(accountId: string, projectId: string | null, input: McpInput) {
    const account = this.account(accountId)
    const project = this.project(projectId)
    const name = input.name?.trim()
    if (!name || !/^[\w.-]{1,64}$/.test(name)) throw new Error("El nombre solo puede tener letras, números, puntos, guiones y guiones bajos")
    if (name === "control-plane") throw new Error("Ese nombre lo usa el dashboard")
    if (!["user", "local", "project"].includes(input.scope)) throw new Error("Alcance inválido")
    if (input.scope !== "user" && !project) throw new Error("Elegí un proyecto para ese alcance")
    let cfg: Record<string, unknown>
    if (input.transport === "stdio") {
      if (!input.command?.trim()) throw new Error("Falta el comando")
      cfg = { type: "stdio", command: input.command.trim(), args: (input.args ?? []).filter(Boolean), env: input.env ?? {} }
    } else if (input.transport === "http" || input.transport === "sse") {
      if (!/^https?:\/\//.test(input.url ?? "")) throw new Error("La URL tiene que empezar con http:// o https://")
      cfg = { type: input.transport, url: input.url, ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}) }
    } else {
      throw new Error("Tipo de servidor inválido")
    }
    const cwd = input.scope === "user" ? this.inspectDir() : project!.repoPath
    await this.cli(account, ["mcp", "add-json", name, JSON.stringify(cfg), "--scope", input.scope], cwd)
    this.invalidate(account.id)
  }

  async mcpRemove(accountId: string, projectId: string | null, name: string, scope: McpScope) {
    const account = this.account(accountId)
    const project = this.project(projectId)
    if (!["user", "local", "project"].includes(scope)) throw new Error("Solo se pueden quitar servidores de tu cuenta o de un proyecto")
    if (scope !== "user" && !project) throw new Error("Elegí el proyecto")
    await this.cli(account, ["mcp", "remove", name, "--scope", scope], scope === "user" ? this.inspectDir() : project!.repoPath)
    this.invalidate(account.id)
  }

  /** `claude mcp login`: abre el navegador para autorizar el servidor. Espera unos segundos por si falla enseguida. */
  mcpLogin(accountId: string, name: string): Promise<void> {
    const account = this.account(accountId)
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.deps.accounts.bin(account), ["mcp", "login", name], {
        cwd: this.inspectDir(),
        env: childEnv(this.deps.accounts.env(account)),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let out = ""
      child.stdout.on("data", (d) => (out += String(d)))
      child.stderr.on("data", (d) => (out += String(d)))
      const timer = setTimeout(() => {
        child.stdout.removeAllListeners()
        child.stderr.removeAllListeners()
        child.unref()
        resolve()
      }, 6000)
      child.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on("exit", (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(oneLine(out.trim().split("\n").slice(-2).join(" ") || `claude mcp login terminó con código ${code}`, 300)))
      })
    }).then(() => this.invalidate(account.id))
  }

  // ---------------------------------------------------------------- skills

  private skillDirs(account: AccountRecord, project: ProjectRecord | null) {
    return {
      user: path.join(this.deps.accounts.dir(account), "skills"),
      project: project ? path.join(project.repoPath, ".claude", "skills") : null,
    }
  }

  private overrideFiles(account: AccountRecord, project: ProjectRecord | null) {
    return {
      user: this.deps.accounts.settingsFile(account),
      project: project ? path.join(project.repoPath, ".claude", "settings.json") : null,
      local: project ? path.join(project.repoPath, ".claude", "settings.local.json") : null,
    }
  }

  private skills(account: AccountRecord, project: ProjectRecord | null, insp: Inspection, plugins: PluginInfo[]): SkillInfo[] {
    const files = this.overrideFiles(account, project)
    const overrides = (file: string | null) => {
      const o = file ? readSettingsFile(file).skillOverrides : undefined
      return o && typeof o === "object" ? (o as Record<string, string>) : {}
    }
    const user = overrides(files.user)
    const proj = overrides(files.project)
    const local = overrides(files.local)
    const tokens = new Map(insp.skills.map((s) => [s.name, s]))
    const out = new Map<string, SkillInfo>()

    const add = (s: Omit<SkillInfo, "state" | "stateScope" | "tokens">) => {
      const name = s.name
      const scoped: [SkillInfo["stateScope"], string | undefined][] = [
        ["local", local[name]],
        ["project", proj[name]],
        ["user", user[name]],
      ]
      const hit = scoped.find(([, v]) => v && SKILL_STATES.includes(v as SkillState))
      out.set(name, {
        ...s,
        description: s.description || insp.descriptions.get(name) || "",
        tokens: tokens.get(name)?.tokens ?? null,
        state: (hit?.[1] as SkillState) ?? "on",
        stateScope: hit?.[0] ?? null,
      })
    }

    const dirs = this.skillDirs(account, project)
    for (const s of scanSkills(dirs.user)) add({ ...s, source: "user", plugin: null, editable: true })
    if (dirs.project) for (const s of scanSkills(dirs.project)) add({ ...s, source: "project", plugin: null, editable: true })
    for (const p of plugins) {
      if (!p.enabled) continue
      for (const name of p.components?.skills ?? []) {
        const full = `${p.name}:${name}`
        if (!out.has(full)) add({ name: full, description: "", source: "plugin", plugin: p.name, path: null, editable: false })
      }
    }
    // Las que Claude Code tiene cargadas y no están en disco a la vista (incluidas en Claude Code, gestionadas).
    for (const s of insp.skills) {
      if (out.has(s.name)) continue
      const source =
        s.source === "userSettings" ? "user" : s.source === "projectSettings" || s.source === "localSettings" ? "project" : s.source === "policySettings" ? "managed" : s.source === "plugin" ? "plugin" : "bundled"
      add({ name: s.name, description: "", source, plugin: source === "plugin" ? (s.name.split(":")[0] ?? null) : null, path: null, editable: false })
    }
    return [...out.values()].sort(
      (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.name.localeCompare(b.name)
    )
  }

  /** Estado de una skill (como el menú de skills de Claude Code): en tu cuenta, o solo en este proyecto. */
  async setSkillState(accountId: string, projectId: string | null, name: string, state: SkillState, scope: "user" | "local") {
    const account = this.account(accountId)
    const project = this.project(projectId)
    if (!SKILL_STATES.includes(state)) throw new Error("Estado inválido")
    if (name.includes(":")) throw new Error("Las skills de un plugin se administran con el plugin")
    if (!/^[\w.-]{1,80}$/.test(name)) throw new Error("Nombre de skill inválido")
    if (scope === "local" && !project) throw new Error("Elegí un proyecto")
    const files = this.overrideFiles(account, project)
    const file = scope === "user" ? files.user : files.local!
    const created = !fs.existsSync(file)
    updateSettingsFile(file, (data) => {
      const current = data.skillOverrides && typeof data.skillOverrides === "object" ? { ...(data.skillOverrides as Record<string, string>) } : {}
      if (state === "on") delete current[name]
      else current[name] = state
      if (Object.keys(current).length) data.skillOverrides = current
      else delete data.skillOverrides
    })
    if (scope === "local" && created && project) excludeFromGit(project.repoPath, ".claude/settings.local.json")
    this.invalidate(account.id)
    void this.reloadSessions(account.id, "skills", scope === "local" ? project!.repoPath : undefined)
  }

  private skillFile(account: AccountRecord, project: ProjectRecord | null, name: string, needEditable: boolean): string {
    const dirs = this.skillDirs(account, project)
    for (const dir of [dirs.user, dirs.project]) {
      if (!dir) continue
      const hit = scanSkills(dir).find((s) => s.name === name)
      if (hit?.path) return hit.path
    }
    if (needEditable) throw new Error("Esa skill no se puede editar desde acá")
    throw new Error("No encontré el archivo de esa skill")
  }

  readSkill(accountId: string, projectId: string | null, name: string): { path: string; content: string } {
    const account = this.account(accountId)
    const project = this.project(projectId)
    const file = this.skillFile(account, project, name, false)
    return { path: file, content: fs.readFileSync(file, "utf8") }
  }

  saveSkill(accountId: string, projectId: string | null, name: string, content: string) {
    const account = this.account(accountId)
    const project = this.project(projectId)
    const file = this.skillFile(account, project, name, true)
    if (!content.trim()) throw new Error("La skill quedó vacía")
    fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n")
    this.invalidate(account.id)
    void this.reloadSessions(account.id, "skills")
  }

  /** Después de instalar una skill desde afuera: que las vistas y las sesiones abiertas la vean. */
  skillsChanged(accountId: string) {
    this.invalidate(accountId)
    void this.reloadSessions(accountId, "skills")
  }

  createSkill(
    accountId: string,
    projectId: string | null,
    input: { scope: "user" | "project"; name: string; description: string; body: string; content?: string }
  ): { path: string } {
    const account = this.account(accountId)
    const project = this.project(projectId)
    // Con el SKILL.md entero (el que escribió Claude y revisaste), el nombre sale de su frontmatter.
    const fromContent = input.content ? parseFrontmatter(input.content) : null
    const name = (fromContent?.name ?? input.name).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("El nombre va en minúsculas, con números y guiones (ej. revisar-migraciones)")
    if (!(fromContent ? fromContent.description : input.description)?.trim()) throw new Error("Escribí para qué sirve: Claude la usa para decidir cuándo cargarla")
    const dirs = this.skillDirs(account, project)
    const base = input.scope === "user" ? dirs.user : dirs.project
    if (!base) throw new Error("Elegí un proyecto")
    const dir = path.join(base, name)
    if (fs.existsSync(dir)) throw new Error("Ya hay una skill con ese nombre")
    fs.mkdirSync(dir, { recursive: true })
    const description = oneLine(input.description, 1000).replace(/"/g, '\\"')
    const file = path.join(dir, "SKILL.md")
    const content = input.content?.trim()
      ? input.content.trimEnd() + "\n"
      : `---\nname: ${name}\ndescription: "${description}"\n---\n\n${input.body.trim() || `# ${name}\n`}\n`
    fs.writeFileSync(file, content)
    this.invalidate(account.id)
    void this.reloadSessions(account.id, "skills")
    return { path: file }
  }

  /** La skill no se borra: se mueve a la papelera del dashboard (~/.control-plane/trash). */
  deleteSkill(accountId: string, projectId: string | null, name: string): { movedTo: string } {
    const account = this.account(accountId)
    const project = this.project(projectId)
    const file = this.skillFile(account, project, name, true)
    const dir = path.dirname(file)
    const dirs = this.skillDirs(account, project)
    if (![dirs.user, dirs.project].some((d) => d && path.dirname(dir) === d)) throw new Error("Esa skill no se puede quitar desde acá")
    const trash = path.join(this.deps.home, "trash", "skills", `${path.basename(dir)}-${Date.now()}`)
    fs.mkdirSync(path.dirname(trash), { recursive: true })
    try {
      fs.renameSync(dir, trash)
    } catch {
      fs.cpSync(dir, trash, { recursive: true })
      fs.rmSync(dir, { recursive: true, force: true })
    }
    this.invalidate(account.id)
    void this.reloadSessions(account.id, "skills")
    return { movedTo: trash }
  }
}

/** Skills de una carpeta: cada subcarpeta con SKILL.md (nombre y descripción del frontmatter). */
function scanSkills(dir: string): { name: string; description: string; path: string }[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { name: string; description: string; path: string }[] = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const file = path.join(dir, e.name, "SKILL.md")
    let md = ""
    try {
      md = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const fm = parseFrontmatter(md)
    out.push({ name: fm.name?.trim() || e.name, description: fm.description ?? "", path: file })
  }
  return out
}

function manifestDescription(installPath?: string): string | null {
  if (!installPath) return null
  try {
    const m = JSON.parse(fs.readFileSync(path.join(installPath, ".claude-plugin", "plugin.json"), "utf8")) as { description?: string }
    return m.description ?? null
  } catch {
    return null
  }
}

/** Que git no suba un archivo local (settings.local.json) sin tocar el .gitignore del repo. */
function excludeFromGit(repo: string, rel: string) {
  const exclude = path.join(repo, ".git", "info", "exclude")
  try {
    if (!fs.existsSync(path.join(repo, ".git"))) return
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : ""
    if (current.split("\n").some((l) => l.trim() === rel || l.trim() === `/${rel}`)) return
    const gitignore = path.join(repo, ".gitignore")
    if (fs.existsSync(gitignore) && fs.readFileSync(gitignore, "utf8").includes("settings.local.json")) return
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${rel}\n`)
  } catch {
    // si no se puede, queda como está
  }
}
