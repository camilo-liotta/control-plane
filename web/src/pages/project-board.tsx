import { Blocks, ChevronRight, EllipsisVertical, History, Play, Plus, Send, Settings2, Square, Trash2, Users } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Link, useLocation, useSearch } from "wouter"

import type { Session } from "@shared/types"

import { ArchivedSessions } from "@/components/archived-sessions"
import { DraftCard } from "@/components/draft-card"
import { PageHeader } from "@/components/page-header"
import { appsSummary, ProjectApps } from "@/components/project-apps"
import { ProjectEnvironments, useProjectEnvironments } from "@/components/project-environments"
import { overviewTotals, ProjectRepos, reposHaveChanges, useProjectOverview } from "@/components/project-overview"
import { GraphLegend, ProjectGraph } from "@/components/project-graph"
import { ReportCard } from "@/components/report-card"
import { ProjectScheduled } from "@/components/scheduled"
import { OrchestratorCard, WorkerCard } from "@/components/session-cards"
import { Lamp, SessionLamp } from "@/components/status"
import { UserTasksCard } from "@/components/user-tasks"
import { Button } from "@/components/ui/button"
import { ConfirmAction } from "@/components/ui/confirm-action"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { basename, tokens, totals, usd } from "@/lib/format"
import { needReason, sessionNeedsYou, toneText } from "@/lib/status"
import { cn } from "@/lib/utils"
import { openDrafts, projectReports, projectSessions, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { useAction } from "@/lib/use-action"

function SectionTitle({
  children,
  count,
  action,
  tone,
}: {
  children: React.ReactNode
  count?: number
  action?: React.ReactNode
  tone?: "attention" | "pending"
}) {
  return (
    <div className="mb-3 flex min-h-8 items-center gap-2">
      <h2 className={cn("eyebrow", tone && toneText[tone])}>{children}</h2>
      {count !== undefined && <span className={cn("text-xs", tone ? cn("font-semibold", toneText[tone]) : "text-muted-foreground")}>{count}</span>}
      <div className="ml-auto">{action}</div>
    </div>
  )
}

/**
 * Las pestañas del proyecto. "resumen" es lo que te espera y cómo va el trabajo; las otras son de
 * consulta y configuración. Se pueden enlazar con ?tab=repos, ?tab=entornos o ?tab=mapa.
 */
const TABS = ["resumen", "repos", "entornos", "mapa"] as const
type Tab = (typeof TABS)[number]

/** Arriba de todo: las sesiones que esperan una respuesta tuya. */
function NeedsYou({ sessions }: { sessions: Session[] }) {
  const compactions = useStore((s) => s.compactions)
  const setUi = useUi((s) => s.set)
  return (
    <section>
      <SectionTitle count={sessions.length} tone="attention">
        Te necesitan
      </SectionTitle>
      <ul className="surface-card divide-y overflow-hidden">
        {sessions.map((s) => {
          const reason = needReason(s, Boolean(compactions[s.id]?.waiting))
          return (
            <li key={s.id}>
              <Link
                href={`/p/${s.projectId}/s/${s.id}`}
                onClick={() => compactions[s.id]?.waiting && setUi({ compactFor: s.id })}
                className="flex min-h-11 items-center gap-2.5 px-4 py-2 transition-colors outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <SessionLamp session={s} quiet />
                <span className="name max-w-[45%] min-w-0 shrink-0 truncate text-sm" title={s.name}>
                  {s.kind === "orchestrator" ? "Orquestadora" : s.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={reason}>
                  {reason}
                </span>
                <span className="hidden text-xs text-muted-foreground sm:inline">Responder</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function ProjectBoard({ projectId }: { projectId: string }) {
  const [, navigate] = useLocation()
  const search = useSearch()
  const project = useStore((s) => s.projects[projectId])
  const sessions = useStore((s) => s.sessions)
  const allDrafts = useStore((s) => s.drafts)
  const allReports = useStore((s) => s.reports)
  const apps = useStore((s) => s.apps[projectId])
  const allTasks = useStore((s) => s.tasks)
  const projectTasks = useMemo(() => Object.values(allTasks).filter((t) => t.projectId === projectId), [allTasks, projectId])
  const envs = useProjectEnvironments(projectId)
  const setUi = useUi((s) => s.set)
  const [sendingAll, setSendingAll] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [allPast, setAllPast] = useState(false)
  const overview = useProjectOverview(projectId)

  const asked = new URLSearchParams(search).get("tab")
  const tab: Tab = TABS.includes(asked as Tab) ? (asked as Tab) : "resumen"
  const setTab = (t: string) => navigate(t === "resumen" ? `/p/${projectId}` : `/p/${projectId}?tab=${t}`, { replace: true })

  // Lo que llega con `reveal` (la Bandeja, la paleta, un aviso) vive en una pestaña: se abre esa y
  // la sección misma se encarga de llevar la vista hasta ahí y de limpiar el pedido.
  const pendingReveal = useUi((s) => s.reveal)
  useEffect(() => {
    if (!pendingReveal || pendingReveal.id !== projectId) return
    const want: Tab | null = pendingReveal.kind === "environments" ? "entornos" : pendingReveal.kind === "tasks" || pendingReveal.kind === "archived" ? "resumen" : null
    if (want && want !== tab) navigate(want === "resumen" ? `/p/${projectId}` : `/p/${projectId}?tab=${want}`, { replace: true })
  }, [pendingReveal, projectId, tab, navigate])

  const { orchestrator, workers } = projectSessions(sessions, projectId)
  const drafts = useMemo(() => openDrafts(allDrafts, projectId), [allDrafts, projectId])
  const reports = useMemo(() => projectReports(allReports, projectId), [allReports, projectId])
  const lastReportBySession = useMemo(() => {
    const map = new Map<string, (typeof reports)[number]>()
    for (const r of reports) if (!map.has(r.sessionId)) map.set(r.sessionId, r)
    return map
  }, [reports])
  const liveSessions = useMemo(() => Object.values(sessions).filter((s) => s.projectId === projectId), [sessions, projectId])

  // Antes de los return tempranos: la cantidad de hooks no puede cambiar entre renders.
  const action = useAction()
  if (!project) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Este proyecto no existe</EmptyTitle>
          <EmptyDescription>Puede que lo hayas archivado o borrado. Elegí otro en la barra lateral.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const ready = drafts.filter((d) => d.state === "ready")
  const pendingReports = reports.filter((r) => r.state === "queued" || r.state === "in_review")
  const reviewed = reports.filter((r) => r.state === "reviewed")
  const pastReports = reviewed.slice(0, allPast ? 12 : 4)
  const hasTasks = projectTasks.some((t) => t.status === "open")
  const needs = [orchestrator, ...workers].filter((s): s is Session => s !== null && sessionNeedsYou(s))
  const appsState = appsSummary(apps ?? [])
  const gitChanges = reposHaveChanges(overview.data)
  const live = totals([orchestrator, ...workers].filter((s) => s !== null))
  const total = overviewTotals(overview.data)
  const folder = basename(project.repoPath)
  const staged = drafts.filter((d) => d.state !== "ready")

  const sendAll = async () => {
    setSendingAll(true)
    let ok = 0
    for (const d of ready) {
      try {
        await api.sendDraft(d.id)
        ok++
      } catch (err) {
        toast.error(`No se pudo enviar "${d.title}"`, { description: err instanceof Error ? err.message : String(err) })
      }
    }
    if (ok) toast.success(ok === 1 ? "1 propuesta enviada" : `${ok} propuestas enviadas`)
    setSendingAll(false)
  }

  const run = (key: string, fn: () => Promise<unknown>, ok: string, failed: string) =>
    action.run(key, () =>
      fn().then(
        () => toast.success(ok),
        (err: Error) => toast.error(failed, { description: err.message })
      )
    )

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={project.name}
        subtitle={
          <>
            {/* La carpeta solo si no se llama como el proyecto; la ruta completa, en el title. */}
            {folder !== project.name && (
              <>
                <span title={project.repoPath}>{folder}</span>
                {(total || live.cost > 0 || live.tokens > 0) && " · "}
              </>
            )}
            {total ? (
              <span title={`${project.repoPath}\n${total.title}`}>{total.text}</span>
            ) : live.cost > 0 || live.tokens > 0 ? (
              <span title={`${project.repoPath}\nLas sesiones del proyecto (equivalente API; con tu plan no se cobra aparte)`}>
                {usd(live.cost)} · {tokens(live.tokens)} tokens
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <Button size="sm" onClick={() => setUi({ newSessionFor: project.id })}>
              <Plus />
              Nueva sesión
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Más acciones">
                  <EllipsisVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-56">
                <DropdownMenuItem
                  disabled={action.busy("all")}
                  onClick={() => run("all", () => api.startAll(project.id), "Sesiones reanudadas", "No se pudieron reanudar las sesiones")}
                >
                  <Play />
                  Reanudar todas las sesiones
                </DropdownMenuItem>
                <DropdownMenuItem disabled={action.busy("all")} onClick={() => setStopping(true)}>
                  <Square />
                  Detener todas las sesiones…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setUi({ importFor: project.id })}>
                  <History />
                  Importar una sesión existente
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate(`/p/${project.id}/tools`)}>
                  <Blocks />
                  Herramientas del proyecto
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setUi({ settingsFor: project.id })}>
                  <Settings2 />
                  Configuración del proyecto
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setUi({ deleteFor: project.id })}>
                  <Trash2 />
                  Borrar proyecto…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmAction
              open={stopping}
              onOpenChange={setStopping}
              title="¿Detener todas las sesiones?"
              description="Se corta el turno de las que están trabajando. Cada una retoma su conversación cuando la reanudes."
              confirmLabel="Detener todas"
              onConfirm={async () => {
                await api.stopAll(project.id)
                toast.success("Sesiones detenidas")
              }}
            />
          </>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <Tabs value={tab} onValueChange={setTab} className="mx-auto max-w-6xl gap-6 px-4 pb-6 sm:px-6">
          {/* Las pestañas quedan a la vista al scrollear (y cuando un aviso lleva hasta algo de abajo). */}
          <div className="sticky top-0 z-10 -mx-4 bg-background px-4 pt-4 sm:-mx-6 sm:px-6">
          <TabsList variant="line" className="max-w-full justify-start overflow-x-auto" aria-label="Secciones del proyecto">
            <TabsTrigger value="resumen" className="flex-none px-2">
              Resumen
            </TabsTrigger>
            <TabsTrigger value="repos" className="flex-none px-2">
              Repos y apps
              {appsState?.crashed ? (
                <Lamp tone="error" label={appsState.crashed === 1 ? "1 app se cayó" : `${appsState.crashed} apps se cayeron`} className="size-1.5" />
              ) : gitChanges ? (
                <Lamp tone="pending" label="Commits sin subir" className="size-1.5" />
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="entornos" className="flex-none px-2">
              Entornos
              {envs.length > 0 && <span className="text-xs font-normal text-muted-foreground">{envs.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="mapa" className="flex-none px-2">
              Mapa
            </TabsTrigger>
          </TabsList>
          </div>

          <TabsContent value="resumen" className="flex flex-col gap-8">
            {needs.length > 0 && <NeedsYou sessions={needs} />}

            {hasTasks && <UserTasksCard project={project} />}

            <div className="flex flex-col gap-4">
              {/* Las propuestas listas te esperan: van antes que la orquestadora. Las que están en preparación, después. */}
              {ready.length > 0 && (
                <section>
                  <SectionTitle
                    count={ready.length}
                    tone="pending"
                    action={
                      ready.length > 1 && (
                        <Button size="sm" variant="outline" onClick={sendAll} disabled={sendingAll}>
                          {sendingAll ? <Spinner /> : <Send />}
                          Enviar las {ready.length} listas
                        </Button>
                      )
                    }
                  >
                    Propuestas listas
                  </SectionTitle>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {ready.map((d) => (
                      <DraftCard key={d.id} draft={d} compact />
                    ))}
                  </div>
                </section>
              )}
              <OrchestratorCard project={project} orchestrator={orchestrator} drafts={drafts} />
              {staged.length > 0 && (
                <section>
                  <SectionTitle count={staged.length}>Propuestas en preparación</SectionTitle>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {staged.map((d) => (
                      <DraftCard key={d.id} draft={d} compact />
                    ))}
                  </div>
                </section>
              )}
            </div>

            <section>
              <SectionTitle count={workers.length}>Sesiones</SectionTitle>
              {workers.length ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {workers.map((w) => (
                    <WorkerCard key={w.id} session={w} lastReport={lastReportBySession.get(w.id)} />
                  ))}
                </div>
              ) : (
                <Empty className="rounded-2xl bg-muted/50">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Users />
                    </EmptyMedia>
                    <EmptyTitle>Todavía no hay sesiones</EmptyTitle>
                    <EmptyDescription>
                      Creá la primera vos, o pedile a la orquestadora que proponga el equipo: las sesiones que proponga aparecen arriba para que
                      las apruebes.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent className="flex-row justify-center">
                    <Button size="sm" variant="outline" onClick={() => setUi({ newSessionFor: project.id })}>
                      <Plus />
                      Nueva sesión
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setUi({ importFor: project.id })}>
                      <History />
                      Importar una existente
                    </Button>
                  </EmptyContent>
                </Empty>
              )}
            </section>

            {/* Sin nada pendiente, Tareas para vos no ocupa el lugar de lo que te espera. */}
            {!hasTasks && <UserTasksCard project={project} />}

            {/* Lo programado: plegado, con su línea (no aparece si no hay nada). */}
            <div className="surface-card overflow-hidden empty:hidden [&>*]:border-b-0">
              <ProjectScheduled sessions={liveSessions} />
            </div>

            {(pendingReports.length > 0 || pastReports.length > 0) && (
              <section>
                <SectionTitle count={pendingReports.length || undefined}>Resultados</SectionTitle>
                <div className="grid gap-3 lg:grid-cols-2">
                  {[...pendingReports, ...pastReports].map((r) => (
                    <ReportCard key={r.id} report={r} />
                  ))}
                </div>
                {reviewed.length > pastReports.length && (
                  <Button size="xs" variant="ghost" className="mt-2 text-muted-foreground" onClick={() => setAllPast(true)}>
                    Ver {Math.min(reviewed.length, 12) - pastReports.length} más
                  </Button>
                )}
              </section>
            )}

            <ArchivedSessions projectId={project.id} />
          </TabsContent>

          <TabsContent value="repos" className="flex flex-col gap-6">
            <ProjectRepos project={project} data={overview.data} error={overview.error} onRetry={overview.reload} />
            <ProjectApps project={project} />
          </TabsContent>

          <TabsContent value="entornos">
            <ProjectEnvironments project={project} />
          </TabsContent>

          <TabsContent value="mapa">
            <section className="surface-card overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
                <h2 className="eyebrow">Mapa en vivo</h2>
                <div className="ml-auto">
                  <GraphLegend />
                </div>
              </div>
              <ProjectGraph project={project} orchestrator={orchestrator} workers={workers} drafts={drafts} reports={reports} />
            </section>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
