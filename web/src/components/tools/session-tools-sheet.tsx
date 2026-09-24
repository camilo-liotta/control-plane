import { ExternalLink, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { ToolsView } from "@shared/types"

import { McpSection } from "@/components/tools/mcp-section"
import { SkillSection } from "@/components/tools/skill-section"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

/** Lo que tiene cargado una sesión ahora: sus MCP (en vivo), skills y plugins. */
export function SessionToolsSheet() {
  const sessionId = useUi((s) => s.toolsFor)
  const setUi = useUi((s) => s.set)
  const session = useStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const [view, setView] = useState<ToolsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = session && session.status !== "stopped" && session.status !== "error"

  const load = async () => {
    if (!sessionId) return
    setError(null)
    try {
      setView(await api.sessionTools(sessionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    setView(null)
    if (sessionId && running) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, running])

  const reload = async () => {
    if (!sessionId) return
    setBusy(true)
    try {
      setView(await api.reloadSessionTools(sessionId))
      toast.success("Plugins y skills recargados en la sesión")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={Boolean(sessionId)} onOpenChange={(v) => !v && setUi({ toolsFor: null })}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle>Herramientas de {session?.name}</SheetTitle>
          <SheetDescription>Lo que tiene cargado esta sesión ahora. Lo del proyecto se administra en Herramientas.</SheetDescription>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="xs" variant="outline" onClick={() => void reload()} disabled={busy || !running}>
              {busy ? <Spinner /> : <RefreshCw />}
              Recargar plugins y skills
            </Button>
            {session && (
              <Button size="xs" variant="ghost" asChild>
                <Link href={`/p/${session.projectId}/tools`} onClick={() => setUi({ toolsFor: null })}>
                  <ExternalLink />
                  Herramientas del proyecto
                </Link>
              </Button>
            )}
          </div>
        </SheetHeader>
        <div className="px-4 py-4">
          {!running && <p className="text-sm text-muted-foreground">La sesión está detenida: reanudala para ver lo que carga.</p>}
          {error && <p className="text-sm text-status-error">{error}</p>}
          {running && !view && !error && (
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}
          {view && sessionId && (
            <Tabs defaultValue="mcp">
              <TabsList className="mb-4">
                <TabsTrigger value="mcp">MCP · {view.mcp.filter((s) => !s.internal).length}</TabsTrigger>
                <TabsTrigger value="skills">Skills · {view.skills.length}</TabsTrigger>
                <TabsTrigger value="plugins">Plugins · {view.plugins.length}</TabsTrigger>
              </TabsList>
              <TabsContent value="mcp">
                <McpSection view={view} sessionId={sessionId} onChanged={() => void load()} />
              </TabsContent>
              <TabsContent value="skills">
                <SkillSection view={view} onChanged={() => void load()} readOnly />
              </TabsContent>
              <TabsContent value="plugins">
                <ul className="divide-y rounded-xl border bg-card">
                  {view.plugins.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{p.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{p.description}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{p.enabled ? "Habilitado" : "Deshabilitado"}</span>
                    </li>
                  ))}
                  {!view.plugins.length && <li className="px-4 py-3 text-sm text-muted-foreground">Sin plugins.</li>}
                </ul>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
