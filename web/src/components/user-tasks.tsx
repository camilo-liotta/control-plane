import { CalendarClock, Check, ChevronRight, ClipboardList, Hourglass, Plus, TriangleAlert, Undo2, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import { groupTag, orderTasks, tagGroups, type TagGroup } from "@shared/task-order"
import type { CliJob, Project, UserTask } from "@shared/types"

import { FileRefScope, RefText } from "@/components/file-ref"
import { TonePill } from "@/components/status"
import { TerminalTargetProvider, type TerminalTarget } from "@/components/take-to-terminal"
import { CredentialState, JobPanel, LoginButton, TerminalLoginButton, useCliView } from "@/components/tools/cli-login"
import { Markdown } from "@/components/timeline/markdown"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { useStore } from "@/lib/store"
import { useAction } from "@/lib/use-action"
import { cn } from "@/lib/utils"

const when = (ms: number) =>
  new Date(ms).toLocaleString("es-AR", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })

/** Un color por etiqueta, para el borde que une las tareas que van juntas. */
export function tagHue(tag: string) {
  let h = 0
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
const tagColor = (tag: string) => `oklch(0.66 0.13 ${tagHue(tag)})`

/** El número de prioridad, chico, al lado del título. */
export function PriorityBadge({ priority, className }: { priority: number | null; className?: string }) {
  if (priority === null) return null
  return (
    <span
      className={cn("inline-grid h-4.5 min-w-4.5 shrink-0 place-items-center rounded border px-1 font-mono text-[0.65rem] leading-none text-muted-foreground tabular-nums", className)}
      title={`Prioridad ${priority} (1 va primero)`}
    >
      {priority}
    </span>
  )
}

/** El tablero de tareas para vos del proyecto: lo que las sesiones necesitan que hagas. */
export function UserTasksCard({ project }: { project: Project }) {
  const all = useStore((s) => s.tasks)
  const [adding, setAdding] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [tag, setTag] = useState<string | null>(null)
  const tasks = useMemo(() => Object.values(all).filter((t) => t.projectId === project.id), [all, project.id])
  const groups = useMemo(() => tagGroups(tasks), [tasks])
  const filter = tag && groups.has(tag) ? tag : null
  const mine = (t: UserTask) => !filter || t.tags.includes(filter)
  const allOpen = tasks.filter((t) => t.status === "open")
  const open = orderTasks(allOpen).filter(mine)
  const closed = tasks.filter((t) => t.status !== "open" && mine(t)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
  const waiting = allOpen.filter((t) => t.blocking).length
  // Si el grupo se deshizo (quedó una sola abierta), se saca el filtro.
  useEffect(() => {
    if (tag && !groups.has(tag)) setTag(null)
  }, [tag, groups])

  return (
    <section id="tareas-para-vos" className="scroll-mt-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ClipboardList className="size-4.5 shrink-0" />
        <h2 className="font-medium">Tareas para vos</h2>
        <span className="font-mono text-sm text-muted-foreground">{open.length}</span>
        {waiting > 0 && <TonePill tone="attention">{waiting === 1 ? "1 frena a una sesión" : `${waiting} frenan a sesiones`}</TonePill>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdding((v) => !v)}>
          <Plus />
          Nueva tarea
        </Button>
      </header>
      <p className="mt-1 text-sm text-muted-foreground">
        Lo que las sesiones necesitan que hagas y no pueden hacer ellas. Ellas mismas las crean y las cierran cuando ya no hacen falta.
      </p>

      {adding && <NewTask projectId={project.id} onDone={() => setAdding(false)} />}

      {filter && <TagFilter group={groups.get(filter)!} onClear={() => setTag(null)} />}

      {open.length > 0 ? (
        <ul className="mt-3 divide-y rounded-xl border">
          {open.map((t, i) => (
            <TaskRow key={t.id} task={t} groups={groups} onTag={setTag} joined={joinedWith(open, i, groups)} />
          ))}
        </ul>
      ) : (
        !adding && <p className="mt-3 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">Nada pendiente de tu lado.</p>
      )}

      {closed.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowClosed((v) => !v)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn("size-3.5 transition-transform", showClosed && "rotate-90")} />
            Cerradas en la última semana · {closed.length}
          </button>
          {showClosed && (
            <ul className="mt-2 divide-y rounded-xl border">
              {closed.map((t) => (
                <ClosedRow key={t.id} task={t} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

/** Si la tarea va con la de arriba o la de abajo (misma etiqueta): para dibujar el borde que las une. */
function joinedWith(list: UserTask[], i: number, groups: Map<string, TagGroup>) {
  const g = groupTag(list[i]!, groups)
  if (!g) return null
  return { tag: g, first: i === 0 || groupTag(list[i - 1]!, groups) !== g, last: i === list.length - 1 || groupTag(list[i + 1]!, groups) !== g }
}

/** Arriba de la lista, con una etiqueta elegida: cuántas son y cuántas están hechas. */
function TagFilter({ group, onClear }: { group: TagGroup; onClear: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: tagColor(group.tag) }}>
      <TagChip tag={group.tag} />
      <span className="text-muted-foreground">
        {group.done} de {group.total} {group.total === 1 ? "hecha" : "hechas"} · {group.open} {group.open === 1 ? "abierta" : "abiertas"}
      </span>
      <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={onClear}>
        <X />
        Ver todas
      </Button>
    </div>
  )
}

function TagChip({ tag, count, onClick }: { tag: string; count?: string; onClick?: () => void }) {
  const style = { borderColor: tagColor(tag), color: tagColor(tag) }
  const body = (
    <>
      <span className="font-mono">{tag}</span>
      {count && <span className="text-muted-foreground">· {count}</span>}
    </>
  )
  const cls = "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.68rem] leading-tight"
  return onClick ? (
    <button
      type="button"
      className={cn(cls, "hover:bg-muted")}
      style={style}
      title="Ver solo las tareas de este grupo"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {body}
    </button>
  ) : (
    <span className={cls} style={style}>
      {body}
    </span>
  )
}

function Asker({ id }: { id: string | null }) {
  const s = useStore((st) => (id ? st.sessions[id] : undefined))
  if (!id) return <span>vos</span>
  if (!s) return <span>una sesión</span>
  return (
    <Link href={`/p/${s.projectId}/s/${s.id}`} className="font-mono text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
      {s.name}
    </Link>
  )
}

/**
 * La terminal a la que van los comandos de la tarea: la de la sesión que la pidió o, si la creaste
 * vos o esa sesión ya no está, la de la orquestadora del proyecto.
 */
function useTaskTerminal(task: UserTask): TerminalTarget | null {
  const sessions = useStore((s) => s.sessions)
  const live = (id: string | null) => (id && sessions[id] && !sessions[id].archivedAt ? sessions[id] : undefined)
  const s = live(task.createdBy) ?? Object.values(sessions).find((x) => x.projectId === task.projectId && x.kind === "orchestrator" && !x.archivedAt)
  return s ? { sessionId: s.id, projectId: s.projectId } : null
}

function TaskRow({
  task,
  groups,
  onTag,
  joined,
}: {
  task: UserTask
  groups: Map<string, TagGroup>
  onTag: (tag: string) => void
  joined: { tag: string; first: boolean; last: boolean } | null
}) {
  const [open, setOpen] = useState(task.blocking || task.cli !== null)
  const [note, setNote] = useState("")
  const [notify, setNotify] = useState(task.blocking)
  const [busy, setBusy] = useState<null | "done" | "dismissed">(null)
  const overdue = task.due !== null && task.due < Date.now()
  const askers = [task.createdBy, ...task.alsoBy].filter(Boolean).length
  const target = useTaskTerminal(task)

  const close = async (status: "done" | "dismissed") => {
    setBusy(status)
    try {
      await api.updateTask(task.id, { status, note: note.trim() || undefined, notify })
      toast.success(status === "done" ? "Tarea hecha" : "Tarea descartada", {
        description: notify && askers ? "Le avisé a la sesión que la pidió." : undefined,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li
      className={cn("relative px-4 py-3", task.blocking && "bg-status-attention/5")}
      data-task-tag={joined?.tag}
    >
      {joined && (
        <span
          aria-hidden
          className={cn("absolute left-0 w-1", joined.first ? "top-2" : "top-0", joined.last ? "bottom-2" : "bottom-0", joined.first && "rounded-t", joined.last && "rounded-b")}
          style={{ background: tagColor(joined.tag) }}
        />
      )}
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => void close("done")}
          disabled={busy !== null}
          className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border hover:border-status-done hover:bg-status-done/10"
          aria-label={`Marcar hecha: ${task.title}`}
          title="Marcar hecha"
        >
          {busy === "done" ? <Spinner className="size-3" /> : <Check className="size-3 opacity-0 hover:opacity-60" />}
        </button>
        {/* El título despliega la tarea; la línea de abajo también, salvo sus links y etiquetas. */}
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setOpen((v) => !v)}>
          <button type="button" className="flex items-baseline gap-2 text-left" aria-expanded={open}>
            <PriorityBadge priority={task.priority} className="self-center" />
            <span className="font-medium">{task.title}</span>
          </button>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {task.tags
              .filter((x) => groups.has(x))
              .map((x) => {
                const g = groups.get(x)!
                return <TagChip key={x} tag={x} count={`${g.done} de ${g.total}`} onClick={() => onTag(x)} />
              })}
            {task.blocking && (
              <span className="inline-flex items-center gap-1 font-medium text-status-attention">
                <Hourglass className="size-3" /> te está esperando
              </span>
            )}
            {task.due && (
              <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-status-error")}>
                <CalendarClock className="size-3" /> {overdue ? "venció " : "para el "}
                {when(task.due)}
              </span>
            )}
            <span>
              la pidió <Asker id={task.createdBy} />
              {task.alsoBy.length > 0 && ` y ${task.alsoBy.length} más`} · {timeAgo(task.createdAt)}
            </span>
          </span>
        </div>
        <ChevronRight className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </div>
      {open && (
        <FileRefScope projectId={task.projectId} sessionId={task.createdBy ?? undefined}>
          <div className="mt-3 space-y-3 pl-8">
            {task.why && (
              <p className="text-sm text-muted-foreground">
                <RefText text={task.why} />
              </p>
            )}
            {task.cli && <TaskCliLogin task={task} />}
            {task.note &&
              (task.note.startsWith("No se pudo reautenticar") ? (
                <p className="flex items-start gap-1.5 text-sm text-status-error">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {task.note}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Nota: {task.note}</p>
              ))}
            <TerminalTargetProvider value={target}>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm marker:text-muted-foreground">
                {task.steps.map((s, i) => (
                  <li key={i}>
                    <Markdown text={s} className="[&_p]:my-0" inlineCommands />
                  </li>
                ))}
              </ol>
            </TerminalTargetProvider>
            <div className="flex flex-wrap items-center gap-2">
              <PriorityInput task={task} />
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota para la sesión (opcional)" className="h-8 min-w-48 flex-1 text-sm" />
              {askers > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} aria-label="Avisarle a la sesión" />
                  Avisarle a la sesión
                </label>
              )}
              <Button size="sm" onClick={() => void close("done")} disabled={busy !== null}>
                {busy === "done" ? <Spinner /> : <Check />}
                Hecha
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void close("dismissed")} disabled={busy !== null}>
                {busy === "dismissed" ? <Spinner /> : <X />}
                No hace falta
              </Button>
            </div>
          </div>
        </FileRefScope>
      )}
    </li>
  )
}

/** La prioridad a mano: un número (1 va primero), o vacío para sacarla. */
function PriorityInput({ task }: { task: UserTask }) {
  const [value, setValue] = useState(task.priority === null ? "" : String(task.priority))
  useEffect(() => setValue(task.priority === null ? "" : String(task.priority)), [task.priority])
  const save = () => {
    const n = value.trim() === "" ? null : Math.max(1, Math.round(Number(value)))
    if (n !== null && !Number.isFinite(n)) return setValue(task.priority === null ? "" : String(task.priority))
    if (n === task.priority) return
    void api.updateTask(task.id, { priority: n }).catch((err: Error) => toast.error(err.message))
  }
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="En qué orden hacerla: 1 va primero. Vacío: sin prioridad.">
      Prioridad
      <Input
        type="number"
        min={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        placeholder="–"
        aria-label={`Prioridad de ${task.title}`}
        className="h-8 w-14 text-center font-mono text-sm"
      />
    </label>
  )
}

/**
 * El login del CLI que pide la tarea, ahí mismo: el estado de la credencial y el mismo botón y
 * panel que Herramientas → CLIs. Si sale bien, el server cierra la tarea y le avisa a la sesión.
 */
function TaskCliLogin({ task }: { task: UserTask }) {
  const view = useCliView()
  const tick = useStore((s) => s.clisTick)
  const [starting, setStarting] = useState(false)
  const [job, setJob] = useState<CliJob | null>(null)
  const cli = view?.clis.find((c) => c.id === task.cli!.id)
  const credential = cli?.credentials[task.cli!.credential] ?? cli?.credentials[0]
  // Un login que ya estaba corriendo para este CLI (lo arrancaste acá o en Herramientas).
  const running = view?.jobs.filter((j) => j.cliId === task.cli!.id && j.kind === "login").at(-1)
  const shown = job ?? (running?.status === "running" ? running : null)

  useEffect(() => {
    if (!job) return
    let live = true
    void api.cliJob(job.id).then((j) => live && setJob(j), () => {})
    return () => {
      live = false
    }
  }, [tick, job?.id])

  const login = async () => {
    setStarting(true)
    try {
      setJob(await api.taskCliLogin(task.id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const name = task.cli!.id
  if (!view) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" /> Revisando {name}…
      </p>
    )
  }
  if (!cli || !cli.installed) {
    return <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">{cli ? `${cli.name} no está instalado: instalalo en Herramientas → CLIs.` : `No conozco el CLI ${name}.`}</p>
  }
  const state = credential?.state ?? "unknown"
  const verb = state === "logged_out" || state === "unknown" ? "Loguear" : "Reautenticar"
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2" data-task-cli={name}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{cli.name}</span>
        {credential?.label && <span className="text-muted-foreground">{credential.label}</span>}
        {credential && <CredentialState credential={credential} />}
        <span className="text-xs text-muted-foreground">
          {state === "ok" && credential?.account ? `logueado como ${credential.account}` : state === "ok" ? "logueado" : state === "expired" ? "sesión vencida" : state === "logged_out" ? "sin sesión" : ""}
        </span>
        {credential?.terminalLogin ? (
          <TerminalLoginButton command={credential.terminalLogin} className="ml-auto" />
        ) : (
          <LoginButton
            state={state}
            disabled={starting || shown?.status === "running"}
            starting={starting}
            className="ml-auto"
            label={`${verb} ${name}`}
            onClick={() => void login()}
          />
        )}
      </div>
      {shown && <JobPanel key={shown.id} job={shown} />}
    </div>
  )
}

function ClosedRow({ task }: { task: UserTask }) {
  const action = useAction()
  const reopen = () => action.run("reopen", () => api.updateTask(task.id, { status: "open" }).catch((err: Error) => toast.error(err.message)))
  return (
    <li className="flex items-start gap-3 px-4 py-2 text-sm">
      {task.status === "done" ? <Check className="mt-0.5 size-4 shrink-0 text-status-done" /> : <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className="text-muted-foreground line-through decoration-muted-foreground/40">{task.title}</span>
        <span className="block text-xs text-muted-foreground">
          {task.status === "done" ? "hecha" : "descartada"} por {task.closedBy === "user" ? "vos" : <Asker id={task.closedBy} />}
          {task.closedAt ? ` · ${timeAgo(task.closedAt)}` : ""}
          {task.note ? ` · ${task.note}` : ""}
        </span>
      </span>
      <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={action.busy()} onClick={() => void reopen()}>
        <Undo2 />
        Reabrir
      </Button>
    </li>
  )
}

function NewTask({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [title, setTitle] = useState("")
  const [steps, setSteps] = useState("")
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await api.createTask(projectId, { title, steps: steps.split("\n").map((s) => s.replace(/^\s*(\d+[.)]|[-*])\s*/, "")).filter((s) => s.trim()) })
      toast.success("Tarea creada")
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      className="mt-3 space-y-2 rounded-xl border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Qué hay que hacer" aria-label="Título de la tarea" autoFocus />
      <Textarea id="task-steps" value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={"Un paso por línea"} aria-label="Pasos de la tarea, uno por línea" className="min-h-20 text-sm" />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
        <Button type="submit" size="sm" disabled={saving || !title.trim() || !steps.trim()}>
          {saving && <Spinner />}
          Crear
        </Button>
      </div>
    </form>
  )
}
