import type {
  Account,
  AccountAuth,
  Attachment,
  CatalogPlugin,
  ClaudeSetting,
  ClaudeSettingValue,
  CompactionState,
  ContextUsage,
  Draft,
  Marketplace,
  Project,
  ProjectSettings,
  Report,
  Session,
  SkillState,
  SlashCommand,
  StoredEvent,
  SubagentSpec,
  ToolsView,
} from "@shared/types"

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`)
  return data as T
}

export interface DirSuggestion {
  path: string
  exists: boolean
  isGitRepo: boolean
  dirs: { path: string; isGitRepo: boolean }[]
  home: string
}

export interface Importable {
  sessionId: string
  name: string | null
  updatedAt: number
  preview: string | null
  sizeKb: number
  running: { kind: "interactive" | "background"; pid: number | null; id: string | null } | null
  imported: boolean
}

/** Lo que mandás al compactar: cada punto (quizás editado) y si sobrevive. */
export interface CompactionSelection {
  sections: { title: string; points: { text: string; keep: boolean }[] }[]
  extra?: string
}

export interface McpInput {
  name: string
  scope: "user" | "local" | "project"
  transport: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  projectId?: string
}

export type PluginActionResult = { ok: true; message: string } | { needsConfirm: { command: string; sha256: string } }

const enc = encodeURIComponent
const qs = (params: Record<string, string | null | undefined>) => {
  const q = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${enc(v!)}`)
    .join("&")
  return q ? `?${q}` : ""
}

export const attachmentUrl = (id: string, download = false) => `/api/attachments/${id}${download ? "?download=1" : ""}`

export const api = {
  accounts: (refresh = false) => request<Account[]>("GET", `/api/accounts${refresh ? "?refresh=1" : ""}`),
  detectAccounts: () => request<{ configDir: string; name: string; auth: AccountAuth }[]>("GET", "/api/accounts/detect"),
  createAccount: (body: { name: string; configDir: string; bin?: string | null }) => request<Account>("POST", "/api/accounts", body),
  updateAccount: (id: string, body: { name?: string; bin?: string | null }) => request<Account>("PATCH", `/api/accounts/${id}`, body),
  removeAccount: (id: string) => request("DELETE", `/api/accounts/${id}`),
  claudeSettings: (id: string) =>
    request<{ files: { user: string; global: string }; items: ClaudeSetting[] }>("GET", `/api/accounts/${id}/settings`),
  setClaudeSetting: (id: string, key: string, value: ClaudeSettingValue) =>
    request<ClaudeSetting>("PATCH", `/api/accounts/${id}/settings`, { key, value }),
  archivedSessions: (projectId: string) => request<Session[]>("GET", `/api/projects/${projectId}/archived`),
  restoreSession: (id: string) => request<Session>("POST", `/api/sessions/${id}/restore`),
  purgeSession: (id: string) => request("DELETE", `/api/sessions/${id}?purge=1`),
  suggestDirs: (path: string) => request<DirSuggestion>("GET", `/api/fs/suggest?path=${encodeURIComponent(path)}`),

  createProject: (body: { name?: string; repoPath: string; accountId?: string; settings?: Partial<ProjectSettings> }) =>
    request<Project>("POST", "/api/projects", body),
  updateProject: (id: string, body: { name?: string; settings?: Partial<ProjectSettings> }) =>
    request<Project>("PATCH", `/api/projects/${id}`, body),
  archiveProject: (id: string) => request<Project>("DELETE", `/api/projects/${id}`),
  reviewNow: (id: string) => request("POST", `/api/projects/${id}/review-now`),
  importable: (id: string) => request<Importable[]>("GET", `/api/projects/${id}/importable`),
  importSession: (id: string, body: { claudeSessionId: string; name: string; role?: string }) =>
    request<Session>("POST", `/api/projects/${id}/import`, body),
  releaseReview: (id: string) => request("POST", `/api/projects/${id}/release`),
  startAll: (id: string) => request("POST", `/api/projects/${id}/start-all`),
  stopAll: (id: string) => request("POST", `/api/projects/${id}/stop-all`),

  createSession: (
    projectId: string,
    body: { name: string; role?: string; prompt?: string; model?: string | null; effort?: string | null; worktree?: boolean }
  ) => request<Session>("POST", `/api/projects/${projectId}/sessions`, body),
  updateSession: (id: string, body: { name?: string; role?: string; model?: string | null; effort?: string | null }) =>
    request<Session>("PATCH", `/api/sessions/${id}`, body),
  archiveSession: (id: string) => request("DELETE", `/api/sessions/${id}`),
  events: (id: string, before?: number, limit = 300) =>
    request<StoredEvent[]>("GET", `/api/sessions/${id}/events?limit=${limit}${before ? `&before=${before}` : ""}`),
  sessionReports: (id: string) => request<Report[]>("GET", `/api/sessions/${id}/reports`),
  send: (id: string, text: string, attachmentIds: string[] = []) =>
    request<StoredEvent>("POST", `/api/sessions/${id}/messages`, { text, attachmentIds }),
  upload: (id: string, file: { name: string; mime: string; data: string }) =>
    request<Attachment>("POST", `/api/sessions/${id}/attachments`, file),
  attachments: (id: string) => request<Attachment[]>("GET", `/api/sessions/${id}/attachments`),
  commands: (id: string) => request<SlashCommand[]>("GET", `/api/sessions/${id}/commands`),
  start: (id: string) => request("POST", `/api/sessions/${id}/start`),
  stop: (id: string) => request("POST", `/api/sessions/${id}/stop`),
  interrupt: (id: string) => request("POST", `/api/sessions/${id}/interrupt`),
  answer: (id: string, requestId: string, answers: Record<string, string>) =>
    request("POST", `/api/sessions/${id}/answer`, { requestId, answers }),
  permission: (id: string, requestId: string, allow: boolean) =>
    request("POST", `/api/sessions/${id}/permission`, { requestId, allow }),

  sendDraft: (
    id: string,
    edits: { title?: string; prompt?: string; name?: string; role?: string; subagents?: SubagentSpec[] } = {}
  ) => request<Draft>("POST", `/api/drafts/${id}/send`, edits),
  discardDraft: (id: string) => request<Draft>("POST", `/api/drafts/${id}/discard`),
  editDraft: (id: string, edits: { title?: string; prompt?: string; subagents?: SubagentSpec[] }) =>
    request<Draft>("PATCH", `/api/drafts/${id}`, edits),

  dismissReport: (id: string) => request("POST", `/api/reports/${id}/dismiss`),

  compactionDraft: (id: string) => request<CompactionState>("POST", `/api/sessions/${id}/compaction/draft`),
  compactionApply: (id: string, selection: CompactionSelection) =>
    request("POST", `/api/sessions/${id}/compaction/apply`, selection),
  compactionDirect: (id: string) => request("POST", `/api/sessions/${id}/compaction/direct`),
  compactionDiscard: (id: string) => request("DELETE", `/api/sessions/${id}/compaction`),
  refreshContext: (id: string) => request<ContextUsage | null>("POST", `/api/sessions/${id}/context`),

  tools: (accountId: string, projectId: string | null, refresh = false) =>
    request<ToolsView>("GET", `/api/accounts/${accountId}/tools${qs({ projectId, refresh: refresh ? "1" : null })}`),
  sessionTools: (id: string) => request<ToolsView>("GET", `/api/sessions/${id}/tools`),
  reloadSessionTools: (id: string) => request<ToolsView>("POST", `/api/sessions/${id}/tools/reload`),
  pluginCatalog: (accountId: string, refresh = false) =>
    request<CatalogPlugin[]>("GET", `/api/accounts/${accountId}/plugins/catalog${refresh ? "?refresh=1" : ""}`),
  pluginAction: (
    accountId: string,
    body: { id: string; action: "enable" | "disable" | "install" | "uninstall" | "update"; projectId?: string | null; scope?: string; acceptCommand?: string }
  ) => request<PluginActionResult>("POST", `/api/accounts/${accountId}/plugins/action`, { ...body, projectId: body.projectId ?? undefined }),
  marketplaces: (accountId: string) => request<Marketplace[]>("GET", `/api/accounts/${accountId}/marketplaces`),
  marketplaceAction: (accountId: string, action: "add" | "remove" | "update", target?: string) =>
    request("POST", `/api/accounts/${accountId}/marketplaces`, { action, target }),
  addMcp: (accountId: string, input: McpInput) => request("POST", `/api/accounts/${accountId}/mcp`, input),
  removeMcp: (accountId: string, name: string, scope: string, projectId: string | null) =>
    request("DELETE", `/api/accounts/${accountId}/mcp/${enc(name)}${qs({ scope, projectId })}`),
  loginMcp: (accountId: string, name: string) => request("POST", `/api/accounts/${accountId}/mcp/${enc(name)}/login`),
  toggleMcp: (projectId: string, name: string, enabled: boolean) =>
    request<{ warning?: string }>("POST", `/api/projects/${projectId}/mcp/${enc(name)}/toggle`, { enabled }),
  reconnectMcp: (sessionId: string, name: string) => request("POST", `/api/sessions/${sessionId}/mcp/${enc(name)}/reconnect`),
  readSkill: (accountId: string, name: string, projectId: string | null) =>
    request<{ path: string; content: string }>("GET", `/api/accounts/${accountId}/skills/${enc(name)}${qs({ projectId })}`),
  saveSkill: (accountId: string, name: string, content: string, projectId: string | null) =>
    request("PUT", `/api/accounts/${accountId}/skills/${enc(name)}`, { content, projectId: projectId ?? undefined }),
  createSkill: (accountId: string, body: { scope: "user" | "project"; name: string; description: string; body: string; projectId?: string | null }) =>
    request<{ path: string }>("POST", `/api/accounts/${accountId}/skills`, { ...body, projectId: body.projectId ?? undefined }),
  deleteSkill: (accountId: string, name: string, projectId: string | null) =>
    request<{ movedTo: string }>("DELETE", `/api/accounts/${accountId}/skills/${enc(name)}${qs({ projectId })}`),
  setSkillState: (accountId: string, name: string, state: SkillState, scope: "user" | "local", projectId: string | null) =>
    request("POST", `/api/accounts/${accountId}/skills/${enc(name)}/state`, { state, scope, projectId: projectId ?? undefined }),
}
