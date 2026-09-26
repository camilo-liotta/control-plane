import type { Db } from "./db.ts"
import type { DesktopSummary, Session } from "./shared/types.ts"

export interface SummaryDeps {
  db: Pick<Db, "listProjects" | "listDrafts">
  sessions: { list(): Session[]; isRunning(id: string): boolean }
}

const isWorking = (s: Session) => s.status === "working" || s.status === "starting"

/**
 * Resumen para la bandeja de la app de escritorio. `needs` cuenta lo mismo que la bandeja de
 * entrada de la web (useInboxCount): sesiones que te necesitan más propuestas listas para enviar.
 */
export function desktopSummary({ db, sessions }: SummaryDeps): DesktopSummary {
  const all = sessions.list()
  const ready = db.listDrafts({ states: ["ready"] })
  const projects = db.listProjects().map((p) => {
    const own = all.filter((s) => s.projectId === p.id)
    return {
      id: p.id,
      name: p.name,
      needs: own.filter((s) => s.status === "needs_input").length + ready.filter((d) => d.projectId === p.id).length,
      working: own.filter(isWorking).length,
    }
  })
  return {
    needs: all.filter((s) => s.status === "needs_input").length + ready.length,
    working: all.filter(isWorking).length,
    // El proceso real, no el status: es lo que corta detener el server.
    running: all.filter((s) => sessions.isRunning(s.id)).length,
    projects,
  }
}
