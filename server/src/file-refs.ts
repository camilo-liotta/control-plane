import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readRepos } from "./overview.ts"
import { looksLikePath, parseRef, type ResolvedRef } from "./shared/file-refs.ts"

/** Como mucho, cuántas rutas se resuelven por pedido. */
export const MAX_PATHS = 200

export interface Found extends ResolvedRef {
  /** La ruta real (sin symlinks) del archivo o la carpeta. */
  abs: string
  /** La carpeta donde se encontró (realpath): la de la sesión, la del proyecto o un worktree. */
  root: string
}

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

const isInside = (root: string, p: string) => {
  const rel = path.relative(root, p)
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Busca `input` (una ruta con `:línea:col` opcional) en las carpetas `roots`, en orden, y la devuelve
 * solo si existe y su ruta real cae adentro de alguna: nada de `..` que salga ni symlinks que apunten
 * afuera. Las absolutas y las de `~/` valen si terminan adentro; las relativas se prueban en cada
 * carpeta y tienen que quedar dentro de esa misma.
 */
export function resolveRef(input: string, roots: string[], home = os.homedir()): Found | null {
  if (typeof input !== "string" || input.includes("\0")) return null
  const ref = parseRef(input.trim())
  if (!looksLikePath(ref.path, "code")) return null
  const realRoots = roots.map(real).filter((r): r is string => r !== null)
  const found = (abs: string, root: string): Found | null => {
    const target = real(abs)
    if (!target || !isInside(root, target)) return null
    const kind = fs.statSync(target).isDirectory() ? "dir" : "file"
    const { line, col } = ref
    return { input, path: ref.path, rel: path.relative(root, target) || ".", kind, abs: target, root, ...(line ? { line } : {}), ...(col ? { col } : {}) }
  }
  if (ref.path.startsWith("~/") || path.isAbsolute(ref.path)) {
    const abs = ref.path.startsWith("~/") ? path.join(home, ref.path.slice(2)) : ref.path
    for (const root of realRoots) {
      const f = found(abs, root)
      if (f) return f
    }
    return null
  }
  for (const root of realRoots) {
    const f = found(path.resolve(root, ref.path), root)
    if (f) return f
  }
  return null
}

/**
 * Resuelve las rutas de un proyecto: primero en la carpeta de la sesión (que puede ser un worktree) y la
 * del proyecto; lo que no aparece ahí, en los demás repos y worktrees del proyecto (se leen una vez cada
 * 30 segundos, y solo si hace falta).
 */
export class PathResolver {
  private repos = new Map<string, { at: number; value: Promise<string[]> }>()
  private home: string

  constructor({ home = os.homedir() }: { home?: string } = {}) {
    this.home = home
  }

  private projectRepos(root: string): Promise<string[]> {
    const hit = this.repos.get(root)
    if (hit && Date.now() - hit.at < 30_000) return hit.value
    const value = readRepos(root).then(
      (rs) => rs.map((r) => r.path),
      () => []
    )
    this.repos.set(root, { at: Date.now(), value })
    return value
  }

  async resolve(inputs: string[], base: { projectRoot: string; sessionCwd?: string }): Promise<Found[]> {
    const first = [base.sessionCwd, base.projectRoot].filter((d): d is string => !!d)
    const unique = [...new Set(inputs.filter((i) => typeof i === "string").slice(0, MAX_PATHS))]
    const out = new Map<string, Found>()
    const missing: string[] = []
    for (const input of unique) {
      const f = resolveRef(input, first, this.home)
      if (f) out.set(input, f)
      else missing.push(input)
    }
    // Lo que no está en la sesión ni en el proyecto, en sus otros repos y worktrees.
    const candidates = missing.filter((i) => looksLikePath(parseRef(i.trim()).path, "code"))
    if (candidates.length) {
      const more = (await this.projectRepos(base.projectRoot)).filter((r) => !first.includes(r))
      for (const input of candidates) {
        const f = resolveRef(input, more, this.home)
        if (f) out.set(input, f)
      }
    }
    return unique.flatMap((i) => (out.has(i) ? [out.get(i)!] : []))
  }

  async one(input: string, base: { projectRoot: string; sessionCwd?: string }): Promise<Found> {
    const [f] = await this.resolve([input], base)
    if (!f) throw new Error("No encontré ese archivo en el proyecto")
    return f
  }
}
