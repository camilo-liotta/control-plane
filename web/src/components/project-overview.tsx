import { ArrowRight, ChevronRight, FolderGit2, GitBranch, GitCommitHorizontal } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useLocation } from "wouter"

import type { Project, ProjectOverview, RepoInfo } from "@shared/types"

import { GithubMark } from "@/components/github-mark"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { shortPath, timeAgo, tokens, tokensFull, usd } from "@/lib/format"
import { usePanelSections, useSectionOpen } from "@/lib/panel-sections"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function changesText(r: RepoInfo) {
  if (r.changes === null) return null
  return r.changes === 0 ? "sin cambios" : plural(r.changes, "archivo con cambios", "archivos con cambios")
}

/** El estado de un checkout: cambios y commits por subir (con el color de atención) o por bajar. */
function RepoState({ repo }: { repo: RepoInfo }) {
  const parts = [
    { text: changesText(repo), warn: Boolean(repo.changes) },
    { text: repo.ahead ? `${repo.ahead} por subir` : null, warn: true },
    { text: repo.behind ? `${repo.behind} por bajar` : null, warn: false },
  ].filter((p) => p.text)
  if (!parts.length) return null
  return (
    <span className="text-xs text-muted-foreground">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          <span className={cn(p.warn && "font-medium text-status-attention")}>{p.text}</span>
        </span>
      ))}
    </span>
  )
}

function Branch({ repo }: { repo: RepoInfo }) {
  if (!repo.branch) return <span className="font-mono text-xs text-muted-foreground">HEAD suelto</span>
  const inner = (
    <>
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate">{repo.branch}</span>
    </>
  )
  return repo.github?.branchUrl ? (
    <a href={repo.github.branchUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">
      {inner}
    </a>
  ) : (
    <span className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">{inner}</span>
  )
}

function Commit({ repo }: { repo: RepoInfo }) {
  const gh = repo.github
  if (!repo.head) return null
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <GitCommitHorizontal className="size-3.5 shrink-0" />
      {gh ? (
        <a href={`${gh.url}/commit/${repo.head.hash}`} target="_blank" rel="noreferrer" className="shrink-0 font-mono hover:text-foreground hover:underline">
          {repo.head.hash.slice(0, 7)}
        </a>
      ) : (
        <span className="shrink-0 font-mono">{repo.head.hash.slice(0, 7)}</span>
      )}
      <span className="min-w-0 truncate text-foreground/80">{repo.head.subject}</span>
      {repo.head.at && <span className="shrink-0">· {timeAgo(repo.head.at)}</span>}
    </span>
  )
}

function repoName(r: RepoInfo) {
  return r.github ? `${r.github.owner}/${r.github.repo}` : r.isRoot ? "Repositorio git" : r.name
}

/** Un repo con su checkout principal arriba y sus worktrees abajo, cada uno con su rama y su estado. */
function RepoGroup({ main, worktrees }: { main: RepoInfo; worktrees: RepoInfo[] }) {
  const gh = main.github
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {gh ? (
          <a href={gh.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-medium hover:underline">
            <GithubMark className="size-4" />
            {gh.owner}/{gh.repo}
          </a>
        ) : (
          <span className="flex items-center gap-1.5 font-medium">
            <FolderGit2 className="size-4 text-muted-foreground" />
            {repoName(main)}
            {main.remote && <span className="font-mono text-xs font-normal text-muted-foreground">{main.remote}</span>}
          </span>
        )}
        <Branch repo={main} />
        <RepoState repo={main} />
      </div>
      <Commit repo={main} />
      {worktrees.length > 0 && (
        <ul className="mt-1 space-y-1 border-l pl-3">
          {worktrees.map((w) => (
            <li key={w.path} className="grid min-w-0 grid-cols-[minmax(0,14rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,14rem)_auto_minmax(0,1fr)]">
              <Branch repo={w} />
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[0.7rem] text-muted-foreground/80" title={w.path}>
                  {shortPath(w.path)}
                </span>
                <RepoState repo={w} />
              </span>
              <span className="hidden min-w-0 sm:block">
                <Commit repo={w} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Los repos agrupados: cada worktree con el repo al que pertenece, el checkout principal primero. */
function groupRepos(repos: RepoInfo[]): { main: RepoInfo; worktrees: RepoInfo[] }[] {
  const groups = new Map<string, RepoInfo[]>()
  for (const r of repos) groups.set(r.group ?? r.path, [...(groups.get(r.group ?? r.path) ?? []), r])
  return [...groups.values()].map((list) => {
    const main = list.find((r) => !r.worktree) ?? list[0]!
    const worktrees = list.filter((r) => r !== main).sort((a, b) => (a.branch ?? a.name).localeCompare(b.branch ?? b.name))
    return { main, worktrees }
  })
}

/** La línea del resumen plegado: qué repo, cuántas ramas, cuántas con cambios y cuánto falta subir. */
function RepoSummary({ repos, groups }: { repos: RepoInfo[]; groups: { main: RepoInfo }[] }) {
  const dirty = repos.filter((r) => r.changes).length
  const ahead = repos.reduce((n, r) => n + (r.ahead ?? 0), 0)
  const behind = repos.reduce((n, r) => n + (r.behind ?? 0), 0)
  const first = groups[0]!.main
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
      {first.github ? <GithubMark className="size-4 shrink-0" /> : <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />}
      <span className="font-medium">{repoName(first)}</span>
      {groups.length > 1 && <span className="text-muted-foreground">y {plural(groups.length - 1, "repo más", "repos más")}</span>}
      <span className="text-xs text-muted-foreground">
        {" · "}
        {repos.length === 1 && first.branch ? <span className="font-mono">{first.branch}</span> : plural(repos.length, "rama", "ramas")}
        {" · "}
        {dirty ? <span className="font-medium text-status-attention">{repos.length === 1 ? changesText(first) : `${dirty} con cambios`}</span> : "sin cambios"}
        {ahead > 0 && (
          <>
            {" · "}
            <span className="font-medium text-status-attention">{ahead} por subir</span>
          </>
        )}
        {behind > 0 && ` · ${behind} por bajar`}
      </span>
    </span>
  )
}

function Repos({ data }: { data: ProjectOverview | null }) {
  const open = useSectionOpen("project-repos")
  const toggle = usePanelSections((s) => s.toggle)
  const groups = useMemo(() => groupRepos(data?.repos ?? []), [data])
  if (!data) return <div className="border-b px-4 py-3"><Skeleton className="h-6 w-2/3" /></div>
  if (!data.repos.length)
    return <p className="border-b px-4 py-3 text-sm text-muted-foreground">La carpeta del proyecto no es un repositorio git.</p>
  return (
    <Collapsible open={open} onOpenChange={(v) => toggle("project-repos", v)} className="border-b">
      <CollapsibleTrigger
        className="group flex w-full min-w-0 items-center gap-2 rounded-t-xl px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        aria-label={open ? "Plegar los repos" : "Ver los repos y sus ramas"}
      >
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <RepoSummary repos={data.repos} groups={groups} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-4 pb-4 pl-10">
        {groups.map((g) => (
          <RepoGroup key={g.main.path} main={g.main} worktrees={g.worktrees} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="eyebrow">{label}</p>
      <div className="mt-1 text-lg font-semibold tracking-tight">{children}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

/** Lo principal del proyecto arriba de todo: sus repos, cuánto se gastó y dónde fue lo último. */
export function ProjectOverviewCard({ project }: { project: Project }) {
  const [, navigate] = useLocation()
  const [data, setData] = useState<ProjectOverview | null>(null)
  const sessions = useStore((s) => s.sessions)

  useEffect(() => {
    let alive = true
    const load = () => api.projectOverview(project.id).then((d) => alive && setData(d), () => {})
    void load()
    const t = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [project.id])

  // La última actividad sale de las sesiones en vivo (se mueve más rápido que el resumen).
  const last = useMemo(() => {
    const list = Object.values(sessions).filter((s) => s.projectId === project.id && s.lastActivityAt)
    return list.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0] ?? null
  }, [sessions, project.id])

  const t = data?.tokens
  return (
    <section className="rounded-xl border bg-card">
      <Repos data={data} />
      <div className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat
          label="Tokens del proyecto"
          sub={t && t.total ? `entrada ${tokens(t.input)} · salida ${tokens(t.output)} · caché ${tokens(t.cacheRead + t.cacheWrite)}` : undefined}
        >
          <span title={t ? tokensFull(t.total) : undefined}>{t ? tokens(t.total) : "—"}</span>
        </Stat>
        <Stat label="Costo equivalente" sub={data ? `${data.sessions} ${data.sessions === 1 ? "sesión" : "sesiones"}, incluidas las archivadas` : undefined}>
          <span title="Lo que costaría por API. Con tu plan no se cobra aparte.">{data ? usd(data.costUsd) : "—"}</span>
        </Stat>
        <div className="flex min-w-0 items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Última actividad</p>
            {last ? (
              <>
                <p className="mt-1 text-lg font-semibold tracking-tight">
                  {timeAgo(last.lastActivityAt)} <span className="font-mono text-sm font-medium text-muted-foreground">{last.kind === "orchestrator" ? "orquestadora" : last.name}</span>
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={last.lastActivityAt ? new Date(last.lastActivityAt).toLocaleString("es-AR") : undefined}>
                  {last.lastActivityAt ? new Date(last.lastActivityAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : ""}
                  {last.lastActivity ? ` · ${last.lastActivity}` : ""}
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Todavía no hubo actividad.</p>
            )}
          </div>
          {last && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/p/${project.id}/s/${last.id}`)}>
              Ir a la sesión
              <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
