import { FolderGit2, Plus } from "lucide-react"
import { Link } from "wouter"

import { Mark } from "@/components/app-sidebar"
import { PageHeader } from "@/components/page-header"
import { SessionLamp } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { shortPath, tokens, totals, usd } from "@/lib/format"
import { openDrafts, projectSessions, useProjects, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

export function Home() {
  const projects = useProjects()
  const sessions = useStore((s) => s.sessions)
  const drafts = useStore((s) => s.drafts)
  const loaded = useStore((s) => s.loaded)
  const setUi = useUi((s) => s.set)

  if (loaded && !projects.length) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="control-plane" />
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Mark className="size-6" />
            </EmptyMedia>
            <EmptyTitle>Creá tu primer proyecto</EmptyTitle>
            <EmptyDescription>
              Un proyecto es un repo con su orquestadora y sus sesiones worker. Elegí la carpeta y arrancamos.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setUi({ newProject: true })}>
              <Plus />
              Nuevo proyecto
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Proyectos"
        subtitle={
          <>
            <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> para saltar a cualquier sesión
          </>
        }
        actions={
          <Button size="sm" variant="outline" onClick={() => setUi({ newProject: true })}>
            <Plus />
            Nuevo proyecto
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl gap-3 px-6 py-6 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const { orchestrator, workers } = projectSessions(sessions, p.id)
            const working = workers.filter((w) => w.status === "working").length
            const ready = openDrafts(drafts, p.id).filter((d) => d.state === "ready").length
            return (
              <Link
                key={p.id}
                href={`/p/${p.id}`}
                className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs transition-all hover:-translate-y-px hover:border-foreground/20 hover:shadow-sm"
              >
                <div className="flex items-center gap-2">
                  <FolderGit2 className="size-4 text-muted-foreground" />
                  <span className="truncate font-semibold">{p.name}</span>
                  {ready > 0 && (
                    <span className="ml-auto rounded-full bg-status-attention/15 px-2 font-condensed text-[0.72rem] font-semibold text-status-attention">
                      {ready} {ready === 1 ? "propuesta" : "propuestas"}
                    </span>
                  )}
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground">{shortPath(p.repoPath)}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {orchestrator && <SessionLamp session={orchestrator} />}
                  {workers.map((w) => (
                    <span key={w.id} className="inline-flex items-center gap-1.5 font-mono text-[0.72rem]">
                      <SessionLamp session={w} />
                      {w.name}
                    </span>
                  ))}
                  {!workers.length && <span className="text-xs text-muted-foreground">Sin sesiones worker</span>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {working ? `${working} trabajando` : "Nadie trabajando ahora"}
                  {p.review.queued ? ` · ${p.review.queued} en cola` : ""}
                  {(() => {
                    const t = totals([orchestrator, ...workers].filter((s) => s !== null))
                    return t.tokens > 0 ? ` · ${usd(t.cost)} · ${tokens(t.tokens)} tokens` : ""
                  })()}
                </p>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
