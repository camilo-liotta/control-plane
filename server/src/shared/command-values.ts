// "Valores para completar" en los comandos que una sesión le pasa al usuario:
//
//   gcloud config set project {{PROYECTO_GCP: el id de tu proyecto de GCP}}
//   gsutil ls gs://{{BUCKET: el bucket del backup = mi-backup}}
//
// Un marcador es {{NOMBRE: descripción}} o {{NOMBRE: descripción = valor sugerido}}. El nombre va
// en mayúsculas (A–Z, 0–9, _), pegado a las llaves y seguido de ":". Así no se confunde con
// plantillas reales que pasan por la shell ({{.State.Status}} de docker, {{ .Values }} de helm,
// {{ var }} de jinja) ni con la expansión de llaves de bash ({a,b}).
//
// Al llevar el comando a la terminal, cada valor se escribe citado según dónde está el marcador:
// afuera de comillas, entre comillas simples o entre dobles. Nunca se ejecuta solo: se pega y el
// usuario aprieta Enter.

export interface CommandValue {
  name: string
  description: string
  suggested: string | null
}

const MARKER = /\{\{([A-Z][A-Z0-9_]*):\s*([^{}]*?)\s*\}\}/g

/** Los valores que pide el comando, cada nombre una vez, en el orden en que aparecen. */
export function commandValues(command: string): CommandValue[] {
  const out = new Map<string, CommandValue>()
  for (const m of command.matchAll(MARKER)) {
    const name = m[1]!
    if (out.has(name)) continue
    const body = m[2]!
    const eq = body.lastIndexOf(" = ")
    out.set(name, eq >= 0 ? { name, description: body.slice(0, eq).trim(), suggested: body.slice(eq + 3).trim() || null } : { name, description: body.trim(), suggested: null })
  }
  return [...out.values()]
}

type Quote = "none" | "single" | "double"

/**
 * El valor escrito para que la shell lo lea como texto, según las comillas en las que cae.
 * - Afuera de comillas: tal cual si son solo caracteres seguros; si no, entre comillas simples.
 * - Entre simples: cierra, agrega la comilla escapada y vuelve a abrir (`'\''`).
 * - Entre dobles: cierra las dobles, pone el valor entre simples y las vuelve a abrir
 *   (`"…"'valor'"…"`). Escapar con `\` no sirve para `!`: bash deja la barra.
 */
export function quoteValue(value: string, where: Quote): string {
  const safe = value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
  const single = `'${value.replace(/'/g, `'\\''`)}'`
  if (where === "single") return value.replace(/'/g, `'\\''`)
  if (where === "double") return safe ? value : `"${single}"`
  return safe ? value : single
}

/** Un valor tipeado no puede traer saltos de línea ni caracteres de control: se sacan. */
export function cleanValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, "")
}

/**
 * El comando con los valores puestos. Recorre el texto llevando el estado de las comillas (como
 * sh: `\` escapa afuera y dentro de dobles, nada dentro de simples) para citar cada valor bien.
 * Un marcador sin valor queda como está.
 */
export function fillCommand(command: string, values: Record<string, string>): string {
  let out = ""
  let quote: Quote = "none"
  let i = 0
  while (i < command.length) {
    MARKER.lastIndex = i
    const m = MARKER.exec(command)
    if (m && m.index === i && values[m[1]!] !== undefined) {
      out += quoteValue(cleanValue(values[m[1]!]!), quote)
      i += m[0].length
      continue
    }
    const c = command[i]!
    if (c === "\\" && quote !== "single") {
      out += command.slice(i, i + 2)
      i += 2
      continue
    }
    if (c === "'" && quote !== "double") quote = quote === "single" ? "none" : "single"
    else if (c === '"' && quote !== "single") quote = quote === "double" ? "none" : "double"
    out += c
    i++
  }
  return out
}

/** Si un bloque de código es de shell: por el lenguaje, o porque sus líneas empiezan con `$ `. */
export function isShellBlock(lang: string | undefined, text: string): boolean {
  if (lang) return /^(bash|sh|zsh|shell|console|shellsession|fish|terminal)$/i.test(lang)
  return text.split("\n").some((l) => /^\s*\$ \S/.test(l))
}

/** El comando de un bloque de shell: sin el `$ ` de los prompts y, si hay prompts, sin la salida. */
export function blockCommand(text: string): string {
  const lines = text.replace(/\n$/, "").split("\n")
  if (!lines.some((l) => /^\s*\$ /.test(l))) return lines.join("\n")
  return lines
    .filter((l) => /^\s*\$ /.test(l))
    .map((l) => l.replace(/^\s*\$ /, ""))
    .join("\n")
}

/**
 * Lo que se pega. Con bracketed paste (bash 5.1+, zsh, fish) la shell recibe varias líneas sin
 * ejecutarlas. Sin eso, cada salto de línea sería un Enter: se juntan en una línea con `;` (y las
 * que terminan en `\` siguen en la misma), así nunca corre nada sin que aprietes Enter.
 */
export function pasteText(text: string, bracketed: boolean): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
  if (bracketed || !clean.includes("\n")) return clean
  return clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((acc, l) => (acc === "" ? l : acc.endsWith("\\") ? `${acc.slice(0, -1).trimEnd()} ${l}` : `${acc}; ${l}`), "")
}
