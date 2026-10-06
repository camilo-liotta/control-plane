import { ChevronRight, Download, Plus, RefreshCw, Search, Store, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { CatalogPlugin, Marketplace, PluginInfo, ToolsView } from "@shared/types"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmAction } from "@/components/ui/confirm-action"
import { Input } from "@/components/ui/input"
import { LoadError } from "@/components/ui/load-error"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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

const ACTION_VERB = { enable: "habilitar", disable: "deshabilitar", install: "instalar", uninstall: "desinstalar", update: "actualizar" } as const

type Pending = { id: string; name: string; action: "install" | "update"; command: string; sha256: string }

function useRunner(view: ToolsView, onChanged: () => void) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Pending | null>(null)
  type Action = "enable" | "disable" | "install" | "uninstall" | "update"
  /** Hace la acción y tira el error (para ConfirmAction, que lo muestra y queda abierto). */
  const exec = async (p: { id: string; name: string }, action: Action, ok: string, acceptCommand?: string) => {
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
    } finally {
      setBusy(null)
    }
  }
  const run = (p: { id: string; name: string }, action: Action, ok: string, acceptCommand?: string) =>
    exec(p, action, ok, acceptCommand).catch((err: unknown) => {
      toast.error(`No se pudo ${ACTION_VERB[action]} ${p.name}`, { description: err instanceof Error ? err.message : String(err) })
    })
  return { busy, run, exec, confirm, setConfirm }
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
  const busy = runner.busy === p.id
  const org = p.scope === "synced" || p.scope === "managed"
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium" title={p.name}>{p.name}</span>
              {p.version && <span className="font-mono text-2xs text-muted-foreground">{p.version}</span>}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              <Components p={p} />
            </span>
          </span>
        </button>
        {p.scope && (
          <Badge variant="secondary" className="hidden sm:inline-flex">
            {SCOPE_LABEL[p.scope] ?? p.scope}
          </Badge>
        )}
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
            <div className="grid gap-1 font-mono text-2xs">
              {p.components.skills.length > 0 && <p>Skills: {p.components.skills.join(", ")}</p>}
              {p.components.agents.length > 0 && <p>Agentes: {p.components.agents.join(", ")}</p>}
              {p.components.mcpServers.length > 0 && <p>MCP: {p.components.mcpServers.join(", ")}</p>}
            </div>
          )}
          <p className="font-mono text-2xs text-muted-foreground">
            {p.id} · {SCOPE_LABEL[p.scope ?? ""] ?? p.scope}
          </p>
          <div className="flex gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => runner.run(p, "update", `${p.name} actualizado`)}>
              <RefreshCw />
              Actualizar
            </Button>
            {!org && (
              <ConfirmAction
                title={`¿Desinstalar ${p.name}?`}
                description="Se quita con claude plugin uninstall. Lo podés volver a instalar desde Explorar."
                confirmLabel="Desinstalar"
                onConfirm={() => runner.exec(p, "uninstall", `${p.name} desinstalado`)}
              >
                <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={busy}>
                  <Trash2 />
                  Desinstalar
                </Button>
              </ConfirmAction>
            )}
          </div>
          {org && <p className="text-muted-foreground">Lo instala tu organización desde claude.ai: podés deshabilitarlo para vos, no desinstalarlo.</p>}
        </div>
      )}
    </li>
  )
}

function Catalog({ view, runner }: { view: ToolsView; runner: ReturnType<typeof useRunner> }) {
  const [list, setList] = useState<CatalogPlugin[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [q, setQ] = useState("")
  const load = useCallback(() => {
    setList(null)
    setError(null)
    return api.pluginCatalog(view.accountId).then(setList, setError)
  }, [view.accountId])
  useEffect(() => {
    void load()
  }, [load])
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
        <h3 className="eyebrow">
          Explorar {list && <span className="font-normal">· {list.length}</span>}
        </h3>
      </div>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar plugins en tus marketplaces…" className="pl-8" />
      </div>
      {Boolean(error) && <LoadError what="el catálogo de plugins" error={error} onRetry={load} />}
      {!list && !error && (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {list && (
        <ul className="surface-card divide-y overflow-hidden">
          {shown.map((p) => (
            <li key={p.id} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <span className="truncate" title={p.name}>{p.name}</span>
                  <span className="shrink-0 text-2xs font-normal text-muted-foreground">{p.marketplace}</span>
                </p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
              </div>
              {p.installs !== null && (
                <span className="hidden shrink-0 text-2xs text-muted-foreground sm:inline" title="Instalaciones">
                  {p.installs.toLocaleString("es-AR")}
                </span>
              )}
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
  const [error, setError] = useState<unknown>(null)
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState("")
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    setError(null)
    return api.marketplaces(view.accountId).then(setList, setError)
  }, [view.accountId])
  useEffect(() => {
    if (open && !list) void load()
  }, [open, list, load])
  /** Tira el error: así quitar (con ConfirmAction) queda abierto si falla. */
  const exec = async (action: "add" | "remove" | "update", target?: string) => {
    setBusy(true)
    try {
      await api.marketplaceAction(view.accountId, action, target)
      toast.success(action === "add" ? "Marketplace agregado" : action === "remove" ? "Marketplace quitado" : "Marketplace actualizado")
      if (action === "add") setSource("")
      void load()
    } finally {
      setBusy(false)
    }
  }
  const act = (action: "add" | "update", target?: string) =>
    exec(action, target).catch((err: unknown) => {
      toast.error("No se pudo agregar o actualizar el marketplace", { description: err instanceof Error ? err.message : String(err) })
    })
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
        <span className="eyebrow text-current">Marketplaces</span>
      </button>
      {open && (
        <div className="space-y-3">
          {error && !list ? (
            <LoadError what="los marketplaces" error={error} onRetry={load} />
          ) : (
            <ul className="surface-card divide-y overflow-hidden">
              {(list ?? []).map((m) => {
                const where = m.repo ?? m.url ?? m.path ?? m.source
                return (
                  <li key={m.name} className="flex items-center gap-3 px-4 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" title={m.name}>{m.name}</span>
                      <span className="block truncate font-mono text-2xs text-muted-foreground" title={where}>{where}</span>
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button size="icon-xs" variant="ghost" aria-label={`Actualizar ${m.name}`} disabled={busy} onClick={() => void act("update", m.name)}>
                          <RefreshCw />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Actualizar</TooltipContent>
                    </Tooltip>
                    <ConfirmAction
                      title={`¿Quitar el marketplace ${m.name}?`}
                      description={`Se quita con claude plugin marketplace remove y sus plugins dejan de aparecer en Explorar. Para volver a tenerlo, lo agregás de nuevo con ${m.repo ?? m.url ?? m.path ?? "su repo o URL"}.`}
                      confirmLabel="Quitar"
                      onConfirm={() => exec("remove", m.name)}
                    >
                      <Button size="icon-xs" variant="ghost" aria-label={`Quitar ${m.name}`} title="Quitar" className="text-muted-foreground" disabled={busy}>
                        <Trash2 />
                      </Button>
                    </ConfirmAction>
                  </li>
                )
              })}
              {list && !list.length && <li className="px-4 py-2 text-sm text-muted-foreground">Los marketplaces que agregues aparecen acá: abajo va su repo o URL.</li>}
              {!list && (
                <li className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground" role="status">
                  <Spinner className="size-3.5" /> Cargando…
                </li>
              )}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (source.trim()) void act("add", source)
            }}
          >
            <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="usuario/repo, URL o carpeta" aria-label="Marketplace para agregar" className="font-mono text-xs" />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !source.trim()}>
              {busy ? <Spinner /> : <Plus />}
              Agregar
            </Button>
          </form>
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
          Instalados <span className="font-normal">· {view.plugins.length}</span>
        </h3>
        {view.projectId && (
          <p className="mb-2 text-xs text-muted-foreground">En este proyecto, habilitar o instalar aplica solo para vos (queda en .claude/settings.local.json).</p>
        )}
        <ul className="surface-card divide-y overflow-hidden">
          {view.plugins.map((p) => (
            <InstalledRow key={p.id} p={p} runner={runner} />
          ))}
          {!view.plugins.length && <li className="px-4 py-3 text-sm text-muted-foreground">Los plugins que instales aparecen acá. Buscalos en Explorar.</li>}
        </ul>
      </section>
      <Catalog view={view} runner={runner} />
      <Marketplaces view={view} />
      <ConfirmAction
        open={Boolean(c)}
        onOpenChange={(v) => !v && runner.setConfirm(null)}
        title={`${c?.name ?? ""} necesita correr un comando`}
        description={
          <>
            <p>
              El marketplace declara este comando para {c?.action === "update" ? "actualizarlo" : "instalarlo"}. Corre en tu máquina, con tus
              permisos: aceptalo solo si confiás en ese marketplace.
            </p>
            <pre className="max-h-48 overflow-auto rounded-xl bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-foreground">{c?.command}</pre>
          </>
        }
        confirmLabel="Aceptar y seguir"
        destructive={false}
        onConfirm={() => c && runner.exec(c, c.action, `${c.name} ${c.action === "update" ? "actualizado" : "instalado"}`, c.sha256)}
      />
    </div>
  )
}
