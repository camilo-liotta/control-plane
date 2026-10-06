import type { Db, ProjectRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import type { Orchestration } from "./orchestration.ts"
import type { SessionManager } from "./sessions.ts"
import type { Project } from "./shared/types.ts"
import { now } from "./util.ts"

export interface ArchiveProjectDeps {
  db: Db
  hub: Pick<Hub, "broadcast">
  sessions: Pick<SessionManager, "archive" | "update">
  orchestration: Pick<Orchestration, "projectView">
}

/**
 * Margen para los proyectos archivados antes de que se anotara la hora al empezar: sus sesiones se
 * archivaban una por una y quedaban apenas antes que el proyecto.
 */
export const RESTORE_WINDOW_MS = 60_000

/**
 * Archiva un proyecto con sus sesiones. La hora del proyecto es la del comienzo, así al restaurarlo
 * se sabe cuáles se archivaron con él (las de después) y cuáles ya estaban archivadas (las de antes).
 */
export async function archiveProject(deps: ArchiveProjectDeps, p: ProjectRecord): Promise<Project> {
  const at = now()
  for (const s of deps.db.listProjectSessions(p.id).filter((s) => !s.archivedAt)) await deps.sessions.archive(s.id)
  deps.db.updateProject(p.id, { archivedAt: at })
  const view = deps.orchestration.projectView(deps.db.getProject(p.id)!)
  deps.hub.broadcast({ type: "project", project: view })
  return view
}

/**
 * Restaura un proyecto archivado y las sesiones que se archivaron con él (detenidas). La orquestadora
 * vuelve siempre. Si una sesión choca de nombre con otra que está activa, queda en Archivadas para
 * restaurarla después de renombrar.
 */
export function restoreProject(deps: ArchiveProjectDeps, id: string): { project: Project; restored: number; skipped: string[] } {
  const { db } = deps
  const p = db.getProject(id)
  if (!p) throw new Error("El proyecto no existe")
  if (!p.archivedAt) throw new Error("El proyecto no está archivado")
  const since = p.archivedAt - RESTORE_WINDOW_MS
  const taken = new Set(db.listSessions().filter((s) => !s.archivedAt).map((s) => s.name.toLowerCase()))
  const skipped: string[] = []
  let restored = 0
  for (const s of db.listProjectSessions(id)) {
    if (!s.archivedAt) continue
    if (s.kind !== "orchestrator" && s.archivedAt < since) continue
    if (taken.has(s.name.toLowerCase())) {
      if (s.kind === "orchestrator") {
        let name = `${s.name}-2`
        for (let i = 3; taken.has(name.toLowerCase()); i++) name = `${s.name}-${i}`
        deps.sessions.update(s.id, { name })
      } else {
        skipped.push(s.name)
        continue
      }
    }
    deps.sessions.update(s.id, { archivedAt: null, status: "stopped" })
    taken.add((db.getSession(s.id)?.name ?? s.name).toLowerCase())
    restored++
  }
  db.updateProject(id, { archivedAt: null })
  const project = deps.orchestration.projectView(db.getProject(id)!)
  deps.hub.broadcast({ type: "project", project })
  return { project, restored, skipped }
}
