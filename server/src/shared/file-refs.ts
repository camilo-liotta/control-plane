// Referencias a archivos del workspace en lo que escriben las sesiones:
//
//   `server/src/sessions.ts`, `web/src/lib/api.ts:120`, ./scripts/deploy.sh, ~/projects/x/README.md
//
// Esto solo decide qué *parece* una ruta; el server después mira cuáles existen de verdad (dentro de
// la sesión, el proyecto o sus worktrees) y la web linkea solo esas. Por eso acá se prefiere no
// marcar algo dudoso: en el texto suelto, una ruta tiene que tener "/" y una extensión conocida, o
// empezar con ./, ../, ~/ o /. En código inline (todo el código es la ruta) se acepta también un
// nombre de archivo suelto con extensión (`package.json`) y una carpeta que termina en "/".

/** Extensiones que cuentan como archivo. Sin números: así `v0.4.2` o `1.2.3` no son rutas. */
const EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx txt css scss sass less html htm vue svelte astro " +
    "rs toml lock yaml yml xml ini cfg conf env sh bash zsh fish ps1 bat py pyi ipynb rb php go mod sum java kt kts " +
    "gradle swift m mm c h cc cpp cxx hpp cs fs ex exs erl zig dart lua nix sql graphql gql proto tf tfvars hcl " +
    "csv tsv log svg png jpg jpeg gif webp ico icns pdf plist entitlements desktop service socket timer patch diff"
  ).split(" ")
)

/** Archivos conocidos sin extensión. */
const NAMES = new Set(["Dockerfile", "Makefile", "Procfile", "Gemfile", "Rakefile", "Justfile", "LICENSE", "CODEOWNERS", ".gitignore", ".npmrc", ".nvmrc", ".env"])

export interface FileRef {
  /** La ruta sin la línea ni la columna. */
  path: string
  line?: number
  col?: number
}

/** Separa `ruta:línea:col` (las dos opcionales). */
export function parseRef(input: string): FileRef {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(input)
  if (!m || !m[1]) return { path: input }
  const line = Number(m[2])
  const col = m[3] ? Number(m[3]) : undefined
  return line > 0 ? { path: m[1], line, ...(col ? { col } : {}) } : { path: m[1] }
}

const SEGMENT = /^[\w@+.-]+$/

function hasKnownExtension(name: string): boolean {
  if (NAMES.has(name)) return true
  const dot = name.lastIndexOf(".")
  if (dot <= 0 && !name.startsWith(".")) return false
  const ext = name.slice(dot + 1).toLowerCase()
  return EXTENSIONS.has(ext) && /[a-z]/i.test(name.slice(0, dot) || name)
}

/**
 * Si `p` (sin línea) parece una ruta a un archivo o carpeta. `code`: es todo el contenido de un código
 * inline, así que vale también un nombre suelto con extensión o una carpeta con "/" al final.
 */
export function looksLikePath(p: string, mode: "text" | "code"): boolean {
  if (!p || p.length > 400 || /[\s`'"<>|*?$={}\\:,;()[\]]/.test(p) || p.includes("//")) return false
  if (p.startsWith("-") || /^www\./i.test(p)) return false
  let rest = p
  let anchored = false
  if (p.startsWith("~/")) [rest, anchored] = [p.slice(2), true]
  else if (p.startsWith("./")) [rest, anchored] = [p.slice(2), true]
  else if (p.startsWith("../")) {
    rest = p.replace(/^(\.\.\/)+/, "")
    anchored = true
  } else if (p.startsWith("/")) [rest, anchored] = [p.slice(1), true]
  const dirLike = rest.endsWith("/")
  const segments = (dirLike ? rest.slice(0, -1) : rest).split("/")
  if (!segments.length || segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return false
  const last = segments.at(-1)!
  if (/^\d+(\.\d+)*$/.test(last)) return false
  // Absolutas: al menos dos niveles (/tmp sola no dice nada); con prefijo ./ ../ ~/ alcanza uno.
  if (p.startsWith("/") && segments.length < 2) return false
  if (anchored || (mode === "code" && dirLike)) return true
  return (segments.length > 1 || mode === "code") && hasKnownExtension(last)
}

/** Si todo el contenido de un código inline es una referencia a un archivo. */
export function codeRef(text: string): FileRef | null {
  const t = text.trim()
  const ref = parseRef(t)
  return looksLikePath(ref.path, "code") ? ref : null
}

export interface TextRef extends FileRef {
  /** Lo que se linkea, tal cual está en el texto (con la línea). */
  input: string
  start: number
  end: number
}

/** Las referencias a archivos dentro de un texto suelto (sin URLs ni cosas como `v0.4.2` o `a/b`). */
export function textRefs(text: string): TextRef[] {
  const out: TextRef[] = []
  for (const m of text.matchAll(/[^\s`'"()<>[\]{},;]+/g)) {
    let token = m[0]
    let start = m.index
    if (token.includes("://") || /^(mailto|data|javascript):/i.test(token)) continue
    // Puntuación pegada al final ("mirá server/src/x.ts.") o adelante ("¿./x.sh?").
    while (token && /[.:!?¡¿]$/.test(token)) token = token.slice(0, -1)
    while (token && /^[¡¿:]/.test(token)) {
      token = token.slice(1)
      start++
    }
    if (!token) continue
    const ref = parseRef(token)
    if (!looksLikePath(ref.path, "text")) continue
    out.push({ ...ref, input: token, start, end: start + token.length })
  }
  return out
}

/** Lo que el server responde por cada ruta que existe. */
export interface ResolvedRef extends FileRef {
  input: string
  /** Relativa a la carpeta donde se encontró (la de la sesión, el proyecto o un worktree). */
  rel: string
  kind: "file" | "dir"
}
