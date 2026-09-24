import { EllipsisVertical, History, Play, Plus, Send, Settings2, Square, Users } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { DraftCard } from "@/components/draft-card"
import { PageHeader } from "@/components/page-header"
import { ReportCard } from "@/components/report-card"
import { OrchestratorCard, WorkerCard } from "@/components/session-cards"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { shortPath } from "@/lib/format"
import { openDrafts, projectReports, projectSessions, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

function SectionTitle({ children, count, action }: { children: React.ReactNode; count?: number; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="eyebrow text-foreground/80">{children}</h2>
      {count !== undefined && <span className="font-mono text-xs text-muted-foreground">{count}</span>}
      <div className="ml-auto">{action}</div>
    </div>
  )
}

export function ProjectBoard({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const sessions = useStore((s) => s.sessions)
  const allDrafts = useStore((s) => s.drafts)
  const allReports = useStore((s) => s.reports)
  const setUi = useUi((s) => s.set)
  const [sendingAll, setSendingAll] = useState(false)

  const { orchestrator, workers } = projectSessions(sessions, projectId)
  const drafts = useMemo(() => openDrafts(allDrafts, projectId), [allDrafts, projectId])
  const reports = useMemo(() => projectReports(allReports, projectId), [allReports, projectId])
  const lastReportBySession = useMemo(() => {
    const map = new Map<string, (typeof reports)[number]>()
    for (const r of reports) if (!map.has(r.sessionId)) map.set(r.sessionId, r)
    return map
  }, [reports])

  if (!project) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Este proyecto no existe</EmptyTitle>
          <EmptyDescription>Puede que lo hayas archivado. Elegí otro en la barra lateral.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const ready = drafts.filter((d) => d.state === "ready")
  const pendingReports = reports.filter((r) => r.state === "queued" || r.state === "in_review")
  const pastReports = reports.filter((r) => r.state === "reviewed").slice(0, 8)

  const sendAll = async () => {
    setSendingAll(true)
    let ok = 0
    for (const d of ready) {
      try {
        await api.sendDraft(d.id)
        ok++
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
    if (ok) toast.success(`${ok === 1 ? "Se envió 1 propuesta" : `Se enviaron ${ok} propuestas`}`)
    setSendingAll(false)
  }

  const run = (fn: () => Promise<unknown>, ok: string) =>
    fn().then(
      () => toast.success(ok),
      (err: Error) => toast.error(err.message)
    )

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={project.name}
        subtitle={<span className="font-mono">{shortPath(project.repoPath)}</span>}
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
                <DropdownMenuItem onClick={() => run(() => api.startAll(project.id), "Sesiones iniciadas")}>
                  <Play />
                  Iniciar todas las sesiones
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => run(() => api.stopAll(project.id), "Sesiones detenidas")}>
                  <Square />
                  Detener todas las sesiones
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setUi({ importFor: project.id })}>
                  <History />
                  Importar una sesión existente
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setUi({ settingsFor: project.id })}>
                  <Settings2 />
                  Configuración del proyecto
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-6">
          <OrchestratorCard project={project} orchestrator={orchestrator} drafts={drafts} />

          {drafts.length > 0 && (
            <section>
              <SectionTitle
                count={drafts.length}
                action={
                  ready.length > 1 && (
                    <Button size="sm" variant="outline" onClick={sendAll} disabled={sendingAll}>
                      {sendingAll ? <Spinner /> : <Send />}
                      Enviar las {ready.length} listas
                    </Button>
                  )
                }
              >
                Propuestas
              </SectionTitle>
              <div className="grid gap-3 lg:grid-cols-2">
                {drafts.map((d) => (
                  <DraftCard key={d.id} draft={d} compact />
                ))}
              </div>
            </section>
          )}

          <section>
            <SectionTitle count={workers.length}>Sesiones</SectionTitle>
            {workers.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {workers.map((w) => (
                  <WorkerCard key={w.id} session={w} lastReport={lastReportBySession.get(w.id)} />
                ))}
              </div>
            ) : (
              <Empty className="rounded-2xl border border-dashed">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Users />
                  </EmptyMedia>
                  <EmptyTitle>Todavía no hay sesiones worker</EmptyTitle>
                  <EmptyDescription>
                    Creá la primera vos, o pedile a la orquestadora que proponga el equipo: las sesiones que proponga
                    aparecen arriba para que las apruebes.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="flex-row justify-center">
                  <Button size="sm" onClick={() => setUi({ newSessionFor: project.id })}>
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

          {(pendingReports.length > 0 || pastReports.length > 0) && (
            <section>
              <SectionTitle count={pendingReports.length || undefined}>Resultados</SectionTitle>
              <div className="grid gap-3 lg:grid-cols-2">
                {[...pendingReports, ...pastReports].map((r) => (
                  <ReportCard key={r.id} report={r} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
