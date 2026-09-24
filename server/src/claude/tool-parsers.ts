import type { McpServerInfo, PluginComponents, SkillState } from "../shared/types.ts"

/** Lo que imprime `claude plugin details <id>` (no tiene --json): componentes y costo en tokens. */
export function parsePluginDetails(text: string): {
  description: string | null
  components: PluginComponents
  alwaysOnTokens: number | null
} {
  const components: PluginComponents = { skills: [], agents: [], commands: [], hooks: 0, mcpServers: [] }
  const description = /^\s+Description:\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null
  for (const line of text.split("\n")) {
    const m = /^\s+(Skills|Agents|Commands|Hooks|MCP servers|LSP servers)\s+\((\d+)\)\s*(.*)$/.exec(line)
    if (!m) continue
    const names = (m[3] ?? "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
    if (m[1] === "Skills") components.skills = names
    else if (m[1] === "Agents") components.agents = names
    else if (m[1] === "Commands") components.commands = names
    else if (m[1] === "Hooks") components.hooks = Number(m[2])
    else if (m[1] === "MCP servers") components.mcpServers = names
  }
  const tok = /Always-on:\s+~?([\d.,]+)\s*(k?)\s*tok/i.exec(text)
  const alwaysOnTokens = tok ? Math.round(parseFloat(tok[1]!.replace(",", ".")) * (tok[2] ? 1000 : 1)) : null
  return { description, components, alwaysOnTokens }
}

/** La última línea JSON que imprimen los comandos `claude plugin … --json`. */
export function lastJsonLine(out: string): Record<string, unknown> | null {
  const lines = out.trim().split("\n").reverse()
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      return JSON.parse(t) as Record<string, unknown>
    } catch {
      // sigue buscando
    }
  }
  return null
}

/** Frontmatter simple de un SKILL.md (name y description en una línea, o description en bloque). */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  const out: Record<string, string> = {}
  const lines = m[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    let value = kv[2]!.trim()
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
      value = block.join(value.startsWith(">") ? " " : "\n")
    }
    out[kv[1]!] = value.replace(/^["']|["']$/g, "")
  }
  return out
}

export const SKILL_STATES: SkillState[] = ["on", "name-only", "user-invocable-only", "off"]

/** Un servidor de `mcp_status` (el formato del CLI) en el de la web. */
export function toMcpInfo(raw: Record<string, unknown>): McpServerInfo {
  const config = (raw.config ?? {}) as { type?: string; url?: string; command?: string; args?: string[] }
  const tools = Array.isArray(raw.tools)
    ? (raw.tools as { name?: string; annotations?: { readOnly?: boolean; destructive?: boolean } }[]).map((t) => ({
        name: String(t.name ?? ""),
        ...(t.annotations?.readOnly ? { readOnly: true } : {}),
        ...(t.annotations?.destructive ? { destructive: true } : {}),
      }))
    : []
  const target = config.url ?? (config.command ? [config.command, ...(config.args ?? [])].join(" ") : null)
  return {
    name: String(raw.name ?? ""),
    status: String(raw.status ?? "pending"),
    scope: typeof raw.scope === "string" ? raw.scope : null,
    source: typeof raw.source === "string" ? raw.source : null,
    transport: config.type ?? (config.command ? "stdio" : null),
    target,
    error: typeof raw.error === "string" ? raw.error : null,
    tools,
    ...(raw.name === "control-plane" ? { internal: true } : {}),
  }
}
