// Tipos compartidos entre el server y la web. Solo tipos: la web los importa con `import type`.

export type SessionKind = "orchestrator" | "worker"

export type SessionStatus =
  | "stopped" // sin proceso (se puede reanudar)
  | "starting" // proceso lanzado, esperando handshake
  | "idle" // esperando un mensaje
  | "working" // turno en curso
  | "needs_input" // pregunta o permiso pendiente
  | "error" // el proceso terminó mal

export type TaskState =
  | "none"
  | "assigned"
  | "reported_done"
  | "reported_blocked"
  | "reported_partial"

export interface ProjectSettings {
  /** Enviar automáticamente los prompts propuestos cuando la revisión termina. */
  autoDispatch: boolean
  /** Ventana (segundos) para agrupar resultados que llegan casi juntos. */
  batchWindowSec: number
  /** Si la orquestadora puede editar archivos (por defecto no). */
  orchestratorCanEdit: boolean
  /** Instrucciones extra que se suman al protocolo de los workers. */
  workerInstructions: string
  /** Instrucciones extra que se suman al protocolo de la orquestadora. */
  orchestratorInstructions: string
  defaultModel: string | null
  defaultEffort: string | null
  /** Qué pasa cuando Claude Code va a compactar solo. */
  compactMode: CompactMode
  /** Modo "esperarme": cuántos minutos espera tu elección antes de compactar solo. */
  compactWaitMin: number
}

/**
 * auto: Claude Code compacta como siempre, sin avisar.
 * notify: te avisa cuando el contexto se está llenando, para que elijas qué conservar.
 * ask: además, cuando llega el momento, la sesión espera tu elección (hasta compactWaitMin).
 */
export type CompactMode = "auto" | "notify" | "ask"

/** Cuánto contexto usa la sesión (lo informa Claude Code después de cada turno). */
export interface ContextUsage {
  tokens: number
  max: number
  /** Dónde compacta solo Claude Code (null si no compacta por umbral). */
  threshold: number | null
  autoCompact: boolean
  categories: { name: string; tokens: number }[]
  updatedAt: number
}

export interface CompactionPoint {
  id: string
  text: string
}

export interface CompactionSection {
  title: string
  points: CompactionPoint[]
}

/** Borrador del resumen, punto por punto, para elegir qué sobrevive a la compactación. */
export interface CompactionDraft {
  sections: CompactionSection[]
  createdAt: number
  /** Tokens de contexto cuando se armó (para saber si quedó viejo). */
  contextTokens: number | null
}

export interface CompactionState {
  sessionId: string
  draft: CompactionDraft | null
  drafting: boolean
  error: string | null
  /** La sesión está por compactar y espera tu elección (modo "esperarme"). */
  waiting: { since: number; deadline: number } | null
  /** Se mandó la compactación con tu selección y todavía no terminó. */
  applying: boolean
  /** Hay un mensaje que no entró por el contexto lleno: sale solo después de compactar. */
  resendPending: boolean
}

export interface ReviewState {
  /** Resultados en cola, todavía no entregados a la orquestadora. */
  queued: number
  /** Resultados entregados en la revisión actual (todavía abierta). */
  inReview: number
  /** Hay una revisión abierta: las propuestas quedan bloqueadas. */
  active: boolean
  /** Interrumpiste a la orquestadora a mitad de revisión: no se entrega ni se libera nada solo. */
  paused: boolean
  /** Cuándo se entrega el próximo lote (ventana de agrupación). */
  deliverAt: number | null
}

export interface Project {
  id: string
  name: string
  repoPath: string
  settings: ProjectSettings
  accountId: string | null
  createdAt: number
  archivedAt: number | null
  review: ReviewState
}

export interface QuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: QuestionOption[]
}

export type PendingRequest =
  | { kind: "question"; requestId: string; eventId: number }
  | { kind: "permission"; requestId: string; eventId: number; toolName: string }

export interface Session {
  id: string
  projectId: string
  kind: SessionKind
  name: string
  role: string
  claudeSessionId: string
  model: string | null
  effort: string | null
  worktree: boolean
  cwd: string
  status: SessionStatus
  statusDetail: string | null
  taskTitle: string | null
  taskState: TaskState
  lastActivity: string | null
  lastActivityAt: number | null
  costUsd: number
  createdAt: number
  archivedAt: number | null
  pending: PendingRequest | null
  /** Mensajes enviados que el CLI todavía no empezó a procesar. */
  queuedMessages: number
  /** Último texto que escribió la sesión (para las tarjetas). */
  lastText: string | null
  /** Modelo que está usando ahora el proceso (lo informa el CLI en cada turno). */
  currentModel: string | null
  /** Subagentes trabajando en este momento. */
  subagentsRunning: number
  /** Tokens acumulados de la sesión (incluye a sus subagentes). */
  tokens: TokenUsage | null
  /** Subagentes activos y recientes de este proceso (para el mapa del proyecto). */
  subagents: SubagentBrief[]
  /** Uso de contexto al terminar el último turno. */
  context: ContextUsage | null
  /** La conversación está abierta fuera del dashboard (en una terminal o en segundo plano). */
  external: ExternalSession | null
}

export interface RepoInfo {
  path: string
  /** Relativo a la carpeta del proyecto ("" si es la raíz). */
  name: string
  isRoot: boolean
  branch: string | null
  remote: string | null
  github: { owner: string; repo: string; url: string; branchUrl: string | null } | null
  head: { hash: string; subject: string; at: number | null; author: string | null } | null
  /** Archivos con cambios sin commitear (null si no se pudo leer). */
  changes: number | null
  ahead: number | null
  behind: number | null
  /** Otros worktrees del repo (donde suelen trabajar las sesiones en sus ramas). */
  worktrees: { path: string; branch: string | null }[]
}

export interface ProjectOverview {
  projectId: string
  repos: RepoInfo[]
  /** Todo lo que gastaron las sesiones del proyecto, incluidas las archivadas. */
  tokens: TokenUsage
  costUsd: number
  sessions: number
  lastActivity: { sessionId: string; name: string; kind: SessionKind; at: number; text: string | null } | null
  at: number
}

export interface TurnProgress {
  startedAt: number
  /** Tokens que devolvió el modelo en este turno (estimados mientras llegan). */
  tokens: number
}

export interface ExternalSession {
  pid: number | null
  kind: "interactive" | "background"
  /** Id corto de Claude Code (para `claude stop <id>` en las de segundo plano). */
  id: string | null
}

export interface SubagentBrief {
  toolUseId: string
  name: string | null
  description: string
  subagentType: string | null
  model: string | null
  status: SubagentStatus
  startedAt: number
  endedAt: number | null
  tokens: number | null
  lastActivity: string | null
}

export interface AccountAuth {
  loggedIn: boolean
  email?: string
  organization?: string
  subscription?: string
  method?: string
  error?: string
}

/** Una cuenta de Claude Code (un directorio de configuración con su login). */
export interface Account {
  id: string
  name: string
  configDir: string
  isDefault: boolean
  bin: string | null
  auth: AccountAuth | null
  usage: UsageInfo | null
  projects: number
}

export type ClaudeSettingValue = string | boolean | null

/** Una opción del menú /config de Claude Code, con su valor actual en la cuenta. */
export interface ClaudeSetting {
  key: string
  label: string
  description: string
  group: string
  type: "boolean" | "enum"
  options?: { value: string; label: string }[]
  /** Dónde lo guarda Claude Code: settings.json de la cuenta o su config global (.claude.json). */
  file: "user" | "global"
  value: ClaudeSettingValue
  defaultValue: ClaudeSettingValue
  isSet: boolean
  terminalOnly?: boolean
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** Subagente que la orquestadora le pide a un worker, con su rol, tarea y reglas. */
export interface SubagentSpec {
  name: string
  role: string
  task: string
  rules: string[]
  model: string | null
  background: boolean
  readOnly: boolean
}

export interface AttachmentRef {
  id: string
  name: string
  mime: string
  size: number
}

export interface Attachment extends AttachmentRef {
  sessionId: string
  source: "user" | "tool"
  createdAt: number
}

export interface SlashCommand {
  name: string
  description: string
  argumentHint: string
  builtin?: boolean
}

// ------------------------------------------------------------ herramientas

export type McpStatus = "connected" | "failed" | "needs-auth" | "pending" | "disabled" | (string & {})

export interface McpTool {
  name: string
  readOnly?: boolean
  destructive?: boolean
}

/** Un servidor MCP como lo ve Claude Code en esa cuenta y carpeta. */
export interface McpServerInfo {
  name: string
  status: McpStatus
  /** user (tu cuenta) · local (solo vos en este proyecto) · project (.mcp.json) · claudeai (conector) · dynamic (plugin o dashboard) · managed */
  scope: string | null
  source: string | null
  transport: string | null
  /** URL o comando. */
  target: string | null
  error: string | null
  tools: McpTool[]
  /** El MCP propio del dashboard: no se puede tocar desde acá. */
  internal?: boolean
}

export interface PluginComponents {
  skills: string[]
  agents: string[]
  commands: string[]
  hooks: number
  mcpServers: string[]
}

export interface PluginInfo {
  /** nombre@marketplace */
  id: string
  name: string
  marketplace: string
  version: string | null
  /** user · project · local · synced (de tu organización) · managed */
  scope: string | null
  enabled: boolean
  description: string | null
  components: PluginComponents | null
  /** Tokens que suma a cada sesión aunque no se use. */
  alwaysOnTokens: number | null
}

export interface CatalogPlugin {
  id: string
  name: string
  description: string
  marketplace: string
  installs: number | null
  installed: boolean
}

export interface Marketplace {
  name: string
  source: string
  repo?: string
  url?: string
  path?: string
}

export type SkillState = "on" | "name-only" | "user-invocable-only" | "off"

export interface SkillInfo {
  name: string
  description: string
  /** user · project · plugin · bundled · managed */
  source: string
  plugin: string | null
  /** SKILL.md (o el .md del comando), si se puede abrir. */
  path: string | null
  /** Tokens que ocupa en el contexto de cada sesión (su nombre y descripción). */
  tokens: number | null
  state: SkillState
  /** Dónde está definido el estado (si no es el de siempre). */
  stateScope: "user" | "project" | "local" | null
  /** Se puede editar el archivo desde el dashboard. */
  editable: boolean
}

/** Una skill de un marketplace (fuente de skills o marketplace de plugins), para instalarla suelta. */
export interface CatalogSkill {
  /** "<fuente>::<carpeta relativa>" */
  id: string
  name: string
  description: string
  sourceId: string
  sourceName: string
  /** Si viene adentro de un plugin de un marketplace de plugins. */
  plugin: string | null
  /** Si ya hay una skill con ese nombre en tu cuenta o en el proyecto. */
  installed: "user" | "project" | null
}

export interface SkillSourceView {
  id: string
  name: string
  kind: "git" | "local" | "plugin-marketplace"
  url: string | null
  path: string
  skills: number
  updatedAt: number | null
  /** Las de marketplaces de plugins se administran en Plugins. */
  removable: boolean
}

export interface SkillMarketView {
  sources: SkillSourceView[]
  skills: CatalogSkill[]
  suggested: { name: string; url: string; description: string }[]
}

export interface ToolsView {
  accountId: string
  projectId: string | null
  cwd: string
  mcp: McpServerInfo[]
  plugins: PluginInfo[]
  skills: SkillInfo[]
  /** De dónde salió lo que ves: una sesión abierta, o una consulta a Claude Code sin sesión. */
  via: { kind: "session"; sessionId: string; name: string } | { kind: "inspector" }
  at: number
}

export type SubagentStatus = "running" | "completed" | "failed" | "killed"

export interface SubagentUsage {
  tokens: number
  toolUses: number
  durationMs: number
}

export type DraftKind = "prompt" | "session"

export type DraftState =
  | "staged" // en preparación: la orquestadora está revisando, no se puede enviar
  | "ready" // lista para que la apruebes
  | "sent"
  | "discarded"

export interface Draft {
  id: string
  projectId: string
  kind: DraftKind
  targetSessionId: string | null
  newSession: { name: string; role: string } | null
  title: string
  prompt: string
  state: DraftState
  createdBy: string | null
  createdAt: number
  updatedAt: number
  decidedAt: number | null
  edited: boolean
  revision: number
  subagents: SubagentSpec[]
  /** La sesión empieza de cero (/clear) antes de este prompt. */
  fresh: boolean
}

export type ReportStatus = "done" | "blocked" | "partial"

export type ReportState = "queued" | "in_review" | "reviewed" | "dismissed"

export interface Report {
  id: string
  projectId: string
  sessionId: string
  sessionName: string
  taskTitle: string | null
  status: ReportStatus
  summary: string
  details: string | null
  state: ReportState
  createdAt: number
  deliveredAt: number | null
  reviewedAt: number | null
}

export type UserOrigin = "user" | "draft" | "control" | "external"

export type TimelineEvent =
  | {
      kind: "user"
      text: string
      origin: UserOrigin
      uuid: string
      draftId?: string
      draftTitle?: string
      attachments?: AttachmentRef[]
      /** Subagentes que pidió la orquestadora en esta propuesta (el texto enviado incluye sus instrucciones). */
      subagents?: SubagentSpec[]
    }
  | { kind: "peer"; from: string; body: string }
  | {
      kind: "text"
      text: string
      messageId: string
      parent: string | null
      aborted?: boolean
    }
  | { kind: "thinking"; text: string; messageId: string; parent: string | null }
  | {
      kind: "tool_use"
      id: string
      name: string
      input: unknown
      parent: string | null
    }
  | {
      kind: "tool_result"
      toolUseId: string
      content: string
      isError: boolean
      structured?: unknown
      truncated?: boolean
      parent: string | null
      images?: AttachmentRef[]
    }
  | {
      kind: "turn_end"
      ok: boolean
      subtype: string
      durationMs: number
      costUsd: number
      /** Tokens de este turno (entrada + salida + caché). */
      tokens?: number
      terminalReason?: string
      error?: string
    }
  | {
      kind: "question"
      requestId: string
      toolUseId: string
      questions: Question[]
      state: "pending" | "answered" | "cancelled"
      answers?: Record<string, string>
    }
  | {
      kind: "permission"
      requestId: string
      toolName: string
      input: unknown
      state: "pending" | "allowed" | "denied" | "cancelled"
    }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "batch"; reportIds: string[]; text: string; followUp: boolean }
  | {
      kind: "compact"
      trigger: string
      preTokens: number
      postTokens?: number
      durationMs?: number
      /** El resumen con el que siguió la conversación. */
      summary?: string
      /** Si la compactación usó tu selección: cuántos puntos quedaron y cuántos descartaste. */
      kept?: number
      dropped?: number
    }
  | {
      kind: "subagent"
      toolUseId: string
      taskId: string
      description: string
      subagentType: string | null
      name: string | null
      model: string | null
      background: boolean
      prompt: string
      status: SubagentStatus
      startedAt: number
      endedAt: number | null
      usage: SubagentUsage | null
      lastActivity: string | null
      summary: string | null
      /** Llamada Agent que lanzó a este subagente, si es un subagente de otro subagente. */
      parent: string | null
    }

export interface StoredEvent {
  id: number
  sessionId: string
  ts: number
  event: TimelineEvent
}

export interface UsageWindow {
  utilization: number
  resetsAt: number
}

export interface UsageInfo {
  status: string | null
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  updatedAt: number
}

export interface ModelOption {
  value: string
  label: string
  description?: string
  efforts?: string[]
  /** Id real del modelo (ej. claude-sonnet-5), para reconocer el que está usando una sesión. */
  resolved?: string
}

export interface Meta {
  version: string
  claudeVersion: string | null
  models: ModelOption[]
  account: { email?: string; organization?: string; subscription?: string } | null
  homeDir: string
}

export interface Snapshot {
  projects: Project[]
  sessions: Session[]
  drafts: Draft[]
  reports: Report[]
  accounts: Account[]
  compactions: CompactionState[]
  turns: { sessionId: string; turn: TurnProgress }[]
  tasks: UserTask[]
  meta: Meta
}

export type ToastLevel = "info" | "success" | "warn" | "error"

export type ServerMessage =
  | { type: "hello"; snapshot: Snapshot }
  | { type: "project"; project: Project }
  | { type: "session"; session: Session }
  | { type: "event"; event: StoredEvent }
  | { type: "event_update"; event: StoredEvent }
  | {
      type: "partial"
      sessionId: string
      messageId: string
      index: number
      block: "text" | "thinking"
      delta: string
    }
  | { type: "partial_clear"; sessionId: string }
  | { type: "draft"; draft: Draft }
  | { type: "report"; report: Report }
  | { type: "usage"; accountId: string; usage: UsageInfo }
  | { type: "account"; account: Account }
  | { type: "account_removed"; id: string }
  | { type: "meta"; meta: Meta }
  | { type: "compaction"; state: CompactionState }
  /** El turno en curso de una sesión (null cuando termina): para el indicador de "trabajando". */
  | { type: "turn"; sessionId: string; turn: TurnProgress | null }
  /** Cambió algo de los CLIs (un login o una instalación que avanzó o terminó). */
  | { type: "clis_changed" }
  | { type: "task"; task: UserTask }
  | {
      type: "toast"
      level: ToastLevel
      title: string
      body?: string
      projectId?: string
      sessionId?: string
      /** Qué abrir al tocar "Ver" (por defecto, la sesión). */
      open?: "compaction"
      /** De qué se trata, para elegir el sonido. */
      event?: NoticeEvent
    }

// ------------------------------------------------------------------ CLIs

/** Los tipos de aviso de la bandeja, cada uno con su sonido. */
export type NoticeEvent = "result" | "blocked" | "needs_you" | "proposals" | "compaction" | "error" | "task"

// ------------------------------------------------------------------ tareas para vos

export type UserTaskStatus = "open" | "done" | "dismissed"

/** Algo que las sesiones necesitan que hagas vos (un login, una web, una aprobación en otro sistema). */
export interface UserTask {
  id: string
  projectId: string
  title: string
  /** Pasos cortos, en orden. Pueden tener `comandos` y links. */
  steps: string[]
  /** Para qué hace falta, en una línea. */
  why: string | null
  /** Alguna sesión está frenada esperando esto. */
  blocking: boolean
  /** Para cuándo (las que tienen día, como "el 30/9 a la noche"). */
  due: number | null
  /** Quién la pidió (id de sesión) o null si la creaste vos. */
  createdBy: string | null
  /** Otras sesiones que pidieron lo mismo. */
  alsoBy: string[]
  status: UserTaskStatus
  /** Cómo se cerró ("ya estaba hecho", tu nota al marcarla). */
  note: string | null
  /** "user" o el id de la sesión que la cerró. */
  closedBy: string | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
}

export type CliAuthState = "ok" | "expired" | "logged_out" | "unknown"

export interface CliCredential {
  index: number
  /** Qué credencial es, si el CLI tiene más de una (ej. gcloud: tu usuario y las de aplicación). */
  label: string | null
  state: CliAuthState
  account: string | null
  detail: string | null
  /** Si el login pide pegar una credencial, no hay botón: este comando es para la terminal. */
  terminalLogin: string | null
}

export interface CliInfo {
  id: string
  name: string
  description: string
  category: string
  docs: string
  installed: boolean
  path: string | null
  version: string | null
  /** Cómo instalarlo en esta máquina; runnable: el dashboard lo puede correr (no pide sudo). */
  install: { command: string; runnable: boolean } | null
  credentials: CliCredential[]
  /** Cuántas veces lo usaron tus sesiones (últimos 30 días). */
  usage: { count: number; lastAt: number } | null
  /** Cuántas veces lo quisieron usar y no estaba instalado ("command not found"). */
  wanted: number
}

/** Un programa que usaron tus sesiones y no está en el catálogo. */
export interface UsedProgram {
  name: string
  path: string
  count: number
  lastAt: number
  projects: string[]
}

export interface CliJob {
  id: string
  cliId: string
  kind: "login" | "install"
  label: string
  command: string
  status: "running" | "done" | "failed"
  exitCode: number | null
  /** Lo que imprime (sin tokens), para ver links, códigos o preguntas. */
  output: string
  urls: string[]
  code: string | null
  startedAt: number
  endedAt: number | null
}

export interface CliView {
  platform: string
  at: number
  clis: CliInfo[]
  jobs: CliJob[]
  used: UsedProgram[]
  /** Todavía está leyendo los transcripts (la primera vez tarda). */
  usageScanning: boolean
}
