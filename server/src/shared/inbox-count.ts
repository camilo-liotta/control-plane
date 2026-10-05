// Cuántas cosas te esperan: el número de la Bandeja en la web y el del ícono de la app de
// escritorio (y el contador del dock). Los dos lo sacan de acá para no contar distinto.

import type { Draft, Session, UserTask } from "./types.ts"

type Counted = {
  sessions: Iterable<Pick<Session, "projectId" | "status">>
  drafts: Iterable<Pick<Draft, "projectId" | "state">>
  tasks: Iterable<Pick<UserTask, "projectId" | "status" | "blocking">>
}

/** Te espera: una sesión que te necesita, una propuesta lista o una tarea que frena a una sesión. */
export const sessionWaits = (s: Pick<Session, "status">) => s.status === "needs_input"
export const draftWaits = (d: Pick<Draft, "state">) => d.state === "ready"
export const taskWaits = (t: Pick<UserTask, "status" | "blocking">) => t.status === "open" && t.blocking

/** Lo que te espera, en total y por proyecto (solo aparecen los proyectos con algo). */
export function inboxCounts({ sessions, drafts, tasks }: Counted): { total: number; byProject: Map<string, number> } {
  const byProject = new Map<string, number>()
  let total = 0
  const add = (projectId: string) => {
    total++
    byProject.set(projectId, (byProject.get(projectId) ?? 0) + 1)
  }
  for (const s of sessions) if (sessionWaits(s)) add(s.projectId)
  for (const d of drafts) if (draftWaits(d)) add(d.projectId)
  for (const t of tasks) if (taskWaits(t)) add(t.projectId)
  return { total, byProject }
}
