import { Boxes, ExternalLink, Pencil, Play, Plus, RotateCw, ScrollText, Sparkles, Square, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { AppHealth, AppInput, AppStatus, AppSuggestion, AppView, Project } from "@shared/types"

import { SectionHeader } from "@/components/project-overview"
import { Lamp } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmAction } from "@/components/ui/confirm-action"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { LoadError } from "@/components/ui/load-error"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { toneSoft, toneText, type Tone } from "@/lib/status"
import { useStore } from "@/lib/store"
import { useAction } from "@/lib/use-action"
import { cn } from "@/lib/utils"

export const APP_STATUS: Record<AppStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  stopped: { label: "detenida", tone: "idle" },
  starting: { label: "arrancando", tone: "working", pulse: true },
  up: { label: "levantada", tone: "done" },
  unresponsive: { label: "sin responder", tone: "error" },
  crashed: { label: "se cayó", tone: "error" },
  external: { label: "levantada afuera", tone: "done" },
}

const isUp = (a: AppView) => a.state.status === "up" || a.state.status === "external"
const isOurs = (a: AppView) => a.state.status === "starting" || a.state.status === "up" || a.state.status === "unresponsive"
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
/** Un error en la voz del glosario: "No se pudo …" y el motivo en la descripción. */
const fail = (what: string) => (err: unknown) => toast.error(`No se pudo ${what}`, { description: errText(err) })

/** Levantar, bajar o reiniciar una app: lo usan su fila y la paleta de comandos. */
export function appAction(id: string, what: "start" | "stop" | "restart", name?: string) {
  const verb = { start: "levantar", stop: "bajar", restart: "reiniciar" }[what]
  return (what === "start" ? api.startApp(id) : what === "stop" ? api.stopApp(id) : api.restartApp(id)).then(() => {}, fail(`${verb} ${name ?? "la app"}`))
}
export { isOurs as appIsRunning }

/**
 * Las apps del proyecto: se piden una vez al entrar y, solo con la sección abierta, cada 20 s con
 * `watch` (así el server mira la salud de las que no corren solo mientras alguien las mira). Plegada,
 * el resumen se mantiene con los avisos del server. Si no se pudieron pedir, lo dice (`error`), salvo
 * que ya haya datos del server.
 */
function useWatchApps(projectId: string, open: boolean) {
  const [error, setError] = useState<unknown>(null)
  const alive = useRef(true)
  const load = useCallback(
    () =>
      api.apps(projectId, open).then(
        (apps) => {
          if (!alive.current) return
          useStore.setState((s) => ({ apps: { ...s.apps, [projectId]: apps } }))
          setError(null)
        },
        (err: unknown) => alive.current && setError(err)
      ),
    [projectId, open]
  )
  useEffect(() => {
    alive.current = true
    void load()
    const t = open ? setInterval(load, 20_000) : null
    return () => {
      alive.current = false
      if (t) clearInterval(t)
    }
  }, [load, open])
  return { error, retry: load }
}

function healthText(h: AppHealth | null) {
  if (!h) return "sin salud: cuenta como levantada si el proceso vive"
  return h.kind === "http" ? h.url : `puerto ${h.port}${h.host ? ` en ${h.host}` : ""}`
}

function AppRow({ app, onEdit, onLog }: { app: AppView; onEdit: () => void; onLog: () => void }) {
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | null>(null)
  const st = APP_STATUS[app.state.status]
  const run = (what: "start" | "stop" | "restart") => async () => {
    setBusy(what)
    try {
      await appAction(app.id, what, app.name)
    } finally {
      setBusy(null)
    }
  }
  const crashed = app.state.status === "crashed"
  const exit = app.state.error ?? (app.state.exitCode !== null ? `código ${app.state.exitCode}` : app.state.signal ? `por ${app.state.signal}` : null)
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="name">{app.name}</span>
            <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", st.tone === "idle" ? "text-muted-foreground" : toneText[st.tone])}>
              <Lamp tone={st.tone} pulse={st.pulse} className={cn("size-1.5", app.state.status === "external" && "ring-2 ring-status-done-lamp/30")} />
              {st.label}
              {crashed && exit ? ` (${exit})` : ""}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={app.cwd ? `${app.command} · en ${app.cwd}` : app.command}>
            {app.command}
            {app.cwd ? <span> · en {app.cwd}</span> : null}
          </p>
          {app.state.status === "external" && <p className="mt-0.5 text-xs text-muted-foreground">Responde, pero no la levantó el dashboard: no la toca.</p>}
          {app.state.status === "unresponsive" && <p className="mt-0.5 text-xs text-status-error">El proceso sigue vivo pero {healthText(app.health)} no contesta.</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isOurs(app) ? (
            <>
              <Button size="sm" variant="outline" onClick={run("stop")} disabled={busy !== null}>
                {busy === "stop" ? <Spinner /> : <Square />}
                Bajar
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={run("restart")} disabled={busy !== null} aria-label={`Reiniciar ${app.name}`} title="Reiniciar">
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
            <Button size="icon-sm" variant="ghost" asChild aria-label={`Abrir ${app.name} en el navegador`} title={`Abrir ${app.url}`}>
              <a href={app.url} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" onClick={onLog} aria-label={`Ver el log de ${app.name}`} title="Ver el log">
            <ScrollText />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label={`Editar ${app.name}`} title="Editar">
            <Pencil />
          </Button>
        </div>
      </div>
      {crashed && app.state.tail.length > 0 && (
        <pre className={cn("mt-2 max-h-28 overflow-auto rounded-xl p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap wrap-anywhere", toneSoft.error)}>
          {app.state.tail.slice(-6).join("\n")}
        </pre>
      )}
    </li>
  )
}

/** El log de una app: las últimas líneas, que se refrescan mientras está abierto. */
function LogDialog({ app, onClose }: { app: AppView | null; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null)
  // Si no se puede leer, se dice adentro del log (se reintenta solo), sin un aviso por cada intento.
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLPreElement>(null)
  const id = app?.id
  useEffect(() => {
    if (!id) return
    setLines(null)
    setError(null)
    let alive = true
    const load = () =>
      api.appLog(id).then(
        (r) => {
          if (!alive) return
          setLines(r.lines)
          setError(null)
        },
        (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err))
      )
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
        <pre ref={box} className="h-[60svh] overflow-auto rounded-xl bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {lines === null ? (error ? "" : "Cargando…") : lines.length ? lines.join("\n") : "Todavía no escribió nada."}
          {error && <span className="block text-status-error">{`${lines?.length ? "\n" : ""}No se pudo leer el log: ${error}. Se reintenta solo…`}</span>}
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
      toast.success(editing ? "App guardada" : "App agregada", { description: input.name })
      onClose()
    } catch (err) {
      fail(editing ? "guardar la app" : "agregar la app")(err)
    } finally {
      setSaving(false)
    }
  }
  const remove = async () => {
    if (!editing) return
    await api.removeApp(editing.id)
    toast.success("App quitada", { description: editing.name })
    onClose()
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
            <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
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
              <div className="flex flex-wrap gap-2">
                <Select value={f.healthKind} onValueChange={(v) => set("healthKind")(v as HealthKind)}>
                  <SelectTrigger className="w-36" aria-label="Cómo saber que está levantada">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">Una URL</SelectItem>
                    <SelectItem value="tcp">Un puerto</SelectItem>
                    <SelectItem value="none">Sin verificar</SelectItem>
                  </SelectContent>
                </Select>
                {f.healthKind === "http" && (
                  <Input value={f.healthUrl} onChange={(e) => set("healthUrl")(e.target.value)} placeholder="http://127.0.0.1:3000/health" aria-label="URL de salud" className="min-w-48 flex-1 font-mono text-sm" />
                )}
                {f.healthKind === "tcp" && (
                  <Input value={f.healthPort} onChange={(e) => set("healthPort")(e.target.value)} placeholder="5173" inputMode="numeric" aria-label="Puerto" className="w-28 font-mono text-sm" />
                )}
              </div>
              {f.healthKind === "none" && <FieldDescription>Cuenta como levantada mientras el proceso siga vivo.</FieldDescription>}
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
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
              <ConfirmAction
                title={`¿Quitar ${editing.name}?`}
                description="Sale de Apps y, si la levantó el dashboard, se baja. El repo no se toca: la podés volver a agregar."
                confirmLabel="Quitar app"
                onConfirm={remove}
              >
                <Button type="button" variant="ghost" className="mr-auto text-status-error">
                  <Trash2 />
                  Quitar…
                </Button>
              </ConfirmAction>
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
        Esto parece levantable en el repo. Revisalo antes de agregarlo:
      </p>
      <ul className="space-y-1">
        {list.map((s) => (
          <li key={`${s.source}-${s.command}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/50">
            <span className="min-w-0 flex-1">
              <span className="name">{s.name}</span> <span className="font-mono text-xs text-muted-foreground">{s.command}</span>
              <span className="block text-2xs text-muted-foreground">de <span className="font-mono">{s.source}</span></span>
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

/** Cómo están las apps, en una línea: para el encabezado de Apps y la pestaña del proyecto. */
export function appsSummary(apps: AppView[]): { tone: Tone; text: string; crashed: number } | null {
  if (!apps.length) return null
  const up = apps.filter(isUp).length
  const crashed = apps.filter((a) => a.state.status === "crashed").length
  const tone: Tone = crashed ? "error" : up === apps.length ? "done" : "idle"
  const text = apps.length === 1 ? APP_STATUS[apps[0]!.state.status].label : `${up} de ${apps.length} levantadas`
  return { tone, text, crashed }
}

/**
 * "Apps" del proyecto: lo que se levanta localmente, su estado y los botones. Vive en su pestaña:
 * mientras está a la vista se piden con `watch` cada 20 s (el server mira la salud de las que no
 * corren solo mientras alguien las mira).
 */
export function ProjectApps({ project }: { project: Project }) {
  const { error, retry } = useWatchApps(project.id, true)
  const apps = useStore((s) => s.apps[project.id]) ?? NO_APPS
  const [dialog, setDialog] = useState<{ editing: AppView | null; initial: AppInput | null } | null>(null)
  const [logOf, setLogOf] = useState<string | null>(null)
  const action = useAction()
  const up = apps.filter(isUp).length
  const sum = appsSummary(apps)
  const logApp = useMemo(() => apps.find((a) => a.id === logOf) ?? null, [apps, logOf])
  // Sin datos y con error: no es "ninguna todavía", es que no se pudo saber.
  const failed = Boolean(error) && !apps.length
  const all = (what: "start" | "stop") => () =>
    action.run(what, async () => {
      try {
        if (what === "start") {
          const r = await api.startAllApps(project.id)
          for (const f of r.failed) toast.error(`No se pudo levantar ${f.name}`, { description: f.error })
        } else await api.stopAllApps(project.id)
      } catch (err) {
        fail(what === "start" ? "levantar las apps" : "bajar las apps")(err)
      }
    })

  return (
    <section className="surface-card overflow-hidden">
      <SectionHeader
        icon={<Boxes />}
        title="Apps"
        summary={
          failed ? (
            <span className="font-medium text-status-error">no se pudieron cargar</span>
          ) : sum ? (
            <span className="inline-flex items-center gap-1.5">
              <Lamp tone={sum.tone} className="size-1.5" />
              {sum.text}
              {sum.crashed > 0 && apps.length > 1 && <span className="font-medium text-status-error">· {sum.crashed === 1 ? "1 se cayó" : `${sum.crashed} se cayeron`}</span>}
            </span>
          ) : (
            "lo que se levanta localmente: backend, frontend, workers"
          )
        }
        actions={
          <>
            {apps.length > 1 && (
              <>
                <Button size="xs" variant="ghost" onClick={all("start")} disabled={action.busy() || up === apps.length}>
                  {action.busy("start") ? <Spinner /> : <Play />}
                  Levantar todas
                </Button>
                <Button size="xs" variant="ghost" onClick={all("stop")} disabled={action.busy() || !apps.some(isOurs)}>
                  {action.busy("stop") ? <Spinner /> : <Square />}
                  Bajar todas
                </Button>
              </>
            )}
            <Button size="xs" variant="ghost" onClick={() => setDialog({ editing: null, initial: null })}>
              <Plus />
              Agregar app
            </Button>
          </>
        }
      />
      <div className="px-4 pb-3">
        {failed ? (
          <LoadError what="las apps" error={error} onRetry={retry} className="mt-3" />
        ) : apps.length > 0 ? (
          <ul className="divide-y">
            {apps.map((a) => (
              <AppRow key={a.id} app={a} onEdit={() => setDialog({ editing: a, initial: null })} onLog={() => setLogOf(a.id)} />
            ))}
          </ul>
        ) : (
          <>
            <p className="pt-3 text-sm text-muted-foreground">
              Lo que se levanta localmente (un backend, un frontend, un worker). Las sesiones las registran solas cuando arman una; también podés agregarlas vos.
            </p>
            <Suggestions projectId={project.id} onPick={(s) => setDialog({ editing: null, initial: s })} />
          </>
        )}
      </div>
      <AppDialog projectId={project.id} open={!!dialog} editing={dialog?.editing ?? null} initial={dialog?.initial ?? null} onClose={() => setDialog(null)} />
      <LogDialog app={logApp} onClose={() => setLogOf(null)} />
    </section>
  )
}
const NO_APPS: AppView[] = []
