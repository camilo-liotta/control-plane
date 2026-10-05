import { ArrowRight, FolderGit2, History, Plus } from "lucide-react"
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
import { isMac, lastRoute } from "@/lib/nav"
import { restorableRoute } from "@shared/navigation"

/**
 * En la web, el inicio no te lleva solo a la última pantalla (podés querer la grilla): te la ofrece.
 * En la app de escritorio ya volviste ahí al abrir (ver RememberRoute).
 */
function ContinueWhereYouWere() {
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  const alive = {
    projects: new Set(Object.values(projects).filter((p) => !p.archivedAt).map((p) => p.id)),
    sessions: new Set(Object.values(sessions).filter((x) => !x.archivedAt).map((x) => x.id)),
  }
  const route = restorableRoute(lastRoute.get(), alive)
  if (!route) return null
  const m = /^\/p\/([^/]+)(?:\/s\/([^/]+)|\/(tools))?/.exec(route)
  const project = m ? projects[m[1]!] : undefined
  const session = m?.[2] ? sessions[m[2]] : undefined
  const what = session
    ? `${session.kind === "orchestrator" ? "la orquestadora" : session.name} en ${project?.name}`
    : m?.[3]
      ? `las herramientas de ${project?.name}`
      : project
        ? `el tablero de ${project.name}`
        : "Herramientas"
  return (
    <div className="mx-auto max-w-6xl px-6 pt-6">
      <Link
        href={route}
        className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm shadow-xs transition-colors hover:border-foreground/20"
      >
        <History className="size-4 text-muted-foreground" />
        <span>
          Seguir donde estabas: <span className="font-medium">{what}</span>
        </span>
        <ArrowRight className="ml-auto size-4 text-muted-foreground" />
      </Link>
    </div>
  )
}

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
            <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd> <Kbd>K</Kbd> para saltar a cualquier sesión · <Kbd>?</Kbd> para ver los atajos
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
        <ContinueWhereYouWere />
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
