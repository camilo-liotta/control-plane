import { CalendarClock, Check, ChevronRight, ClipboardList, Hourglass, Plus, TriangleAlert, Undo2, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
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
import { reveal } from "@/lib/reveal"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { undoable } from "@/lib/undo"
import { useAction } from "@/lib/use-action"
import { cn } from "@/lib/utils"

/** "mié 7/10 20:53": fecha corta y hora (la completa va en el title). */
const when = (ms: number) => {
  const d = new Date(ms)
  const day = d.toLocaleDateString("es-AR", { weekday: "short" }).replace(".", "")
  const time = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  return `${day} ${d.getDate()}/${d.getMonth() + 1} ${time}`
}

/** Un color por etiqueta, para el borde que une las tareas que van juntas. */
export function tagHue(tag: string) {
  let h = 0
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
/** El tono de la etiqueta: la barra y el borde con la luz, el texto más oscuro en claro y más claro en oscuro (AA). */
const tagColor = (tag: string) => `oklch(0.66 0.13 ${tagHue(tag)})`
const tagVars = (tag: string) => ({ "--tag-h": tagHue(tag) }) as React.CSSProperties
const TAG_TEXT = "[color:oklch(0.48_0.14_var(--tag-h))] dark:[color:oklch(0.8_0.11_var(--tag-h))]"

/** El número de prioridad, chico, al lado del título. */
export function PriorityBadge({ priority, className }: { priority: number | null; className?: string }) {
  if (priority === null) return null
  return (
    <span
      className={cn("inline-grid h-4.5 min-w-4.5 shrink-0 place-items-center rounded-md bg-muted px-1 text-2xs leading-none font-semibold text-muted-foreground", className)}
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
  // Las que cerraste y todavía se pueden deshacer: se esconden sin desmontarse (no se pierde la nota).
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set())
  const [revealItem, setRevealItem] = useState<string | null>(null)
  const section = useRef<HTMLElement>(null)
  const tasks = useMemo(() => Object.values(all).filter((t) => t.projectId === project.id), [all, project.id])
  const groups = useMemo(() => tagGroups(tasks), [tasks])
  const filter = tag && groups.has(tag) ? tag : null
  const mine = (t: UserTask) => !filter || t.tags.includes(filter)
  const allOpen = tasks.filter((t) => t.status === "open")
  const open = orderTasks(allOpen).filter(mine)
  const closed = tasks.filter((t) => t.status !== "open" && mine(t)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
  const shownOpen = allOpen.filter((t) => !closing.has(t.id))
  const waiting = shownOpen.filter((t) => t.blocking).length
  const visible = open.filter((t) => !closing.has(t.id))
  const count = visible.length
  // Si el grupo se deshizo (quedó una sola abierta), se saca el filtro.
  useEffect(() => {
    if (tag && !groups.has(tag)) setTag(null)
  }, [tag, groups])

  const hide = (id: string, hidden: boolean) =>
    setClosing((prev) => {
      const next = new Set(prev)
      if (hidden) next.add(id)
      else next.delete(id)
      return next
    })

  // Llegaste desde la Bandeja o un aviso: la tarea misma (abierta y a la vista) o, sin tarea, la sección.
  // El pedido se limpia recién después de mover la vista: si se limpiara antes, el efecto se volvería
  // a correr y su limpieza cancelaría el scroll.
  const pendingReveal = useUi((s) => s.reveal)
  const setUi = useUi((s) => s.set)
  useEffect(() => {
    if (pendingReveal?.kind !== "tasks" || pendingReveal.id !== project.id) return
    const item = pendingReveal.item ? useStore.getState().tasks[pendingReveal.item] : undefined
    if (item) {
      setTag(null)
      if (item.status !== "open") setShowClosed(true)
      setRevealItem(item.id)
    }
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const el = (item && section.current?.querySelector<HTMLElement>(`[data-task-id="${item.id}"]`)) || section.current
        if (el) reveal(el)
        setUi({ reveal: null })
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [pendingReveal, project.id, setUi])

  return (
    <section ref={section} id="tareas-para-vos" className="surface-card scroll-mt-16 overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
        <ClipboardList className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="font-medium">Tareas para vos</h2>
        {count > 0 ? (
          <span className="text-sm text-muted-foreground">{count}</span>
        ) : (
          !adding && (
            <span
              className="min-w-0 text-xs text-muted-foreground"
              title="Cuando una sesión necesita algo que no puede hacer ella (un login, algo en otro sistema), lo deja acá."
            >
              · nada pendiente de tu lado
            </span>
          )
        )}
        {waiting > 0 && <TonePill tone="attention">{waiting === 1 ? "1 frena a una sesión" : `${waiting} frenan a sesiones`}</TonePill>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdding((v) => !v)}>
          <Plus />
          Nueva tarea
        </Button>
      </header>

      {adding && (
        <div className="px-4 pb-4 sm:px-5 [&>form]:mt-0">
          <NewTask projectId={project.id} onDone={() => setAdding(false)} />
        </div>
      )}

      {filter && (
        <div className="px-4 pb-3 sm:px-5 [&>div]:mt-0">
          <TagFilter group={groups.get(filter)!} onClear={() => setTag(null)} />
        </div>
      )}

      {open.length > 0 && (
        <ul className="divide-y border-t" hidden={count === 0}>
          {open.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              groups={groups}
              onTag={setTag}
              joined={closing.has(t.id) ? null : joinedWith(visible, visible.indexOf(t), groups)}
              hidden={closing.has(t.id)}
              onHide={(v) => hide(t.id, v)}
              revealed={revealItem === t.id}
            />
          ))}
        </ul>
      )}

      {closed.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            aria-expanded={showClosed}
            className="flex w-full items-center gap-1.5 border-t px-4 py-2.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", showClosed && "rotate-90")} />
            Cerradas en la última semana · {closed.length}
          </button>
          {showClosed && (
            <ul className="divide-y border-t">
              {closed.map((t) => (
                <ClosedRow key={t.id} task={t} />
              ))}
            </ul>
          )}
        </>
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
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-sm">
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
  const style = { ...tagVars(tag), borderColor: tagColor(tag) }
  const body = (
    <>
      <span>{tag}</span>
      {count && <span className="text-muted-foreground">· {count}</span>}
    </>
  )
  const cls = cn("inline-flex items-center gap-1 rounded-full border px-1.5 text-2xs", TAG_TEXT)
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
    <Link href={`/p/${s.projectId}/s/${s.id}`} className="name text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
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
  hidden,
  onHide,
  revealed,
}: {
  task: UserTask
  groups: Map<string, TagGroup>
  onTag: (tag: string) => void
  joined: { tag: string; first: boolean; last: boolean } | null
  hidden: boolean
  onHide: (hidden: boolean) => void
  revealed: boolean
}) {
  // Plegadas: se lee la lista de un vistazo. La que te espera lo dice en su línea, y la Bandeja abre
  // la que tocaste.
  const [open, setOpen] = useState(revealed)
  const [note, setNote] = useState("")
  const [notify, setNotify] = useState(task.blocking)
  const overdue = task.due !== null && task.due < Date.now()
  const askers = [task.createdBy, ...task.alsoBy].filter(Boolean).length
  const target = useTaskTerminal(task)
  useEffect(() => {
    if (revealed) setOpen(true)
  }, [revealed])

  // No pregunta: se esconde, y la sesión recién se entera (si corresponde) cuando vencen los 5 s del Deshacer.
  const close = (status: "done" | "dismissed") =>
    undoable({
      message: status === "done" ? "Tarea hecha" : "Tarea cerrada: no hace falta",
      failMessage: "No se pudo cerrar la tarea",
      run: () =>
        api.updateTask(task.id, { status, note: note.trim() || undefined, notify }).then(() => {
          // Ya llegó cerrada (o llega enseguida por el WS): se suelta el escondite para cuando se reabra.
          window.setTimeout(() => onHide(false), 1500)
        }),
      onHide: () => onHide(true),
      onRestore: () => onHide(false),
    })

  return (
    <li
      hidden={hidden}
      className={cn("relative px-4 py-3 sm:px-5", task.blocking && "bg-status-attention-lamp/8")}
      data-task-tag={joined?.tag}
      data-task-id={task.id}
    >
      {joined && (
        <span
          aria-hidden
          className={cn("absolute left-0 w-1", joined.first ? "top-2" : "top-0", joined.last ? "bottom-2" : "bottom-0", joined.first && "rounded-t", joined.last && "rounded-b")}
          style={{ background: tagColor(joined.tag) }}
        />
      )}
      <div className="flex items-start gap-3">
        {/* El check cierra al toque, pero con Deshacer: un clic de más no le avisa nada a nadie. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            close("done")
          }}
          className="group/check mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border outline-none hover:border-status-done-lamp hover:bg-status-done-lamp/14 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Marcar hecha: ${task.title}`}
          title="Marcar hecha"
        >
          <Check className="size-3 opacity-0 group-hover/check:opacity-60" />
        </button>
        {/* El título despliega la tarea; la línea de abajo también, salvo sus links y etiquetas. */}
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setOpen((v) => !v)}>
          <button type="button" className="flex items-baseline gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={open}>
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
                <Hourglass className="size-3" /> te espera
              </span>
            )}
            {task.due && (
              <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-status-error")} title={new Date(task.due).toLocaleString("es-AR")}>
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
            {task.steps.length > 0 && (
              <TerminalTargetProvider value={target}>
                <ol className="list-decimal space-y-1.5 pl-5 text-sm marker:text-muted-foreground">
                  {task.steps.map((s, i) => (
                    <li key={i}>
                      <Markdown text={s} className="[&_p]:my-0" inlineCommands />
                    </li>
                  ))}
                </ol>
              </TerminalTargetProvider>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <PriorityInput task={task} />
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={askers ? "Nota para la sesión (opcional)" : "Nota (opcional)"}
                aria-label="Nota al cerrarla"
                className="h-8 min-w-40 flex-1 text-sm"
              />
              {askers > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} aria-label="Avisarle a la sesión" />
                  Avisarle a la sesión
                </label>
              )}
              <Button size="sm" variant="outline" onClick={() => close("done")}>
                <Check />
                Hecha
              </Button>
              <Button size="sm" variant="ghost" onClick={() => close("dismissed")}>
                <X />
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
    void api.updateTask(task.id, { priority: n }).then(
      () => toast.success(n === null ? "Prioridad quitada" : "Prioridad guardada"),
      (err: Error) => toast.error("No se pudo guardar la prioridad", { description: err.message })
    )
  }
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="En qué orden hacerla: 1 va primero. Vacío: sin prioridad.">
      Prioridad
      <Input
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        placeholder="–"
        aria-label={`Prioridad de ${task.title}`}
        className="h-8 w-14 text-center text-sm"
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
      toast.error(`No se pudo ${verb.toLowerCase()} ${task.cli!.id}`, { description: err instanceof Error ? err.message : String(err) })
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
    return (
      <p className="rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
        {cli ? (
          <>
            {cli.name} no está instalado. Instalalo en{" "}
            <Link href="/tools?tab=clis" className="font-medium text-foreground underline-offset-2 hover:underline">
              Herramientas → CLIs
            </Link>
            .
          </>
        ) : (
          <>
            El CLI <span className="font-mono">{name}</span> no está en el catálogo de Herramientas.
          </>
        )}
      </p>
    )
  }
  const state = credential?.state ?? "unknown"
  const verb = state === "logged_out" || state === "unknown" ? "Loguear" : "Reautenticar"
  return (
    <div className="rounded-xl bg-muted px-3 py-2" data-task-cli={name}>
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
  const reopen = () =>
    action.run("reopen", () =>
      api.updateTask(task.id, { status: "open" }).then(
        () => toast.success("Tarea reabierta", { description: task.title }),
        (err: Error) => toast.error("No se pudo reabrir la tarea", { description: err.message })
      )
    )
  return (
    <li className="flex items-start gap-3 px-4 py-2 text-sm sm:px-5" data-task-id={task.id}>
      {task.status === "done" ? <Check className="mt-0.5 size-4 shrink-0 text-status-done" /> : <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className="text-muted-foreground line-through decoration-muted-foreground/40">{task.title}</span>
        <span className="block text-xs text-muted-foreground">
          {task.status === "done" ? "hecha" : "cerrada (no hacía falta)"} por {task.closedBy === "user" ? "vos" : <Asker id={task.closedBy} />}
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
  const [priority, setPriority] = useState("")
  const [tags, setTags] = useState("")
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const n = Number(priority)
      await api.createTask(projectId, {
        title,
        steps: steps.split("\n").map((s) => s.replace(/^\s*(\d+[.)]|[-*])\s*/, "")).filter((s) => s.trim()),
        priority: priority.trim() && Number.isFinite(n) ? Math.max(1, Math.round(n)) : null,
        tags: tags.split(/[,\s]+/).filter(Boolean),
      })
      toast.success("Tarea creada", { description: title.trim() })
      onDone()
    } catch (err) {
      toast.error("No se pudo crear la tarea", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      className="mt-3 space-y-2 rounded-xl bg-muted/50 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Qué hay que hacer" aria-label="Título de la tarea" autoFocus />
      <Textarea
        id="task-steps"
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
        placeholder="Pasos, uno por línea (opcional)"
        aria-label="Pasos de la tarea, uno por línea (opcional)"
        className="min-h-16 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="En qué orden hacerla: 1 va primero. Vacío: sin prioridad.">
          Prioridad
          <Input
            inputMode="numeric"
            pattern="[0-9]*"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            placeholder="–"
            aria-label="Prioridad de la tarea nueva"
            className="h-8 w-14 text-center text-sm"
          />
        </label>
        <Input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="Etiquetas para agruparla con otras (opcional)"
          aria-label="Etiquetas, separadas por coma"
          className="h-8 min-w-48 flex-1 text-sm"
        />
        <div className="ml-auto flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancelar
          </Button>
          <Button type="submit" size="sm" disabled={saving || !title.trim()}>
            {saving && <Spinner />}
            Crear tarea
          </Button>
        </div>
      </div>
    </form>
  )
}
