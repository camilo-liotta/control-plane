import { CalendarClock, Check, ChevronRight, ClipboardList, Hourglass, Plus, Undo2, X } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { Project, UserTask } from "@shared/types"

import { TonePill } from "@/components/status"
import { Markdown } from "@/components/timeline/markdown"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const when = (ms: number) =>
  new Date(ms).toLocaleString("es-AR", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })

/** Las abiertas primero: las que frenan a alguien, después por fecha, después las más nuevas. */
function order(a: UserTask, b: UserTask) {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
  if (a.due !== b.due) return (a.due ?? Infinity) - (b.due ?? Infinity)
  return b.createdAt - a.createdAt
}

/** El tablero de tareas para vos del proyecto: lo que las sesiones necesitan que hagas. */
export function UserTasksCard({ project }: { project: Project }) {
  const all = useStore((s) => s.tasks)
  const [adding, setAdding] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const tasks = useMemo(() => Object.values(all).filter((t) => t.projectId === project.id), [all, project.id])
  const open = tasks.filter((t) => t.status === "open").sort(order)
  const closed = tasks.filter((t) => t.status !== "open").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
  const waiting = open.filter((t) => t.blocking).length

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

      {open.length > 0 ? (
        <ul className="mt-3 divide-y rounded-xl border">
          {open.map((t) => (
            <TaskRow key={t.id} task={t} />
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

function Asker({ id }: { id: string | null }) {
  const s = useStore((st) => (id ? st.sessions[id] : undefined))
  if (!id) return <span>vos</span>
  if (!s) return <span>una sesión</span>
  return (
    <Link href={`/p/${s.projectId}/s/${s.id}`} className="font-mono text-foreground hover:underline">
      {s.name}
    </Link>
  )
}

function TaskRow({ task }: { task: UserTask }) {
  const [open, setOpen] = useState(task.blocking)
  const [note, setNote] = useState("")
  const [notify, setNotify] = useState(task.blocking)
  const [busy, setBusy] = useState<null | "done" | "dismissed">(null)
  const overdue = task.due !== null && task.due < Date.now()
  const askers = [task.createdBy, ...task.alsoBy].filter(Boolean).length

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
    <li className={cn("px-4 py-3", task.blocking && "bg-status-attention/5")}>
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
        <button type="button" onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <span className="font-medium">{task.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
        </button>
        <ChevronRight className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </div>
      {open && (
        <div className="mt-3 space-y-3 pl-8">
          {task.why && <p className="text-sm text-muted-foreground">{task.why}</p>}
          <ol className="list-decimal space-y-1.5 pl-5 text-sm marker:text-muted-foreground">
            {task.steps.map((s, i) => (
              <li key={i}>
                <Markdown text={s} className="[&_p]:my-0" />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nota para la sesión (opcional)" className="h-8 min-w-48 flex-1 text-sm" />
            {askers > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} />
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
      )}
    </li>
  )
}

function ClosedRow({ task }: { task: UserTask }) {
  const reopen = () => api.updateTask(task.id, { status: "open" }).catch((err: Error) => toast.error(err.message))
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
      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void reopen()}>
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
      <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Qué hay que hacer" autoFocus />
      <Textarea id="task-steps" value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={"Un paso por línea"} className="min-h-20 text-sm" />
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
