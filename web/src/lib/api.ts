import type { Draft, Project, ProjectSettings, Report, Session, StoredEvent } from "@shared/types"

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

export const api = {
  suggestDirs: (path: string) => request<DirSuggestion>("GET", `/api/fs/suggest?path=${encodeURIComponent(path)}`),

  createProject: (body: { name?: string; repoPath: string; settings?: Partial<ProjectSettings> }) =>
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
  send: (id: string, text: string) => request<StoredEvent>("POST", `/api/sessions/${id}/messages`, { text }),
  start: (id: string) => request("POST", `/api/sessions/${id}/start`),
  stop: (id: string) => request("POST", `/api/sessions/${id}/stop`),
  interrupt: (id: string) => request("POST", `/api/sessions/${id}/interrupt`),
  answer: (id: string, requestId: string, answers: Record<string, string>) =>
    request("POST", `/api/sessions/${id}/answer`, { requestId, answers }),
  permission: (id: string, requestId: string, allow: boolean) =>
    request("POST", `/api/sessions/${id}/permission`, { requestId, allow }),

  sendDraft: (id: string, edits: { title?: string; prompt?: string; name?: string; role?: string } = {}) =>
    request<Draft>("POST", `/api/drafts/${id}/send`, edits),
  discardDraft: (id: string) => request<Draft>("POST", `/api/drafts/${id}/discard`),
  editDraft: (id: string, edits: { title?: string; prompt?: string }) => request<Draft>("PATCH", `/api/drafts/${id}`, edits),

  dismissReport: (id: string) => request("POST", `/api/reports/${id}/dismiss`),
}
