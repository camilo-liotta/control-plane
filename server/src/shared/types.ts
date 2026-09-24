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
  | { kind: "compact"; trigger: string; preTokens: number }
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
  | {
      type: "toast"
      level: ToastLevel
      title: string
      body?: string
      projectId?: string
      sessionId?: string
    }
