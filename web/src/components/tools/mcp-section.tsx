import { ChevronRight, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import type { McpServerInfo, ToolsView } from "@shared/types"

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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api, type McpInput } from "@/lib/api"
import type { Tone } from "@/lib/status"
import { cn } from "@/lib/utils"

const STATUS: Record<string, { label: string; tone: Tone }> = {
  connected: { label: "Conectado", tone: "done" },
  "needs-auth": { label: "Requiere login", tone: "attention" },
  failed: { label: "Falló", tone: "error" },
  pending: { label: "Conectando", tone: "working" },
  disabled: { label: "Desactivado", tone: "idle" },
}

/** De dónde viene un servidor, en palabras. */
export function mcpOrigin(s: McpServerInfo): string {
  if (s.internal) return "Del dashboard"
  if (s.scope === "claudeai" || s.source === "claudeai") return "Conector de claude.ai"
  if (s.source === "plugin" || s.name.startsWith("plugin:")) return `Plugin ${s.name.split(":")[1] ?? ""}`.trim()
  if (s.scope === "user") return "Tu cuenta"
  if (s.scope === "local") return "Solo vos en este proyecto"
  if (s.scope === "project") return "Este proyecto (.mcp.json)"
  if (s.scope === "managed" || s.scope === "enterprise") return "De tu organización"
  return s.scope ?? "Otro"
}

const GROUPS: { title: string; match: (s: McpServerInfo) => boolean }[] = [
  { title: "Tuyos y del proyecto", match: (s) => !s.internal && ["user", "local", "project"].includes(s.scope ?? "") },
  { title: "Conectores de claude.ai", match: (s) => s.scope === "claudeai" || s.source === "claudeai" },
  { title: "De plugins", match: (s) => s.source === "plugin" || s.name.startsWith("plugin:") },
  { title: "Otros", match: () => true },
]

function ServerRow({
  server,
  view,
  sessionId,
  onChanged,
}: {
  server: McpServerInfo
  view: ToolsView
  sessionId?: string
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const status = STATUS[server.status] ?? { label: server.status, tone: "idle" as Tone }
  const removable = ["user", "local", "project"].includes(server.scope ?? "") && !server.internal
  const act = async (fn: () => Promise<unknown>, ok: string, description?: string) => {
    setBusy(true)
    try {
      await fn()
      toast.success(ok, { description })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{server.name}</span>
            <span className="block truncate font-mono text-[0.7rem] text-muted-foreground">
              {mcpOrigin(server)}
              {server.tools.length ? ` · ${server.tools.length} herramientas` : ""}
            </span>
          </span>
        </button>
        <TonePill tone={status.tone}>{status.label}</TonePill>
        {server.status === "needs-auth" && (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              act(() => api.loginMcp(view.accountId, server.name), `Autorizá ${server.name} en el navegador`, "Se abrió una pestaña para iniciar sesión. Cuando termines, tocá Actualizar.")
            }
          >
            <KeyRound />
            Iniciar sesión
          </Button>
        )}
        {sessionId && (server.status === "failed" || server.status === "needs-auth") && (
          <Button size="icon-xs" variant="ghost" disabled={busy} title="Reconectar" onClick={() => act(() => api.reconnectMcp(sessionId, server.name), "Reconectando")}>
            <RefreshCw />
          </Button>
        )}
        {view.projectId && !server.internal && (
          <Switch
            checked={server.status !== "disabled"}
            disabled={busy}
            onCheckedChange={(v) =>
              act(
                async () => {
                  const r = await api.toggleMcp(view.projectId!, server.name, v)
                  if (r.warning) toast.warning(`${server.name} quedó activo, pero no se pudo conectar`, { description: r.warning })
                },
                v ? `${server.name}: activo en este proyecto` : `${server.name}: desactivado en este proyecto`
              )
            }
            aria-label={`Activo en este proyecto: ${server.name}`}
          />
        )}
        {removable && (
          <Button size="icon-xs" variant="ghost" className="text-muted-foreground" title="Quitar" onClick={() => setRemoving(true)}>
            <Trash2 />
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-2 ml-5.5 space-y-2 text-xs">
          {server.target && <p className="font-mono break-all text-muted-foreground">{server.target}</p>}
          {server.error && <p className="text-status-error">{server.error}</p>}
          {server.tools.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {server.tools.map((t) => (
                <span
                  key={t.name}
                  className={cn("rounded-md border px-1.5 py-0.5 font-mono text-[0.68rem]", t.destructive && "border-status-error/40 text-status-error")}
                  title={t.readOnly ? "Solo lee" : t.destructive ? "Puede borrar o cambiar datos" : undefined}
                >
                  {t.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">{server.status === "connected" ? "No expone herramientas." : "Las herramientas aparecen cuando se conecta."}</p>
          )}
          {(server.scope === "claudeai" || server.source === "claudeai") && (
            <p className="text-muted-foreground">
              Los conectores se administran en{" "}
              <a href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer" className="underline">
                claude.ai → Configuración → Conectores
              </a>
              .
            </p>
          )}
        </div>
      )}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Quitar {server.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Se borra de la configuración de Claude Code ({mcpOrigin(server).toLowerCase()}). Las sesiones que lo usan lo pierden al reanudarse.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => act(() => api.removeMcp(view.accountId, server.name, server.scope ?? "user", view.projectId), `${server.name} quitado`)}
            >
              Quitar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

/** Separa un comando en palabras respetando comillas: npx -y "mi server" → [npx, -y, mi server]. */
function splitCommand(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  return out
}

function parsePairs(text: string, sep: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep)
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

function AddServerDialog({ view, open, onOpenChange, onAdded }: { view: ToolsView; open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const [name, setName] = useState("")
  const [transport, setTransport] = useState<McpInput["transport"]>("stdio")
  const [command, setCommand] = useState("")
  const [url, setUrl] = useState("")
  const [pairs, setPairs] = useState("")
  const [scope, setScope] = useState<McpInput["scope"]>(view.projectId ? "local" : "user")
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const words = splitCommand(command)
      await api.addMcp(view.accountId, {
        name: name.trim(),
        scope,
        transport,
        ...(transport === "stdio"
          ? { command: words[0], args: words.slice(1), env: parsePairs(pairs, "=") }
          : { url: url.trim(), headers: parsePairs(pairs, ":") }),
        projectId: view.projectId ?? undefined,
      })
      toast.success(`${name.trim()} agregado`, { description: "Las sesiones lo toman al reanudarse." })
      onOpenChange(false)
      setName("")
      setCommand("")
      setUrl("")
      setPairs("")
      onAdded()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Agregar un servidor MCP</DialogTitle>
          <DialogDescription>Se guarda con `claude mcp`, igual que desde la terminal.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="mcp-name">Nombre</FieldLabel>
              <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="postgres" className="font-mono" />
            </Field>
            <Field>
              <FieldLabel>Tipo</FieldLabel>
              <Select value={transport} onValueChange={(v) => setTransport(v as McpInput["transport"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">Comando local</SelectItem>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {transport === "stdio" ? (
            <Field>
              <FieldLabel htmlFor="mcp-cmd">Comando</FieldLabel>
              <Input
                id="mcp-cmd"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx -y @modelcontextprotocol/server-postgres postgresql://localhost/db"
                className="font-mono text-xs"
              />
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="mcp-url">URL</FieldLabel>
              <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.ejemplo.com/mcp" className="font-mono text-xs" />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="mcp-pairs">{transport === "stdio" ? "Variables de entorno" : "Encabezados"} (opcional)</FieldLabel>
            <Textarea
              id="mcp-pairs"
              value={pairs}
              onChange={(e) => setPairs(e.target.value)}
              placeholder={transport === "stdio" ? "API_KEY=…\nOTRA=…" : "Authorization: Bearer …"}
              className="min-h-16 font-mono text-xs"
            />
            <FieldDescription>Una por línea. Quedan guardadas en texto plano en la configuración de Claude Code.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Dónde</FieldLabel>
            <Select value={scope} onValueChange={(v) => setScope(v as McpInput["scope"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">En tu cuenta (todos los proyectos)</SelectItem>
                {view.projectId && <SelectItem value="local">Solo vos, en este proyecto</SelectItem>}
                {view.projectId && <SelectItem value="project">En este proyecto, compartido (.mcp.json)</SelectItem>}
              </SelectContent>
            </Select>
            {scope === "project" && (
              <FieldDescription className="text-status-attention">
                Se guarda en el .mcp.json del repo y lo ve quien lo clone: no pongas claves acá.
              </FieldDescription>
            )}
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}>
            {saving && <Spinner />}
            Agregar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function McpSection({ view, sessionId, onChanged }: { view: ToolsView; sessionId?: string; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const used = new Set<string>()
  const groups = GROUPS.map((g) => {
    const list = view.mcp.filter((s) => !used.has(s.name) && g.match(s))
    for (const s of list) used.add(s.name)
    return { title: g.title, list }
  }).filter((g) => g.list.length)
  const connected = view.mcp.filter((s) => s.status === "connected" && !s.internal).length

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">
          {connected} de {view.mcp.filter((s) => !s.internal).length} conectados
          {view.projectId ? ". El interruptor los activa o desactiva solo en este proyecto." : "."}
        </p>
        {!sessionId && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus />
            Agregar servidor
          </Button>
        )}
      </div>
      {groups.map((g) => (
        <section key={g.title}>
          <h3 className="eyebrow mb-2">
            {g.title} <span className="font-mono text-muted-foreground">{g.list.length}</span>
          </h3>
          <ul className="divide-y rounded-xl border bg-card">
            {g.list.map((s) => (
              <ServerRow key={s.name} server={s} view={view} sessionId={sessionId} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      ))}
      {!view.mcp.length && <p className="text-sm text-muted-foreground">No hay servidores MCP configurados.</p>}
      <AddServerDialog view={view} open={adding} onOpenChange={setAdding} onAdded={onChanged} />
    </div>
  )
}
