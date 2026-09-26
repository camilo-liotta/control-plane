import type { Db, SessionRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import type { SessionManager } from "./sessions.ts"
import type { UserTask, UserTaskStatus } from "./shared/types.ts"
import { now, oneLine, shortId } from "./util.ts"

/**
 * El tablero de tareas para vos: lo que las sesiones necesitan que hagas y no pueden hacer ellas
 * (un login, algo en una web, una aprobación en otro sistema). Las crean y las cierran las sesiones;
 * vos las marcás hechas desde el tablero del proyecto, y la sesión que esperaba se entera.
 */

const DAY = 24 * 60 * 60 * 1000
/** Se avisa un poco antes de la fecha. */
const REMIND_AHEAD = 15 * 60_000

export interface TaskInput {
  title: string
  steps: string[]
  why?: string | null
  blocking?: boolean
  due?: number | null
}

/** Palabras que importan de un título, para reconocer dos pedidos del mismo trabajo. */
function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9#]+/g, " ")
      .split(" ")
      .filter((w) => w.length > 2)
  )
}

export function sameTask(a: string, b: string): boolean {
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase()
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.min(x.size, y.size) >= 0.75
}

function clean(input: TaskInput) {
  const title = oneLine(input.title, 140).trim()
  if (!title) throw new Error("La tarea necesita un título")
  const steps = input.steps.map((s) => s.trim()).filter(Boolean).slice(0, 12)
  if (!steps.length) throw new Error("Contá los pasos: una lista corta de lo que el usuario tiene que hacer")
  return { title, steps, why: input.why?.trim() ? oneLine(input.why, 300) : null }
}

export class UserTasks {
  private deps: { db: Db; hub: Hub; sessions: SessionManager }
  private timer: NodeJS.Timeout

  constructor(deps: { db: Db; hub: Hub; sessions: SessionManager }) {
    this.deps = deps
    this.timer = setInterval(() => this.remind(), 60_000)
    this.timer.unref?.()
  }

  list(projectId?: string): UserTask[] {
    return this.deps.db.listTasks({ projectId, closedSince: now() - 7 * DAY })
  }

  private broadcast(id: string) {
    const task = this.deps.db.getTask(id)
    if (task) this.deps.hub.broadcast({ type: "task", task })
    return task!
  }

  private project(projectId: string) {
    const p = this.deps.db.getProject(projectId)
    if (!p || p.archivedAt) throw new Error("El proyecto no existe")
    return p
  }

  /**
   * Una tarea nueva. Si ya hay una abierta para lo mismo, se suma a esa (quién más la pide, si
   * ahora frena a alguien) y se devuelve esa: la sesión se entera de que ya estaba.
   */
  create(projectId: string, input: TaskInput, from: SessionRecord | null): { task: UserTask; existing: boolean } {
    const p = this.project(projectId)
    const { title, steps, why } = clean(input)
    const twin = this.deps.db.listTasks({ projectId: p.id }).find((t) => t.status === "open" && sameTask(t.title, title))
    if (twin) {
      const alsoBy = from && from.id !== twin.createdBy && !twin.alsoBy.includes(from.id) ? [...twin.alsoBy, from.id] : twin.alsoBy
      this.deps.db.updateTask(twin.id, { alsoBy, blocking: twin.blocking || Boolean(input.blocking), updatedAt: now() })
      if (from) this.deps.sessions.addEvent(from.id, { kind: "notice", level: "info", text: `Ya había una tarea para el usuario con eso: "${twin.title}". Se sumó tu pedido.` })
      return { task: this.broadcast(twin.id), existing: true }
    }
    const task: UserTask = {
      id: shortId("t_"),
      projectId: p.id,
      title,
      steps,
      why,
      blocking: Boolean(input.blocking),
      due: input.due ?? null,
      createdBy: from?.id ?? null,
      alsoBy: [],
      status: "open",
      note: null,
      closedBy: null,
      createdAt: now(),
      updatedAt: now(),
      closedAt: null,
    }
    this.deps.db.insertTask(task)
    if (from) {
      this.deps.sessions.addEvent(from.id, { kind: "notice", level: "info", text: `Creó una tarea para vos: "${title}". Está en el tablero del proyecto.` })
      this.deps.hub.broadcast({
        type: "toast",
        level: task.blocking ? "warn" : "info",
        event: "task",
        title: `${from.name} te dejó una tarea`,
        body: title,
        projectId: p.id,
        sessionId: from.id,
        // La tarea se ve en el tablero, no en el chat de quien la pidió.
        open: "tasks",
      })
    }
    return { task: this.broadcast(task.id), existing: false }
  }

  /** Cambiar una tarea: la completan o descartan las sesiones o vos, o se corrigen sus pasos. */
  update(
    id: string,
    patch: { status?: UserTaskStatus; note?: string | null; title?: string; steps?: string[]; why?: string | null; blocking?: boolean; due?: number | null },
    by: SessionRecord | "user",
    opts: { notify?: boolean } = {}
  ): UserTask {
    const t = this.deps.db.getTask(id)
    if (!t) throw new Error(`No existe la tarea ${id}`)
    if (by !== "user" && by.projectId !== t.projectId) throw new Error(`La tarea ${id} es de otro proyecto`)
    const change: Partial<UserTask> = { updatedAt: now() }
    if (patch.title !== undefined || patch.steps !== undefined) {
      const c = clean({ title: patch.title ?? t.title, steps: patch.steps ?? t.steps, why: patch.why !== undefined ? patch.why : t.why })
      Object.assign(change, c)
    } else if (patch.why !== undefined) change.why = patch.why?.trim() || null
    if (patch.blocking !== undefined) change.blocking = patch.blocking
    if (patch.due !== undefined) change.due = patch.due
    const closing = patch.status && patch.status !== "open" && t.status === "open"
    if (patch.status) {
      change.status = patch.status
      change.closedAt = patch.status === "open" ? null : now()
      change.closedBy = patch.status === "open" ? null : by === "user" ? "user" : by.id
    }
    if (patch.note !== undefined) change.note = patch.note?.trim() ? oneLine(patch.note, 400) : null
    this.deps.db.updateTask(t.id, change)
    const task = this.broadcast(t.id)
    if (closing && by !== "user") {
      this.deps.sessions.addEvent(by.id, {
        kind: "notice",
        level: "info",
        text: `${patch.status === "done" ? "Dio por hecha" : "Descartó"} la tarea para vos: "${t.title}"${task.note ? ` (${task.note})` : ""}.`,
      })
    }
    // La marcaste vos: a las sesiones que la pidieron les llega el aviso (si esperaban, siguen).
    if (closing && by === "user" && (opts.notify ?? t.blocking)) void this.tell(task)
    return task
  }

  private async tell(task: UserTask) {
    const ids = [task.createdBy, ...task.alsoBy].filter((x): x is string => Boolean(x))
    for (const id of new Set(ids)) {
      const s = this.deps.db.getSession(id)
      if (!s || s.archivedAt) continue
      const what = task.status === "done" ? "ya hizo" : "descartó (no hace falta)"
      const text = `[control-plane] El usuario ${what} la tarea "${task.title}" (${task.id})${task.note ? `. Nota: ${task.note}` : ""}. Si estabas esperando esto, seguí.`
      await this.deps.sessions
        .send(s.id, text, { origin: "control", event: { kind: "notice", level: "info", text: `Le avisé que ${task.status === "done" ? "hiciste" : "descartaste"} la tarea "${task.title}".` } })
        .catch(() => {})
    }
  }

  /** Las que tienen fecha: un aviso un rato antes. */
  private remind() {
    const at = now()
    for (const t of this.deps.db.dueTasks(at + REMIND_AHEAD)) {
      this.deps.db.markReminded(t.id, at)
      this.deps.hub.broadcast({
        type: "toast",
        level: "warn",
        event: "task",
        title: t.due! <= at ? "Una tarea tuya ya venció" : "Una tarea tuya vence en un rato",
        body: t.title,
        projectId: t.projectId,
        open: "tasks",
      })
    }
  }

  /** Lo que ven las sesiones con list_user_tasks. */
  summary(projectId: string): string {
    const list = this.list(projectId)
    if (!list.length) return "No hay tareas para el usuario en este proyecto."
    const name = (id: string | null) => (id ? (this.deps.db.getSession(id)?.name ?? "?") : "el usuario")
    const fmt = (t: UserTask) =>
      `- [${t.id}] ${t.title}${t.blocking ? " · frena a alguien" : ""}${t.due ? ` · para ${new Date(t.due).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""} · la pidió ${name(t.createdBy)}` +
      `${t.alsoBy.length ? ` (también ${t.alsoBy.map(name).join(", ")})` : ""}\n  ${t.steps.map((s, i) => `${i + 1}. ${s}`).join("\n  ")}`
    const open = list.filter((t) => t.status === "open")
    const closed = list.filter((t) => t.status !== "open")
    return [
      open.length ? `Abiertas:\n${open.map(fmt).join("\n")}` : "No hay tareas abiertas.",
      closed.length
        ? `Cerradas en los últimos días:\n${closed.map((t) => `- [${t.id}] ${t.title} · ${t.status === "done" ? "hecha" : "descartada"} por ${t.closedBy === "user" ? "el usuario" : name(t.closedBy)}${t.note ? ` (${t.note})` : ""}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  dispose() {
    clearInterval(this.timer)
  }
}
