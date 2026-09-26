import { useMemo } from "react"
import { create } from "zustand"

import type {
  Account,
  CompactionState,
  Draft,
  UserTask,
  Meta,
  ModelOption,
  Project,
  Report,
  ServerMessage,
  Session,
  StoredEvent,
  TurnProgress,
} from "@shared/types"

import { api } from "./api"
import { notify } from "./notify"
import { useUi } from "./ui"

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
  tasks: Record<string, UserTask>
  reports: Record<string, Report>
  events: Record<string, StoredEvent[]>
  hasMore: Record<string, boolean>
  partials: Record<string, PartialBlock | undefined>
  unread: Record<string, number>
  accounts: Record<string, Account>
  /** Compactaciones en curso por sesión (borrador, espera, aplicando). */
  compactions: Record<string, CompactionState>
  /** Turno en curso de cada sesión que está trabajando: cuándo empezó y cuántos tokens van. */
  turns: Record<string, TurnProgress | undefined>
  /** Sube cada vez que el server avisa que cambió algo de los CLIs. */
  clisTick: number
  /** Si hay una app de escritorio conectada al server. */
  desktopConnected: boolean
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
  tasks: {},
  reports: {},
  events: {},
  hasMore: {},
  partials: {},
  unread: {},
  accounts: {},
  compactions: {},
  turns: {},
  clisTick: 0,
  desktopConnected: false,
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
          tasks: byId(snapshot.tasks ?? []),
          reports: byId(snapshot.reports),
          accounts: byId(snapshot.accounts),
          compactions: Object.fromEntries((snapshot.compactions ?? []).map((c) => [c.sessionId, c])),
          turns: Object.fromEntries((snapshot.turns ?? []).map((t) => [t.sessionId, t.turn])),
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
      case "task":
        set((s) => ({ tasks: { ...s.tasks, [msg.task.id]: msg.task } }))
        break
      case "report":
        set((s) => ({ reports: { ...s.reports, [msg.report.id]: msg.report } }))
        break
      case "usage":
        set((s) => {
          const account = s.accounts[msg.accountId]
          return account ? { accounts: { ...s.accounts, [msg.accountId]: { ...account, usage: msg.usage } } } : {}
        })
        break
      case "account":
        set((s) => ({ accounts: { ...s.accounts, [msg.account.id]: msg.account } }))
        break
      case "account_removed":
        set((s) => {
          const accounts = { ...s.accounts }
          delete accounts[msg.id]
          return { accounts }
        })
        break
      case "meta":
        set({ meta: msg.meta })
        break
      case "compaction":
        set((s) => ({ compactions: { ...s.compactions, [msg.state.sessionId]: msg.state } }))
        break
      case "turn":
        set((s) => ({ turns: { ...s.turns, [msg.sessionId]: msg.turn ?? undefined } }))
        break
      case "clis_changed":
        set((s) => ({ clisTick: s.clisTick + 1 }))
        break
      case "desktop":
        set({ desktopConnected: msg.connected })
        break
      case "desktop_summary":
        // es para la app de escritorio: a la web no le llega
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

/** Cuentas ordenadas: la de siempre primero. */
export function useAccounts() {
  const accounts = useStore((s) => s.accounts)
  return useMemo(
    () => Object.values(accounts).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)),
    [accounts]
  )
}

/** La cuenta elegida en el selector (si la guardada ya no existe, la de siempre). */
export function useCurrentAccount(): Account | null {
  const accounts = useAccounts()
  const selected = useUi((s) => s.account)
  return accounts.find((a) => a.id === selected) ?? accounts.find((a) => a.isDefault) ?? accounts[0] ?? null
}

/** Proyectos de la cuenta elegida (u otra), ordenados por fecha de creación (referencia estable entre renders). */
export function useProjects(of?: Account | null) {
  const projects = useStore((s) => s.projects)
  const current = useCurrentAccount()
  const account = of ?? current
  const accountId = account?.id ?? null
  const isDefault = account?.isDefault ?? true
  return useMemo(
    () =>
      Object.values(projects)
        .filter((p) => (p.accountId ? p.accountId === accountId : isDefault))
        .sort((a, b) => a.createdAt - b.createdAt),
    [projects, accountId, isDefault]
  )
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
