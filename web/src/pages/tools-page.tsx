import { Blocks, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { useLocation, useSearch } from "wouter"

import type { ToolsView } from "@shared/types"

import { PageHeader } from "@/components/page-header"
import { CliSection } from "@/components/tools/cli-section"
import { McpSection } from "@/components/tools/mcp-section"
import { PluginSection } from "@/components/tools/plugin-section"
import { SkillSection } from "@/components/tools/skill-section"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LoadError } from "@/components/ui/load-error"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { shortPath, timeAgo } from "@/lib/format"
import { useAccounts, useCurrentAccount, useProjects, useStore } from "@/lib/store"

const ACCOUNT = "__account"

/** Carga lo que tiene Claude Code (cuenta o proyecto) y lo recarga después de cada cambio. */
export function useToolsView(accountId: string | null, projectId: string | null) {
  const [view, setView] = useState<ToolsView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    async (refresh = false) => {
      if (!accountId) return
      setLoading(true)
      setError(null)
      try {
        setView(await api.tools(accountId, projectId, refresh))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [accountId, projectId]
  )
  useEffect(() => {
    setView(null)
    void load()
  }, [load])
  return { view, loading, error, reload: () => load(true) }
}

/** Las pestañas: se pueden abrir directo con ?tab=clis (o mcp, plugins, skills). */
const TABS = ["mcp", "plugins", "skills", "clis"] as const
type Tab = (typeof TABS)[number]

function viaText(view: ToolsView) {
  return view.via.kind === "session" ? `leído de la sesión ${view.via.name}` : "consultado a Claude Code"
}

export function ToolsPage({ projectId = null }: { projectId?: string | null }) {
  const [, navigate] = useLocation()
  const current = useCurrentAccount()
  const accounts = useAccounts()
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  // Un proyecto usa siempre su propia cuenta (aunque el selector tenga otra elegida).
  const account = project ? (accounts.find((a) => a.id === project.accountId) ?? accounts.find((a) => a.isDefault) ?? current) : current
  const projects = useProjects(account)
  const { view, loading, error, reload } = useToolsView(account?.id ?? null, projectId)
  const search = useSearch()
  const asked = new URLSearchParams(search).get("tab")
  const tab: Tab = TABS.includes(asked as Tab) ? (asked as Tab) : "mcp"
  const base = projectId ? `/p/${projectId}/tools` : "/tools"
  const setTab = (t: string) => navigate(t === "mcp" ? base : `${base}?tab=${t}`, { replace: true })

  const refresh = () =>
    reload().catch((err: Error) => {
      toast.error("No se pudieron actualizar las herramientas", { description: err.message })
    })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={<Blocks className="hidden size-4.5 shrink-0 sm:block" />}
        title="Herramientas"
        subtitle={
          <>
            Skills, plugins y servidores MCP · {account?.name}
            {view ? ` · ${viaText(view)} ${timeAgo(view.at)}` : ""}
          </>
        }
        actions={
          <>
            <Select
              value={projectId ?? ACCOUNT}
              onValueChange={(v) => navigate(`${v === ACCOUNT ? "/tools" : `/p/${v}/tools`}${tab === "mcp" ? "" : `?tab=${tab}`}`)}
            >
              <SelectTrigger size="sm" className="w-36 text-xs sm:w-52" aria-label="De qué ver las herramientas">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ACCOUNT}>Toda la cuenta</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading} aria-label="Actualizar">
              {loading ? <Spinner /> : <RefreshCw />}
              <span className="hidden sm:inline">Actualizar</span>
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
          <p className="mb-5 text-sm text-muted-foreground">
            {project
              ? <>
                  Lo que usa Claude Code en {project.name} (<code className="font-mono text-xs" title={project.repoPath}>{shortPath(project.repoPath)}</code>):
                  lo de tu cuenta más lo propio del proyecto.
                </>
              : "Lo que tiene tu cuenta de Claude Code en todos los proyectos. Elegí un proyecto para ver y ajustar lo que aplica en él."}
          </p>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="mb-5 max-w-full overflow-x-auto">
              <TabsTrigger value="mcp">MCP{view ? ` · ${view.mcp.filter((s) => !s.internal).length}` : ""}</TabsTrigger>
              <TabsTrigger value="plugins">Plugins{view ? ` · ${view.plugins.length}` : ""}</TabsTrigger>
              <TabsTrigger value="skills">Skills{view ? ` · ${view.skills.length}` : ""}</TabsTrigger>
              <TabsTrigger value="clis">CLIs</TabsTrigger>
            </TabsList>
            {tab !== "clis" && error && <LoadError what="las herramientas" error={error} onRetry={refresh} className="mb-4" />}
            {tab !== "clis" && !view && !error && (
              <div className="space-y-3">
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Consultando a Claude Code (conecta los MCP para ver su estado; tarda unos segundos)…
                </p>
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            )}
            {view && (
              <>
                <TabsContent value="mcp">
                  <McpSection view={view} onChanged={() => void refresh()} />
                </TabsContent>
                <TabsContent value="plugins">
                  <PluginSection view={view} onChanged={() => void refresh()} />
                </TabsContent>
                <TabsContent value="skills">
                  <SkillSection view={view} onChanged={() => void refresh()} />
                </TabsContent>
              </>
            )}
            <TabsContent value="clis">
              <CliSection />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
