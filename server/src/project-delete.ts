import type { Apps } from "./apps.ts"
import type { AttachmentStore } from "./attachments.ts"
import type { Compaction } from "./compaction.ts"
import type { Db } from "./db.ts"
import type { Hub } from "./hub.ts"
import type { Orchestration } from "./orchestration.ts"
import type { SessionManager } from "./sessions.ts"

export interface DeleteProjectDeps {
  db: Db
  hub: Pick<Hub, "broadcast">
  sessions: Pick<SessionManager, "setDeleting" | "stopAll" | "forget" | "isRunning">
  orchestration: Pick<Orchestration, "forgetProject">
  compaction: Pick<Compaction, "forget">
  attachments: Pick<AttachmentStore, "removeSession">
  /** Para bajar las apps del proyecto que estén levantadas antes de borrarlas. */
  apps?: Pick<Apps, "removeProject">
}

/** Cuánto esperamos a que se detengan las sesiones (el cierre de siempre llega a SIGKILL a los 8 s). */
export const STOP_TIMEOUT_MS = 15_000

/**
 * Borra un proyecto del dashboard: primero detiene sus sesiones y después borra de la base todo lo
 * suyo (en una transacción) y los adjuntos de sus sesiones. No toca el repo, los worktrees ni las
 * conversaciones de Claude Code. Pide el nombre del proyecto como confirmación.
 */
export async function deleteProject(
  deps: DeleteProjectDeps,
  id: string,
  confirm: unknown,
  opts: { stopTimeoutMs?: number } = {}
): Promise<{ ok: true; stopped: number }> {
  const { db, sessions } = deps
  const project = db.getProject(id)
  if (!project) throw new Error("El proyecto no existe")
  if (typeof confirm !== "string" || confirm.trim() !== project.name)
    throw new Error(`Para borrarlo, escribí el nombre del proyecto: ${project.name}`)

  const list = db.listProjectSessions(id)
  const ids = list.map((s) => s.id)
  sessions.setDeleting(id, true)
  const stopped = ids.filter((sid) => sessions.isRunning(sid)).length
  try {
    const stuck = await sessions.stopAll(ids, opts.stopTimeoutMs ?? STOP_TIMEOUT_MS)
    if (stuck.length) {
      const names = list.filter((s) => stuck.includes(s.id)).map((s) => s.name)
      throw new Error(`No se pudieron detener ${names.join(", ")} y no se borró nada. Detenelas y probá de nuevo.`)
    }
    for (const sid of ids) deps.compaction.forget(sid)
    await deps.apps?.removeProject(id)
    db.purgeProject(id)
  } finally {
    sessions.setDeleting(id, false)
  }

  for (const sid of ids) {
    try {
      deps.attachments.removeSession(sid)
    } catch {
      // la base ya no los nombra: si quedó algún archivo, no rompe nada
    }
  }
  sessions.forget(ids)
  deps.orchestration.forgetProject(id)
  deps.hub.broadcast({ type: "project_removed", id })
  return { ok: true, stopped }
}
