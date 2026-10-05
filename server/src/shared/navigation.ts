// Moverse entre sesiones, lo que te necesita, las recientes y la última ruta: la lógica de los
// atajos y de la paleta, sin React ni el navegador (para poder probarla).

import type { Draft, Session, UserTask } from "./types.ts"

/** Las sesiones del proyecto en el orden de la barra lateral: la orquestadora y los workers por antigüedad. */
export function sessionOrder(sessions: Session[], projectId: string): Session[] {
  const mine = sessions.filter((s) => s.projectId === projectId && !s.archivedAt)
  const orch = mine.filter((s) => s.kind === "orchestrator")
  const workers = mine.filter((s) => s.kind === "worker").sort((a, b) => a.createdAt - b.createdAt)
  return [...orch, ...workers]
}

/**
 * La sesión anterior o siguiente del proyecto, dando la vuelta. Desde el tablero (sin sesión
 * actual), la primera o la última.
 */
export function adjacentSession(sessions: Session[], projectId: string, currentId: string | null, dir: 1 | -1): Session | null {
  const list = sessionOrder(sessions, projectId)
  if (!list.length) return null
  const i = currentId ? list.findIndex((s) => s.id === currentId) : -1
  if (i < 0) return dir === 1 ? list[0]! : list[list.length - 1]!
  if (list.length === 1) return null
  return list[(i + dir + list.length) % list.length]!
}

/** Qué te necesita, en orden: lo que la paleta pone arriba y a donde lleva "la próxima". */
export type NeedsYou =
  | { kind: "session"; session: Session; since: number }
  | { kind: "proposals"; projectId: string; orchestratorId: string; count: number; since: number }
  | { kind: "task"; task: UserTask; since: number }

/**
 * Lo que espera algo de vos en estos proyectos, lo más viejo primero (lo mismo que cuenta la Bandeja):
 * sesiones que te preguntan algo, propuestas listas para enviar y tareas que frenan a una sesión.
 */
export function needsYou(args: { sessions: Session[]; drafts: Draft[]; tasks: UserTask[]; projectIds: Set<string> }): NeedsYou[] {
  const { sessions, drafts, tasks, projectIds } = args
  const out: NeedsYou[] = []
  for (const s of sessions) {
    if (!projectIds.has(s.projectId) || s.archivedAt || s.status !== "needs_input") continue
    out.push({ kind: "session", session: s, since: s.lastActivityAt ?? s.createdAt })
  }
  const ready = new Map<string, Draft[]>()
  for (const d of drafts) if (d.state === "ready" && projectIds.has(d.projectId)) ready.set(d.projectId, [...(ready.get(d.projectId) ?? []), d])
  for (const [projectId, list] of ready) {
    const orch = sessions.find((s) => s.projectId === projectId && s.kind === "orchestrator" && !s.archivedAt)
    if (orch) out.push({ kind: "proposals", projectId, orchestratorId: orch.id, count: list.length, since: Math.min(...list.map((d) => d.updatedAt)) })
  }
  for (const t of tasks) {
    if (t.status === "open" && t.blocking && projectIds.has(t.projectId)) out.push({ kind: "task", task: t, since: t.updatedAt })
  }
  return out.sort((a, b) => a.since - b.since)
}

/** A dónde lleva cada cosa que te necesita. */
export function needsYouHref(n: NeedsYou): string {
  if (n.kind === "session") return `/p/${n.session.projectId}/s/${n.session.id}`
  if (n.kind === "proposals") return `/p/${n.projectId}/s/${n.orchestratorId}`
  return `/p/${n.task.projectId}`
}

/**
 * La próxima que te necesita, después de donde estás (dando la vuelta): apretando el atajo varias
 * veces se recorren todas. Si estás en la única, null (no hay a dónde ir).
 */
export function nextNeedsYou(list: NeedsYou[], here: string | null): NeedsYou | null {
  if (!list.length) return null
  const hrefs = list.map(needsYouHref)
  const i = here ? hrefs.indexOf(here) : -1
  for (let k = 1; k <= list.length; k++) {
    const n = list[(i + k + list.length) % list.length]!
    if (needsYouHref(n) !== here) return n
  }
  return null
}

/** Las sesiones que abriste hace poco, la más reciente primero (sin repetir). */
export function pushRecent(recent: string[], id: string, max = 8): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, max)
}

/**
 * La ruta a la que se puede volver al abrir: una sesión o un tablero que siguen existiendo (y no
 * archivados). El inicio no cuenta (es a donde ya llegás).
 */
export function restorableRoute(route: string | null, alive: { projects: Set<string>; sessions: Set<string> }): string | null {
  if (!route) return null
  const m = /^\/p\/([^/?#]+)(?:\/(tools)|\/s\/([^/?#]+))?\/?$/.exec(route)
  if (m) {
    const [, projectId, , sessionId] = m
    if (!alive.projects.has(projectId!)) return null
    if (sessionId && !alive.sessions.has(sessionId)) return null
    return route
  }
  return route === "/tools" ? route : null
}

/** Dónde quedó el scroll de una sesión: pegado al final, o en una posición. */
export type ScrollSpot = { atEnd: true } | { atEnd: false; top: number }

/** Lo que se guarda al salir de una sesión. "Al final" con un margen, como el que usa el chat para seguir lo nuevo. */
export function scrollSpot(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, margin = 140): ScrollSpot {
  return el.scrollHeight - el.scrollTop - el.clientHeight < margin ? { atEnd: true } : { atEnd: false, top: el.scrollTop }
}
