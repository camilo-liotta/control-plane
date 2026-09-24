import type { SessionRecord } from "../db.ts"

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
    JSON.stringify({ crossSessionInbound: "accept" }),
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
