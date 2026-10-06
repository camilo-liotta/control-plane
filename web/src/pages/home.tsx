import { Archive, ArrowRight, ChevronRight, History, Inbox, Plus, RotateCcw } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { Project, Report, Session } from "@shared/types"

import { Mark, useInboxParts } from "@/components/app-sidebar"
import { PageHeader } from "@/components/page-header"
import { Lamp, SessionLamp, TonePill } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Shortcut } from "@/components/ui/kbd"
import { LoadError } from "@/components/ui/load-error"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { plural, shortPath, timeAgo, tokens, totals, usd } from "@/lib/format"
import { lastRoute } from "@/lib/nav"
import { openDrafts, projectSessions, useCurrentAccount, useProjects, useStore } from "@/lib/store"
import { reportStatusView, sessionStatus, type Tone } from "@/lib/status"
import { useAction } from "@/lib/use-action"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"
import { restorableRoute } from "@shared/navigation"

const sessionName = (s: Session) => (s.kind === "orchestrator" ? "Orquestadora" : s.name)

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
    <Link
      href={route}
      className="group surface-card flex min-w-0 items-center gap-3 px-4 py-3 text-sm outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <History className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate" title={`Seguir donde estabas: ${what}`}>
        Seguir donde estabas: <span className="font-medium">{what}</span>
      </span>
      <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

/** Cuánto hay en la Bandeja, en una línea: el detalle está allá, no se repite acá. */
function InboxSummary() {
  const { blocking, ready } = useInboxParts()
  const setUi = useUi((s) => s.set)
  if (!blocking && !ready) return null
  const tone: Tone = blocking ? "attention" : "pending"
  return (
    <button
      type="button"
      onClick={() => setUi({ inbox: true })}
      className="group surface-card flex min-w-0 items-center gap-3 px-4 py-3 text-left text-sm outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Inbox className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {blocking > 0 && <TonePill tone="attention">{blocking} {blocking === 1 ? "te necesita" : "te necesitan"}</TonePill>}
        {ready > 0 && <TonePill tone="pending">{plural(ready, "propuesta lista", "propuestas listas")}</TonePill>}
      </span>
      <span className={cn("ml-auto flex shrink-0 items-center gap-1 text-xs font-medium", tone === "attention" ? "text-foreground" : "text-muted-foreground")}>
        Abrir la Bandeja
        <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  )
}

function ProjectCard({ project }: { project: Project }) {
  const sessions = useStore((s) => s.sessions)
  const drafts = useStore((s) => s.drafts)
  const { orchestrator, workers } = projectSessions(sessions, project.id)
  const all = [orchestrator, ...workers].filter((s) => s !== null)
  const needs = all.filter((s) => sessionStatus(s).tone === "attention").length
  const working = all.filter((s) => s.status === "working" || s.status === "starting").length
  const ready = openDrafts(drafts, project.id).filter((d) => d.state === "ready").length
  const last = Math.max(0, ...all.map((s) => s.lastActivityAt ?? 0))
  const t = totals(all)
  // Primero las que te necesitan, después las que trabajan; la orquestadora siempre arriba.
  const rank = (s: Session) => (s.kind === "orchestrator" ? -1 : ({ attention: 0, working: 1, error: 2, pending: 3, done: 4, idle: 5 } as const)[sessionStatus(s).tone])
  const shown = [...all].sort((a, b) => rank(a) - rank(b)).slice(0, 6)

  return (
    <Link
      href={`/p/${project.id}`}
      className="group surface-card flex min-w-0 flex-col gap-3 p-4 outline-hidden transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 truncate text-base font-semibold" title={project.name}>
            {project.name}
          </h2>
          <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <p className="truncate font-mono text-2xs text-muted-foreground" title={project.repoPath}>
          {shortPath(project.repoPath)}
        </p>
      </div>
      <div className="flex min-h-5 flex-wrap items-center gap-1.5">
        {needs > 0 && <TonePill tone="attention">{needs} {needs === 1 ? "te necesita" : "te necesitan"}</TonePill>}
        {working > 0 && <TonePill tone="working">{working} trabajando</TonePill>}
        {ready > 0 && <TonePill tone="pending">{plural(ready, "propuesta", "propuestas")}</TonePill>}
        {project.review.queued > 0 && <TonePill tone="pending">{project.review.queued} en cola</TonePill>}
        {!needs && !working && !ready && !project.review.queued && <span className="text-xs text-muted-foreground">Todo quieto</span>}
      </div>
      <ul className="flex flex-col gap-1">
        {shown.map((s) => {
          const st = sessionStatus(s)
          return (
            <li key={s.id} className="flex min-w-0 items-center gap-2 text-ui">
              <SessionLamp session={s} quiet className="shrink-0" />
              <span className={cn("name min-w-0 truncate", s.kind === "orchestrator" && "text-muted-foreground")} title={sessionName(s)}>
                {sessionName(s)}
              </span>
              <span className="ml-auto shrink-0 text-2xs text-muted-foreground">{st.label}</span>
            </li>
          )
        })}
        {all.length > shown.length && <li className="text-2xs text-muted-foreground">y {plural(all.length - shown.length, "sesión más", "sesiones más")}</li>}
        {!workers.length && <li className="text-xs text-muted-foreground">Sin sesiones worker todavía</li>}
      </ul>
      <p className="mt-auto flex flex-wrap gap-x-2 text-2xs text-muted-foreground">
        {last > 0 && <span>Actividad {timeAgo(last)}</span>}
        {t.tokens > 0 && (
          <span title="Total del proyecto (equivalente API; con tu plan no se cobra aparte)">
            {usd(t.cost)} · {tokens(t.tokens)} tokens
          </span>
        )}
      </p>
    </Link>
  )
}

type Activity = { id: string; at: number; tone: Tone; who: string; what: string; href: string; project: string }

/** Lo último que pasó en los proyectos de la cuenta: resultados entregados y lo que dijo cada sesión. */
function useActivity(projects: Project[]): Activity[] {
  const sessions = useStore((s) => s.sessions)
  const reports = useStore((s) => s.reports)
  return useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.name]))
    const items: Activity[] = []
    for (const r of Object.values(reports) as Report[]) {
      if (!names.has(r.projectId) || r.state === "dismissed") continue
      const v = reportStatusView[r.status]
      items.push({
        id: `r-${r.id}`,
        at: r.createdAt,
        tone: v.tone,
        who: r.sessionName,
        what: `${v.label}: ${r.taskTitle}`,
        href: `/p/${r.projectId}/s/${r.sessionId}`,
        project: names.get(r.projectId)!,
      })
    }
    for (const s of Object.values(sessions)) {
      if (!names.has(s.projectId) || !s.lastActivityAt || !s.lastActivity) continue
      items.push({
        id: `s-${s.id}`,
        at: s.lastActivityAt,
        tone: sessionStatus(s).tone,
        who: sessionName(s),
        what: s.lastActivity,
        href: `/p/${s.projectId}/s/${s.id}`,
        project: names.get(s.projectId)!,
      })
    }
    return items.sort((a, b) => b.at - a.at).slice(0, 8)
  }, [projects, sessions, reports])
}

function RecentActivity({ projects }: { projects: Project[] }) {
  const items = useActivity(projects)
  return (
    <section aria-labelledby="home-activity" className="min-w-0">
      <h2 id="home-activity" className="eyebrow mb-2 px-1">
        Actividad reciente
      </h2>
      {items.length ? (
        <ol className="surface-card divide-y overflow-hidden">
          {items.map((a) => (
            <li key={a.id}>
              <Link
                href={a.href}
                className="flex min-w-0 gap-2.5 px-3.5 py-2.5 outline-hidden transition-colors hover:bg-accent focus-visible:bg-accent"
              >
                <Lamp tone={a.tone} className="mt-1.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2 text-ui">
                    <span className="name min-w-0 truncate" title={`${a.who} · ${a.project}`}>
                      {a.who}
                    </span>
                    <span className="truncate text-2xs text-muted-foreground">{a.project}</span>
                    <time className="ml-auto shrink-0 text-2xs text-muted-foreground" dateTime={new Date(a.at).toISOString()}>
                      {timeAgo(a.at)}
                    </time>
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground" title={a.what}>
                    {a.what}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="surface-card px-4 py-3 text-xs text-muted-foreground">Todavía no hay actividad en esta cuenta.</p>
      )}
    </section>
  )
}

/** M8: los proyectos archivados de la cuenta, con Restaurar. Se cargan al abrir la sección. */
function ArchivedProjects() {
  const account = useCurrentAccount()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Project[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const { run, busy } = useAction()

  const load = useCallback(async () => {
    setError(null)
    try {
      setList(await api.archivedProjects())
    } catch (err) {
      setError(err)
    }
  }, [])

  const mine = (list ?? []).filter((p) => (p.accountId ? p.accountId === account?.id : (account?.isDefault ?? true)))

  const restore = (p: Project) =>
    run(p.id, async () => {
      try {
        const r = await api.restoreProject(p.id)
        setList((l) => l?.filter((x) => x.id !== p.id) ?? null)
        toast.success(`Proyecto ${p.name} restaurado`, {
          description: r.skipped.length
            ? `${r.skipped.join(", ")} ${r.skipped.length === 1 ? "quedó" : "quedaron"} en Archivadas: ya hay otra sesión con ese nombre.`
            : "Sus sesiones vuelven detenidas: se reanudan cuando les escribas.",
        })
      } catch (err) {
        toast.error(`No se pudo restaurar ${p.name}`, { description: err instanceof Error ? err.message : String(err) })
      }
    })

  return (
    <Collapsible
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) void load()
      }}
    >
      <CollapsibleTrigger className="eyebrow flex items-center gap-1.5 rounded-md px-1 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Archivados
        {list && <span className="font-normal">· {mine.length}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {error ? (
          <LoadError what="los proyectos archivados" error={error} onRetry={load} />
        ) : !list ? (
          <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground" role="status">
            <Spinner className="size-3.5" /> Cargando…
          </p>
        ) : !mine.length ? (
          <p className="px-1 text-xs text-muted-foreground">No hay proyectos archivados en esta cuenta.</p>
        ) : (
          <ul className="surface-card divide-y overflow-hidden">
            {mine.map((p) => (
              <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <Archive className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={p.name}>
                    {p.name}
                  </span>
                  <span className="flex min-w-0 gap-1.5 text-2xs text-muted-foreground">
                    <span className="truncate font-mono" title={p.repoPath}>
                      {shortPath(p.repoPath)}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">Archivado {timeAgo(p.archivedAt)}</span>
                  </span>
                </span>
                <Button size="sm" variant="outline" onClick={() => void restore(p)} disabled={busy(p.id)}>
                  {busy(p.id) ? <Spinner /> : <RotateCcw />}
                  Restaurar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Home() {
  const projects = useProjects()
  const sessions = useStore((s) => s.sessions)
  const loaded = useStore((s) => s.loaded)
  const setUi = useUi((s) => s.set)

  const stats = useMemo(() => {
    const ids = new Set(projects.map((p) => p.id))
    const mine = Object.values(sessions).filter((s) => ids.has(s.projectId))
    return {
      working: mine.filter((s) => s.status === "working" || s.status === "starting").length,
      sessions: mine.length,
    }
  }, [projects, sessions])

  if (loaded && !projects.length) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Inicio" />
        <div className="flex-1 overflow-y-auto">
          <Empty className="min-h-[60%]">
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
          <div className="mx-auto max-w-6xl px-4 pb-8 sm:px-6">
            <ArchivedProjects />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Inicio"
        subtitle={
          <>
            {plural(projects.length, "proyecto", "proyectos")} · {plural(stats.sessions, "sesión", "sesiones")}
            {stats.working > 0 && ` · ${stats.working} trabajando`}
          </>
        }
        actions={
          <Button size="sm" onClick={() => setUi({ newProject: true })}>
            <Plus />
            <span className="hidden sm:inline">Nuevo proyecto</span>
            <span className="sr-only sm:hidden">Nuevo proyecto</span>
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6">
          <div className="grid gap-3 empty:hidden lg:grid-cols-2">
            <ContinueWhereYouWere />
            <InboxSummary />
          </div>
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <section aria-labelledby="home-projects" className="min-w-0">
              <h2 id="home-projects" className="eyebrow mb-2 px-1">
                Proyectos
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {projects.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            </section>
            <RecentActivity projects={projects} />
          </div>
          <ArchivedProjects />
          <p className="hidden items-center gap-1.5 px-1 text-2xs text-muted-foreground sm:flex">
            <Shortcut keys="mod+k" /> para saltar a cualquier sesión o acción · <Shortcut keys="?" /> para ver los atajos
          </p>
        </div>
      </div>
    </div>
  )
}
