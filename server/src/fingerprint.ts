import { createHash } from "node:crypto"

/**
 * Lo último que vio una sesión de control-plane: el esquema de cada herramienta MCP que le corresponde y
 * las secciones de su protocolo, con un hash de cada una. Sirve para avisarle al modelo cuando cambian
 * (ver SessionManager.send): una conversación vieja sigue viendo el esquema que cargó con ToolSearch
 * y el protocolo nuevo compite con la costumbre de todo su historial.
 */
export interface Fingerprint {
  /** Versión de control-plane con que se tomó. */
  version: string
  tools: Record<string, string>
  sections: Record<string, string>
}

export const hash = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 12)

/** Las secciones `## Título` de un protocolo, con el hash de su texto. Lo que va antes del primer título no cuenta (trae datos del momento). */
export function sectionHashes(protocol: string): Record<string, string> {
  const out: Record<string, string> = {}
  const parts = protocol.split(/^## (.+)$/m)
  for (let i = 1; i < parts.length; i += 2) out[parts[i]!.trim()] = hash((parts[i + 1] ?? "").trim())
  return out
}

const names = (list: string[]) => list.join(", ")
const quoted = (list: string[]) => list.map((t) => `«${t}»`).join(", ")

/**
 * El bloque que se antepone al próximo mensaje de la sesión, o null si no cambió nada. Sin huella previa
 * (`prev` null: una sesión de antes de que existiera) se dan por cambiadas todas las herramientas y secciones.
 */
export function fingerprintNotice(prev: Fingerprint | null, cur: Fingerprint): string | null {
  const isNew = (cur_: Record<string, string>, old: Record<string, string> | undefined) => Object.keys(cur_).filter((k) => !old || !(k in old))
  const isChanged = (cur_: Record<string, string>, old: Record<string, string> | undefined) => Object.keys(cur_).filter((k) => old && k in old && old[k] !== cur_[k])
  const toolsNew = prev ? isNew(cur.tools, prev.tools) : []
  const toolsChanged = prev ? isChanged(cur.tools, prev.tools) : Object.keys(cur.tools)
  const sections = prev ? [...isNew(cur.sections, prev.sections), ...isChanged(cur.sections, prev.sections)] : Object.keys(cur.sections)
  if (!toolsNew.length && !toolsChanged.length && !sections.length) return null
  const lines = [`[control-plane] control-plane se actualizó a v${cur.version}.`]
  const reload = [...toolsNew, ...toolsChanged].map((t) => `mcp__control-plane__${t}`)
  if (toolsNew.length) lines.push(`- Herramientas nuevas: ${names(toolsNew)}.`)
  if (toolsChanged.length)
    lines.push(
      prev
        ? `- Herramientas que cambiaron: ${names(toolsChanged)}.`
        : `- Herramientas de control-plane (puede que tengas guardado el esquema viejo): ${names(toolsChanged)}.`
    )
  if (reload.length)
    lines.push(`Volvé a cargarlas con ToolSearch (select:${reload.join(",")}) antes de usarlas: el esquema que tenés en la conversación es el viejo.`)
  if (sections.length) lines.push(`- Secciones nuevas o cambiadas de tu protocolo: ${quoted(sections)}. Releelas.`)
  return lines.join("\n")
}
