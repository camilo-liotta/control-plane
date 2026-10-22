import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { Fingerprint } from "./fingerprint.ts"
import type {
  AfkEndReason,
  AfkState,
  AppDef,
  AppHealth,
  Attachment,
  Credential,
  Environment,
  ContextUsage,
  Draft,
  DraftKind,
  PlanState,
  PlanStep,
  DraftState,
  ProjectSettings,
  ProjectMessage,
  Report,
  ReportState,
  ReportStatus,
  SessionKind,
  SessionStatus,
  StoredEvent,
  SubagentSpec,
  TaskState,
  TokenUsage,
  TimelineEvent,
  UserTask,
  UserTaskCli,
  UserTaskStatus,
} from "./shared/types.ts"

export const defaultSettings: ProjectSettings = {
  batchWindowSec: 15,
  orchestratorCanEdit: false,
  workerInstructions: "",
  orchestratorInstructions: "",
  defaultModel: null,
  defaultEffort: null,
  workerModel: null,
  workerEffort: null,
  compactMode: "notify",
  compactWaitMin: 10,
}

export interface ProjectRecord {
  id: string
  name: string
  repoPath: string
  settings: ProjectSettings
  afk: AfkState | null
  accountId: string | null
  createdAt: number
  archivedAt: number | null
}

/** Un período AFK de un proyecto (abierto mientras endedAt es null). */
export interface AfkPeriodRow {
  id: number
  projectId: string
  since: number
  until: number | null
  budgetUsd: number | null
  spentAtStart: number
  /** El costo por modelo del proyecto al entrar. */
  costByModelAtStart: Record<string, number>
  endedAt: number | null
  endReason: AfkEndReason | null
  /** Lo gastado en el período, fijado al terminar. */
  spentUsd: number | null
  costByModel: Record<string, number> | null
}

/** Una cuenta de Claude Code: un directorio de configuración (CLAUDE_CONFIG_DIR) con su login. */
export interface AccountRecord {
  id: string
  name: string
  /** null = la de siempre (~/.claude, o CLAUDE_CONFIG_DIR si el server arrancó con esa variable). */
  configDir: string | null
  /** Binario a usar (por defecto, claude). */
  bin: string | null
  createdAt: number
}

export interface SessionRecord {
  id: string
  projectId: string
  kind: SessionKind
  name: string
  role: string
  claudeSessionId: string
  startedOnce: boolean
  mcpToken: string
  model: string | null
  effort: string | null
  worktree: boolean
  cwd: string
  status: SessionStatus
  taskTitle: string | null
  taskState: TaskState
  lastActivity: string | null
  lastActivityAt: number | null
  costUsd: number
  costByModel: Record<string, number>
  tokens: TokenUsage | null
  context: ContextUsage | null
  createdAt: number
  archivedAt: number | null
}

type Row = Record<string, unknown>

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    claude_session_id TEXT NOT NULL,
    started_once INTEGER NOT NULL DEFAULT 0,
    mcp_token TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    worktree INTEGER NOT NULL DEFAULT 0,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'stopped',
    task_title TEXT,
    task_state TEXT NOT NULL DEFAULT 'none',
    last_activity TEXT,
    last_activity_at INTEGER,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE UNIQUE INDEX sessions_token ON sessions(mcp_token);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_session ON events(session_id, id);
  CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_session_id TEXT,
    new_session TEXT,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    state TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_at INTEGER,
    edited INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX drafts_project ON drafts(project_id, state);
  CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    task_title TEXT,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    reviewed_at INTEGER
  );
  CREATE INDEX reports_project ON reports(project_id, state);
  `,
  `
  ALTER TABLE drafts ADD COLUMN subagents TEXT;
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_session ON attachments(session_id, created_at);
  `,
  `
  ALTER TABLE sessions ADD COLUMN tokens TEXT;
  `,
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config_dir TEXT,
    bin TEXT,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE projects ADD COLUMN account_id TEXT;
  `,
  `
  ALTER TABLE sessions ADD COLUMN context TEXT;
  `,
  `
  ALTER TABLE drafts ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE user_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    steps TEXT NOT NULL,
    why TEXT,
    blocking INTEGER NOT NULL DEFAULT 0,
    due INTEGER,
    created_by TEXT,
    also_by TEXT,
    status TEXT NOT NULL,
    note TEXT,
    closed_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    reminded_at INTEGER
  );
  CREATE INDEX user_tasks_project ON user_tasks(project_id, status);
  `,
  `
  CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    url TEXT,
    app_id TEXT,
    notes TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    username TEXT,
    secret TEXT,
    login_url TEXT,
    notes TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (environment_id, name)
  );
  `,
  `
  ALTER TABLE user_tasks ADD COLUMN cli TEXT;
  ALTER TABLE user_tasks ADD COLUMN priority INTEGER;
  ALTER TABLE user_tasks ADD COLUMN tags TEXT;
  `,
  `
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    shell INTEGER NOT NULL DEFAULT 0,
    cwd TEXT NOT NULL DEFAULT '',
    env TEXT NOT NULL DEFAULT '{}',
    health TEXT,
    url TEXT,
    stop_command TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX apps_project ON apps(project_id);
  `,
  `
  ALTER TABLE drafts ADD COLUMN model TEXT;
  ALTER TABLE drafts ADD COLUMN effort TEXT;
  ALTER TABLE drafts ADD COLUMN steps TEXT;
  ALTER TABLE drafts ADD COLUMN plan_state TEXT;
  ALTER TABLE drafts ADD COLUMN current_step INTEGER;
  ALTER TABLE drafts ADD COLUMN plan_note TEXT;
  ALTER TABLE drafts ADD COLUMN revises TEXT;
  `,
  `
  ALTER TABLE sessions ADD COLUMN cost_by_model TEXT;
  `,
  `
  CREATE TABLE project_messages (
    id TEXT PRIMARY KEY,
    from_project_id TEXT NOT NULL,
    to_project_id TEXT NOT NULL,
    from_session_id TEXT NOT NULL,
    to_session_id TEXT,
    text TEXT NOT NULL,
    reply_to TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX project_messages_to ON project_messages(to_project_id, delivered_at);
  CREATE INDEX project_messages_from ON project_messages(from_project_id, created_at);
  `,
  `
  ALTER TABLE projects ADD COLUMN afk TEXT;
  ALTER TABLE drafts ADD COLUMN hold INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE drafts ADD COLUMN sent_by TEXT;
  CREATE TABLE afk_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    since INTEGER NOT NULL,
    until INTEGER,
    budget_usd REAL,
    spent_at_start REAL NOT NULL DEFAULT 0,
    cost_by_model_at_start TEXT,
    ended_at INTEGER,
    end_reason TEXT,
    spent_usd REAL,
    cost_by_model TEXT
  );
  CREATE INDEX afk_periods_project ON afk_periods(project_id, since);
  -- Lo que ya estaba enviándose solo (autoDispatch) pasa a AFK sin límites en migrateAutoDispatch.
  UPDATE drafts SET sent_by = 'user' WHERE state = 'sent';
  `,
  `
  CREATE TABLE session_fingerprints (
    session_id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  `,
  // Acceso remoto (Tailscale): una sola fila de ajustes. Apagado de fábrica; los puertos son los de siempre.
  `
  CREATE TABLE remote_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'read',
    require_local_dangerous INTEGER NOT NULL DEFAULT 1,
    https_port INTEGER NOT NULL DEFAULT 8443,
    local_port INTEGER NOT NULL DEFAULT 4710,
    origin TEXT,
    serve_owned INTEGER NOT NULL DEFAULT 0,
    serve_target TEXT,
    serve_created_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO remote_config (id, updated_at) VALUES (1, 0);
  `,
  // Dispositivos emparejados y enlaces de pareo. Solo se guardan los hashes (sha256) de lo secreto.
  `
  CREATE TABLE remote_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'read',
    token_hash TEXT NOT NULL UNIQUE,
    ts_login TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE remote_pairings (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    name TEXT,
    tier TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX remote_pairings_hash ON remote_pairings(token_hash);
  `,
  // Auditoría del acceso remoto: acotada (ver remote/audit.ts). Nunca guarda cuerpos, mensajes, inputs, cookies ni tokens.
  `
  CREATE TABLE remote_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    device_id TEXT,
    kind TEXT NOT NULL,
    method TEXT,
    route TEXT,
    target_id TEXT,
    tool_name TEXT,
    input_hash TEXT,
    status INTEGER,
    outcome TEXT NOT NULL,
    reason TEXT
  );
  CREATE INDEX remote_audit_at ON remote_audit(at);
  `,
]

/** Un dispositivo emparejado (la fila de remote_devices; el hash es de la cookie, nunca la cookie). */
export interface RemoteDeviceRow {
  id: string
  name: string
  tier: "read" | "respond" | "control"
  tokenHash: string
  tsLogin: string | null
  createdAt: number
  expiresAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export interface RemotePairingRow {
  id: string
  tokenHash: string
  name: string | null
  tier: "read" | "respond" | "control"
  expiresAt: number
  usedAt: number | null
}

/** Una fila de remote_audit (ver remote/audit.ts). */
export interface RemoteAuditRow {
  id?: number
  at: number
  deviceId: string | null
  kind: string
  method: string | null
  route: string | null
  targetId: string | null
  toolName: string | null
  inputHash: string | null
  status: number | null
  outcome: string
  reason: string | null
}

/** Los ajustes del acceso remoto (la fila única de remote_config). */
export interface RemoteConfig {
  enabled: boolean
  /** El techo de nivel de todos los dispositivos: read, respond o control. */
  tier: "read" | "respond" | "control"
  requireLocalForDangerous: boolean
  httpsPort: number
  localPort: number
  /** https://<dns>:<puerto>, el único Origin válido mientras está activo. */
  origin: string | null
  /** Si la entrada de serve la creamos nosotros (solo esa se saca). */
  serveOwned: boolean
  serveTarget: string | null
  serveCreatedAt: number | null
  updatedAt: number
}

const bool = (v: unknown) => v === 1 || v === true
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const str = (v: unknown) => (v === null || v === undefined ? null : String(v))

function toApp(r: Row): AppDef {
  const json = <T>(v: unknown, fallback: T): T => {
    try {
      return v === null || v === undefined ? fallback : (JSON.parse(String(v)) as T)
    } catch {
      return fallback
    }
  }
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    command: String(r.command),
    shell: bool(r.shell),
    cwd: String(r.cwd ?? ""),
    env: json<Record<string, string>>(r.env, {}),
    health: json<AppHealth | null>(r.health, null),
    url: str(r.url),
    stopCommand: str(r.stop_command),
    createdBy: str(r.created_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

function toProject(r: Row): ProjectRecord {
  let settings: Partial<ProjectSettings> = {}
  try {
    settings = JSON.parse(String(r.settings ?? "{}"))
  } catch {
    settings = {}
  }
  return {
    id: String(r.id),
    name: String(r.name),
    repoPath: String(r.repo_path),
    settings: { ...defaultSettings, ...settings },
    afk: parseAfk(r.afk),
    accountId: str(r.account_id),
    createdAt: Number(r.created_at),
    archivedAt: num(r.archived_at),
  }
}

function toAccount(r: Row): AccountRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    configDir: str(r.config_dir),
    bin: str(r.bin),
    createdAt: Number(r.created_at),
  }
}

function toSession(r: Row): SessionRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: r.kind as SessionKind,
    name: String(r.name),
    role: String(r.role ?? ""),
    claudeSessionId: String(r.claude_session_id),
    startedOnce: bool(r.started_once),
    mcpToken: String(r.mcp_token),
    model: str(r.model),
    effort: str(r.effort),
    worktree: bool(r.worktree),
    cwd: String(r.cwd),
    status: r.status as SessionStatus,
    taskTitle: str(r.task_title),
    taskState: (r.task_state as TaskState) ?? "none",
    lastActivity: str(r.last_activity),
    lastActivityAt: num(r.last_activity_at),
    costUsd: Number(r.cost_usd ?? 0),
    costByModel: parseCostByModel(r.cost_by_model),
    tokens: parseTokens(r.tokens),
    context: parseContext(r.context),
    createdAt: Number(r.created_at),
    archivedAt: num(r.archived_at),
  }
}

function parseAfk(raw: unknown): AfkState | null {
  if (!raw) return null
  try {
    const a = JSON.parse(String(raw)) as Partial<AfkState>
    if (typeof a.since !== "number") return null
    return {
      since: a.since,
      until: typeof a.until === "number" ? a.until : null,
      budgetUsd: typeof a.budgetUsd === "number" ? a.budgetUsd : null,
      spentAtStart: typeof a.spentAtStart === "number" ? a.spentAtStart : 0,
    }
  } catch {
    return null
  }
}

function toPeriod(r: Row): AfkPeriodRow {
  return {
    id: Number(r.id),
    projectId: String(r.project_id),
    since: Number(r.since),
    until: num(r.until),
    budgetUsd: num(r.budget_usd),
    spentAtStart: Number(r.spent_at_start ?? 0),
    costByModelAtStart: parseCostByModel(r.cost_by_model_at_start),
    endedAt: num(r.ended_at),
    endReason: (str(r.end_reason) as AfkEndReason | null) ?? null,
    spentUsd: num(r.spent_usd),
    costByModel: r.cost_by_model === null || r.cost_by_model === undefined ? null : parseCostByModel(r.cost_by_model),
  }
}

function parseTokens(raw: unknown): TokenUsage | null {
  if (!raw) return null
  try {
    const t = JSON.parse(String(raw)) as TokenUsage
    return typeof t.total === "number" ? t : null
  } catch {
    return null
  }
}

function parseCostByModel(raw: unknown): Record<string, number> {
  if (!raw) return {}
  try {
    const o = JSON.parse(String(raw)) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(o ?? {})) if (typeof v === "number" && v > 0) out[k] = v
    return out
  } catch {
    return {}
  }
}

function parseContext(raw: unknown): ContextUsage | null {
  if (!raw) return null
  try {
    const c = JSON.parse(String(raw)) as ContextUsage
    return typeof c.tokens === "number" && typeof c.max === "number" ? c : null
  } catch {
    return null
  }
}

function parseSubagents(raw: unknown): SubagentSpec[] {
  if (!raw) return []
  try {
    const list = JSON.parse(String(raw)) as SubagentSpec[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function toDraft(r: Row): Draft {
  let newSession: Draft["newSession"] = null
  if (r.new_session) {
    try {
      newSession = JSON.parse(String(r.new_session))
    } catch {
      newSession = null
    }
  }
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    kind: r.kind as DraftKind,
    targetSessionId: str(r.target_session_id),
    newSession,
    title: String(r.title),
    prompt: String(r.prompt),
    state: r.state as DraftState,
    createdBy: str(r.created_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    decidedAt: num(r.decided_at),
    edited: bool(r.edited),
    revision: Number(r.revision ?? 1),
    subagents: parseSubagents(r.subagents),
    fresh: bool(r.fresh),
    model: str(r.model),
    effort: str(r.effort),
    steps: parseSteps(r.steps),
    planState: (str(r.plan_state) as PlanState | null) ?? null,
    currentStep: num(r.current_step),
    planNote: str(r.plan_note),
    revises: str(r.revises),
    hold: bool(r.hold),
    sentBy: r.sent_by === "user" || r.sent_by === "afk" ? r.sent_by : null,
  }
}

function parseSteps(v: unknown): PlanStep[] {
  if (v === null || v === undefined) return []
  try {
    const list = JSON.parse(String(v))
    return Array.isArray(list) ? (list as PlanStep[]) : []
  } catch {
    return []
  }
}

/** Un entorno tal como está en la base (las credenciales van aparte). */
export type EnvironmentRecord = Omit<Environment, "credentials">

/** Una credencial tal como está en la base: con el secreto. No sale del server salvo pedido explícito. */
export interface CredentialRecord extends Omit<Credential, "hasSecret"> {
  secret: string | null
}

function toEnvironment(r: Row): EnvironmentRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    url: str(r.url),
    appId: str(r.app_id),
    notes: str(r.notes),
    createdBy: str(r.created_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

function toCredential(r: Row): CredentialRecord {
  return {
    id: String(r.id),
    environmentId: String(r.environment_id),
    name: String(r.name),
    username: str(r.username),
    secret: str(r.secret),
    loginUrl: str(r.login_url),
    notes: str(r.notes),
    createdBy: str(r.created_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export interface AttachmentRecord extends Attachment {
  path: string
}

function toAttachment(r: Row): AttachmentRecord {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    name: String(r.name),
    mime: String(r.mime),
    size: Number(r.size),
    path: String(r.path),
    source: r.source === "tool" ? "tool" : "user",
    createdAt: Number(r.created_at),
  }
}

/** Lo que guarda la base de un mensaje entre proyectos; los nombres los pone la vista. */
export type ProjectMessageRow = Omit<ProjectMessage, "fromProjectName" | "toProjectName">

function toProjectMessage(r: Row): ProjectMessageRow {
  return {
    id: String(r.id),
    fromProjectId: String(r.from_project_id),
    toProjectId: String(r.to_project_id),
    fromSessionId: String(r.from_session_id),
    toSessionId: str(r.to_session_id),
    text: String(r.text),
    replyTo: str(r.reply_to),
    createdAt: Number(r.created_at),
    deliveredAt: num(r.delivered_at),
  }
}

export type ReportRow = Omit<Report, "sessionName">

function toReport(r: Row): ReportRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    sessionId: String(r.session_id),
    taskTitle: str(r.task_title),
    status: r.status as ReportStatus,
    summary: String(r.summary),
    details: str(r.details),
    state: r.state as ReportState,
    createdAt: Number(r.created_at),
    deliveredAt: num(r.delivered_at),
    reviewedAt: num(r.reviewed_at),
  }
}

const SESSION_COLUMNS: Record<keyof SessionRecord, string> = {
  id: "id",
  projectId: "project_id",
  kind: "kind",
  name: "name",
  role: "role",
  claudeSessionId: "claude_session_id",
  startedOnce: "started_once",
  mcpToken: "mcp_token",
  model: "model",
  effort: "effort",
  worktree: "worktree",
  cwd: "cwd",
  status: "status",
  taskTitle: "task_title",
  taskState: "task_state",
  lastActivity: "last_activity",
  lastActivityAt: "last_activity_at",
  costUsd: "cost_usd",
  costByModel: "cost_by_model",
  tokens: "tokens",
  context: "context",
  createdAt: "created_at",
  archivedAt: "archived_at",
}

function toTask(r: Row): UserTask {
  const list = (v: unknown): string[] => {
    try {
      const a = JSON.parse(String(v ?? "[]")) as unknown
      return Array.isArray(a) ? a.map(String) : []
    } catch {
      return []
    }
  }
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    title: String(r.title),
    steps: list(r.steps),
    why: str(r.why),
    blocking: bool(r.blocking),
    due: num(r.due),
    createdBy: str(r.created_by),
    alsoBy: list(r.also_by),
    status: String(r.status) as UserTaskStatus,
    note: str(r.note),
    closedBy: str(r.closed_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    closedAt: num(r.closed_at),
    cli: taskCli(r.cli),
    priority: num(r.priority),
    tags: list(r.tags),
  }
}

function taskCli(v: unknown): UserTaskCli | null {
  if (v === null || v === undefined) return null
  try {
    const c = JSON.parse(String(v)) as Partial<UserTaskCli>
    return typeof c.id === "string" ? { id: c.id, credential: Number(c.credential) || 0 } : null
  } catch {
    return null
  }
}

const DRAFT_COLUMNS: Partial<Record<keyof Draft, string>> = {
  targetSessionId: "target_session_id",
  newSession: "new_session",
  title: "title",
  prompt: "prompt",
  state: "state",
  updatedAt: "updated_at",
  decidedAt: "decided_at",
  edited: "edited",
  revision: "revision",
  subagents: "subagents",
  fresh: "fresh",
  model: "model",
  effort: "effort",
  steps: "steps",
  planState: "plan_state",
  currentStep: "current_step",
  planNote: "plan_note",
  revises: "revises",
  hold: "hold",
  sentBy: "sent_by",
}

const REPORT_COLUMNS: Partial<Record<keyof Report, string>> = {
  state: "state",
  deliveredAt: "delivered_at",
  reviewedAt: "reviewed_at",
}

type SqlValue = string | number | null

function sqlValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null
  if (typeof v === "boolean") return v ? 1 : 0
  if (typeof v === "number" || typeof v === "string") return v
  return JSON.stringify(v)
}

/**
 * La base guarda credenciales de prueba: solo la lee tu usuario. La carpeta queda en 0700 y la base
 * (con su -wal y -shm) en 0600, también las que se crearon antes con los permisos por defecto.
 */
function restrict(file: string) {
  try {
    fs.chmodSync(path.dirname(file), 0o700)
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600)
  } catch {
    // otro dueño o un sistema de archivos sin permisos: se sigue igual
  }
}

export class Db {
  private db: DatabaseSync

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
    this.migrate()
    this.migrateAutoDispatch()
    restrict(file)
  }

  private migrate() {
    const current = Number(
      (this.db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0
    )
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN")
      try {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec("COMMIT")
      } catch (err) {
        this.db.exec("ROLLBACK")
        throw err
      }
    }
  }

  close() {
    this.db.close()
  }

  // ---------------------------------------------------------------- projects

  insertProject(p: Omit<ProjectRecord, "afk"> & { afk?: AfkState | null }) {
    this.db
      .prepare(
        "INSERT INTO projects (id, name, repo_path, settings, account_id, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(p.id, p.name, p.repoPath, JSON.stringify(p.settings), p.accountId, p.createdAt, p.archivedAt)
    if (p.afk) this.updateProject(p.id, { afk: p.afk })
  }

  /** Proyectos creados antes de que hubiera cuentas: pasan a la cuenta por defecto. */
  assignOrphanProjects(accountId: string) {
    this.db.prepare("UPDATE projects SET account_id = ? WHERE account_id IS NULL").run(accountId)
  }

  updateProject(id: string, patch: Partial<Pick<ProjectRecord, "name" | "settings" | "archivedAt" | "accountId" | "afk">>) {
    if (patch.afk !== undefined)
      this.db.prepare("UPDATE projects SET afk = ? WHERE id = ?").run(patch.afk ? JSON.stringify(patch.afk) : null, id)
    if (patch.name !== undefined)
      this.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(patch.name, id)
    if (patch.settings !== undefined)
      this.db
        .prepare("UPDATE projects SET settings = ? WHERE id = ?")
        .run(JSON.stringify(patch.settings), id)
    if (patch.archivedAt !== undefined)
      this.db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(patch.archivedAt, id)
    if (patch.accountId !== undefined)
      this.db.prepare("UPDATE projects SET account_id = ? WHERE id = ?").run(patch.accountId, id)
  }

  // ------------------------------------------------------------- huellas

  /** Lo último que vio la sesión de sus herramientas y su protocolo (null: nunca se anotó). */
  getFingerprint(sessionId: string): Fingerprint | null {
    const r = this.db.prepare("SELECT data FROM session_fingerprints WHERE session_id = ?").get(sessionId) as Row | undefined
    if (!r) return null
    try {
      const f = JSON.parse(String(r.data)) as Fingerprint
      return f && typeof f.tools === "object" && typeof f.sections === "object" ? f : null
    } catch {
      return null
    }
  }

  setFingerprint(sessionId: string, f: Fingerprint) {
    this.db.prepare("INSERT INTO session_fingerprints (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data").run(sessionId, JSON.stringify(f))
  }

  // ------------------------------------------------------------ acceso remoto

  getRemoteConfig(): RemoteConfig {
    const r = this.db.prepare("SELECT * FROM remote_config WHERE id = 1").get() as Row
    const tier = String(r.tier)
    return {
      enabled: bool(r.enabled),
      tier: tier === "respond" || tier === "control" ? tier : "read",
      requireLocalForDangerous: bool(r.require_local_dangerous),
      httpsPort: Number(r.https_port),
      localPort: Number(r.local_port),
      origin: str(r.origin),
      serveOwned: bool(r.serve_owned),
      serveTarget: str(r.serve_target),
      serveCreatedAt: num(r.serve_created_at),
      updatedAt: Number(r.updated_at),
    }
  }

  insertRemoteDevice(d: RemoteDeviceRow) {
    this.db
      .prepare("INSERT INTO remote_devices (id, name, tier, token_hash, ts_login, created_at, expires_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.id, d.name, d.tier, d.tokenHash, d.tsLogin, d.createdAt, d.expiresAt, d.lastSeenAt, d.revokedAt)
  }

  private toDevice(r: Row): RemoteDeviceRow {
    const tier = String(r.tier)
    return {
      id: String(r.id),
      name: String(r.name),
      tier: tier === "respond" || tier === "control" ? tier : "read",
      tokenHash: String(r.token_hash),
      tsLogin: str(r.ts_login),
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      lastSeenAt: num(r.last_seen_at),
      revokedAt: num(r.revoked_at),
    }
  }

  /** Por el hash de la cookie (la columna es única, así que la búsqueda va por índice). */
  getRemoteDeviceByHash(hash: string): RemoteDeviceRow | null {
    const r = this.db.prepare("SELECT * FROM remote_devices WHERE token_hash = ?").get(hash) as Row | undefined
    return r ? this.toDevice(r) : null
  }

  getRemoteDevice(id: string): RemoteDeviceRow | null {
    const r = this.db.prepare("SELECT * FROM remote_devices WHERE id = ?").get(id) as Row | undefined
    return r ? this.toDevice(r) : null
  }

  /** Los que no fueron revocados, del más nuevo al más viejo. */
  listRemoteDevices(): RemoteDeviceRow[] {
    return (this.db.prepare("SELECT * FROM remote_devices WHERE revoked_at IS NULL ORDER BY created_at DESC, id").all() as Row[]).map((r) => this.toDevice(r))
  }

  touchRemoteDevice(id: string, at: number) {
    this.db.prepare("UPDATE remote_devices SET last_seen_at = ? WHERE id = ?").run(at, id)
  }

  insertRemoteAudit(r: RemoteAuditRow) {
    this.db
      .prepare("INSERT INTO remote_audit (at, device_id, kind, method, route, target_id, tool_name, input_hash, status, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.at, r.deviceId, r.kind, r.method, r.route, r.targetId, r.toolName, r.inputHash, r.status, r.outcome, r.reason)
  }

  /** Borra lo anterior a `cutoff` y, de lo que queda, todo menos las `maxRows` más nuevas. */
  pruneRemoteAudit(cutoff: number, maxRows: number) {
    this.db.prepare("DELETE FROM remote_audit WHERE at < ?").run(cutoff)
    this.db.prepare("DELETE FROM remote_audit WHERE id <= (SELECT id FROM remote_audit ORDER BY id DESC LIMIT 1 OFFSET ?)").run(maxRows)
  }

  /** Las más nuevas primero. */
  listRemoteAudit(limit: number): RemoteAuditRow[] {
    return (this.db.prepare("SELECT * FROM remote_audit ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      deviceId: str(r.device_id),
      kind: String(r.kind),
      method: str(r.method),
      route: str(r.route),
      targetId: str(r.target_id),
      toolName: str(r.tool_name),
      inputHash: str(r.input_hash),
      status: num(r.status),
      outcome: String(r.outcome),
      reason: str(r.reason),
    }))
  }

  /** Revoca todos los dispositivos vigentes; devuelve sus ids. */
  revokeAllRemoteDevices(at: number): string[] {
    const ids = (this.db.prepare("SELECT id FROM remote_devices WHERE revoked_at IS NULL").all() as Row[]).map((r) => String(r.id))
    this.db.prepare("UPDATE remote_devices SET revoked_at = ? WHERE revoked_at IS NULL").run(at)
    return ids
  }

  /** Cambia el nivel de un dispositivo no revocado; true si existía. */
  setRemoteDeviceTier(id: string, tier: RemoteDeviceRow["tier"]): boolean {
    return Number(this.db.prepare("UPDATE remote_devices SET tier = ? WHERE id = ? AND revoked_at IS NULL").run(tier, id).changes) > 0
  }

  /** true si estaba activo y quedó revocado. */
  revokeRemoteDevice(id: string, at: number): boolean {
    return Number(this.db.prepare("UPDATE remote_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id).changes) > 0
  }

  /** Hay un solo enlace activo: el nuevo reemplaza a todos los anteriores. */
  replaceRemotePairing(p: Omit<RemotePairingRow, "usedAt">) {
    this.db.exec("BEGIN")
    try {
      this.db.prepare("DELETE FROM remote_pairings").run()
      this.db.prepare("INSERT INTO remote_pairings (id, token_hash, name, tier, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)").run(p.id, p.tokenHash, p.name, p.tier, p.expiresAt)
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  getRemotePairingByHash(hash: string): RemotePairingRow | null {
    const r = this.db.prepare("SELECT * FROM remote_pairings WHERE token_hash = ?").get(hash) as Row | undefined
    if (!r) return null
    const tier = String(r.tier)
    return { id: String(r.id), tokenHash: String(r.token_hash), name: str(r.name), tier: tier === "respond" || tier === "control" ? tier : "read", expiresAt: Number(r.expires_at), usedAt: num(r.used_at) }
  }

  /** Marca el enlace como usado; true solo para quien lo gasta primero (un enlace sirve una vez). */
  consumeRemotePairing(id: string, at: number): boolean {
    return Number(this.db.prepare("UPDATE remote_pairings SET used_at = ? WHERE id = ? AND used_at IS NULL").run(at, id).changes) > 0
  }

  /** Cambia solo lo que viene en el parche; devuelve cómo quedó. */
  updateRemoteConfig(patch: Partial<Omit<RemoteConfig, "updatedAt">>): RemoteConfig {
    const columns: Record<string, string> = {
      enabled: "enabled",
      tier: "tier",
      requireLocalForDangerous: "require_local_dangerous",
      httpsPort: "https_port",
      localPort: "local_port",
      origin: "origin",
      serveOwned: "serve_owned",
      serveTarget: "serve_target",
      serveCreatedAt: "serve_created_at",
    }
    const sets: string[] = ["updated_at = ?"]
    const values: (string | number | null)[] = [Date.now()]
    for (const [key, value] of Object.entries(patch)) {
      const col = columns[key]
      if (!col || value === undefined) continue
      sets.push(`${col} = ?`)
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null))
    }
    this.db.prepare(`UPDATE remote_config SET ${sets.join(", ")} WHERE id = 1`).run(...values)
    return this.getRemoteConfig()
  }

  // --------------------------------------------------------------------- afk

  /** Lo que gastó el proyecto hasta ahora: la suma del costo de todas sus sesiones (también las archivadas). */
  projectCost(projectId: string): { usd: number; byModel: Record<string, number> } {
    const rows = this.db.prepare("SELECT cost_usd, cost_by_model FROM sessions WHERE project_id = ?").all(projectId) as Row[]
    let usd = 0
    const byModel: Record<string, number> = {}
    for (const r of rows) {
      usd += Number(r.cost_usd ?? 0)
      for (const [m, v] of Object.entries(parseCostByModel(r.cost_by_model))) byModel[m] = (byModel[m] ?? 0) + v
    }
    return { usd, byModel }
  }

  insertAfkPeriod(p: Omit<AfkPeriodRow, "id" | "endedAt" | "endReason" | "spentUsd" | "costByModel">) {
    this.db
      .prepare("INSERT INTO afk_periods (project_id, since, until, budget_usd, spent_at_start, cost_by_model_at_start) VALUES (?, ?, ?, ?, ?, ?)")
      .run(p.projectId, p.since, p.until, p.budgetUsd, p.spentAtStart, JSON.stringify(p.costByModelAtStart))
  }

  /** Cambia el límite de tiempo o de plata del período abierto (volver a ponerse AFK sin salir). */
  updateOpenAfkPeriod(projectId: string, patch: { until: number | null; budgetUsd: number | null }) {
    this.db.prepare("UPDATE afk_periods SET until = ?, budget_usd = ? WHERE project_id = ? AND ended_at IS NULL").run(patch.until, patch.budgetUsd, projectId)
  }

  closeAfkPeriod(projectId: string, end: { endedAt: number; endReason: AfkEndReason; spentUsd: number; costByModel: Record<string, number> }) {
    this.db
      .prepare("UPDATE afk_periods SET ended_at = ?, end_reason = ?, spent_usd = ?, cost_by_model = ? WHERE project_id = ? AND ended_at IS NULL")
      .run(end.endedAt, end.endReason, end.spentUsd, JSON.stringify(end.costByModel), projectId)
  }

  /** El período más reciente del proyecto (el abierto, si hay uno). */
  lastAfkPeriod(projectId: string): AfkPeriodRow | null {
    const r = this.db.prepare("SELECT * FROM afk_periods WHERE project_id = ? ORDER BY since DESC, id DESC LIMIT 1").get(projectId) as Row | undefined
    return r ? toPeriod(r) : null
  }

  /** Los proyectos con AFK activo. */
  listAfkProjects(): ProjectRecord[] {
    return (this.db.prepare("SELECT * FROM projects WHERE afk IS NOT NULL AND archived_at IS NULL").all() as Row[]).map(toProject)
  }

  /**
   * Un proyecto que tenía autoDispatch en true pasa a AFK sin límites, y la opción se borra de sus ajustes.
   * Idempotente: sin autoDispatch en los ajustes no hace nada.
   */
  private migrateAutoDispatch() {
    const rows = this.db.prepare("SELECT * FROM projects WHERE json_extract(settings, '$.autoDispatch') IS NOT NULL").all() as Row[]
    for (const r of rows) {
      const p = toProject(r)
      const raw = JSON.parse(String(r.settings ?? "{}")) as Record<string, unknown>
      const wasOn = raw.autoDispatch === true
      delete raw.autoDispatch
      this.db.prepare("UPDATE projects SET settings = ? WHERE id = ?").run(JSON.stringify(raw), p.id)
      if (!wasOn || p.afk) continue
      const cost = this.projectCost(p.id)
      const afk: AfkState = { since: Date.now(), until: null, budgetUsd: null, spentAtStart: cost.usd }
      this.updateProject(p.id, { afk })
      this.insertAfkPeriod({ projectId: p.id, since: afk.since, until: null, budgetUsd: null, spentAtStart: cost.usd, costByModelAtStart: cost.byModel })
    }
  }

  // ---------------------------------------------------------------- accounts

  insertAccount(a: AccountRecord) {
    this.db
      .prepare("INSERT INTO accounts (id, name, config_dir, bin, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(a.id, a.name, a.configDir, a.bin, a.createdAt)
  }

  updateAccount(id: string, patch: Partial<Pick<AccountRecord, "name" | "configDir" | "bin">>) {
    if (patch.name !== undefined) this.db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(patch.name, id)
    if (patch.configDir !== undefined)
      this.db.prepare("UPDATE accounts SET config_dir = ? WHERE id = ?").run(patch.configDir, id)
    if (patch.bin !== undefined) this.db.prepare("UPDATE accounts SET bin = ? WHERE id = ?").run(patch.bin, id)
  }

  deleteAccount(id: string) {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id)
  }

  getAccount(id: string): AccountRecord | null {
    const r = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined
    return r ? toAccount(r) : null
  }

  listAccounts(): AccountRecord[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at").all() as Row[]).map(toAccount)
  }

  countProjectsByAccount(accountId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE account_id = ? AND archived_at IS NULL")
      .get(accountId) as Row
    return Number(r.n ?? 0)
  }

  getProject(id: string): ProjectRecord | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined
    return r ? toProject(r) : null
  }

  /** Los archivados, del más reciente al más viejo. */
  listArchivedProjects(): ProjectRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC")
        .all() as Row[]
    ).map(toProject)
  }

  listProjects(): ProjectRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at")
        .all() as Row[]
    ).map(toProject)
  }

  // ---------------------------------------------------------------- sessions

  insertSession(s: SessionRecord) {
    const cols = Object.values(SESSION_COLUMNS)
    const values = (Object.keys(SESSION_COLUMNS) as (keyof SessionRecord)[]).map((k) =>
      sqlValue(s[k])
    )
    this.db
      .prepare(`INSERT INTO sessions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...values)
  }

  updateSession(id: string, patch: Partial<SessionRecord>) {
    const keys = (Object.keys(patch) as (keyof SessionRecord)[]).filter(
      (k) => k !== "id" && SESSION_COLUMNS[k]
    )
    if (!keys.length) return
    const sets = keys.map((k) => `${SESSION_COLUMNS[k]} = ?`).join(", ")
    this.db
      .prepare(`UPDATE sessions SET ${sets} WHERE id = ?`)
      .run(...keys.map((k) => sqlValue(patch[k])), id)
  }

  getSession(id: string): SessionRecord | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined
    return r ? toSession(r) : null
  }

  getSessionByToken(token: string): SessionRecord | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE mcp_token = ?").get(token) as
      | Row
      | undefined
    return r ? toSession(r) : null
  }

  listArchivedSessions(projectId: string): SessionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions WHERE project_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC")
        .all(projectId) as Row[]
    ).map(toSession)
  }

  /** Borra del dashboard una sesión archivada: su historial, adjuntos y resultados (no toca el transcript de Claude Code). */
  purgeSession(id: string) {
    this.db.exec("BEGIN")
    try {
      this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id)
      this.db.prepare("DELETE FROM attachments WHERE session_id = ?").run(id)
      this.db.prepare("DELETE FROM reports WHERE session_id = ?").run(id)
      this.db
        .prepare("UPDATE drafts SET state = 'discarded' WHERE target_session_id = ? AND state IN ('staged', 'ready')")
        .run(id)
      this.db.prepare("DELETE FROM session_fingerprints WHERE session_id = ?").run(id)
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  /** Todas las sesiones de un proyecto, también las archivadas. */
  listProjectSessions(projectId: string): SessionRecord[] {
    return (
      this.db.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at").all(projectId) as Row[]
    ).map(toSession)
  }

  /**
   * Borra un proyecto con todo lo suyo en la base, en una transacción: o todo o nada. Solo la base:
   * el repo, los worktrees y las conversaciones de Claude Code quedan como están.
   */
  purgeProject(id: string) {
    const sessionIds = `SELECT id FROM sessions WHERE project_id = ?`
    this.db.exec("BEGIN")
    try {
      this.db.prepare(`DELETE FROM events WHERE session_id IN (${sessionIds})`).run(id)
      this.db.prepare(`DELETE FROM attachments WHERE session_id IN (${sessionIds})`).run(id)
      this.db.prepare("DELETE FROM reports WHERE project_id = ?").run(id)
      this.db.prepare("DELETE FROM project_messages WHERE from_project_id = ? OR to_project_id = ?").run(id, id)
      this.db.prepare("DELETE FROM drafts WHERE project_id = ?").run(id)
      this.db.prepare("DELETE FROM afk_periods WHERE project_id = ?").run(id)
      this.db.prepare(`DELETE FROM session_fingerprints WHERE session_id IN (${sessionIds})`).run(id)
      this.db.prepare("DELETE FROM user_tasks WHERE project_id = ?").run(id)
      this.db.prepare("DELETE FROM credentials WHERE environment_id IN (SELECT id FROM environments WHERE project_id = ?)").run(id)
      this.db.prepare("DELETE FROM environments WHERE project_id = ?").run(id)
      this.db.prepare("DELETE FROM apps WHERE project_id = ?").run(id)
      this.db.prepare("DELETE FROM sessions WHERE project_id = ?").run(id)
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id)
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  listSessions(): SessionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY created_at")
        .all() as Row[]
    ).map(toSession)
  }

  // ------------------------------------------------------------------ events

  insertEvent(sessionId: string, ts: number, event: TimelineEvent): StoredEvent {
    const res = this.db
      .prepare("INSERT INTO events (session_id, ts, kind, data) VALUES (?, ?, ?, ?)")
      .run(sessionId, ts, event.kind, JSON.stringify(event))
    return { id: Number(res.lastInsertRowid), sessionId, ts, event }
  }

  updateEvent(stored: StoredEvent) {
    this.db
      .prepare("UPDATE events SET data = ?, kind = ? WHERE id = ?")
      .run(JSON.stringify(stored.event), stored.event.kind, stored.id)
  }

  getEvent(id: number): StoredEvent | null {
    const r = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined
    return r ? this.toStored(r) : null
  }

  listEvents(sessionId: string, opts: { before?: number; limit?: number } = {}): StoredEvent[] {
    const limit = Math.min(opts.limit ?? 400, 2000)
    const rows = (
      opts.before
        ? this.db
            .prepare(
              "SELECT * FROM events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
            )
            .all(sessionId, opts.before, limit)
        : this.db
            .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?")
            .all(sessionId, limit)
    ) as Row[]
    return rows.reverse().map((r) => this.toStored(r))
  }

  /**
   * Los eventos que hacen falta para saber qué programó una sesión: los tool_use de las herramientas
   * de programar, sus resultados y los mensajes que llegaron de afuera (los disparos). Solo si hubo alguno.
   */
  listScheduleEvents(sessionId: string, tools: string[]): StoredEvent[] {
    const marks = tools.map(() => "?").join(", ")
    const uses = `SELECT json_extract(data, '$.id') FROM events WHERE session_id = ? AND kind = 'tool_use' AND json_extract(data, '$.name') IN (${marks})`
    const first = this.db.prepare(`SELECT MIN(id) AS id FROM events WHERE session_id = ? AND kind = 'tool_use' AND json_extract(data, '$.name') IN (${marks})`).get(sessionId, ...tools) as Row | undefined
    if (!first?.id) return []
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE session_id = ? AND id >= ? AND (
          (kind = 'tool_use' AND json_extract(data, '$.name') IN (${marks}))
          OR (kind = 'tool_result' AND json_extract(data, '$.toolUseId') IN (${uses}))
          OR (kind = 'user' AND json_extract(data, '$.origin') = 'external')
        ) ORDER BY id`
      )
      .all(sessionId, Number(first.id), ...tools, sessionId, ...tools) as Row[]
    return rows.map((r) => this.toStored(r))
  }

  /** Cuándo se reinició la conversación de la sesión (los avisos del chat con ese texto). */
  noticeTimes(sessionId: string, text: string): number[] {
    return (
      this.db
        .prepare("SELECT ts FROM events WHERE session_id = ? AND kind = 'notice' AND json_extract(data, '$.text') = ? ORDER BY id")
        .all(sessionId, text) as Row[]
    ).map((r) => Number(r.ts))
  }

  /** Último texto de la sesión (para resúmenes en tarjetas). */
  lastText(sessionId: string): string | null {
    const r = this.db
      .prepare(
        "SELECT data FROM events WHERE session_id = ? AND kind = 'text' ORDER BY id DESC LIMIT 1"
      )
      .get(sessionId) as Row | undefined
    if (!r) return null
    try {
      return (JSON.parse(String(r.data)) as { text: string }).text
    } catch {
      return null
    }
  }

  private toStored(r: Row): StoredEvent {
    return {
      id: Number(r.id),
      sessionId: String(r.session_id),
      ts: Number(r.ts),
      event: JSON.parse(String(r.data)) as TimelineEvent,
    }
  }

  // ------------------------------------------------------------------ tareas para vos

  // ---------------------------------------------------------------- entornos

  insertEnvironment(e: EnvironmentRecord) {
    this.db
      .prepare("INSERT INTO environments (id, project_id, name, url, app_id, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(e.id, e.projectId, e.name, e.url, e.appId, e.notes, e.createdBy, e.createdAt, e.updatedAt)
  }

  updateEnvironment(id: string, patch: Partial<Pick<EnvironmentRecord, "name" | "url" | "appId" | "notes" | "updatedAt">>) {
    const cols = { name: "name", url: "url", appId: "app_id", notes: "notes", updatedAt: "updated_at" } as const
    const keys = (Object.keys(patch) as (keyof typeof cols)[]).filter((k) => cols[k] && patch[k] !== undefined)
    if (!keys.length) return
    this.db.prepare(`UPDATE environments SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => sqlValue(patch[k])), id)
  }

  getEnvironment(id: string): EnvironmentRecord | null {
    const r = this.db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as Row | undefined
    return r ? toEnvironment(r) : null
  }

  /** Por nombre, sin distinguir mayúsculas. */
  findEnvironment(projectId: string, name: string): EnvironmentRecord | null {
    const r = this.db.prepare("SELECT * FROM environments WHERE project_id = ? AND name = ?").get(projectId, name) as Row | undefined
    return r ? toEnvironment(r) : null
  }

  listEnvironments(projectId?: string): EnvironmentRecord[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM environments WHERE project_id = ? ORDER BY created_at").all(projectId)
      : this.db.prepare("SELECT * FROM environments ORDER BY created_at").all()
    return (rows as Row[]).map(toEnvironment)
  }

  deleteEnvironment(id: string) {
    this.db.exec("BEGIN")
    try {
      this.db.prepare("DELETE FROM credentials WHERE environment_id = ?").run(id)
      this.db.prepare("DELETE FROM environments WHERE id = ?").run(id)
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  insertCredential(c: CredentialRecord) {
    this.db
      .prepare(
        "INSERT INTO credentials (id, environment_id, name, username, secret, login_url, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(c.id, c.environmentId, c.name, c.username, c.secret, c.loginUrl, c.notes, c.createdBy, c.createdAt, c.updatedAt)
  }

  updateCredential(id: string, patch: Partial<Pick<CredentialRecord, "environmentId" | "name" | "username" | "secret" | "loginUrl" | "notes" | "updatedAt">>) {
    const cols = { environmentId: "environment_id", name: "name", username: "username", secret: "secret", loginUrl: "login_url", notes: "notes", updatedAt: "updated_at" } as const
    const keys = (Object.keys(patch) as (keyof typeof cols)[]).filter((k) => cols[k] && patch[k] !== undefined)
    if (!keys.length) return
    this.db.prepare(`UPDATE credentials SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => sqlValue(patch[k])), id)
  }

  getCredential(id: string): CredentialRecord | null {
    const r = this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as Row | undefined
    return r ? toCredential(r) : null
  }

  findCredential(environmentId: string, name: string): CredentialRecord | null {
    const r = this.db.prepare("SELECT * FROM credentials WHERE environment_id = ? AND name = ?").get(environmentId, name) as Row | undefined
    return r ? toCredential(r) : null
  }

  listCredentials(environmentId: string): CredentialRecord[] {
    return (this.db.prepare("SELECT * FROM credentials WHERE environment_id = ? ORDER BY created_at").all(environmentId) as Row[]).map(toCredential)
  }

  deleteCredential(id: string) {
    this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id)
  }

  insertTask(t: UserTask) {
    this.db
      .prepare(
        `INSERT INTO user_tasks (id, project_id, title, steps, why, blocking, due, created_by, also_by, status, note, closed_by, created_at, updated_at, closed_at, cli, priority, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        t.id, t.projectId, t.title, JSON.stringify(t.steps), t.why, t.blocking ? 1 : 0, t.due, t.createdBy, JSON.stringify(t.alsoBy), t.status, t.note, t.closedBy, t.createdAt, t.updatedAt, t.closedAt,
        t.cli ? JSON.stringify(t.cli) : null, t.priority, JSON.stringify(t.tags)
      )
  }

  updateTask(id: string, patch: Partial<UserTask>) {
    const cols: Partial<Record<keyof UserTask, string>> = {
      title: "title", steps: "steps", why: "why", blocking: "blocking", due: "due", alsoBy: "also_by", status: "status",
      note: "note", closedBy: "closed_by", updatedAt: "updated_at", closedAt: "closed_at", cli: "cli", priority: "priority", tags: "tags",
    }
    const keys = (Object.keys(patch) as (keyof UserTask)[]).filter((k) => cols[k])
    if (!keys.length) return
    this.db.prepare(`UPDATE user_tasks SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => sqlValue(patch[k])), id)
  }

  getTask(id: string): UserTask | null {
    const r = this.db.prepare("SELECT * FROM user_tasks WHERE id = ?").get(id) as Row | undefined
    return r ? toTask(r) : null
  }

  /** Las abiertas y las que se cerraron hace poco. */
  listTasks(opts: { projectId?: string; closedSince?: number } = {}): UserTask[] {
    const since = opts.closedSince ?? 0
    const rows = (
      opts.projectId
        ? this.db.prepare("SELECT * FROM user_tasks WHERE project_id = ? AND (status = 'open' OR closed_at >= ?) ORDER BY created_at").all(opts.projectId, since)
        : this.db.prepare("SELECT * FROM user_tasks WHERE status = 'open' OR closed_at >= ? ORDER BY created_at").all(since)
    ) as Row[]
    return rows.map(toTask)
  }

  /** Las que tienen fecha, están abiertas y todavía no avisaron. */
  dueTasks(until: number): UserTask[] {
    return (this.db.prepare("SELECT * FROM user_tasks WHERE status = 'open' AND due IS NOT NULL AND due <= ? AND reminded_at IS NULL").all(until) as Row[]).map(toTask)
  }

  markReminded(id: string, at: number) {
    this.db.prepare("UPDATE user_tasks SET reminded_at = ? WHERE id = ?").run(at, id)
  }

  // ------------------------------------------------------------------ apps (TRAY)

  insertApp(a: AppDef) {
    this.db
      .prepare(
        `INSERT INTO apps (id, project_id, name, command, shell, cwd, env, health, url, stop_command, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(a.id, a.projectId, a.name, a.command, a.shell ? 1 : 0, a.cwd, JSON.stringify(a.env), a.health ? JSON.stringify(a.health) : null, a.url, a.stopCommand, a.createdBy, a.createdAt, a.updatedAt)
  }

  updateApp(a: AppDef) {
    this.db
      .prepare("UPDATE apps SET name = ?, command = ?, shell = ?, cwd = ?, env = ?, health = ?, url = ?, stop_command = ?, updated_at = ? WHERE id = ?")
      .run(a.name, a.command, a.shell ? 1 : 0, a.cwd, JSON.stringify(a.env), a.health ? JSON.stringify(a.health) : null, a.url, a.stopCommand, a.updatedAt, a.id)
  }

  deleteApp(id: string) {
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(id)
    // Los entornos que tomaban la URL de esta app quedan con la suya propia.
    this.db.prepare("UPDATE environments SET app_id = NULL WHERE app_id = ?").run(id)
  }

  getApp(id: string): AppDef | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as Row | undefined
    return r ? toApp(r) : null
  }

  listApps(projectId?: string): AppDef[] {
    const rows = (
      projectId ? this.db.prepare("SELECT * FROM apps WHERE project_id = ? ORDER BY created_at").all(projectId) : this.db.prepare("SELECT * FROM apps ORDER BY created_at").all()
    ) as Row[]
    return rows.map(toApp)
  }

  // ------------------------------------------------------------------ drafts

  insertDraft(d: Draft) {
    this.db
      .prepare(
        `INSERT INTO drafts (id, project_id, kind, target_session_id, new_session, title, prompt, state,
          created_by, created_at, updated_at, decided_at, edited, revision, subagents, fresh,
          model, effort, steps, plan_state, current_step, plan_note, revises, hold, sent_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        d.id,
        d.projectId,
        d.kind,
        d.targetSessionId,
        d.newSession ? JSON.stringify(d.newSession) : null,
        d.title,
        d.prompt,
        d.state,
        d.createdBy,
        d.createdAt,
        d.updatedAt,
        d.decidedAt,
        d.edited ? 1 : 0,
        d.revision,
        d.subagents.length ? JSON.stringify(d.subagents) : null,
        d.fresh ? 1 : 0,
        d.model,
        d.effort,
        d.steps.length ? JSON.stringify(d.steps) : null,
        d.planState,
        d.currentStep,
        d.planNote,
        d.revises,
        d.hold ? 1 : 0,
        d.sentBy
      )
  }

  updateDraft(id: string, patch: Partial<Draft>) {
    const keys = (Object.keys(patch) as (keyof Draft)[]).filter((k) => DRAFT_COLUMNS[k])
    if (!keys.length) return
    const sets = keys.map((k) => `${DRAFT_COLUMNS[k]} = ?`).join(", ")
    this.db
      .prepare(`UPDATE drafts SET ${sets} WHERE id = ?`)
      .run(...keys.map((k) => sqlValue(patch[k])), id)
  }

  getDraft(id: string): Draft | null {
    const r = this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Row | undefined
    return r ? toDraft(r) : null
  }

  listDrafts(opts: { projectId?: string; states?: DraftState[]; sinceDecided?: number } = {}): Draft[] {
    const where: string[] = []
    const params: SqlValue[] = []
    if (opts.projectId) {
      where.push("project_id = ?")
      params.push(opts.projectId)
    }
    if (opts.states?.length) {
      where.push(`state IN (${opts.states.map(() => "?").join(", ")})`)
      params.push(...opts.states)
    }
    if (opts.sinceDecided !== undefined) {
      where.push("decided_at > ?")
      params.push(opts.sinceDecided)
    }
    const sql = `SELECT * FROM drafts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at`
    return (this.db.prepare(sql).all(...params) as Row[]).map(toDraft)
  }

  /** Borradores abiertos más los decididos en las últimas horas (para la UI). */
  listRecentDrafts(sinceMs: number): Draft[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM drafts WHERE state IN ('staged', 'ready') OR decided_at > ? ORDER BY created_at"
        )
        .all(sinceMs) as Row[]
    ).map(toDraft)
  }

  // ------------------------------------------------------------- attachments

  insertAttachment(a: AttachmentRecord) {
    this.db
      .prepare(
        "INSERT INTO attachments (id, session_id, name, mime, size, path, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(a.id, a.sessionId, a.name, a.mime, a.size, a.path, a.source, a.createdAt)
  }

  getAttachment(id: string): AttachmentRecord | null {
    const r = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Row | undefined
    return r ? toAttachment(r) : null
  }

  listAttachments(sessionId: string): AttachmentRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at DESC LIMIT 200")
        .all(sessionId) as Row[]
    ).map(toAttachment)
  }

  /** Eventos de subagente de una sesión (para reconstruir su estado). */
  listSubagentEvents(sessionId: string): StoredEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM events WHERE session_id = ? AND kind = 'subagent' ORDER BY id")
        .all(sessionId) as Row[]
    ).map((r) => this.toStored(r))
  }

  // ----------------------------------------------------------------- reports

  insertReport(r: ReportRow) {
    this.db
      .prepare(
        `INSERT INTO reports (id, project_id, session_id, task_title, status, summary, details, state,
          created_at, delivered_at, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.id,
        r.projectId,
        r.sessionId,
        r.taskTitle,
        r.status,
        r.summary,
        r.details,
        r.state,
        r.createdAt,
        r.deliveredAt,
        r.reviewedAt
      )
  }

  updateReport(id: string, patch: Partial<Report>) {
    const keys = (Object.keys(patch) as (keyof Report)[]).filter((k) => REPORT_COLUMNS[k])
    if (!keys.length) return
    const sets = keys.map((k) => `${REPORT_COLUMNS[k]} = ?`).join(", ")
    this.db
      .prepare(`UPDATE reports SET ${sets} WHERE id = ?`)
      .run(...keys.map((k) => sqlValue(patch[k])), id)
  }

  getReport(id: string): ReportRow | null {
    const r = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined
    return r ? toReport(r) : null
  }

  listReports(opts: { projectId?: string; states?: ReportState[]; sessionId?: string; limit?: number } = {}): ReportRow[] {
    const where: string[] = []
    const params: SqlValue[] = []
    if (opts.projectId) {
      where.push("project_id = ?")
      params.push(opts.projectId)
    }
    if (opts.sessionId) {
      where.push("session_id = ?")
      params.push(opts.sessionId)
    }
    if (opts.states?.length) {
      where.push(`state IN (${opts.states.map(() => "?").join(", ")})`)
      params.push(...opts.states)
    }
    const limit = opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ""
    const sql = `SELECT * FROM (SELECT * FROM reports ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC${limit}) ORDER BY created_at`
    return (this.db.prepare(sql).all(...params) as Row[]).map(toReport)
  }

  // --------------------------------------------------------- project messages

  insertProjectMessage(m: ProjectMessageRow) {
    this.db
      .prepare(
        `INSERT INTO project_messages (id, from_project_id, to_project_id, from_session_id, to_session_id, text, reply_to, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(m.id, m.fromProjectId, m.toProjectId, m.fromSessionId, m.toSessionId, m.text, m.replyTo, m.createdAt, m.deliveredAt)
  }

  getProjectMessage(id: string): ProjectMessageRow | null {
    const r = this.db.prepare("SELECT * FROM project_messages WHERE id = ?").get(id) as Row | undefined
    return r ? toProjectMessage(r) : null
  }

  /** Marca mensajes como entregados a la orquestadora destino. */
  markProjectMessagesDelivered(ids: string[], toSessionId: string, deliveredAt: number) {
    const stmt = this.db.prepare("UPDATE project_messages SET delivered_at = ?, to_session_id = ? WHERE id = ?")
    for (const id of ids) stmt.run(deliveredAt, toSessionId, id)
  }

  /** Vuelve a la cola mensajes que no se pudieron entregar. */
  requeueProjectMessages(ids: string[]) {
    const stmt = this.db.prepare("UPDATE project_messages SET delivered_at = NULL, to_session_id = NULL WHERE id = ?")
    for (const id of ids) stmt.run(id)
  }

  /** Los que esperan a la orquestadora de un proyecto (sin entregar), del más viejo al más nuevo. */
  listQueuedProjectMessages(toProjectId: string): ProjectMessageRow[] {
    return (
      this.db
        .prepare("SELECT * FROM project_messages WHERE to_project_id = ? AND delivered_at IS NULL ORDER BY created_at, rowid")
        .all(toProjectId) as Row[]
    ).map(toProjectMessage)
  }

  /** Los enviados y recibidos por un proyecto, más nuevos primero. */
  listProjectMessages(projectId: string, limit = 200): ProjectMessageRow[] {
    return (
      this.db
        .prepare("SELECT * FROM project_messages WHERE from_project_id = ? OR to_project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(projectId, projectId, Math.floor(limit)) as Row[]
    ).map(toProjectMessage)
  }

  /** Cuántos mandó un proyecto a otro desde `sinceMs` (para el límite contra bucles). */
  countProjectMessagesSince(fromProjectId: string, toProjectId: string, sinceMs: number): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM project_messages WHERE from_project_id = ? AND to_project_id = ? AND created_at >= ?")
      .get(fromProjectId, toProjectId, sinceMs) as Row
    return Number(r.n)
  }

  /** Reportes abiertos más los recientes (para la UI). */
  listRecentReports(sinceMs: number): ReportRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM reports WHERE state IN ('queued', 'in_review') OR created_at > ? ORDER BY created_at"
        )
        .all(sinceMs) as Row[]
    ).map(toReport)
  }
}
