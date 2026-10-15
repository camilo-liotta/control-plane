import path from "node:path"

import { config } from "../config.ts"
import { childEnv } from "./env.ts"
import type { SessionRecord } from "../db.ts"
import { writePrivateFile } from "./run-files.ts"

/** Tiempo máximo del hook (segundos): el modo "esperarme" responde antes (compactWaitMin ≤ 45). */
const HOOK_TIMEOUT_SEC = 3600

/** Tiempo máximo del hook de SendMessage (segundos); el script deniega antes si el server no contesta. */
const SEND_HOOK_TIMEOUT_SEC = 30

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
    /** Base de los hooks de la sesión en el server: .../compact (PreCompact/PostCompact) y .../send-message (PreToolUse). */
    hookUrl: string
    /**
     * La carpeta privada de la sesión (0700, ver run-files.ts): ahí se escriben, en 0600, la config del MCP, los
     * settings y las URLs de los hooks, para que los tokens no queden en los argumentos del proceso.
     */
    runDir: string
    protocol: string
    orchestratorCanEdit: boolean
    model: string | null
    effort: string | null
  }
): LaunchSpec {
  const mcpConfig = path.join(opts.runDir, "mcp.json")
  writePrivateFile(mcpConfig, JSON.stringify({ mcpServers: { "control-plane": { type: "http", url: opts.mcpUrl } } }))
  const settings = path.join(opts.runDir, "settings.json")
  // disableAllHooks: false gana sobre el que ponga un settings del proyecto o del usuario (los
  // workers pueden escribirlos), que si no apagaría también el cerrojo de SendMessage.
  writePrivateFile(settings, JSON.stringify({ crossSessionInbound: "accept", disableAllHooks: false, hooks: sessionHooks(opts.hookUrl, opts.runDir) }))
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
    mcpConfig,
    "--settings",
    settings,
  ]
  if (opts.model) args.push("--model", opts.model)
  if (opts.effort) args.push("--effort", opts.effort)
  if (session.kind === "orchestrator" && !opts.orchestratorCanEdit) {
    args.push("--disallowedTools", "Edit", "Write", "NotebookEdit")
  }
  if (session.kind === "worker" && session.worktree && !session.startedOnce) {
    args.push("--worktree", session.name.toLowerCase())
  }
  const env = childEnv({ CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" })
  // Nunca heredar el socket de mensajería de otra sesión (por si el server corre dentro de una).
  delete env.CLAUDE_CODE_MESSAGING_SOCKET
  delete env.CLAUDE_CODE_MESSAGING_TOKEN
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.CLAUDECODE
  return { args, env }
}

/**
 * Los hooks con los que el dashboard participa de la sesión (se suman a los del usuario): la compactación
 * y el cerrojo de SendMessage, que solo deja escribirle a sesiones del propio proyecto.
 */
function sessionHooks(base: string, runDir: string) {
  // El script lee la URL (que lleva el token) de un archivo: "@ruta" en vez de la URL, para que tampoco
  // aparezca en los argumentos del proceso del hook.
  const command = (name: string, endpoint: string, ...flags: string[]) => {
    const file = path.join(runDir, `hook-${name}.url`)
    writePrivateFile(file, `${base}/${endpoint}`)
    return [quote(process.execPath), quote(config.compactHook), quote(`@${file}`), ...flags].join(" ")
  }
  const hook = { type: "command", command: command("compact", "compact"), timeout: HOOK_TIMEOUT_SEC }
  return {
    PreCompact: [{ hooks: [hook] }],
    PostCompact: [{ hooks: [{ ...hook, timeout: 30 }] }],
    // Falla cerrado: si el server no contesta, el script deniega (ver compact-hook.mjs).
    PreToolUse: [{ matcher: "SendMessage", hooks: [{ type: "command", command: command("send-message", "send-message", "--deny-on-error"), timeout: SEND_HOOK_TIMEOUT_SEC }] }],
  }
}

const quote = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`
