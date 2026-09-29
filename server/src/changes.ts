import fs from "node:fs"
import path from "node:path"

import { GitError, gitStrict } from "./git.ts"
import type { ChangeGroup, FileChange, SessionChanges } from "./shared/types.ts"
import { now } from "./util.ts"

/** Más archivos que esto por grupo se resumen en "y N más". */
export const MAX_FILES = 200
/** Un archivo nuevo más grande que esto no se lee para contar sus líneas. */
const MAX_COUNT_BYTES = 2 * 1024 * 1024
/** El árbol vacío de git: la base de un repo que todavía no tiene commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

const text = async (dir: string, args: string[]) => (await gitStrict(dir, args)).toString("utf8").trim()
const maybe = (dir: string, args: string[]) => text(dir, args).catch(() => null)

/** Salida de `git diff --numstat -z --no-renames`: "agregadas\tsacadas\truta\0" ("-" en los binarios). */
export function parseNumstat(out: string): FileChange[] {
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [a, d, ...rest] = entry.split("\t")
      const binary = a === "-" || d === "-"
      return {
        path: rest.join("\t"),
        added: binary ? null : Number(a),
        deleted: binary ? null : Number(d),
        binary,
        untracked: false,
        removed: false,
      }
    })
}

/** Líneas de un archivo nuevo: null si es binario o muy grande. */
function countLines(file: string): { lines: number | null; binary: boolean } {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return { lines: null, binary: false }
    if (st.size > MAX_COUNT_BYTES) return { lines: null, binary: false }
    const buf = fs.readFileSync(file)
    if (buf.subarray(0, 8000).includes(0)) return { lines: null, binary: true }
    if (!buf.length) return { lines: 0, binary: false }
    let n = 0
    for (const b of buf) if (b === 10) n++
    return { lines: buf[buf.length - 1] === 10 ? n : n + 1, binary: false }
  } catch {
    return { lines: null, binary: false }
  }
}

function group(files: FileChange[]): ChangeGroup {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  return {
    files: sorted.slice(0, MAX_FILES),
    more: Math.max(0, sorted.length - MAX_FILES),
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0),
  }
}

/** La rama principal del repo, como ref que se puede comparar: la del remoto si está, si no la local. */
export async function defaultBranch(dir: string): Promise<{ name: string; ref: string } | null> {
  const remoteHead = await maybe(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  if (remoteHead) return { name: remoteHead.replace(/^origin\//, ""), ref: remoteHead }
  for (const name of ["main", "master"]) {
    if (await maybe(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])) return { name, ref: `origin/${name}` }
    if (await maybe(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return { name, ref: name }
  }
  return null
}

/** Revisa que la carpeta sea un repo y devuelve si tiene commits. */
async function checkRepo(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) throw new Error("La carpeta de la sesión ya no existe")
  try {
    await text(dir, ["rev-parse", "--show-toplevel"])
  } catch (err) {
    if (err instanceof GitError && err.missing) throw err
    throw new Error("La carpeta de la sesión no es un repo git")
  }
  return (await maybe(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null
}

/** Lo que cambió en `dir`: lo que no se commiteó (staged, sin stagear y nuevo) y lo commiteado en su rama. */
export async function sessionChanges(dir: string): Promise<SessionChanges> {
  const hasHead = await checkRepo(dir)
  const head = hasHead ? "HEAD" : EMPTY_TREE
  const [branchName, tracked, untrackedOut] = await Promise.all([
    maybe(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    text(dir, ["diff", "--numstat", "-z", "--no-renames", "--relative", head]),
    text(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])
  const branch = branchName && branchName !== "HEAD" ? branchName : null

  const files = parseNumstat(tracked).map((f) => ({ ...f, removed: !fs.existsSync(path.join(dir, f.path)) }))
  for (const p of untrackedOut.split("\0").filter(Boolean)) {
    const { lines, binary } = countLines(path.join(dir, p))
    files.push({ path: p, added: lines, deleted: binary || lines === null ? null : 0, binary, untracked: true, removed: false })
  }

  let committed: SessionChanges["committed"] = null
  const main = hasHead ? await defaultBranch(dir) : null
  if (main && branch !== main.name) {
    const base = await maybe(dir, ["merge-base", "HEAD", main.ref])
    const headSha = await maybe(dir, ["rev-parse", "HEAD"])
    if (base && base !== headSha) {
      const [numstat, count] = await Promise.all([
        text(dir, ["diff", "--numstat", "-z", "--no-renames", "--relative", base, "HEAD"]),
        text(dir, ["rev-list", "--count", `${base}..HEAD`]),
      ])
      const list = parseNumstat(numstat).map((f) => ({ ...f, removed: !fs.existsSync(path.join(dir, f.path)) }))
      committed = { ...group(list), base: main.ref, commits: Number(count) || 0 }
    }
  }

  return { branch, uncommitted: group(files), committed, at: now() }
}

/** La base contra la que se compara un archivo: HEAD (sin commitear) o el merge-base con la principal. */
export async function baseRevision(dir: string, side: "uncommitted" | "committed"): Promise<string | null> {
  if (side === "uncommitted") return (await maybe(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])) ? "HEAD" : null
  const main = await defaultBranch(dir)
  return main ? maybe(dir, ["merge-base", "HEAD", main.ref]) : null
}

/** El contenido de `rel` (relativa a `dir`) en `rev`, o null si ahí no existía. */
export async function fileAt(dir: string, rev: string, rel: string): Promise<Buffer | null> {
  try {
    return await gitStrict(dir, ["show", `${rev}:./${rel}`])
  } catch {
    return null
  }
}
