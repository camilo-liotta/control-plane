import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { baseRevision, fileAt } from "./changes.ts"
import { childEnv } from "./claude/env.ts"
import type { EditorSettings } from "./shared/types.ts"

const DEFAULTS: EditorSettings = { kind: "code", command: "" }
/** Las versiones anteriores que se escriben para el diff se borran después de esto. */
const KEEP_MS = 12 * 60 * 60 * 1000

export type Launch = (bin: string, args: string[], cwd: string) => Promise<void>

/**
 * Lanza el editor desacoplado del server: sin heredar stdio, sin esperar a que cierre y sin el entorno
 * propio del server (`NODE_ENV=production` rompería un `npm install` en sus terminales integradas).
 */
export const launchDetached: Launch = (bin, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: childEnv(), detached: true, stdio: "ignore" })
    child.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code
      reject(new Error(code === "ENOENT" || code === "EACCES" ? `No encontré \`${bin}\`. Elegí tu editor en Ajustes` : err.message))
    })
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })

/**
 * La ruta absoluta de `rel` dentro de `dir`, sin salirse: nada de rutas absolutas, `..` ni symlinks que
 * apunten afuera. Si el archivo ya no existe, se mira la carpeta más cercana que sí.
 */
export function resolveInside(dir: string, rel: string): string {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]/).includes(".."))
    throw new Error("Ruta inválida")
  const root = fs.realpathSync(dir)
  const target = path.resolve(root, rel)
  let probe = target
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe)
  const inside = path.relative(root, fs.realpathSync(probe))
  if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("El archivo está fuera de la carpeta de la sesión")
  return target
}

/** Parte un comando en argumentos, respetando comillas simples y dobles (sin shell). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let has = false
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ""
      has = false
    } else cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

/** El binario y los argumentos para abrir `file` (con el diff contra `base`, si hay). */
export function editorCommand(s: EditorSettings, opts: { dir: string; file: string; base: string | null }): { bin: string; args: string[] } {
  if (s.kind === "custom") {
    const [bin, ...rest] = splitCommand(s.command)
    if (!bin) throw new Error("Falta el comando del editor. Configuralo en Ajustes")
    const vars: Record<string, string> = { file: opts.file, dir: opts.dir, base: opts.base ?? "" }
    const args = rest
      .filter((a) => opts.base !== null || !a.includes("{base}"))
      .map((a) => a.replace(/\{(file|dir|base)\}/g, (_, k: string) => vars[k]!))
    if (!rest.some((a) => a.includes("{file}"))) args.push(opts.file)
    return { bin, args }
  }
  // La carpeta primero: el editor usa (o abre) la ventana de ese repo.
  return { bin: s.kind, args: opts.base ? [opts.dir, "--diff", opts.base, opts.file] : [opts.dir, "-g", opts.file] }
}

/** El editor con el que se abren los cambios de una sesión, y lo que hace falta para abrirlos. */
export class Editor {
  private file: string
  private tmp: string
  private launch: Launch

  constructor({ home, launch = launchDetached }: { home: string; launch?: Launch }) {
    this.file = path.join(home, "editor.json")
    this.tmp = path.join(home, "diff-base")
    this.launch = launch
    this.sweep()
  }

  settings(): EditorSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<EditorSettings>
      return {
        kind: raw.kind === "cursor" || raw.kind === "custom" ? raw.kind : "code",
        command: typeof raw.command === "string" ? raw.command : "",
      }
    } catch {
      return { ...DEFAULTS }
    }
  }

  save(patch: Partial<EditorSettings>): EditorSettings {
    const cur = this.settings()
    const next: EditorSettings = {
      kind: patch.kind === "code" || patch.kind === "cursor" || patch.kind === "custom" ? patch.kind : cur.kind,
      command: typeof patch.command === "string" ? patch.command.trim().slice(0, 1000) : cur.command,
    }
    if (next.kind === "custom" && !splitCommand(next.command).length) throw new Error("Escribí el comando del editor")
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2))
    return next
  }

  /** Borra las versiones anteriores que ya tienen sus horas. */
  private sweep() {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(this.tmp)
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(this.tmp, e)
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { recursive: true, force: true })
      } catch {}
    }
  }

  /** Escribe la versión anterior de un archivo en un temporal propio, con el nombre y la extensión del original. */
  private writeBase(rel: string, label: string, content: Buffer): string {
    fs.mkdirSync(this.tmp, { recursive: true })
    const dir = fs.mkdtempSync(path.join(this.tmp, "d-"))
    const ext = path.extname(rel)
    const file = path.join(dir, `${path.basename(rel, ext)} (${label})${ext}`)
    fs.writeFileSync(file, content, { mode: 0o444 })
    return file
  }

  /**
   * Abre `rel` (relativa a la carpeta de la sesión) en el editor. Si el archivo ya estaba en la base,
   * abre el diff; si es nuevo, el archivo; si lo borraron, la versión anterior.
   */
  async open(dir: string, rel: string, side: "uncommitted" | "committed"): Promise<{ diff: boolean }> {
    const file = resolveInside(dir, rel)
    this.sweep()
    const rev = await baseRevision(dir, side)
    const before = rev ? await fileAt(dir, rev, rel) : null
    const label = side === "uncommitted" ? "HEAD" : "base"
    const exists = fs.existsSync(file)
    if (!exists && !before) throw new Error("El archivo ya no existe")
    const base = before ? this.writeBase(rel, label, before) : null
    const cmd = exists ? editorCommand(this.settings(), { dir, file, base }) : editorCommand(this.settings(), { dir, file: base!, base: null })
    await this.launch(cmd.bin, cmd.args, dir)
    return { diff: exists && base !== null }
  }
}
