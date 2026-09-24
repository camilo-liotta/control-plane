import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import type {
  Attachment,
  ContextUsage,
  Draft,
  DraftKind,
  DraftState,
  ProjectSettings,
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
} from "./shared/types.ts"

export const defaultSettings: ProjectSettings = {
  autoDispatch: false,
  batchWindowSec: 15,
  orchestratorCanEdit: false,
  workerInstructions: "",
  orchestratorInstructions: "",
  defaultModel: null,
  defaultEffort: null,
  compactMode: "notify",
  compactWaitMin: 10,
}

export interface ProjectRecord {
  id: string
  name: string
  repoPath: string
  settings: ProjectSettings
  accountId: string | null
  createdAt: number
  archivedAt: number | null
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
]

const bool = (v: unknown) => v === 1 || v === true
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const str = (v: unknown) => (v === null || v === undefined ? null : String(v))

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
    tokens: parseTokens(r.tokens),
    context: parseContext(r.context),
    createdAt: Number(r.created_at),
    archivedAt: num(r.archived_at),
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

type ReportRow = Omit<Report, "sessionName">

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
  tokens: "tokens",
  context: "context",
  createdAt: "created_at",
  archivedAt: "archived_at",
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

export class Db {
  private db: DatabaseSync

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
    this.migrate()
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

  insertProject(p: ProjectRecord) {
    this.db
      .prepare(
        "INSERT INTO projects (id, name, repo_path, settings, account_id, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(p.id, p.name, p.repoPath, JSON.stringify(p.settings), p.accountId, p.createdAt, p.archivedAt)
  }

  /** Proyectos creados antes de que hubiera cuentas: pasan a la cuenta por defecto. */
  assignOrphanProjects(accountId: string) {
    this.db.prepare("UPDATE projects SET account_id = ? WHERE account_id IS NULL").run(accountId)
  }

  updateProject(id: string, patch: Partial<Pick<ProjectRecord, "name" | "settings" | "archivedAt" | "accountId">>) {
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
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id)
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

  // ------------------------------------------------------------------ drafts

  insertDraft(d: Draft) {
    this.db
      .prepare(
        `INSERT INTO drafts (id, project_id, kind, target_session_id, new_session, title, prompt, state,
          created_by, created_at, updated_at, decided_at, edited, revision, subagents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        d.subagents.length ? JSON.stringify(d.subagents) : null
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
