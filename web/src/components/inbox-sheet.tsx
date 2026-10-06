import { ChevronRight, ClipboardList, Inbox } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation } from "wouter"

import { DraftCard } from "@/components/draft-card"
import { ReportCard } from "@/components/report-card"
import { PriorityBadge } from "@/components/user-tasks"
import { SessionLamp, TonePill } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { inboxCounts, taskWaits } from "@shared/inbox-count"
import { orderTasks } from "@shared/task-order"
import type { Draft, Report, Session, UserTask } from "@shared/types"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

/** Con más proyectos que esto, arrancan plegados los que no te necesitan. */
const FOLD_OVER = 3

interface Bucket {
  projectId: string
  needs: Session[]
  todo: UserTask[]
  ready: Draft[]
  staged: Draft[]
  queue: Report[]
  /** Hay algo que te necesita: una sesión, una tarea que frena o una propuesta lista. */
  urgent: boolean
  latest: number
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <section className="space-y-2">
      <h3 className="eyebrow flex items-center gap-1.5">
        {title}
        <span className="font-normal">{count}</span>
      </h3>
      {children}
    </section>
  )
}

/** Una lista de filas apoyada en la hoja (sin una caja por fila). */
function Rows({ children }: { children: React.ReactNode }) {
  return <ul className="surface-card divide-y overflow-hidden">{children}</ul>
}

const rowClass = "flex min-h-11 items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Por qué te necesita una sesión, en una línea. */
function needReason(s: Session, compacting: boolean | undefined) {
  if (s.pending?.kind === "permission") return "pide permiso para una herramienta"
  if (s.pending) return "te hizo una pregunta"
  if (compacting) return "espera que elijas qué conservar al compactar"
  return s.statusDetail ?? "te necesita"
}

function summary(b: Bucket) {
  const blocking = b.todo.filter((t) => t.blocking).length
  return [
    b.needs.length && plural(b.needs.length, "te necesita", "te necesitan"),
    blocking && plural(blocking, "tarea te espera", "tareas te esperan"),
    b.todo.length - blocking && plural(b.todo.length - blocking, "tarea", "tareas"),
    b.ready.length && plural(b.ready.length, "propuesta lista", "propuestas listas"),
    b.staged.length && `${b.staged.length} en preparación`,
    b.queue.length && `${b.queue.length} en la cola`,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Todo lo que espera algo de vos, agrupado por proyecto. */
export function InboxSheet() {
  const open = useUi((s) => s.inbox)
  const setUi = useUi((s) => s.set)
  const sessions = useStore((s) => s.sessions)
  const drafts = useStore((s) => s.drafts)
  const reports = useStore((s) => s.reports)
  const projects = useStore((s) => s.projects)
  const compactions = useStore((s) => s.compactions)
  const tasks = useStore((s) => s.tasks)
  const [location] = useLocation()
  const here = /^\/p\/([^/]+)/.exec(location)?.[1]
  // Lo que plegaste o abriste a mano; se olvida cada vez que se abre la Bandeja.
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (open) setFolded({})
  }, [open])

  const byProject: Record<string, Bucket> = {}
  const bucket = (projectId: string) =>
    (byProject[projectId] ??= { projectId, needs: [], todo: [], ready: [], staged: [], queue: [], urgent: false, latest: 0 })
  const touch = (b: Bucket, at: number) => {
    b.latest = Math.max(b.latest, at)
    return b
  }

  for (const s of Object.values(sessions)) {
    if (s.status === "needs_input") touch(bucket(s.projectId), s.lastActivityAt ?? s.createdAt).needs.push(s)
  }
  for (const t of Object.values(tasks)) {
    if (t.status === "open") touch(bucket(t.projectId), t.updatedAt).todo.push(t)
  }
  // El mismo orden que en el tablero del proyecto: las que frenan, por prioridad, por fecha.
  for (const b of Object.values(byProject)) b.todo = orderTasks(b.todo)
  for (const d of Object.values(drafts).sort((a, b) => a.createdAt - b.createdAt)) {
    if (d.state === "ready") touch(bucket(d.projectId), d.updatedAt).ready.push(d)
    else if (d.state === "staged") touch(bucket(d.projectId), d.updatedAt).staged.push(d)
  }
  for (const r of Object.values(reports).sort((a, b) => a.createdAt - b.createdAt)) {
    if (r.state === "queued" || r.state === "in_review") touch(bucket(r.projectId), r.createdAt).queue.push(r)
  }

  const counts = inboxCounts({ sessions: Object.values(sessions), drafts: Object.values(drafts), tasks: Object.values(tasks) })
  const groups = Object.values(byProject)
  for (const b of groups) b.urgent = b.needs.length > 0 || b.ready.length > 0 || b.todo.some(taskWaits)
  groups.sort(
    (a, b) =>
      Number(b.projectId === here) - Number(a.projectId === here) ||
      // Lo que quedó de un proyecto archivado, al final.
      Number(b.projectId in projects) - Number(a.projectId in projects) ||
      Number(b.urgent) - Number(a.urgent) ||
      b.latest - a.latest
  )
  const foldByDefault = groups.length > FOLD_OVER
  const close = () => setUi({ inbox: false })

  return (
    <Sheet open={open} onOpenChange={(v) => setUi({ inbox: v })}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Bandeja
            {counts.total > 0 && <Badge variant="secondary">{counts.total}</Badge>}
          </SheetTitle>
          <SheetDescription>Lo que espera una decisión tuya, proyecto por proyecto.</SheetDescription>
        </SheetHeader>
        <div className="space-y-7 px-4 pb-6">
          {!groups.length && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>Nada pendiente</EmptyTitle>
                <EmptyDescription>
                  Cuando una sesión te necesite o la orquestadora proponga algo, aparece acá.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {groups.map((b) => {
            const isOpen = folded[b.projectId] ?? (!foldByDefault || b.urgent || b.projectId === here)
            const name = projects[b.projectId]?.name
            // Ámbar solo para lo que frena (DESIGN.md): sesiones que te necesitan y tareas que frenan.
            const waiting = b.needs.length + b.todo.filter(taskWaits).length
            return (
              <Collapsible
                key={b.projectId}
                open={isOpen}
                onOpenChange={(v) => setFolded((f) => ({ ...f, [b.projectId]: v }))}
                className="space-y-4"
              >
                <div className="flex items-start gap-1.5">
                  <CollapsibleTrigger
                    aria-label={isOpen ? `Plegar ${name ?? "el proyecto archivado"}` : `Desplegar ${name ?? "el proyecto archivado"}`}
                    className="mt-0.5 rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none [&[data-state=open]>svg]:rotate-90"
                  >
                    <ChevronRight className="size-4 transition-transform" />
                  </CollapsibleTrigger>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {name ? (
                        <Link href={`/p/${b.projectId}`} onClick={close} className="truncate text-sm font-semibold hover:underline" title={name}>
                          {name}
                        </Link>
                      ) : (
                        <p className="truncate text-sm font-semibold text-muted-foreground">Proyecto archivado</p>
                      )}
                      {waiting > 0 && (
                        <TonePill tone="attention">
                          {waiting === 1 ? "1 te espera" : `${waiting} te esperan`}
                        </TonePill>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{summary(b)}</p>
                  </div>
                </div>
                <CollapsibleContent className="space-y-5 pl-6">
                  <Group title="Te necesitan" count={b.needs.length}>
                    <Rows>
                      {b.needs.map((s) => (
                        <li key={s.id}>
                          <Link
                            href={`/p/${s.projectId}/s/${s.id}`}
                            onClick={() => {
                              close()
                              if (compactions[s.id]?.waiting) setUi({ compactFor: s.id })
                            }}
                            className={rowClass}
                          >
                            <SessionLamp session={s} quiet />
                            <span className="name max-w-[45%] min-w-0 shrink-0 truncate text-sm" title={s.name}>
                              {s.name}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={needReason(s, Boolean(compactions[s.id]?.waiting))}>
                              {needReason(s, Boolean(compactions[s.id]?.waiting))}
                            </span>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </Link>
                        </li>
                      ))}
                    </Rows>
                  </Group>
                  <Group title="Tareas para vos" count={b.todo.length}>
                    <Rows>
                      {b.todo.map((t) => (
                        <li key={t.id}>
                          <Link
                            href={`/p/${t.projectId}`}
                            // M4: el resumen del proyecto abre esta tarea y la lleva a la vista.
                            onClick={() => {
                              close()
                              setUi({ reveal: { kind: "tasks", id: t.projectId, item: t.id, at: Date.now() } })
                            }}
                            className={rowClass}
                          >
                            <ClipboardList className="size-4 shrink-0 text-muted-foreground" />
                            <PriorityBadge priority={t.priority} />
                            <span className="min-w-0 flex-1 truncate text-sm" title={t.title}>
                              {t.title}
                            </span>
                            {taskWaits(t) && <TonePill tone="attention">te espera</TonePill>}
                          </Link>
                        </li>
                      ))}
                    </Rows>
                  </Group>
                  <Group title="Propuestas listas para enviar" count={b.ready.length}>
                    {b.ready.map((d) => (
                      <DraftCard key={d.id} draft={d} compact />
                    ))}
                  </Group>
                  <Group title="En preparación" count={b.staged.length}>
                    <p className="text-xs text-muted-foreground">La orquestadora las revisa junto con la cola: se liberan cuando termine.</p>
                    {b.staged.map((d) => (
                      <DraftCard key={d.id} draft={d} compact />
                    ))}
                  </Group>
                  <Group title="Cola de resultados" count={b.queue.length}>
                    {b.queue.map((r) => (
                      <ReportCard key={r.id} report={r} />
                    ))}
                  </Group>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  )
}
