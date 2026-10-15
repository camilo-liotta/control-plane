import type { NoticeOpen } from "./types.ts"

const OPENS: readonly NoticeOpen[] = ["compaction", "proposals", "tasks", "environments"]

/** El `open` de un aviso, o undefined si no es uno que la web conozca. */
export function noticeOpen(v: unknown): NoticeOpen | undefined {
  return OPENS.includes(v as NoticeOpen) ? (v as NoticeOpen) : undefined
}

/** A dónde lleva tocar un aviso: la sesión si viene, si no el proyecto; las tareas y los entornos, siempre al proyecto. */
export function noticeHref(msg: { projectId?: string; sessionId?: string; open?: string }): string | null {
  if (!msg.projectId) return null
  if (msg.sessionId && msg.open !== "tasks" && msg.open !== "environments") return `/p/${msg.projectId}/s/${msg.sessionId}`
  return `/p/${msg.projectId}`
}
