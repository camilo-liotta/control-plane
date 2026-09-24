import { ChevronRight, Download, Plus, RefreshCw, Search, Store, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { CatalogPlugin, Marketplace, PluginInfo, ToolsView } from "@shared/types"

import { TonePill } from "@/components/status"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { api, type PluginActionResult } from "@/lib/api"
import { tokens } from "@/lib/format"
import { cn } from "@/lib/utils"

const SCOPE_LABEL: Record<string, string> = {
  user: "Tu cuenta",
  project: "Este proyecto",
  local: "Solo vos en este proyecto",
  synced: "De tu organización",
  managed: "De tu organización",
}

type Pending = { id: string; name: string; action: "install" | "update"; command: string; sha256: string }

function useRunner(view: ToolsView, onChanged: () => void) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Pending | null>(null)
  const run = async (
    p: { id: string; name: string },
    action: "enable" | "disable" | "install" | "uninstall" | "update",
    ok: string,
    acceptCommand?: string
  ) => {
    setBusy(p.id)
    try {
      // En un proyecto, lo que habilitás o instalás aplica solo para vos en ese proyecto.
      const scope = view.projectId ? "local" : "user"
      const r: PluginActionResult = await api.pluginAction(view.accountId, { id: p.id, action, projectId: view.projectId, scope, acceptCommand })
      if ("needsConfirm" in r) {
        setConfirm({ ...p, action: action === "update" ? "update" : "install", ...r.needsConfirm })
        return
      }
      toast.success(ok, { description: "Las sesiones abiertas de esta cuenta recargan sus plugins." })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  return { busy, run, confirm, setConfirm }
}

function Components({ p }: { p: PluginInfo }) {
  const c = p.components
  if (!c) return null
  const parts = [
    c.skills.length ? `${c.skills.length} ${c.skills.length === 1 ? "skill" : "skills"}` : null,
    c.agents.length ? `${c.agents.length} ${c.agents.length === 1 ? "agente" : "agentes"}` : null,
    c.commands.length ? `${c.commands.length} ${c.commands.length === 1 ? "comando" : "comandos"}` : null,
    c.hooks ? `${c.hooks} hooks` : null,
    c.mcpServers.length ? `${c.mcpServers.length} MCP` : null,
    p.alwaysOnTokens ? `~${tokens(p.alwaysOnTokens)} tokens en cada sesión` : null,
  ].filter(Boolean)
  return <span>{parts.join(" · ")}</span>
}

function InstalledRow({ p, runner }: { p: PluginInfo; runner: ReturnType<typeof useRunner> }) {
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const busy = runner.busy === p.id
  const org = p.scope === "synced" || p.scope === "managed"
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{p.name}</span>
              {p.version && <span className="font-mono text-[0.7rem] text-muted-foreground">{p.version}</span>}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              <Components p={p} />
            </span>
          </span>
        </button>
        {p.scope && <TonePill tone="idle">{SCOPE_LABEL[p.scope] ?? p.scope}</TonePill>}
        {busy && <Spinner className="size-4" />}
        <Switch
          checked={p.enabled}
          disabled={busy}
          onCheckedChange={(v) => runner.run(p, v ? "enable" : "disable", v ? `${p.name} habilitado` : `${p.name} deshabilitado`)}
          aria-label={`Habilitado: ${p.name}`}
        />
      </div>
      {open && (
        <div className="mt-2 ml-5.5 space-y-2 text-xs">
          {p.description && <p className="text-muted-foreground">{p.description}</p>}
          {p.components && (
            <div className="grid gap-1 font-mono text-[0.7rem]">
              {p.components.skills.length > 0 && <p>Skills: {p.components.skills.join(", ")}</p>}
              {p.components.agents.length > 0 && <p>Agentes: {p.components.agents.join(", ")}</p>}
              {p.components.mcpServers.length > 0 && <p>MCP: {p.components.mcpServers.join(", ")}</p>}
            </div>
          )}
          <p className="font-mono text-[0.7rem] text-muted-foreground">
            {p.id} · {SCOPE_LABEL[p.scope ?? ""] ?? p.scope}
          </p>
          <div className="flex gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => runner.run(p, "update", `${p.name} actualizado`)}>
              <RefreshCw />
              Actualizar
            </Button>
            {!org && (
              <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => setRemoving(true)}>
                <Trash2 />
                Desinstalar
              </Button>
            )}
          </div>
          {org && <p className="text-muted-foreground">Lo instala tu organización desde claude.ai: podés deshabilitarlo para vos, no desinstalarlo.</p>}
        </div>
      )}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Desinstalar {p.name}?</AlertDialogTitle>
            <AlertDialogDescription>Se quita con `claude plugin uninstall`. Lo podés volver a instalar desde Explorar.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => runner.run(p, "uninstall", `${p.name} desinstalado`)}>Desinstalar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

function Catalog({ view, runner }: { view: ToolsView; runner: ReturnType<typeof useRunner> }) {
  const [list, setList] = useState<CatalogPlugin[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState("")
  useEffect(() => {
    setList(null)
    api.pluginCatalog(view.accountId).then(setList, (err: Error) => setError(err.message))
  }, [view.accountId])
  const installed = useMemo(() => new Set(view.plugins.map((p) => p.id)), [view.plugins])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (list ?? [])
      .filter((p) => !installed.has(p.id) && (!needle || p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle)))
      .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
      .slice(0, needle ? 60 : 24)
  }, [list, q, installed])

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="eyebrow">Explorar</h3>
        {list && <span className="font-mono text-xs text-muted-foreground">{list.length}</span>}
      </div>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar plugins en tus marketplaces…" className="pl-8" />
      </div>
      {error && <p className="text-sm text-status-error">{error}</p>}
      {!list && !error && (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {list && (
        <ul className="divide-y rounded-xl border bg-card">
          {shown.map((p) => (
            <li key={p.id} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {p.name}
                  <span className="font-mono text-[0.68rem] font-normal text-muted-foreground">{p.marketplace}</span>
                </p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
              </div>
              {p.installs !== null && <span className="shrink-0 font-mono text-[0.68rem] text-muted-foreground">{p.installs.toLocaleString("es-AR")}</span>}
              <Button size="xs" variant="outline" disabled={runner.busy === p.id} onClick={() => runner.run(p, "install", `${p.name} instalado`)}>
                {runner.busy === p.id ? <Spinner /> : <Download />}
                {view.projectId ? "Instalar acá" : "Instalar"}
              </Button>
            </li>
          ))}
          {!shown.length && <li className="px-4 py-3 text-sm text-muted-foreground">Nada que coincida.</li>}
        </ul>
      )}
    </section>
  )
}

function Marketplaces({ view }: { view: ToolsView }) {
  const [list, setList] = useState<Marketplace[] | null>(null)
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState("")
  const [busy, setBusy] = useState(false)
  const load = () => api.marketplaces(view.accountId).then(setList, () => setList([]))
  useEffect(() => {
    if (open && !list) void load()
  }, [open])
  const act = async (action: "add" | "remove" | "update", target?: string) => {
    setBusy(true)
    try {
      await api.marketplaceAction(view.accountId, action, target)
      toast.success(action === "add" ? "Marketplace agregado" : action === "remove" ? "Marketplace quitado" : "Marketplace actualizado")
      setSource("")
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section>
      <button type="button" onClick={() => setOpen((v) => !v)} className="mb-2 flex items-center gap-2 text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <Store className="size-3.5" />
        <span className="eyebrow text-current">Marketplaces</span>
      </button>
      {open && (
        <div className="space-y-3">
          <ul className="divide-y rounded-xl border bg-card">
            {(list ?? []).map((m) => (
              <li key={m.name} className="flex items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{m.name}</span>
                  <span className="block truncate font-mono text-[0.7rem] text-muted-foreground">{m.repo ?? m.url ?? m.path ?? m.source}</span>
                </span>
                <Button size="icon-xs" variant="ghost" title="Actualizar" disabled={busy} onClick={() => act("update", m.name)}>
                  <RefreshCw />
                </Button>
                <Button size="icon-xs" variant="ghost" title="Quitar" className="text-muted-foreground" disabled={busy} onClick={() => act("remove", m.name)}>
                  <Trash2 />
                </Button>
              </li>
            ))}
            {list && !list.length && <li className="px-4 py-2 text-sm text-muted-foreground">No hay marketplaces.</li>}
            {!list && <li className="px-4 py-2 text-sm text-muted-foreground">Cargando…</li>}
          </ul>
          <div className="flex gap-2">
            <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="usuario/repo, URL o carpeta" className="font-mono text-xs" />
            <Button size="sm" variant="outline" disabled={busy || !source.trim()} onClick={() => act("add", source)}>
              {busy ? <Spinner /> : <Plus />}
              Agregar
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

export function PluginSection({ view, onChanged }: { view: ToolsView; onChanged: () => void }) {
  const runner = useRunner(view, onChanged)
  const c = runner.confirm
  return (
    <div className="space-y-6">
      <section>
        <h3 className="eyebrow mb-2">
          Instalados <span className="font-mono text-muted-foreground">{view.plugins.length}</span>
        </h3>
        {view.projectId && (
          <p className="mb-2 text-xs text-muted-foreground">En este proyecto, habilitar o instalar aplica solo para vos (queda en .claude/settings.local.json).</p>
        )}
        <ul className="divide-y rounded-xl border bg-card">
          {view.plugins.map((p) => (
            <InstalledRow key={p.id} p={p} runner={runner} />
          ))}
          {!view.plugins.length && <li className="px-4 py-3 text-sm text-muted-foreground">No hay plugins instalados.</li>}
        </ul>
      </section>
      <Catalog view={view} runner={runner} />
      <Marketplaces view={view} />
      <AlertDialog open={Boolean(c)} onOpenChange={(v) => !v && runner.setConfirm(null)}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{c?.name} necesita correr un comando</AlertDialogTitle>
            <AlertDialogDescription>
              El marketplace declara este comando para {c?.action === "update" ? "actualizarlo" : "instalarlo"}. Corre en tu máquina, con tus
              permisos: aceptalo solo si confiás en ese marketplace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="max-h-48 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap">{c?.command}</pre>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => c && runner.run(c, c.action, `${c.name} ${c.action === "update" ? "actualizado" : "instalado"}`, c.sha256)}>
              Aceptar y seguir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
