import { FolderGit2, GitBranch, GitCommitHorizontal, SquareArrowOutUpRight } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { Project, ProjectOverview, RepoInfo } from "@shared/types"

import { GithubMark } from "@/components/github-mark"
import { Button } from "@/components/ui/button"
import { LoadError } from "@/components/ui/load-error"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { EDITOR_NAMES, useEditor } from "@/lib/editor"
import { basename, timeAgo, tokens, tokensFull, usd } from "@/lib/format"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function changesText(r: RepoInfo) {
  if (r.changes === null) return null
  return r.changes === 0 ? "sin cambios" : plural(r.changes, "archivo con cambios", "archivos con cambios")
}

/** El estado de un checkout: cambios y commits por subir (en violeta: para mirar cuando puedas) o por bajar. */
function RepoState({ repo }: { repo: RepoInfo }) {
  const parts = [
    { text: changesText(repo), mark: Boolean(repo.changes) },
    { text: repo.ahead ? `${repo.ahead} por subir` : null, mark: true },
    { text: repo.behind ? `${repo.behind} por bajar` : null, mark: false },
  ].filter((p) => p.text)
  if (!parts.length) return null
  return (
    <span className="text-xs text-muted-foreground">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          <span className={cn(p.mark && "font-medium text-status-pending")}>{p.text}</span>
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
      <span className="truncate" title={repo.branch}>
        {repo.branch}
      </span>
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
      <span className="min-w-0 truncate text-foreground/80" title={repo.head.subject}>
        {repo.head.subject}
      </span>
      {repo.head.at && <span className="shrink-0">· {timeAgo(repo.head.at)}</span>}
    </span>
  )
}

/** owner/repo si está en GitHub; si no, el nombre de la carpeta (la ruta completa va en el title). */
function repoName(r: RepoInfo) {
  return r.github ? `${r.github.owner}/${r.github.repo}` : basename(r.path) || r.name
}

/** Abre el proyecto (o una de sus carpetas) en el editor de Ajustes; si falla, lo dice. */
function useOpenInEditor(projectId: string) {
  return async (path?: string) => {
    try {
      await api.openProjectInEditor(projectId, path)
    } catch (err) {
      toast.error("No se pudo abrir en el editor", { description: err instanceof Error ? err.message : String(err) })
    }
  }
}

function OpenFolder({ projectId, path }: { projectId: string; path: string }) {
  const settings = useEditor()
  const open = useOpenInEditor(projectId)
  const label = `Abrir en ${settings ? EDITOR_NAMES[settings.kind] : "VS Code"}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void open(path)}
          aria-label={label}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SquareArrowOutUpRight className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** "Abrir en VS Code" (o el editor de Ajustes): la carpeta del proyecto entera. */
function OpenProject({ projectId }: { projectId: string }) {
  const settings = useEditor()
  const open = useOpenInEditor(projectId)
  return (
    <Button size="xs" variant="outline" className="shrink-0" onClick={() => void open()}>
      <SquareArrowOutUpRight />
      Abrir en {settings ? EDITOR_NAMES[settings.kind] : "VS Code"}
    </Button>
  )
}

/** Un repo con su checkout principal arriba y sus worktrees abajo, cada uno con su rama y su estado. */
function RepoGroup({ main, worktrees, projectId }: { main: RepoInfo; worktrees: RepoInfo[]; projectId: string }) {
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
          <span className="flex items-center gap-1.5 font-medium" title={main.path}>
            <FolderGit2 className="size-4 text-muted-foreground" />
            {repoName(main)}
            {main.remote && <span className="font-mono text-xs font-normal text-muted-foreground">{main.remote}</span>}
          </span>
        )}
        <Branch repo={main} />
        <RepoState repo={main} />
        <OpenFolder projectId={projectId} path={main.path} />
      </div>
      <Commit repo={main} />
      {worktrees.length > 0 && (
        <ul className="mt-1 space-y-1 border-l pl-3">
          {worktrees.map((w) => (
            <li key={w.path} className="grid min-w-0 grid-cols-1 items-center gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,14rem)_auto_minmax(0,1fr)]">
              <Branch repo={w} />
              <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span className="min-w-0 truncate text-xs text-muted-foreground" title={w.path}>
                  {basename(w.path)}
                </span>
                <RepoState repo={w} />
                <OpenFolder projectId={projectId} path={w.path} />
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

/** Lo que dice la línea de git: cuántas ramas, cuántas con cambios y cuánto falta subir o bajar. */
function RepoSummary({ repos }: { repos: RepoInfo[] }) {
  const dirty = repos.filter((r) => r.changes).length
  const ahead = repos.reduce((n, r) => n + (r.ahead ?? 0), 0)
  const behind = repos.reduce((n, r) => n + (r.behind ?? 0), 0)
  return (
    <span className="text-xs text-muted-foreground">
      {plural(repos.length, "rama", "ramas")}
      {" · "}
      {dirty ? <span className="font-medium text-status-pending">{dirty} con cambios</span> : "sin cambios"}
      {ahead > 0 && (
        <>
          {" · "}
          <span className="font-medium text-status-pending">{ahead} por subir</span>
        </>
      )}
      {behind > 0 && ` · ${behind} por bajar`}
    </span>
  )
}

/** Si hay commits sin subir en algún checkout: para el punto de la pestaña (los cambios locales son lo normal). */
export function reposHaveChanges(data: ProjectOverview | null) {
  return Boolean(data?.repos.some((r) => r.ahead))
}

/** El encabezado de una sección del proyecto (Git, Apps, Entornos): ícono, título, su línea y las acciones. */
export function SectionHeader({
  icon,
  title,
  summary,
  actions,
}: {
  icon: React.ReactNode
  title: string
  summary?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-3 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
      {icon}
      <h2 className="font-medium">{title}</h2>
      {summary && <span className="min-w-0 text-xs text-muted-foreground">· {summary}</span>}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </header>
  )
}

/** Git: los repos del proyecto, cada uno con su rama, sus worktrees y su estado. */
export function ProjectRepos({ project, data, error, onRetry }: { project: Project; data: ProjectOverview | null; error: unknown; onRetry: () => unknown }) {
  const groups = useMemo(() => groupRepos(data?.repos ?? []), [data])
  return (
    <section className="surface-card overflow-hidden">
      <SectionHeader
        icon={<GitBranch />}
        title="Repos"
        summary={data?.repos.length ? <RepoSummary repos={data.repos} /> : undefined}
        actions={<OpenProject projectId={project.id} />}
      />
      <div className="space-y-4 px-4 py-3">
        {!data && error ? (
          <LoadError what="el estado de git" error={error} onRetry={onRetry} compact />
        ) : !data ? (
          <Skeleton className="h-6 w-2/3" />
        ) : !data.repos.length ? (
          <p className="text-sm text-muted-foreground">La carpeta del proyecto no es un repositorio git.</p>
        ) : (
          groups.map((g) => <RepoGroup key={g.main.path} main={g.main} worktrees={g.worktrees} projectId={project.id} />)
        )}
      </div>
    </section>
  )
}

/**
 * El resumen del proyecto (git, tokens, costo), compartido por el tablero: se pide al entrar, cada
 * minuto, al volver a la pestaña o a la ventana, y cuando una sesión del proyecto termina un turno
 * (que es cuando suele haber commits o cambios nuevos).
 */
export function useProjectOverview(projectId: string) {
  const [data, setData] = useState<ProjectOverview | null>(null)
  const [error, setError] = useState<unknown>(null)
  // Lo que llega de un proyecto anterior (al cambiar rápido) no pisa al actual.
  const current = useRef(projectId)
  current.current = projectId
  const load = useCallback(() => {
    const id = projectId
    return api.projectOverview(id).then(
      (d) => {
        if (current.current !== id) return
        setData(d)
        setError(null)
      },
      (err: unknown) => current.current === id && setError(err)
    )
  }, [projectId])

  useEffect(() => {
    setData(null)
    setError(null)
    void load()
    const t = setInterval(load, 60_000)
    const onFocus = () => document.visibilityState === "visible" && void load()
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, [load])

  const workingKey = useStore((s) =>
    Object.values(s.sessions)
      .filter((x) => x.projectId === projectId && x.status === "working")
      .map((x) => x.id)
      .sort()
      .join(",")
  )
  const lastWorking = useRef(workingKey)
  useEffect(() => {
    const before = lastWorking.current.split(",").filter(Boolean)
    lastWorking.current = workingKey
    const still = new Set(workingKey.split(","))
    if (!before.some((id) => !still.has(id))) return
    const t = setTimeout(() => void load(), 1500)
    return () => clearTimeout(t)
  }, [workingKey, load])

  return { data, error, reload: load }
}

/** El costo y los tokens del proyecto, para el encabezado; el detalle va en el title. */
export function overviewTotals(data: ProjectOverview | null): { text: string; title: string } | null {
  if (!data || (!data.costUsd && !data.tokens.total)) return null
  const t = data.tokens
  return {
    text: `${usd(data.costUsd)} · ${tokens(t.total)} tokens`,
    title: [
      `${plural(data.sessions, "sesión", "sesiones")}, incluidas las archivadas.`,
      `Entrada ${tokens(t.input)} · salida ${tokens(t.output)} · caché ${tokens(t.cacheRead + t.cacheWrite)} (${tokensFull(t.total)}).`,
      "Costo equivalente por API: con tu plan no se cobra aparte.",
    ].join("\n"),
  }
}
