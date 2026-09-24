import { ArrowRight, FolderGit2, GitBranch, GitCommitHorizontal } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useLocation } from "wouter"

import type { Project, ProjectOverview, RepoInfo } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { shortPath, timeAgo, tokens, tokensFull, usd } from "@/lib/format"
import { useStore } from "@/lib/store"

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

function Repo({ repo }: { repo: RepoInfo }) {
  const gh = repo.github
  const state =
    repo.changes === null
      ? null
      : repo.changes === 0
        ? "sin cambios"
        : `${repo.changes} ${repo.changes === 1 ? "archivo con cambios" : "archivos con cambios"}`
  const sync = [repo.ahead ? `${repo.ahead} por subir` : null, repo.behind ? `${repo.behind} por bajar` : null].filter(Boolean).join(" · ")
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {gh ? (
          <a href={gh.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-medium hover:underline">
            <GithubMark className="size-4" />
            {gh.owner}/{gh.repo}
          </a>
        ) : (
          <span className="flex items-center gap-1.5 font-medium">
            <FolderGit2 className="size-4 text-muted-foreground" />
            {repo.isRoot ? "Repositorio git" : repo.name}
            {repo.remote && <span className="font-mono text-xs font-normal text-muted-foreground">{repo.remote}</span>}
          </span>
        )}
        {repo.branch &&
          (gh?.branchUrl ? (
            <a href={gh.branchUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">
              <GitBranch className="size-3.5" />
              {repo.branch}
            </a>
          ) : (
            <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <GitBranch className="size-3.5" />
              {repo.branch}
            </span>
          ))}
        {(state || sync) && <span className="text-xs text-muted-foreground">{[state, sync].filter(Boolean).join(" · ")}</span>}
      </div>
      {repo.head && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
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
        </p>
      )}
      {repo.worktrees.length > 0 && (
        <p className="truncate text-xs text-muted-foreground" title={repo.worktrees.map((w) => `${w.path} (${w.branch ?? "sin rama"})`).join("\n")}>
          Worktrees: {repo.worktrees.map((w) => `${shortPath(w.path)}${w.branch ? ` (${w.branch})` : ""}`).join(" · ")}
        </p>
      )}
    </div>
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
      <div className="space-y-3 border-b px-4 py-3">
        {!data ? (
          <Skeleton className="h-10 w-2/3" />
        ) : data.repos.length ? (
          data.repos.map((r) => <Repo key={r.path} repo={r} />)
        ) : (
          <p className="text-sm text-muted-foreground">La carpeta del proyecto no es un repositorio git.</p>
        )}
      </div>
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
