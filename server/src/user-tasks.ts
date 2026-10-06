import type { Clis, CliSpec } from "./clis.ts"
import type { Db, SessionRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import type { SessionManager } from "./sessions.ts"
import { compareTasks, normalizeTags } from "./shared/task-order.ts"
import type { CliJob, UserTask, UserTaskCli, UserTaskStatus } from "./shared/types.ts"
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
  cli?: { id: string; credential?: number | null } | null
  priority?: number | null
  tags?: string[]
}

/** La nota con la que se cierra sola una tarea de login que salió bien. */
export const CLI_DONE_NOTE = "Reautenticado desde la tarea"
/** Cómo empieza la nota de una tarea de login que falló (sigue abierta, con el motivo). */
export const CLI_FAILED_NOTE = "No se pudo reautenticar:"

const LOGIN_WORDS = /\b(re-?autentic\w*|autentic\w*|re-?logue\w*|logue\w*|login|log in|inici\w* (la )?sesi[oó]n|sign in)\b/i
/** Loguearse en la web de algo no es loguear su CLI. */
const NOT_THE_CLI = /\b(web|consola|console|dashboard|portal|navegador)\b/i
const ADC = /application-default|\bADC\b|credenciales de (la )?aplicaci[oó]n/i
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * De qué CLI es una tarea que no lo dice (las de antes de que existiera el campo): conservador.
 * - el título pide loguearse ("Reautenticar gcloud", "Loguear gh con la cuenta de la empresa") y
 *   nombra un CLI del catálogo que tiene login, sin hablar de su web o su consola; o
 * - un paso trae su comando de login tal cual (`gcloud auth login`).
 */
export function detectCli(task: Pick<UserTask, "title" | "steps">, catalog: readonly CliSpec[]): UserTaskCli | null {
  const text = [task.title, ...task.steps].join("\n")
  const credentialOf = (spec: CliSpec) => {
    if (!ADC.test(text)) return 0
    const i = (spec.auth ?? []).findIndex((a) => a.login?.includes("application-default"))
    return i >= 0 ? i : 0
  }
  const withLogin = catalog.filter((c) => c.auth?.some((a) => a.login || a.terminalLogin))
  for (const spec of withLogin) {
    for (const a of spec.auth ?? []) {
      if (!a.login) continue
      for (const bin of spec.bins) if (text.includes(`${bin} ${a.login.join(" ")}`)) return { id: spec.id, credential: credentialOf(spec) }
    }
  }
  if (!LOGIN_WORDS.test(task.title) || NOT_THE_CLI.test(task.title)) return null
  for (const spec of withLogin) {
    const names = [spec.id, ...spec.bins, spec.name.replace(/\s+CLI$/i, "")].map((n) => n.toLowerCase())
    const re = new RegExp(`(^|[^a-z0-9-])(${[...new Set(names)].map((n) => escape(n).replace(/\s+/g, "\\s+")).join("|")})($|[^a-z0-9-])`, "i")
    if (re.test(task.title)) return { id: spec.id, credential: credentialOf(spec) }
  }
  return null
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

/** `needSteps`: las sesiones tienen que contar los pasos; una tarea que te anotás vos puede no tenerlos. */
function clean(input: TaskInput, needSteps = true) {
  const title = oneLine(input.title, 140).trim()
  if (!title) throw new Error("La tarea necesita un título")
  const steps = input.steps.map((s) => s.trim()).filter(Boolean).slice(0, 12)
  if (needSteps && !steps.length) throw new Error("Contá los pasos: una lista corta de lo que el usuario tiene que hacer")
  return { title, steps, why: input.why?.trim() ? oneLine(input.why, 300) : null }
}

/** Prioridad: un entero desde 1 (1 va primero), o sin prioridad. */
function cleanPriority(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null
  return Math.min(999, Math.max(1, Math.round(Number(v))))
}

const lastLine = (out: string) => oneLine(out.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "", 160)

export class UserTasks {
  private deps: { db: Db; hub: Hub; sessions: SessionManager; clis?: Clis }
  private timer: NodeJS.Timeout

  constructor(deps: { db: Db; hub: Hub; sessions: SessionManager; clis?: Clis }) {
    this.deps = deps
    this.timer = setInterval(() => this.remind(), 60_000)
    this.timer.unref?.()
  }

  list(projectId?: string): UserTask[] {
    return this.deps.db.listTasks({ projectId, closedSince: now() - 7 * DAY }).map((t) => this.withCli(t))
  }

  get(id: string): UserTask | null {
    const t = this.deps.db.getTask(id)
    return t ? this.withCli(t) : null
  }

  /** Las que no dicen de qué CLI son: si se reconoce por el título o los pasos, se completa (no se guarda). */
  private withCli(t: UserTask): UserTask {
    if (t.cli || !this.deps.clis) return t
    return { ...t, cli: detectCli(t, this.deps.clis.specs()) }
  }

  private broadcast(id: string) {
    const task = this.get(id)
    if (task) this.deps.hub.broadcast({ type: "task", task })
    return task!
  }

  /** El CLI que pide una sesión: tiene que estar en el catálogo y tener esa credencial. */
  private cliOf(input: TaskInput["cli"]): UserTaskCli | null {
    if (!input) return null
    const credential = Math.max(0, Math.round(Number(input.credential ?? 0)) || 0)
    const spec = this.deps.clis?.specs().find((c) => c.id === input.id)
    if (this.deps.clis && !spec) throw new Error(`"${input.id}" no está en el catálogo de CLIs: mirá los ids con list_clis`)
    if (spec && !spec.auth?.[credential]) throw new Error(`${spec.name} no tiene la credencial ${credential}`)
    return { id: input.id, credential }
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
    const { title, steps, why } = clean(input, from !== null)
    const cli = this.cliOf(input.cli)
    const priority = cleanPriority(input.priority)
    const tags = normalizeTags(input.tags ?? [])
    const twin = this.deps.db.listTasks({ projectId: p.id }).find((t) => t.status === "open" && sameTask(t.title, title))
    if (twin) {
      const alsoBy = from && from.id !== twin.createdBy && !twin.alsoBy.includes(from.id) ? [...twin.alsoBy, from.id] : twin.alsoBy
      this.deps.db.updateTask(twin.id, {
        alsoBy,
        blocking: twin.blocking || Boolean(input.blocking),
        cli: twin.cli ?? cli,
        priority: twin.priority ?? priority,
        tags: normalizeTags([...twin.tags, ...tags]),
        updatedAt: now(),
      })
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
      cli,
      priority,
      tags,
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
    patch: {
      status?: UserTaskStatus
      note?: string | null
      title?: string
      steps?: string[]
      why?: string | null
      blocking?: boolean
      due?: number | null
      cli?: TaskInput["cli"]
      priority?: number | null
      tags?: string[]
    },
    by: SessionRecord | "user",
    opts: { notify?: boolean } = {}
  ): UserTask {
    const t = this.deps.db.getTask(id)
    if (!t) throw new Error(`No existe la tarea ${id}`)
    if (by !== "user" && by.projectId !== t.projectId) throw new Error(`La tarea ${id} es de otro proyecto`)
    const change: Partial<UserTask> = { updatedAt: now() }
    if (patch.title !== undefined || patch.steps !== undefined) {
      const c = clean({ title: patch.title ?? t.title, steps: patch.steps ?? t.steps, why: patch.why !== undefined ? patch.why : t.why },
        // Una sesión no le saca los pasos a una tarea; si la anotaste vos sin pasos, igual la puede retitular.
        by !== "user" && (t.steps.length > 0 || patch.steps !== undefined)
      )
      Object.assign(change, c)
    } else if (patch.why !== undefined) change.why = patch.why?.trim() || null
    if (patch.blocking !== undefined) change.blocking = patch.blocking
    if (patch.due !== undefined) change.due = patch.due
    if (patch.cli !== undefined) change.cli = this.cliOf(patch.cli)
    if (patch.priority !== undefined) change.priority = cleanPriority(patch.priority)
    if (patch.tags !== undefined) change.tags = normalizeTags(patch.tags)
    const closing = patch.status && patch.status !== "open" && t.status === "open"
    if (patch.status) {
      change.status = patch.status
      change.closedAt = patch.status === "open" ? null : now()
      change.closedBy = patch.status === "open" ? null : by === "user" ? "user" : by.id
    }
    if (patch.note !== undefined) change.note = patch.note?.trim() ? oneLine(patch.note, 400) : null
    // Reabrirla deja atrás cómo se había cerrado.
    else if (patch.status === "open" && t.status !== "open") change.note = null
    this.deps.db.updateTask(t.id, change)
    const task = this.broadcast(t.id)
    if (closing && by !== "user") {
      this.deps.sessions.addEvent(by.id, {
        kind: "notice",
        level: "info",
        text: `${patch.status === "done" ? "Dio por hecha la tarea para vos" : "Cerró la tarea para vos porque no hace falta"}: "${t.title}"${task.note ? ` (${task.note})` : ""}.`,
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
      const what = task.status === "done" ? "ya hizo" : "cerró porque no hace falta"
      const text = `[control-plane] El usuario ${what} la tarea "${task.title}" (${task.id})${task.note ? `. Nota: ${task.note}` : ""}. Si estabas esperando esto, seguí.`
      await this.deps.sessions
        .send(s.id, text, { origin: "control", event: { kind: "notice", level: "info", text: `Se le avisó que la tarea "${task.title}" ${task.status === "done" ? "está hecha" : "no hace falta"}.` } })
        .catch(() => {})
    }
  }

  /**
   * El login del CLI de la tarea, desde la tarea: corre el del catálogo (el mismo que Herramientas →
   * CLIs). Si sale bien y el CLI queda logueado, la tarea se cierra sola y se le avisa a quien la
   * pidió; si no, queda abierta con el motivo.
   */
  loginFromTask(id: string): CliJob {
    const clis = this.deps.clis
    if (!clis) throw new Error("Los CLIs no están disponibles")
    const task = this.get(id)
    if (!task) throw new Error(`No existe la tarea ${id}`)
    if (task.status !== "open") throw new Error("La tarea ya está cerrada")
    if (!task.cli) throw new Error("Esta tarea no es de loguear un CLI")
    const cli = task.cli
    const job = clis.login(cli.id, cli.credential)
    void clis.whenDone(job.id).then(async (end) => {
      const fresh = this.deps.db.getTask(id)
      if (!fresh || fresh.status !== "open") return
      const after = end.status === "done" ? await clis.credential(cli.id, cli.credential, true).catch(() => null) : null
      if (end.status === "done" && (!after?.credential || after.credential.state === "ok")) {
        this.update(id, { status: "done", note: CLI_DONE_NOTE }, "user", { notify: true })
        this.deps.hub.broadcast({ type: "toast", level: "success", event: "task", title: "Tarea hecha", body: `${task.title}: ${CLI_DONE_NOTE.toLowerCase()}.`, projectId: task.projectId })
        return
      }
      const why =
        end.status === "done"
          ? `el login terminó, pero ${cli.id} sigue ${after?.credential?.state === "expired" ? "con la sesión vencida" : "sin sesión"}`
          : `el login terminó con error${end.exitCode !== null ? ` (código ${end.exitCode})` : ""}${lastLine(end.output) ? `: ${lastLine(end.output)}` : ""}`
      this.deps.db.updateTask(id, { note: oneLine(`${CLI_FAILED_NOTE} ${why}`, 400), updatedAt: now() })
      this.broadcast(id)
    })
    return job
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
      `- [${t.id}] ${t.priority !== null ? `(prioridad ${t.priority}) ` : ""}${t.title}${t.blocking ? " · frena a alguien" : ""}${t.cli ? ` · login de ${t.cli.id}` : ""}${t.tags.length ? ` · etiquetas: ${t.tags.join(", ")}` : ""}${t.due ? ` · para ${new Date(t.due).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""} · la pidió ${name(t.createdBy)}` +
      `${t.alsoBy.length ? ` (también ${t.alsoBy.map(name).join(", ")})` : ""}\n  ${t.steps.map((s, i) => `${i + 1}. ${s}`).join("\n  ")}`
    const open = list.filter((t) => t.status === "open").sort(compareTasks)
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
