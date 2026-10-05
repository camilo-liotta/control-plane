import type { Db } from "./db.ts"
import { inboxCounts } from "./shared/inbox-count.ts"
import type { DesktopSummary, Session } from "./shared/types.ts"

export interface SummaryDeps {
  db: Pick<Db, "listProjects" | "listDrafts" | "listTasks">
  sessions: { list(): Session[]; isRunning(id: string): boolean }
}

const isWorking = (s: Session) => s.status === "working" || s.status === "starting"

/**
 * Resumen para el ícono de la app de escritorio. `needs` es el mismo número que el de la Bandeja
 * de la web: los dos salen de inboxCounts.
 */
export function desktopSummary({ db, sessions }: SummaryDeps): DesktopSummary {
  const all = sessions.list()
  const counts = inboxCounts({ sessions: all, drafts: db.listDrafts({ states: ["ready"] }), tasks: db.listTasks() })
  const projects = db.listProjects().map((p) => ({
    id: p.id,
    name: p.name,
    needs: counts.byProject.get(p.id) ?? 0,
    working: all.filter((s) => s.projectId === p.id && isWorking(s)).length,
  }))
  return {
    needs: counts.total,
    working: all.filter(isWorking).length,
    // El proceso real, no el status: es lo que corta detener el server.
    running: all.filter((s) => sessions.isRunning(s.id)).length,
    projects,
  }
}
