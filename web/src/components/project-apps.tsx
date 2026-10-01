import { Boxes, ChevronRight, ExternalLink, Pencil, Play, Plus, RotateCw, ScrollText, Sparkles, Square, Trash2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { AppHealth, AppInput, AppStatus, AppSuggestion, AppView, Project } from "@shared/types"

import { Lamp } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { usePanelSections, useSectionOpen } from "@/lib/panel-sections"
import type { Tone } from "@/lib/status"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const STATUS: Record<AppStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  stopped: { label: "detenida", tone: "idle" },
  starting: { label: "arrancando", tone: "working", pulse: true },
  up: { label: "levantada", tone: "done" },
  unresponsive: { label: "sin responder", tone: "attention" },
  crashed: { label: "se cayó", tone: "error" },
  external: { label: "levantada afuera", tone: "done" },
}
const TEXT: Record<Tone, string> = {
  idle: "text-muted-foreground",
  working: "text-status-working",
  done: "text-status-done",
  attention: "text-status-attention",
  error: "text-status-error",
}

const isUp = (a: AppView) => a.state.status === "up" || a.state.status === "external"
const isOurs = (a: AppView) => a.state.status === "starting" || a.state.status === "up" || a.state.status === "unresponsive"
const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))

/** Pide las apps del proyecto mientras la sección está en pantalla: así el server mira su salud solo mientras alguien mira. */
function useWatchApps(projectId: string) {
  useEffect(() => {
    let alive = true
    const load = () =>
      api.apps(projectId, true).then(
        (apps) => alive && useStore.setState((s) => ({ apps: { ...s.apps, [projectId]: apps } })),
        () => {}
      )
    void load()
    const t = setInterval(load, 20_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [projectId])
}

function healthText(h: AppHealth | null) {
  if (!h) return "sin salud: cuenta como levantada si el proceso vive"
  return h.kind === "http" ? h.url : `puerto ${h.port}${h.host ? ` en ${h.host}` : ""}`
}

function AppRow({ app, onEdit, onLog }: { app: AppView; onEdit: () => void; onLog: () => void }) {
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null)
  const st = STATUS[app.state.status]
  const run = (what: "start" | "stop" | "restart") => async () => {
    setBusy(what)
    try {
      await (what === "start" ? api.startApp(app.id) : what === "stop" ? api.stopApp(app.id) : api.restartApp(app.id))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }
  const crashed = app.state.status === "crashed"
  const exit = app.state.error ?? (app.state.exitCode !== null ? `código ${app.state.exitCode}` : app.state.signal ? `por ${app.state.signal}` : null)
  return (
    <li className="rounded-lg border bg-background/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium">{app.name}</span>
            <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", TEXT[st.tone])}>
              <Lamp tone={st.tone} pulse={st.pulse} className={cn("size-1.5", app.state.status === "external" && "ring-2 ring-status-done/30")} />
              {st.label}
              {crashed && exit ? ` (${exit})` : ""}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[0.72rem] text-muted-foreground" title={app.command}>
            {app.command}
            {app.cwd ? <span className="text-muted-foreground/70"> · en {app.cwd}</span> : null}
          </p>
          {app.state.status === "external" && <p className="mt-0.5 text-xs text-muted-foreground">Responde, pero no la levantó el dashboard: no la toca.</p>}
          {app.state.status === "unresponsive" && <p className="mt-0.5 text-xs text-status-attention">El proceso sigue vivo pero {healthText(app.health)} no contesta.</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isOurs(app) ? (
            <>
              <Button size="sm" variant="outline" onClick={run("stop")} disabled={busy !== null}>
                {busy === "stop" ? <Spinner /> : <Square />}
                Bajar
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={run("restart")} disabled={busy !== null} aria-label="Reiniciar" title="Reiniciar">
                {busy === "restart" ? <Spinner /> : <RotateCw />}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={run("start")} disabled={busy !== null || app.state.status === "external"}>
              {busy === "start" ? <Spinner /> : <Play />}
              Levantar
            </Button>
          )}
          {app.url && (isUp(app) || app.state.status === "unresponsive") && (
            <Button size="icon-sm" variant="ghost" asChild aria-label="Abrir en el navegador" title={`Abrir ${app.url}`}>
              <a href={app.url} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" onClick={onLog} aria-label="Ver el log" title="Ver el log">
            <ScrollText />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label="Editar" title="Editar">
            <Pencil />
          </Button>
        </div>
      </div>
      {crashed && app.state.tail.length > 0 && (
        <pre className="mt-2 max-h-28 overflow-auto rounded-md bg-status-error/5 p-2 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap wrap-anywhere text-foreground/80">
          {app.state.tail.slice(-6).join("\n")}
        </pre>
      )}
    </li>
  )
}

/** El log de una app: las últimas líneas, que se refrescan mientras está abierto. */
function LogDialog({ app, onClose }: { app: AppView | null; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null)
  const box = useRef<HTMLPreElement>(null)
  const id = app?.id
  useEffect(() => {
    if (!id) return
    setLines(null)
    let alive = true
    const load = () => api.appLog(id).then((r) => alive && setLines(r.lines), fail)
    void load()
    const t = setInterval(load, 2_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [id])
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [lines])
  return (
    <Dialog open={!!app} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Log de {app?.name}</DialogTitle>
          <DialogDescription>Las últimas líneas de lo que escribió la app. Se actualiza solo.</DialogDescription>
        </DialogHeader>
        <pre ref={box} className="h-[60svh] overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {lines === null ? "Cargando…" : lines.length ? lines.join("\n") : "Todavía no escribió nada."}
        </pre>
      </DialogContent>
    </Dialog>
  )
}

type HealthKind = "none" | "http" | "tcp"
interface FormState {
  name: string
  command: string
  shell: boolean
  cwd: string
  healthKind: HealthKind
  healthUrl: string
  healthPort: string
  url: string
  stopCommand: string
  env: string
}

const toForm = (a: AppInput | null): FormState => ({
  name: a?.name ?? "",
  command: a?.command ?? "",
  shell: !!a?.shell,
  cwd: a?.cwd ?? "",
  healthKind: a?.health ? a.health.kind : "none",
  healthUrl: a?.health?.kind === "http" ? a.health.url : "",
  healthPort: a?.health?.kind === "tcp" ? String(a.health.port) : "",
  url: a?.url ?? "",
  stopCommand: a?.stopCommand ?? "",
  env: Object.entries(a?.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n"),
})

function fromForm(f: FormState): AppInput {
  const env: Record<string, string> = {}
  for (const line of f.env.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq <= 0) throw new Error(`Variable sin "=": ${t}`)
    env[t.slice(0, eq).trim()] = t.slice(eq + 1)
  }
  const health: AppHealth | null =
    f.healthKind === "http" ? { kind: "http", url: f.healthUrl.trim() } : f.healthKind === "tcp" ? { kind: "tcp", port: Number(f.healthPort) } : null
  return { name: f.name, command: f.command, shell: f.shell, cwd: f.cwd.trim(), health, url: f.url.trim() || null, stopCommand: f.stopCommand.trim() || null, env }
}

/** Agregar o editar una app (también para confirmar una sugerencia del repo). */
function AppDialog({
  projectId,
  editing,
  initial,
  open,
  onClose,
}: {
  projectId: string
  editing: AppView | null
  initial: AppInput | null
  open: boolean
  onClose: () => void
}) {
  const [f, setF] = useState<FormState>(() => toForm(initial))
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setF(toForm(editing ? { ...editing, url: editing.definedUrl } : initial))
  }, [open, editing, initial])
  const set = <K extends keyof FormState>(k: K) => (v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))
  const save = async () => {
    setSaving(true)
    try {
      const input = fromForm(f)
      if (editing) await api.updateApp(editing.id, input)
      else await api.createApp(projectId, input)
      toast.success(editing ? `Guardé ${input.name}` : `Agregué ${input.name}`)
      onClose()
    } catch (err) {
      fail(err)
    } finally {
      setSaving(false)
    }
  }
  const remove = async () => {
    if (!editing) return
    try {
      await api.removeApp(editing.id)
      toast.success(`Quité ${editing.name}`)
      onClose()
    } catch (err) {
      fail(err)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Editar ${editing.name}` : "Agregar una app"}</DialogTitle>
          <DialogDescription>Algo del proyecto que se levanta localmente: un backend, un frontend, un worker.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-[1fr_1.4fr] gap-3">
              <Field>
                <FieldLabel htmlFor="app-name">Nombre</FieldLabel>
                <Input id="app-name" value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder="backend" autoFocus />
              </Field>
              <Field>
                <FieldLabel htmlFor="app-cwd">Carpeta</FieldLabel>
                <Input id="app-cwd" value={f.cwd} onChange={(e) => set("cwd")(e.target.value)} placeholder="la raíz del proyecto" className="font-mono text-sm" spellCheck={false} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="app-command">Comando</FieldLabel>
              <Input id="app-command" value={f.command} onChange={(e) => set("command")(e.target.value)} placeholder="npm run dev" className="font-mono text-sm" spellCheck={false} />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={f.shell} onCheckedChange={(v) => set("shell")(v === true)} />
                Correrlo en una shell (para &&, pipes o redirecciones)
              </label>
            </Field>
            <Field>
              <FieldLabel>Cómo saber que está levantada</FieldLabel>
              <div className="flex gap-2">
                <Select value={f.healthKind} onValueChange={(v) => set("healthKind")(v as HealthKind)}>
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">Una URL</SelectItem>
                    <SelectItem value="tcp">Un puerto</SelectItem>
                    <SelectItem value="none">Sin verificar</SelectItem>
                  </SelectContent>
                </Select>
                {f.healthKind === "http" && (
                  <Input value={f.healthUrl} onChange={(e) => set("healthUrl")(e.target.value)} placeholder="http://127.0.0.1:3000/health" className="font-mono text-sm" />
                )}
                {f.healthKind === "tcp" && (
                  <Input value={f.healthPort} onChange={(e) => set("healthPort")(e.target.value)} placeholder="5173" inputMode="numeric" className="w-28 font-mono text-sm" />
                )}
              </div>
              {f.healthKind === "none" && <FieldDescription>Cuenta como levantada mientras el proceso siga vivo.</FieldDescription>}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="app-url">URL para abrir (opcional)</FieldLabel>
                <Input id="app-url" value={f.url} onChange={(e) => set("url")(e.target.value)} placeholder="la de salud" className="font-mono text-sm" />
              </Field>
              <Field>
                <FieldLabel htmlFor="app-stop">Comando para bajar (opcional)</FieldLabel>
                <Input id="app-stop" value={f.stopCommand} onChange={(e) => set("stopCommand")(e.target.value)} placeholder="docker compose down" className="font-mono text-sm" />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="app-env">Variables de entorno (opcional)</FieldLabel>
              <Textarea id="app-env" value={f.env} onChange={(e) => set("env")(e.target.value)} placeholder={"PORT=3000\nNODE_ENV=development"} rows={3} className="font-mono text-xs" />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-5">
            {editing && (
              <Button type="button" variant="ghost" className="mr-auto text-status-error" onClick={() => void remove()}>
                <Trash2 />
                Quitar
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving || !f.name.trim() || !f.command.trim()}>
              {saving && <Spinner />}
              {editing ? "Guardar" : "Agregar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Lo que parece haber en el repo para levantar: solo se agrega si el usuario lo confirma. */
function Suggestions({ projectId, onPick }: { projectId: string; onPick: (s: AppSuggestion) => void }) {
  const [list, setList] = useState<AppSuggestion[] | null>(null)
  useEffect(() => {
    let alive = true
    api.appSuggestions(projectId).then((l) => alive && setList(l), () => alive && setList([]))
    return () => {
      alive = false
    }
  }, [projectId])
  if (!list?.length) return null
  return (
    <div className="mt-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" />
        Encontré esto en el repo. Revisalo antes de agregarlo:
      </p>
      <ul className="space-y-1">
        {list.map((s) => (
          <li key={`${s.source}-${s.command}`} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{s.name}</span> <span className="font-mono text-[0.72rem] text-muted-foreground">{s.command}</span>
              <span className="block text-[0.7rem] text-muted-foreground">de {s.source}</span>
            </span>
            <Button size="xs" variant="outline" onClick={() => onPick(s)}>
              <Plus />
              Revisar y agregar
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** "Apps" en el resumen del proyecto: lo que se levanta localmente, su estado y los botones. */
export function ProjectApps({ project }: { project: Project }) {
  useWatchApps(project.id)
  const apps = useStore((s) => s.apps[project.id]) ?? []
  const open = useSectionOpen("project-apps")
  const toggle = usePanelSections((s) => s.toggle)
  const [dialog, setDialog] = useState<{ editing: AppView | null; initial: AppInput | null } | null>(null)
  const [logOf, setLogOf] = useState<string | null>(null)
  const [busyAll, setBusyAll] = useState<"start" | "stop" | null>(null)
  const up = apps.filter(isUp).length
  const crashed = apps.filter((a) => a.state.status === "crashed").length
  const summaryTone: Tone = !apps.length ? "idle" : crashed ? "error" : up === apps.length ? "done" : up ? "attention" : "idle"
  const logApp = useMemo(() => apps.find((a) => a.id === logOf) ?? null, [apps, logOf])
  const all = (what: "start" | "stop") => async () => {
    setBusyAll(what)
    try {
      if (what === "start") {
        const r = await api.startAllApps(project.id)
        for (const f of r.failed) toast.error(`No pude levantar ${f.name}`, { description: f.error })
      } else await api.stopAllApps(project.id)
    } catch (err) {
      fail(err)
    } finally {
      setBusyAll(null)
    }
  }

  return (
    <Collapsible open={open} onOpenChange={(v) => toggle("project-apps", v)} className="border-b">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <Boxes className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
          <span className="font-medium">Apps</span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            {" · "}
            {apps.length ? (
              <>
                <Lamp tone={summaryTone} className="size-1.5" />
                {apps.length === 1 ? (up ? "levantada" : STATUS[apps[0]!.state.status].label) : `${up} de ${apps.length} levantadas`}
                {crashed > 0 && apps.length > 1 && <span className="font-medium text-status-error">· {crashed === 1 ? "1 se cayó" : `${crashed} se cayeron`}</span>}
              </>
            ) : (
              "ninguna registrada"
            )}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4 pl-10">
        {apps.length > 1 && (
          <div className="mb-2 flex items-center gap-1.5">
            <Button size="xs" variant="outline" onClick={all("start")} disabled={busyAll !== null || up === apps.length}>
              {busyAll === "start" ? <Spinner /> : <Play />}
              Levantar todas
            </Button>
            <Button size="xs" variant="outline" onClick={all("stop")} disabled={busyAll !== null || !apps.some(isOurs)}>
              {busyAll === "stop" ? <Spinner /> : <Square />}
              Bajar todas
            </Button>
          </div>
        )}
        {apps.length > 0 ? (
          <ul className="grid gap-2 lg:grid-cols-2">
            {apps.map((a) => (
              <AppRow key={a.id} app={a} onEdit={() => setDialog({ editing: a, initial: null })} onLog={() => setLogOf(a.id)} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Lo que se levanta localmente (un backend, un frontend, un worker). Las sesiones las registran solas cuando arman una; también podés agregarlas vos.
          </p>
        )}
        <Button size="xs" variant="ghost" className="mt-2 text-muted-foreground" onClick={() => setDialog({ editing: null, initial: null })}>
          <Plus />
          Agregar una app
        </Button>
        {apps.length === 0 && open && <Suggestions projectId={project.id} onPick={(s) => setDialog({ editing: null, initial: s })} />}
      </CollapsibleContent>
      <AppDialog projectId={project.id} open={!!dialog} editing={dialog?.editing ?? null} initial={dialog?.initial ?? null} onClose={() => setDialog(null)} />
      <LogDialog app={logApp} onClose={() => setLogOf(null)} />
    </Collapsible>
  )
}
