import { fileURLToPath } from "node:url"

import type { SessionRecord } from "../db.ts"

const COMPACT_HOOK = fileURLToPath(new URL("./compact-hook.mjs", import.meta.url))
/** Tiempo máximo del hook (segundos): el modo "esperarme" responde antes (compactWaitMin ≤ 45). */
const HOOK_TIMEOUT_SEC = 3600

export interface LaunchSpec {
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Arma la línea de comando de `claude` para una sesión manejada por el dashboard.
 * Es el binario instalado, sin modificar, con tu propio login.
 */
export function buildLaunch(
  session: SessionRecord,
  opts: {
    mcpUrl: string
    /** Adonde avisa el hook de compactación (PreCompact/PostCompact). */
    hookUrl: string
    protocol: string
    orchestratorCanEdit: boolean
    model: string | null
    effort: string | null
  }
): LaunchSpec {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    // Que el trabajo de los subagentes (texto incluido) llegue al stream para verlo en vivo.
    "--forward-subagent-text",
    "--permission-prompt-tool",
    "stdio",
    "--dangerously-skip-permissions",
    "--name",
    session.name,
    ...(session.startedOnce ? ["--resume", session.claudeSessionId] : ["--session-id", session.claudeSessionId]),
    "--append-system-prompt",
    opts.protocol,
    // Que los cambios de protocolo/instrucciones apliquen al reanudar la sesión.
    "--system-prompt-snapshot",
    "off",
    "--mcp-config",
    JSON.stringify({ mcpServers: { "control-plane": { type: "http", url: opts.mcpUrl } } }),
    "--settings",
    JSON.stringify({ crossSessionInbound: "accept", hooks: compactHooks(opts.hookUrl) }),
  ]
  if (opts.model) args.push("--model", opts.model)
  if (opts.effort) args.push("--effort", opts.effort)
  if (session.kind === "orchestrator" && !opts.orchestratorCanEdit) {
    args.push("--disallowedTools", "Edit", "Write", "NotebookEdit")
  }
  if (session.kind === "worker" && session.worktree && !session.startedOnce) {
    args.push("--worktree", session.name.toLowerCase())
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  }
  // Nunca heredar el socket de mensajería de otra sesión (por si el server corre dentro de una).
  delete env.CLAUDE_CODE_MESSAGING_SOCKET
  delete env.CLAUDE_CODE_MESSAGING_TOKEN
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.CLAUDECODE
  return { args, env }
}

/** Hooks con los que el dashboard participa de la compactación (se suman a los del usuario). */
function compactHooks(url: string) {
  const command = `${quote(process.execPath)} ${quote(COMPACT_HOOK)} ${quote(url)}`
  const hook = { type: "command", command, timeout: HOOK_TIMEOUT_SEC }
  return {
    PreCompact: [{ hooks: [hook] }],
    PostCompact: [{ hooks: [{ ...hook, timeout: 30 }] }],
  }
}

const quote = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`
