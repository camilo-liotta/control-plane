import type { Db } from "./db.ts"
import { inboxCounts } from "./shared/inbox-count.ts"
import type { DesktopSummary, Session } from "./shared/types.ts"

export interface SummaryDeps {
  db: Pick<Db, "listProjects" | "listDrafts" | "listTasks">
  sessions: { list(): Session[]; isRunning(id: string): boolean }
}

const HOUR = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
const DAY = new Intl.DateTimeFormat("es-AR", { weekday: "short" })
/** "22:00" si es dentro de unas horas; si no, "lun 9:00". */
function limitedUntilText(ms: number): string {
  const d = new Date(ms)
  const soon = ms - Date.now() < 12 * 3_600_000
  return soon ? HOUR.format(d) : `${DAY.format(d).replace(/\.$/, "")} ${HOUR.format(d)}`
}

const isWorking = (s: Session) => s.status === "working" || s.status === "starting"

/**
 * Resumen para el ícono de la app de escritorio. `needs` es el mismo número que el de la Bandeja
 * de la web: los dos salen de inboxCounts.
 */
export function desktopSummary({ db, sessions }: SummaryDeps): DesktopSummary {
  const all = sessions.list()
  const counts = inboxCounts({ sessions: all, drafts: db.listDrafts({ states: ["ready", "sent"] }).filter((d) => d.state === "ready" || d.planState === "paused"), tasks: db.listTasks() })
  const projects = db.listProjects().map((p) => ({
    id: p.id,
    name: p.name,
    needs: counts.byProject.get(p.id) ?? 0,
    working: all.filter((s) => s.projectId === p.id && isWorking(s)).length,
  }))
  // Sin uso: no es "te necesita" (no entra en `needs`), solo una línea más en el menú del ícono.
  const limited = all.filter((s) => s.limited && !s.archivedAt)
  return {
    limited: limited.length,
    limitedUntil: limited.length ? limitedUntilText(Math.max(...limited.map((s) => s.limited!.resetsAt))) : null,
    needs: counts.total,
    working: all.filter(isWorking).length,
    // El proceso real, no el status: es lo que corta detener el server.
    running: all.filter((s) => sessions.isRunning(s.id)).length,
    projects,
  }
}
