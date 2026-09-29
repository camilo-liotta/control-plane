import fs from "node:fs"
import path from "node:path"

import type { Db } from "./db.ts"
import { git } from "./git.ts"
import type { ProjectOverview, RepoInfo } from "./shared/types.ts"
import { now } from "./util.ts"

/** owner/repo de un remoto de GitHub (ssh o https), o null si no es de GitHub. */
export function githubOf(remote: string | null): { owner: string; repo: string } | null {
  if (!remote) return null
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? { owner: m[1]!, repo: m[2]! } : null
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "target", "vendor"])

/** Repos git dentro de la carpeta del proyecto: la raíz y hasta dos niveles abajo. */
export function findRepos(root: string, max = 20): string[] {
  const out: string[] = []
  const visit = (dir: string, depth: number) => {
    if (out.length >= max) return
    if (fs.existsSync(path.join(dir, ".git"))) out.push(dir)
    if (depth >= 2) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue
      visit(path.join(dir, e.name), depth + 1)
    }
  }
  visit(root, 0)
  return out
}

async function repoInfo(dir: string, root: string): Promise<RepoInfo> {
  const [branch, remote, head, status, counts, wt] = await Promise.all([
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(dir, ["remote", "get-url", "origin"]),
    git(dir, ["log", "-1", "--format=%H%x1f%s%x1f%cI%x1f%an"]),
    git(dir, ["status", "--porcelain"]),
    git(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    git(dir, ["worktree", "list", "--porcelain"]),
  ])
  const [gitDir, commonDir] = await Promise.all([
    git(dir, ["rev-parse", "--absolute-git-dir"]),
    git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ])
  const group = real(commonDir ?? gitDir ?? dir)
  const inside = path.relative(root, dir)
  const worktrees = parseWorktrees(wt ?? "").filter((w) => path.resolve(w.path) !== path.resolve(dir))
  const gh = githubOf(remote)
  const [hash, subject, at, author] = (head ?? "").split("\x1f")
  // Sin rama remota (upstream) no se sabe cuánto falta subir o bajar: queda null, no 0.
  const [behind, ahead] = counts ? counts.split(/\s+/).map((n) => Number(n)) : [NaN, NaN]
  const url = gh ? `https://github.com/${gh.owner}/${gh.repo}` : null
  return {
    path: dir,
    name: inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? inside : path.basename(dir),
    isRoot: dir === root,
    branch: branch && branch !== "HEAD" ? branch : null,
    remote: remote ? remote.replace(/\/\/[^@/]+@/, "//") : null,
    github: gh && url ? { ...gh, url, branchUrl: branch && branch !== "HEAD" ? `${url}/tree/${encodeURIComponent(branch)}` : null } : null,
    head: hash ? { hash, subject: subject ?? "", at: at ? Date.parse(at) : null, author: author ?? null } : null,
    changes: status === null ? null : status ? status.split("\n").length : 0,
    ahead: Number.isFinite(ahead) ? ahead! : null,
    behind: Number.isFinite(behind) ? behind! : null,
    worktrees,
    group,
    worktree: gitDir !== null && commonDir !== null && real(gitDir) !== group,
  }
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** Como mucho, cuántos worktrees de un mismo repo se leen además de los que están en la carpeta. */
const MAX_WORKTREES = 12

/**
 * Los repos de la carpeta y también sus worktrees aunque estén afuera (o en carpetas ocultas, como
 * `.claude/worktrees`): cada uno con su rama y su estado, agrupados por repo (`group`).
 */
export async function readRepos(root: string): Promise<RepoInfo[]> {
  const found = await Promise.all(findRepos(root).map((dir) => repoInfo(dir, root)))
  const seen = new Set(found.map((r) => real(r.path)))
  const extra: string[] = []
  for (const r of found) {
    let n = 0
    for (const w of r.worktrees) {
      const p = real(w.path)
      if (seen.has(p) || !fs.existsSync(p) || n >= MAX_WORKTREES) continue
      seen.add(p)
      extra.push(w.path)
      n++
    }
  }
  return [...found, ...(await Promise.all(extra.map((dir) => repoInfo(dir, root))))]
}

/** Salida de `git worktree list --porcelain`: bloques "worktree <ruta>" con su "branch refs/heads/<rama>". */
export function parseWorktrees(out: string): { path: string; branch: string | null }[] {
  return out
    .split(/\n\n+/)
    .map((block) => {
      const p = /^worktree (.+)$/m.exec(block)?.[1]
      const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null
      return p ? { path: p, branch: b } : null
    })
    .filter((w): w is { path: string; branch: string | null } => w !== null)
}

/** Resumen de un proyecto: sus repos, lo que gastó en total y la última actividad. */
export class Overview {
  private cache = new Map<string, { at: number; value: Promise<RepoInfo[]> }>()
  private db: Db

  constructor(db: Db) {
    this.db = db
  }

  private repos(projectId: string, root: string, refresh: boolean): Promise<RepoInfo[]> {
    const hit = this.cache.get(projectId)
    if (hit && !refresh && now() - hit.at < 30_000) return hit.value
    const value = readRepos(root)
    this.cache.set(projectId, { at: now(), value })
    return value
  }

  async get(projectId: string, refresh = false): Promise<ProjectOverview> {
    const project = this.db.getProject(projectId)
    if (!project) throw new Error("El proyecto no existe")
    // Todas las sesiones del proyecto, incluidas las archivadas: es lo que se gastó.
    const all = this.db.listSessions().filter((s) => s.projectId === projectId)
    const archived = this.db.listArchivedSessions(projectId)
    const every = [...all, ...archived.filter((a) => !all.some((s) => s.id === a.id))]
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    let costUsd = 0
    for (const s of every) {
      costUsd += s.costUsd
      if (!s.tokens) continue
      tokens.input += s.tokens.input
      tokens.output += s.tokens.output
      tokens.cacheRead += s.tokens.cacheRead
      tokens.cacheWrite += s.tokens.cacheWrite
      tokens.total += s.tokens.total
    }
    const last = all
      .filter((s) => !s.archivedAt && s.lastActivityAt)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
    return {
      projectId,
      repos: await this.repos(projectId, project.repoPath, refresh),
      tokens,
      costUsd,
      sessions: every.length,
      lastActivity: last ? { sessionId: last.id, name: last.name, kind: last.kind, at: last.lastActivityAt!, text: last.lastActivity } : null,
      at: now(),
    }
  }
}
