import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import type { Accounts } from "./accounts.ts"
import { parseFrontmatter } from "./claude/tool-parsers.ts"
import type { AccountRecord, Db, ProjectRecord } from "./db.ts"
import type { CatalogSkill, SkillMarketView, SkillSourceView } from "./shared/types.ts"
import type { Tools } from "./tools.ts"
import { errorMessage, now, oneLine } from "./util.ts"

const run = promisify(execFile)

interface SourceRecord {
  id: string
  name: string
  kind: "git" | "local"
  url: string | null
  path: string
  addedAt: number
  updatedAt: number | null
}

/** Fuentes que conviene conocer (no se agregan solas). */
export const SUGGESTED_SOURCES = [
  { name: "Anthropic Skills", url: "anthropics/skills", description: "Las skills oficiales de Anthropic: documentos, planillas, presentaciones, diseño, MCP y más." },
]

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__"])

/** Todas las carpetas con SKILL.md debajo de una raíz (no entra en una skill buscando otra). */
export function scanSkillTree(root: string, maxDepth = 6): { dir: string; name: string; description: string }[] {
  const out: { dir: string; name: string; description: string }[] = []
  const visit = (dir: string, depth: number) => {
    const skill = path.join(dir, "SKILL.md")
    if (fs.existsSync(skill)) {
      try {
        const fm = parseFrontmatter(fs.readFileSync(skill, "utf8"))
        out.push({ dir, name: (fm.name?.trim() || path.basename(dir)).slice(0, 80), description: fm.description ?? "" })
      } catch {
        // SKILL.md ilegible: se ignora
      }
      return
    }
    if (depth >= maxDepth) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue
      visit(path.join(dir, e.name), depth + 1)
    }
  }
  visit(root, 0)
  return out
}

/** Nombre de carpeta válido para una skill instalada. */
export function skillDirName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

/** De "usuario/repo", una URL https o una ruta local, qué agregar. */
export function parseSourceInput(input: string): { kind: "git"; url: string; name: string } | { kind: "local"; path: string; name: string } {
  const raw = input.trim()
  if (!raw) throw new Error("Escribí un repo (usuario/repo), una URL o una carpeta")
  if (raw.startsWith("/") || raw.startsWith("~")) return { kind: "local", path: raw, name: path.basename(raw.replace(/\/+$/, "")) }
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(raw)
  if (short) return { kind: "git", url: `https://github.com/${short[1]}/${short[2]!.replace(/\.git$/, "")}.git`, name: `${short[1]}/${short[2]}` }
  if (/^https:\/\/[\w.-]+\/[\w./-]+$/.test(raw)) {
    const m = /\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(raw)
    return { kind: "git", url: raw, name: m ? `${m[1]}/${m[2]}` : raw }
  }
  throw new Error("Solo repos de GitHub (usuario/repo), URLs https de git o carpetas locales")
}

/** Saca el contenido de un SKILL.md de una respuesta (tolera un bloque de código alrededor). */
export function extractSkillMd(raw: string): string {
  let text = raw.trim()
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
  if (fence) text = fence[1]!.trim()
  const start = text.indexOf("---")
  if (start > 0) text = text.slice(start)
  if (!text.startsWith("---")) throw new Error("Claude no devolvió un SKILL.md con su frontmatter")
  const fm = parseFrontmatter(text)
  if (!fm.name || !fm.description) throw new Error("Al SKILL.md le falta el name o la description")
  return text.endsWith("\n") ? text : text + "\n"
}

/** Lo que devuelve la búsqueda con IA: ids del catálogo con el porqué. */
const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      maxItems: 10,
      items: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id", "why"] },
    },
    note: { type: "string" },
  },
  required: ["results"],
}

export interface SkillMarketDeps {
  db: Db
  accounts: Accounts
  tools: Tools
  home: string
}

/**
 * Marketplaces de skills: repos con carpetas SKILL.md (clonados en el directorio del dashboard,
 * nunca adentro de la configuración de Claude Code) y las skills que traen los marketplaces de
 * plugins de la cuenta. Instalar una skill es copiar su carpeta a tus skills o a las del proyecto.
 */
export class SkillMarket {
  private deps: SkillMarketDeps

  constructor(deps: SkillMarketDeps) {
    this.deps = deps
  }

  private get file() {
    return path.join(this.deps.home, "skill-sources.json")
  }

  private get cloneRoot() {
    return path.join(this.deps.home, "skill-sources")
  }

  private records(): SourceRecord[] {
    try {
      const list = JSON.parse(fs.readFileSync(this.file, "utf8")) as SourceRecord[]
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  private save(list: SourceRecord[]) {
    fs.mkdirSync(this.deps.home, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n")
    fs.renameSync(tmp, this.file)
  }

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

  private async git(args: string[], cwd?: string) {
    try {
      await run("git", args, { cwd, timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    } catch (err) {
      const e = err as { stderr?: string }
      throw new Error(oneLine(e.stderr?.trim() || errorMessage(err), 300))
    }
  }

  // ---------------------------------------------------------------- fuentes

  async addSource(input: string): Promise<SourceRecord> {
    const parsed = parseSourceInput(input)
    const list = this.records()
    const base = skillDirName(parsed.name.replace("/", "-")) || "fuente"
    let id = base
    for (let i = 2; list.some((s) => s.id === id); i++) id = `${base}-${i}`
    let rec: SourceRecord
    if (parsed.kind === "local") {
      const dir = path.resolve(parsed.path.replace(/^~/, process.env.HOME ?? ""))
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("Esa carpeta no existe")
      if (list.some((s) => s.path === dir)) throw new Error("Esa carpeta ya está agregada")
      rec = { id, name: parsed.name, kind: "local", url: null, path: dir, addedAt: now(), updatedAt: now() }
    } else {
      if (list.some((s) => s.url === parsed.url)) throw new Error("Ese repo ya está agregado")
      const dir = path.join(this.cloneRoot, id)
      fs.mkdirSync(this.cloneRoot, { recursive: true })
      await this.git(["clone", "--depth", "1", "--quiet", parsed.url, dir])
      rec = { id, name: parsed.name, kind: "git", url: parsed.url, path: dir, addedAt: now(), updatedAt: now() }
    }
    if (!scanSkillTree(rec.path).length) {
      if (rec.kind === "git") fs.rmSync(rec.path, { recursive: true, force: true })
      throw new Error("No encontré ninguna skill (carpetas con SKILL.md) ahí")
    }
    this.save([...list, rec])
    return rec
  }

  async updateSource(id: string) {
    const list = this.records()
    const rec = list.find((s) => s.id === id)
    if (!rec) throw new Error("Esa fuente no existe")
    if (rec.kind === "git") {
      await this.git(["fetch", "--depth", "1", "--quiet", "origin"], rec.path)
      await this.git(["reset", "--hard", "--quiet", "FETCH_HEAD"], rec.path)
    }
    rec.updatedAt = now()
    this.save(list)
  }

  removeSource(id: string) {
    const list = this.records()
    const rec = list.find((s) => s.id === id)
    if (!rec) throw new Error("Esa fuente no existe")
    // Solo se borra lo que clonó el dashboard; una carpeta local tuya queda donde está.
    if (rec.kind === "git" && path.dirname(rec.path) === this.cloneRoot) fs.rmSync(rec.path, { recursive: true, force: true })
    this.save(list.filter((s) => s.id !== id))
  }

  // ---------------------------------------------------------------- catálogo

  private installedNames(account: AccountRecord, project: ProjectRecord | null) {
    const read = (dir: string | null) => {
      if (!dir) return new Set<string>()
      try {
        return new Set(fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "SKILL.md"))))
      } catch {
        return new Set<string>()
      }
    }
    return {
      user: read(path.join(this.deps.accounts.dir(account), "skills")),
      project: read(project ? path.join(project.repoPath, ".claude", "skills") : null),
    }
  }

  async view(accountId: string, projectId: string | null): Promise<SkillMarketView> {
    const account = this.account(accountId)
    const project = this.project(projectId)
    const installed = this.installedNames(account, project)
    const sources: SkillSourceView[] = []
    const skills: CatalogSkill[] = []
    const add = (sourceId: string, sourceName: string, root: string, pluginOf?: (dir: string) => string | null) => {
      const found = scanSkillTree(root)
      for (const s of found) {
        const dirName = skillDirName(s.name) || path.basename(s.dir)
        skills.push({
          id: `${sourceId}::${path.relative(root, s.dir)}`,
          name: s.name,
          description: s.description,
          sourceId,
          sourceName,
          plugin: pluginOf ? pluginOf(path.relative(root, s.dir)) : null,
          installed: installed.project.has(dirName) ? "project" : installed.user.has(dirName) ? "user" : null,
        })
      }
      return found.length
    }
    for (const r of this.records()) {
      const count = fs.existsSync(r.path) ? add(r.id, r.name, r.path) : 0
      sources.push({ id: r.id, name: r.name, kind: r.kind, url: r.url, path: r.path, skills: count, updatedAt: r.updatedAt, removable: true })
    }
    // Los marketplaces de plugins de la cuenta: solo lectura, sus skills se pueden copiar sueltas.
    const markets = await this.deps.tools.marketplaces(accountId).catch(() => [])
    for (const m of markets) {
      const root = (m as { installLocation?: string }).installLocation
      if (!root || !fs.existsSync(root)) continue
      const id = `plugins:${m.name}`
      const count = add(id, m.name, root, (rel) => /^(?:external_)?plugins\/([^/]+)/.exec(rel)?.[1] ?? null)
      sources.push({ id, name: m.name, kind: "plugin-marketplace", url: m.repo ? `https://github.com/${m.repo}` : (m.url ?? null), path: root, skills: count, updatedAt: null, removable: false })
    }
    const known = new Set(this.records().map((r) => r.url))
    const suggestedUrl = (s: { url: string }) => {
      const p = parseSourceInput(s.url)
      return p.kind === "git" ? p.url : p.path
    }
    return {
      sources,
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
      suggested: SUGGESTED_SOURCES.filter((s) => !known.has(suggestedUrl(s))),
    }
  }

  /** Dónde está en disco una skill del catálogo (valida que no se salga de su fuente). */
  private async locate(accountId: string, skillId: string): Promise<{ dir: string; name: string }> {
    const [sourceId, rel] = skillId.split("::")
    if (!sourceId || rel === undefined) throw new Error("Skill inválida")
    let root: string | null = null
    if (sourceId.startsWith("plugins:")) {
      const markets = await this.deps.tools.marketplaces(accountId).catch(() => [])
      root = (markets.find((m) => `plugins:${m.name}` === sourceId) as { installLocation?: string } | undefined)?.installLocation ?? null
    } else {
      root = this.records().find((r) => r.id === sourceId)?.path ?? null
    }
    if (!root) throw new Error("Esa fuente ya no está")
    const dir = path.resolve(root, rel)
    if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error("Skill inválida")
    const md = path.join(dir, "SKILL.md")
    if (!fs.existsSync(md)) throw new Error("Esa skill ya no está en la fuente (probá actualizarla)")
    const fm = parseFrontmatter(fs.readFileSync(md, "utf8"))
    return { dir, name: fm.name?.trim() || path.basename(dir) }
  }

  async preview(accountId: string, skillId: string): Promise<{ content: string; files: string[] }> {
    const { dir } = await this.locate(accountId, skillId)
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (files.length >= 200) return
        const full = path.join(d, e.name)
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) walk(full)
        } else files.push(path.relative(dir, full))
      }
    }
    walk(dir)
    return { content: fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), files: files.sort() }
  }

  /** Copia la carpeta de la skill a tus skills (cuenta) o a las del proyecto. Nunca pisa una existente. */
  async install(accountId: string, projectId: string | null, skillId: string, scope: "user" | "project"): Promise<{ path: string }> {
    const account = this.account(accountId)
    const project = this.project(projectId)
    if (scope === "project" && !project) throw new Error("Elegí un proyecto")
    const { dir, name } = await this.locate(accountId, skillId)
    const base = scope === "user" ? path.join(this.deps.accounts.dir(account), "skills") : path.join(project!.repoPath, ".claude", "skills")
    const target = path.join(base, skillDirName(name) || path.basename(dir))
    if (fs.existsSync(target)) throw new Error(`Ya tenés una skill "${path.basename(target)}" ahí: no la piso`)
    fs.mkdirSync(base, { recursive: true })
    // Sin seguir enlaces: se copian como enlaces y no lo que apuntan fuera de la skill.
    fs.cpSync(dir, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, filter: (src) => !SKIP.has(path.basename(src)) })
    this.deps.tools.skillsChanged(account.id)
    return { path: target }
  }

  // ---------------------------------------------------------------- IA

  /**
   * Una consulta a Claude con tu cuenta: sin herramientas (o solo lectura del repo), sin MCP, sin
   * hooks y sin guardar la conversación. El prompt va por stdin (los catálogos son largos).
   */
  private async ask(account: AccountRecord, prompt: string, opts: { cwd: string; readRepo?: boolean; model?: string; timeoutMs?: number }): Promise<string> {
    const r = await this.run(account, prompt, opts)
    if (!r.result) throw new Error(`Claude no pudo contestar (${r.subtype ?? "error"})`)
    return r.result
  }

  /** Igual, pero la respuesta sale validada contra un JSON Schema (--json-schema) en vez de parsear texto. */
  private async askJson<T>(account: AccountRecord, prompt: string, schema: object, opts: { cwd: string; model?: string; timeoutMs?: number }): Promise<T> {
    const r = await this.run(account, prompt, { ...opts, schema })
    if (r.structured_output && typeof r.structured_output === "object") return r.structured_output as T
    throw new Error("Claude no devolvió los resultados en el formato pedido. Probá de nuevo.")
  }

  private run(
    account: AccountRecord,
    prompt: string,
    opts: { cwd: string; readRepo?: boolean; model?: string; timeoutMs?: number; schema?: object }
  ): Promise<{ result?: string; structured_output?: unknown; subtype?: string }> {
    // La salida estructurada usa una herramienta interna: necesita un par de turnos más.
    const maxTurns = opts.readRepo ? 15 : opts.schema ? 4 : 1
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      opts.model ?? "sonnet",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--settings",
      JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
      "--tools",
      opts.readRepo ? "Read,Grep,Glob" : "",
      "--max-turns",
      String(maxTurns),
      ...(opts.schema ? ["--json-schema", JSON.stringify(opts.schema)] : []),
    ]
    return new Promise((resolve, reject) => {
      const child = spawn(this.deps.accounts.bin(account), args, {
        cwd: opts.cwd,
        env: { ...process.env, ...this.deps.accounts.env(account) },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let out = ""
      let err = ""
      const timer = setTimeout(() => {
        child.kill("SIGTERM")
        reject(new Error("Claude tardó demasiado en contestar"))
      }, opts.timeoutMs ?? 240_000)
      child.stdout.on("data", (d) => (out += String(d)))
      child.stderr.on("data", (d) => (err += String(d)))
      child.on("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on("exit", () => {
        clearTimeout(timer)
        try {
          const r = JSON.parse(out) as { result?: string; structured_output?: unknown; is_error?: boolean; subtype?: string }
          if (r.is_error) throw new Error(oneLine(r.result || `Claude no pudo contestar (${r.subtype ?? "error"})`, 300))
          resolve(r)
        } catch (e) {
          reject(e instanceof SyntaxError ? new Error(oneLine(err.trim() || "Claude no devolvió una respuesta válida", 300)) : e)
        }
      })
      child.stdin.end(prompt)
    })
  }

  private neutralDir() {
    const dir = path.join(this.deps.home, "inspect")
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Busca en los marketplaces (skills y plugins) lo que sirve para un tema, con criterio y no por palabras. */
  async aiSearch(accountId: string, projectId: string | null, query: string) {
    const account = this.account(accountId)
    if (!query.trim()) throw new Error("Escribí qué buscás")
    const market = await this.view(accountId, projectId)
    const plugins = await this.deps.tools.catalog(accountId).catch(() => [])
    const lines: string[] = []
    // Las que ya tenés también cuentan: a veces la respuesta es "ya la tenés".
    const project = this.project(projectId)
    const mine: { id: string; name: string; description: string; scope: "user" | "project" }[] = []
    const dirs: [string, "user" | "project"][] = [[path.join(this.deps.accounts.dir(account), "skills"), "user"]]
    if (project) dirs.push([path.join(project.repoPath, ".claude", "skills"), "project"])
    for (const [dir, scope] of dirs) for (const s of scanSkillTree(dir, 1)) mine.push({ id: `installed::${scope}::${s.name}`, name: s.name, description: s.description, scope })
    for (const s of mine) lines.push(`${s.id} | ya instalada (${s.scope === "user" ? "tu cuenta" : "este proyecto"}) | ${s.name} | ${oneLine(s.description, 220)}`)
    for (const s of market.skills) lines.push(`${s.id} | skill${s.installed ? " (ya instalada)" : ""} | ${s.name} | ${oneLine(s.description, 220)}`)
    for (const p of plugins) lines.push(`plugin::${p.id} | plugin${p.installed ? " (ya instalado)" : ""} | ${p.name} | ${oneLine(p.description, 220)}`)
    if (!lines.length) throw new Error("No hay marketplaces con skills ni plugins para buscar: agregá una fuente")
    const prompt = [
      `Sos un buscador de skills y plugins para Claude Code. El usuario busca: "${oneLine(query, 500)}".`,
      "Abajo está el catálogo, una entrada por línea: id | tipo | nombre | descripción.",
      "Elegí hasta 10 entradas que de verdad sirvan para lo que busca, de la más útil a la menos. Usá solo ids del catálogo, sin inventar. Si algo ya está instalado y sirve, incluilo igual.",
      'En cada resultado, "why" es una línea en castellano, con tildes: para qué le sirve a este pedido. "note" es opcional: una línea si hace falta aclarar algo (por ejemplo, que nada encaja del todo).',
      "",
      "<catalogo>",
      ...lines,
      "</catalogo>",
    ].join("\n")
    const data = await this.askJson<{ results?: { id?: string; why?: string }[]; note?: string }>(account, prompt, SEARCH_SCHEMA, { cwd: this.neutralDir() })
    const byId = new Map(market.skills.map((s) => [s.id, s]))
    const pluginById = new Map(plugins.map((p) => [`plugin::${p.id}`, p]))
    const mineById = new Map(mine.map((s) => [s.id, s]))
    const results = (data.results ?? [])
      .map((r) => {
        const id = String(r.id ?? "")
        const why = oneLine(String(r.why ?? ""), 300)
        const skill = byId.get(id)
        if (skill) return { kind: "skill" as const, why, skill }
        const plugin = pluginById.get(id)
        if (plugin) return { kind: "plugin" as const, why, plugin }
        const own = mineById.get(id)
        if (own) return { kind: "installed" as const, why, installed: { name: own.name, description: own.description, scope: own.scope } }
        return null
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
    return { results, note: data.note ? oneLine(data.note, 400) : null }
  }

  /** Escribe una skill nueva a partir de lo que necesitás. No la guarda: la devuelve para revisarla. */
  async aiDraft(accountId: string, projectId: string | null, input: { description: string; scope: "user" | "project" }) {
    const account = this.account(accountId)
    const project = this.project(projectId)
    if (!input.description.trim()) throw new Error("Contá qué tiene que hacer la skill")
    const readRepo = input.scope === "project" && Boolean(project)
    const prompt = [
      `Escribí una skill de Claude Code (el contenido de un archivo SKILL.md) para esto: "${input.description.trim()}".`,
      readRepo ? "Estás en el repositorio del proyecto: podés leer archivos (Read, Grep, Glob) para adaptarla a cómo es este repo. No modifiques nada." : "",
      "Formato:",
      "- Empieza con un frontmatter YAML entre dos líneas '---' con dos campos: name (minúsculas, números y guiones, máximo 64 caracteres) y description.",
      "- description: qué hace y cuándo usarla, en una o dos oraciones concretas con las palabras que usaría alguien que la necesita. Claude decide cargarla leyendo solo esto. Máximo 1024 caracteres.",
      "- Después, las instrucciones en markdown: pasos concretos, criterio de terminado y ejemplos cortos si ayudan. En imperativo, sin relleno y sin datos que se vencen.",
      "- Corta y útil: lo esencial primero.",
      "- En el idioma del pedido.",
      "Respondé SOLO con el contenido del SKILL.md, sin bloque de código alrededor.",
    ]
      .filter(Boolean)
      .join("\n")
    const content = extractSkillMd(await this.ask(account, prompt, { cwd: readRepo ? project!.repoPath : this.neutralDir(), readRepo }))
    return { name: skillDirName(parseFrontmatter(content).name ?? ""), content }
  }

  /** Propone un cambio a una skill tuya o del proyecto. No lo guarda: devuelve el SKILL.md nuevo. */
  async aiEdit(accountId: string, projectId: string | null, name: string, instruction: string) {
    const account = this.account(accountId)
    const project = this.project(projectId)
    if (!instruction.trim()) throw new Error("Contá qué querés cambiar")
    const current = this.deps.tools.readSkill(accountId, projectId, name)
    const inProject = Boolean(project && current.path.startsWith(path.join(project.repoPath, ".claude", "skills")))
    const prompt = [
      "Este es el SKILL.md de una skill de Claude Code:",
      "<skill>",
      current.content,
      "</skill>",
      `Cambiala según este pedido: "${instruction.trim()}".`,
      inProject ? "Estás en el repositorio del proyecto: podés leer archivos (Read, Grep, Glob) si hace falta. No modifiques nada." : "",
      "Mantené el frontmatter: el name igual, y la description ajustada solo si cambia qué hace o cuándo usarla. No toques lo que el pedido no menciona.",
      "Respondé SOLO con el SKILL.md completo nuevo, sin bloque de código alrededor.",
    ]
      .filter(Boolean)
      .join("\n")
    const content = extractSkillMd(await this.ask(account, prompt, { cwd: inProject ? project!.repoPath : this.neutralDir(), readRepo: inProject }))
    return { path: current.path, before: current.content, content }
  }
}
