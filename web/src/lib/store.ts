import { useMemo } from "react"
import { create } from "zustand"

import type {
  Draft,
  Meta,
  ModelOption,
  Project,
  Report,
  ServerMessage,
  Session,
  StoredEvent,
  UsageInfo,
} from "@shared/types"

import { api } from "./api"
import { notify } from "./notify"

export interface PartialBlock {
  messageId: string
  index: number
  block: "text" | "thinking"
  text: string
}

interface State {
  connected: boolean
  loaded: boolean
  projects: Record<string, Project>
  sessions: Record<string, Session>
  drafts: Record<string, Draft>
  reports: Record<string, Report>
  events: Record<string, StoredEvent[]>
  hasMore: Record<string, boolean>
  partials: Record<string, PartialBlock | undefined>
  unread: Record<string, number>
  usage: UsageInfo | null
  meta: Meta | null
  /** Sesión que estás mirando (no suma no leídos). */
  focused: string | null

  setConnected: (v: boolean) => void
  apply: (msg: ServerMessage) => void
  loadEvents: (sessionId: string) => Promise<void>
  loadOlder: (sessionId: string) => Promise<void>
  focus: (sessionId: string | null) => void
}

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]))

function mergeEvents(current: StoredEvent[], incoming: StoredEvent[]): StoredEvent[] {
  const map = new Map<number, StoredEvent>()
  for (const e of current) map.set(e.id, e)
  for (const e of incoming) map.set(e.id, e)
  return [...map.values()].sort((a, b) => a.id - b.id)
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  loaded: false,
  projects: {},
  sessions: {},
  drafts: {},
  reports: {},
  events: {},
  hasMore: {},
  partials: {},
  unread: {},
  usage: null,
  meta: null,
  focused: null,

  setConnected: (v) => set({ connected: v }),

  focus: (sessionId) =>
    set((s) => ({ focused: sessionId, unread: sessionId ? { ...s.unread, [sessionId]: 0 } : s.unread })),

  apply: (msg) => {
    switch (msg.type) {
      case "hello": {
        const { snapshot } = msg
        set({
          loaded: true,
          projects: byId(snapshot.projects),
          sessions: byId(snapshot.sessions),
          drafts: byId(snapshot.drafts),
          reports: byId(snapshot.reports),
          usage: snapshot.usage,
          meta: snapshot.meta,
          partials: {},
        })
        // Tras una reconexión, rellenamos lo que nos perdimos de las sesiones abiertas.
        for (const id of Object.keys(get().events)) void get().loadEvents(id)
        break
      }
      case "project":
        set((s) => {
          const projects = { ...s.projects }
          if (msg.project.archivedAt) delete projects[msg.project.id]
          else projects[msg.project.id] = msg.project
          return { projects }
        })
        break
      case "session":
        set((s) => {
          const sessions = { ...s.sessions }
          if (msg.session.archivedAt) delete sessions[msg.session.id]
          else sessions[msg.session.id] = msg.session
          return { sessions }
        })
        break
      case "event": {
        const { event } = msg
        set((s) => {
          const patch: Partial<State> = {}
          if (s.events[event.sessionId]) {
            patch.events = { ...s.events, [event.sessionId]: mergeEvents(s.events[event.sessionId]!, [event]) }
          }
          if (event.event.kind === "text" && !event.event.parent) {
            patch.partials = { ...s.partials, [event.sessionId]: undefined }
            if (s.focused !== event.sessionId || document.hidden)
              patch.unread = { ...s.unread, [event.sessionId]: (s.unread[event.sessionId] ?? 0) + 1 }
          }
          return patch
        })
        break
      }
      case "event_update":
        set((s) => {
          const list = s.events[msg.event.sessionId]
          if (!list) return {}
          return { events: { ...s.events, [msg.event.sessionId]: mergeEvents(list, [msg.event]) } }
        })
        break
      case "partial":
        set((s) => {
          const prev = s.partials[msg.sessionId]
          const same = prev && prev.messageId === msg.messageId && prev.index === msg.index
          return {
            partials: {
              ...s.partials,
              [msg.sessionId]: {
                messageId: msg.messageId,
                index: msg.index,
                block: msg.block,
                text: (same ? prev.text : "") + msg.delta,
              },
            },
          }
        })
        break
      case "partial_clear":
        set((s) => ({ partials: { ...s.partials, [msg.sessionId]: undefined } }))
        break
      case "draft":
        set((s) => ({ drafts: { ...s.drafts, [msg.draft.id]: msg.draft } }))
        break
      case "report":
        set((s) => ({ reports: { ...s.reports, [msg.report.id]: msg.report } }))
        break
      case "usage":
        set({ usage: msg.usage })
        break
      case "meta":
        set({ meta: msg.meta })
        break
      case "toast":
        notify(msg)
        break
    }
  },

  loadEvents: async (sessionId) => {
    const list = await api.events(sessionId)
    set((s) => ({
      events: { ...s.events, [sessionId]: mergeEvents(s.events[sessionId] ?? [], list) },
      hasMore: { ...s.hasMore, [sessionId]: list.length >= 300 },
    }))
  },

  loadOlder: async (sessionId) => {
    const current = get().events[sessionId]
    const first = current?.[0]?.id
    if (!first) return
    const list = await api.events(sessionId, first)
    set((s) => ({
      events: { ...s.events, [sessionId]: mergeEvents(s.events[sessionId] ?? [], list) },
      hasMore: { ...s.hasMore, [sessionId]: list.length >= 300 },
    }))
  },
}))

// ------------------------------------------------------------------ selectores

/** Proyectos ordenados por fecha de creación (referencia estable entre renders). */
export function useProjects() {
  const projects = useStore((s) => s.projects)
  return useMemo(() => Object.values(projects).sort((a, b) => a.createdAt - b.createdAt), [projects])
}

const NO_MODELS: ModelOption[] = []

export function useModels() {
  return useStore((s) => s.meta?.models) ?? NO_MODELS
}

export function projectSessions(sessions: Record<string, Session>, projectId: string) {
  const list = Object.values(sessions).filter((s) => s.projectId === projectId)
  const orchestrator = list.find((s) => s.kind === "orchestrator") ?? null
  const workers = list.filter((s) => s.kind === "worker").sort((a, b) => a.createdAt - b.createdAt)
  return { orchestrator, workers }
}

export function openDrafts(drafts: Record<string, Draft>, projectId?: string) {
  return Object.values(drafts)
    .filter((d) => (d.state === "staged" || d.state === "ready") && (!projectId || d.projectId === projectId))
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function projectReports(reports: Record<string, Report>, projectId: string) {
  return Object.values(reports)
    .filter((r) => r.projectId === projectId && r.state !== "dismissed")
    .sort((a, b) => b.createdAt - a.createdAt)
}
