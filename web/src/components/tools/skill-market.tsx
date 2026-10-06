import { ChevronRight, Download, FolderGit2, Plus, RefreshCw, Search, Sparkles, Store, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { CatalogSkill, SkillMarketView, ToolsView } from "@shared/types"

import { TonePill } from "@/components/status"
import { Markdown } from "@/components/timeline/markdown"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LoadError } from "@/components/ui/load-error"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api, type AiSearchResult } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { undoable } from "@/lib/undo"
import { cn } from "@/lib/utils"

const WHERE = { user: "tu cuenta", project: "este proyecto" }

/** Botones de instalar una skill del catálogo: en el proyecto o en tu cuenta. */
function InstallButtons({ skill, view, onInstalled }: { skill: CatalogSkill; view: ToolsView; onInstalled: () => void }) {
  const [busy, setBusy] = useState<"user" | "project" | null>(null)
  if (skill.installed) return <TonePill tone="done">Ya está en {WHERE[skill.installed]}</TonePill>
  const install = async (scope: "user" | "project") => {
    setBusy(scope)
    try {
      await api.installMarketSkill(view.accountId, skill.id, scope, view.projectId)
      toast.success(`${skill.name} instalada en ${WHERE[scope]}`, { description: "Las sesiones abiertas la cargan al instante." })
      onInstalled()
    } catch (err) {
      toast.error(`No se pudo instalar ${skill.name}`, { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex shrink-0 gap-1.5">
      {view.projectId && (
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void install("project")}>
          {busy === "project" ? <Spinner /> : <Download />}
          En el proyecto
        </Button>
      )}
      <Button size="xs" variant={view.projectId ? "ghost" : "outline"} disabled={busy !== null} onClick={() => void install("user")}>
        {busy === "user" ? <Spinner /> : <Download />}
        {view.projectId ? "En tu cuenta" : "Instalar"}
      </Button>
    </div>
  )
}

function PreviewSheet({ skill, view, onClose, onInstalled }: { skill: CatalogSkill | null; view: ToolsView; onClose: () => void; onInstalled: () => void }) {
  const [data, setData] = useState<{ content: string; files: string[] } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setData(null)
    setError(null)
    if (!skill) return
    api.previewMarketSkill(view.accountId, skill.id).then(setData, setError)
  }, [skill?.id, view.accountId, attempt])
  const body = data?.content.replace(/^---\n[\s\S]*?\n---\n?/, "") ?? ""
  const scripts = (data?.files ?? []).filter((f) => /\.(sh|py|js|mjs|ts|rb|pl|ps1|bat)$/i.test(f))
  return (
    <Sheet open={Boolean(skill)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="name">{skill?.name}</SheetTitle>
          <SheetDescription>
            {skill?.description}
            <span className="mt-1 block text-xs">
              De {skill?.sourceName}
              {skill?.plugin ? ` · plugin ${skill.plugin}` : ""}
            </span>
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {Boolean(error) && <LoadError what="la skill" error={error} onRetry={() => setAttempt((n) => n + 1)} />}
          {!data && !error && <Skeleton className="h-40 w-full" />}
          {data && (
            <div className="space-y-4">
              {scripts.length > 0 && (
                <p className="rounded-xl bg-muted px-3 py-2 text-xs leading-snug">
                  Trae {scripts.length === 1 ? "un script" : `${scripts.length} scripts`} ({scripts.slice(0, 4).join(", ")}
                  {scripts.length > 4 ? "…" : ""}) que Claude puede ejecutar. Instalala solo si confiás en la fuente.
                </p>
              )}
              <Markdown text={body || "_(vacía)_"} />
              <div>
                <p className="eyebrow mb-1">Archivos · {data.files.length}</p>
                <p className="font-mono text-2xs break-all text-muted-foreground">{data.files.join(" · ")}</p>
              </div>
            </div>
          )}
        </div>
        {skill && (
          <SheetFooter className="flex-row justify-end border-t">
            <InstallButtons skill={skill} view={view} onInstalled={() => (onInstalled(), onClose())} />
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** Buscar con IA en todos los marketplaces: skills sueltas, plugins y lo que ya tenés. */
export function AiSkillSearch({ view, onChanged, onOpenSkill }: { view: ToolsView; onChanged: () => void; onOpenSkill: (s: CatalogSkill) => void }) {
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ results: AiSearchResult[]; note: string | null } | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)

  const search = async () => {
    if (!query.trim()) return
    setBusy(true)
    try {
      setResult(await api.aiSearchSkills(view.accountId, query, view.projectId))
    } catch (err) {
      toast.error("No se pudo buscar", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const installPlugin = async (id: string, name: string) => {
    setInstalling(id)
    try {
      const r = await api.pluginAction(view.accountId, { id, action: "install", projectId: view.projectId, scope: view.projectId ? "local" : "user" })
      if ("needsConfirm" in r) toast.warning(`${name} pide correr un comando para instalarse`, { description: "Instalalo desde la pestaña Plugins: ahí te muestra el comando antes." })
      else {
        toast.success(`${name} instalado`)
        onChanged()
      }
    } catch (err) {
      toast.error(`No se pudo instalar ${name}`, { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setInstalling(null)
    }
  }

  return (
    <section className="surface-card p-4">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="size-4 text-claude" />
        <h3 className="text-sm font-medium">Buscar con IA</h3>
        <span className="text-xs text-muted-foreground">en tus marketplaces de skills y de plugins, y en lo que ya tenés</span>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ej: revisar migraciones de Postgres, armar presentaciones con datos…" />
        <Button type="submit" size="sm" disabled={busy || !query.trim()}>
          {busy ? <Spinner /> : <Search />}
          Buscar
        </Button>
      </form>
      <p className="mt-1.5 text-2xs text-muted-foreground">Usa tu plan: es una consulta a Claude con el catálogo.</p>
      {result && (
        <div className="mt-3 space-y-2">
          {result.note && <p className="text-xs text-muted-foreground">{result.note}</p>}
          {!result.results.length && <p className="text-sm text-muted-foreground">No encontró nada que sirva para eso.</p>}
          <ul className="divide-y rounded-xl bg-muted/50">
            {result.results.map((r, i) => (
              <li key={i} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  {r.kind === "skill" ? (
                    <button type="button" onClick={() => onOpenSkill(r.skill)} className="rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="name text-sm hover:underline">{r.skill.name}</span>
                      <span className="ml-2 text-2xs text-muted-foreground">
                        skill · {r.skill.sourceName}
                        {r.skill.plugin ? ` · plugin ${r.skill.plugin}` : ""}
                      </span>
                    </button>
                  ) : r.kind === "plugin" ? (
                    <p>
                      <span className="text-sm font-medium">{r.plugin.name}</span>
                      <span className="ml-2 text-2xs text-muted-foreground">plugin · {r.plugin.marketplace}</span>
                    </p>
                  ) : (
                    <p>
                      <span className="name text-sm">{r.installed.name}</span>
                      <span className="ml-2 text-2xs text-muted-foreground">ya la tenés en {WHERE[r.installed.scope]}</span>
                    </p>
                  )}
                  <p className="text-xs text-foreground/80">{r.why}</p>
                </div>
                {r.kind === "skill" && <InstallButtons skill={r.skill} view={view} onInstalled={onChanged} />}
                {r.kind === "plugin" &&
                  (r.plugin.installed ? (
                    <TonePill tone="done">Instalado</TonePill>
                  ) : (
                    <Button size="xs" variant="outline" disabled={installing === r.plugin.id} onClick={() => void installPlugin(r.plugin.id, r.plugin.name)}>
                      {installing === r.plugin.id ? <Spinner /> : <Download />}
                      Instalar plugin
                    </Button>
                  ))}
                {r.kind === "installed" && <TonePill tone="done">Instalada</TonePill>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Marketplaces de skills: repos con carpetas SKILL.md y las skills de tus marketplaces de plugins. */
export function SkillMarketplaces({ view, onChanged, openSkill, setOpenSkill }: {
  view: ToolsView
  onChanged: () => void
  openSkill: CatalogSkill | null
  setOpenSkill: (s: CatalogSkill | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<SkillMarketView | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [source, setSource] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [q, setQ] = useState("")

  const load = () =>
    api.skillMarket(view.accountId, view.projectId).then(
      (d) => {
        setData(d)
        setError(null)
      },
      (err: unknown) => setError(err)
    )
  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view.accountId, view.projectId, view.at])

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key)
    try {
      await fn()
      toast.success(ok)
      await load()
    } catch (err) {
      toast.error("No se pudo hacer el cambio", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data?.skills ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)).slice(0, 80)
  }, [data, q])

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mb-2 flex items-center gap-2 rounded-md text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <Store className="size-3.5" />
        <span className="eyebrow text-current">
          Marketplaces de skills {data && <span className="font-normal">· {data.skills.length}</span>}
        </span>
      </button>
      {open && (
        <div className="space-y-4">
          {Boolean(error) && !data && <LoadError what="los marketplaces de skills" error={error} onRetry={load} />}
          {!data && !error && <Skeleton className="h-24 w-full" />}
          {data && (
            <>
              <ul className="surface-card divide-y overflow-hidden">
                {data.sources.filter((s) => !hidden.has(s.id)).map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-2">
                    <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-2 text-sm font-medium">
                        <span className="truncate" title={s.name}>{s.name}</span>
                        <span className="shrink-0 text-xs font-normal text-muted-foreground">{s.skills} skills</span>
                      </span>
                      <span className="block truncate font-mono text-2xs text-muted-foreground" title={s.url ?? s.path ?? undefined}>
                        {s.kind === "plugin-marketplace" ? "marketplace de plugins (se administra en Plugins)" : (s.url ?? s.path)}
                        {s.updatedAt ? ` · actualizada ${timeAgo(s.updatedAt)}` : ""}
                      </span>
                    </span>
                    {s.removable && (
                      <>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Actualizar ${s.name}`}
                              disabled={busy !== null}
                              onClick={() => act(`u:${s.id}`, () => api.updateSkillSource(view.accountId, s.id), `${s.name} actualizada`)}
                            >
                              {busy === `u:${s.id}` ? <Spinner /> : <RefreshCw />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Actualizar</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Quitar ${s.name}`}
                              className="text-muted-foreground"
                              disabled={busy !== null}
                              onClick={() =>
                                // Se puede deshacer: la fuente desaparece ya y se quita de verdad a los 5 s.
                                undoable({
                                  message: `Fuente ${s.name} quitada`,
                                  failMessage: `No se pudo quitar ${s.name}`,
                                  onHide: () => setHidden((h) => new Set(h).add(s.id)),
                                  onRestore: () =>
                                    setHidden((h) => {
                                      const next = new Set(h)
                                      next.delete(s.id)
                                      return next
                                    }),
                                  run: async () => {
                                    await api.removeSkillSource(view.accountId, s.id)
                                    await load()
                                  },
                                })
                              }
                            >
                              <Trash2 />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Quitar</TooltipContent>
                        </Tooltip>
                      </>
                    )}
                  </li>
                ))}
                {!data.sources.length && <li className="px-4 py-3 text-sm text-muted-foreground">Todavía no hay fuentes de skills.</li>}
              </ul>
              {data.suggested.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {data.suggested.map((s) => (
                    <button
                      key={s.url}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => act(`a:${s.url}`, () => api.addSkillSource(view.accountId, s.url), `${s.name} agregada`)}
                      className="surface-card flex max-w-full items-start gap-2 px-3 py-2 text-left text-xs outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    >
                      {busy === `a:${s.url}` ? <Spinner className="mt-0.5 size-3.5" /> : <Plus className="mt-0.5 size-3.5" />}
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-baseline gap-1.5 font-medium">
                          {s.name} <span className="truncate font-mono font-normal text-muted-foreground" title={s.url}>{s.url}</span>
                        </span>
                        <span className="block text-muted-foreground">{s.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (source.trim()) void act("add", () => api.addSkillSource(view.accountId, source), "Fuente agregada").then(() => setSource(""))
                }}
              >
                <Input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="usuario/repo de GitHub, URL https o carpeta local"
                  aria-label="Fuente de skills para agregar"
                  className="font-mono text-xs"
                />
                <Button type="submit" size="sm" variant="outline" disabled={busy !== null || !source.trim()}>
                  {busy === "add" ? <Spinner /> : <Plus />}
                  Agregar fuente
                </Button>
              </form>
              <p className="text-2xs text-muted-foreground">Los repos se clonan en ~/.control-plane/skill-sources. Instalar una skill copia su carpeta: no se actualiza sola.</p>
              {data.skills.length > 0 && (
                <div>
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar por nombre o descripción…" className="pl-8" />
                  </div>
                  <ul className="surface-card divide-y overflow-hidden">
                    {shown.map((s) => (
                      <li key={s.id} className="flex items-start gap-3 px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => setOpenSkill(s)}
                          className="min-w-0 flex-1 rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="name text-sm hover:underline">{s.name}</span>
                          <span className="ml-2 text-2xs text-muted-foreground">
                            {s.sourceName}
                            {s.plugin ? ` · plugin ${s.plugin}` : ""}
                          </span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>
                        </button>
                        <InstallButtons skill={s} view={view} onInstalled={() => (onChanged(), void load())} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <PreviewSheet skill={openSkill} view={view} onClose={() => setOpenSkill(null)} onInstalled={() => (onChanged(), void load())} />
    </section>
  )
}
