import { Copy, Eye, EyeOff, KeyRound, Pencil, Play, Plus, Server, SquareArrowOutUpRight, Trash2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { AppView, Credential, Environment, Project } from "@shared/types"

import { APP_STATUS } from "@/components/project-apps"
import { SectionHeader } from "@/components/project-overview"
import { TonePill } from "@/components/status"

import { Button } from "@/components/ui/button"
import { ConfirmAction } from "@/components/ui/confirm-action"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { reveal } from "@/lib/reveal"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { useAction } from "@/lib/use-action"
import { cn } from "@/lib/utils"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
/** Un error en la voz del glosario: "No se pudo …" y el motivo en la descripción. */
const fail = (what: string) => (err: unknown) => toast.error(`No se pudo ${what}`, { description: errText(err) })
/** Cuánto queda a la vista un secreto que mostraste. */
const SHOWN_MS = 30_000

/** Los entornos del proyecto, ordenados como se crearon. */
export function useProjectEnvironments(projectId: string): Environment[] {
  const all = useStore((s) => s.environments)
  return useMemo(() => Object.values(all).filter((e) => e.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt), [all, projectId])
}

/** "por ALFA hace 3 h" (con link a la sesión) o "cargado por vos". */
function Author({ projectId, by, at }: { projectId: string; by: string | null; at: number }) {
  const session = useStore((s) => (by ? s.sessions[by] : undefined))
  return (
    <span className="text-2xs text-muted-foreground" title={new Date(at).toLocaleString("es-AR")}>
      {by ? (
        <>
          por{" "}
          {session ? (
            <Link href={`/p/${projectId}/s/${session.id}`} className="name hover:text-foreground hover:underline">
              {session.name}
            </Link>
          ) : (
            "una sesión que ya no está"
          )}
        </>
      ) : (
        "cargado por vos"
      )}{" "}
      · {timeAgo(at)}
    </span>
  )
}

function IconButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className="shrink-0 rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Borrar con `ConfirmAction`: se pierde, así que se pregunta. */
function DeleteButton({ label, title, description, onConfirm }: { label: string; title: string; description: string; onConfirm: () => Promise<unknown> }) {
  return (
    <ConfirmAction title={title} description={description} confirmLabel={label} onConfirm={onConfirm}>
      <button
        type="button"
        aria-label={`${label}…`}
        title={`${label}…`}
        className="shrink-0 rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Trash2 className="size-3.5" />
      </button>
    </ConfirmAction>
  )
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(done)
  } catch {
    toast.error("No se pudo copiar al portapapeles")
  }
}

function CredentialRow({ credential: c, projectId }: { credential: Credential; projectId: string }) {
  const [secret, setSecret] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  // Si cambia (la sesión lo actualizó), lo que se mostraba ya no vale.
  useEffect(() => setSecret(null), [c.updatedAt])

  const fetchSecret = async () => {
    setLoading(true)
    try {
      return (await api.credentialSecret(c.id)).secret
    } finally {
      setLoading(false)
    }
  }
  const toggle = async () => {
    if (secret !== null) return setSecret(null)
    try {
      const s = await fetchSecret()
      setSecret(s ?? "")
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setSecret(null), SHOWN_MS)
    } catch (err) {
      fail("mostrar el secreto")(err)
    }
  }
  const copySecret = async () => {
    try {
      const s = secret ?? (await fetchSecret())
      if (s) await copy(s, "Secreto copiado")
    } catch (err) {
      fail("copiar el secreto")(err)
    }
  }

  if (editing) return <CredentialForm environmentId={c.environmentId} credential={c} onDone={() => setEditing(false)} />
  return (
    <li className="grid gap-x-3 gap-y-0.5 py-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,13rem)_6.5rem] sm:items-center">
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate" title={c.name}>
          {c.name}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-mono text-xs" title={c.username ?? undefined}>
          {c.username ?? <span className="text-muted-foreground">sin usuario</span>}
        </span>
        {c.username && (
          <IconButton label="Copiar usuario" onClick={() => void copy(c.username!, "Usuario copiado")}>
            <Copy className="size-3.5" />
          </IconButton>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1">
        {c.hasSecret ? (
          <>
            <span className="min-w-0 truncate font-mono text-xs" aria-label={secret === null ? "Secreto oculto" : "Secreto"} title={secret ?? undefined}>
              {secret === null ? "••••••••" : secret}
            </span>
            <IconButton label={secret === null ? "Mostrar secreto" : "Ocultar secreto"} onClick={() => void toggle()} disabled={loading}>
              {loading ? <Spinner className="size-3.5" /> : secret === null ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            </IconButton>
            <IconButton label="Copiar secreto" onClick={() => void copySecret()} disabled={loading}>
              <Copy className="size-3.5" />
            </IconButton>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">sin secreto</span>
        )}
      </span>
      <span className="flex items-center gap-0.5 justify-self-end">
        {c.loginUrl && (
          <a href={c.loginUrl} target="_blank" rel="noreferrer" className="mr-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
            login
          </a>
        )}
        <IconButton label="Editar credencial" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
        </IconButton>
        <DeleteButton
          label="Borrar credencial"
          title={`¿Borrar ${c.name}?`}
          description="Se borran el usuario y el secreto guardados. Si una sesión la necesita, la va a tener que volver a dejar."
          onConfirm={async () => {
            await api.deleteCredential(c.id)
            toast.success("Credencial borrada", { description: c.name })
          }}
        />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 sm:col-span-4">
        {c.notes && <span className="min-w-0 text-xs text-muted-foreground">{c.notes}</span>}
        <Author projectId={projectId} by={c.createdBy} at={c.updatedAt} />
      </span>
    </li>
  )
}

/** Las apps levantables del proyecto (las de TRAY, en el store). */
function useProjectApps(projectId: string): AppView[] {
  return useStore((s) => s.apps[projectId]) ?? NO_APPS
}
const NO_APPS: AppView[] = []
/** El valor de "ninguna app" en el selector (Radix no acepta un valor vacío). */
const NO_APP = "__none"

/** El estado de la app conectada y, si está bajada, "Levantar" ahí mismo. */
function AppState({ app }: { app: AppView }) {
  const action = useAction()
  const starting = action.busy("start")
  const st = APP_STATUS[app.state.status]
  const down = app.state.status === "stopped" || app.state.status === "crashed"
  const start = () => action.run("start", () => api.startApp(app.id).catch(fail(`levantar ${app.name}`)))
  return (
    <span className="flex items-center gap-1.5">
      <TonePill tone={st.tone} className={st.pulse ? "animate-pulse" : undefined}>
        <span className="name">{app.name}</span> · {st.label}
      </TonePill>
      {down && (
        <Button size="xs" variant="outline" onClick={() => void start()} disabled={starting}>
          {starting ? <Spinner /> : <Play />}
          Levantar
        </Button>
      )}
    </span>
  )
}

function EnvironmentBlock({ env }: { env: Environment }) {
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  // Conectado a una app: su URL manda. Si la app ya no está, queda la URL propia del entorno.
  const app = useProjectApps(env.projectId).find((a) => a.id === env.appId)
  const url = app?.url ?? env.url
  if (editing) return <EnvironmentForm projectId={env.projectId} environment={env} onDone={() => setEditing(false)} />
  return (
    <div className="min-w-0 space-y-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{env.name}</span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" title={url} className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">
            <span className="truncate">{url}</span>
            <SquareArrowOutUpRight className="size-3 shrink-0" />
          </a>
        )}
        {app && <AppState app={app} />}
        <Author projectId={env.projectId} by={env.createdBy} at={env.createdAt} />
        <span className="ml-auto flex items-center gap-0.5">
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
            <Plus />
            Agregar credencial
          </Button>
          <IconButton label="Editar entorno" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </IconButton>
          <DeleteButton
            label="Borrar entorno"
            title={`¿Borrar el entorno ${env.name}?`}
            description={
              env.credentials.length
                ? `Se borra con ${plural(env.credentials.length, "su credencial", "sus credenciales")}. La app conectada no se toca.`
                : "La app conectada no se toca."
            }
            onConfirm={async () => {
              await api.deleteEnvironment(env.id)
              toast.success("Entorno borrado", { description: env.name })
            }}
          />
        </span>
      </div>
      {env.notes && <p className="pl-6 text-xs text-muted-foreground">{env.notes}</p>}
      {adding && <CredentialForm environmentId={env.id} onDone={() => setAdding(false)} />}
      {env.credentials.length > 0 ? (
        <ul className="divide-y pl-6">
          {env.credentials.map((c) => (
            <CredentialRow key={c.id} credential={c} projectId={env.projectId} />
          ))}
        </ul>
      ) : (
        !adding && <p className="pl-6 text-xs text-muted-foreground">Sin credenciales todavía.</p>
      )}
    </div>
  )
}

function EnvironmentForm({ projectId, environment, onDone }: { projectId: string; environment?: Environment; onDone: () => void }) {
  const [name, setName] = useState(environment?.name ?? "")
  const [url, setUrl] = useState(environment?.url ?? "")
  const apps = useProjectApps(projectId)
  const [app, setApp] = useState(environment?.appId && apps.some((a) => a.id === environment.appId) ? environment.appId : "")
  const [notes, setNotes] = useState(environment?.notes ?? "")
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const fields = { name, url: url.trim() || null, notes: notes.trim() || null, app: app || null }
      if (environment) await api.updateEnvironment(environment.id, fields)
      else await api.createEnvironment(projectId, fields)
      toast.success(environment ? "Entorno guardado" : "Entorno creado", { description: fields.name })
      onDone()
    } catch (err) {
      fail(environment ? "guardar el entorno" : "crear el entorno")(err)
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      className="space-y-2 rounded-xl bg-muted/50 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        <Input aria-label="Nombre del entorno" value={name} onChange={(e) => setName(e.target.value)} placeholder="Local, Staging…" autoFocus />
        <Input
          aria-label="URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={app ? "URL propia (si la app no está)" : "http://localhost:3000"}
          className="font-mono text-xs"
        />
      </div>
      {apps.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          La URL la da la app
          <Select value={app || NO_APP} onValueChange={(v) => setApp(v === NO_APP ? "" : v)}>
            <SelectTrigger size="sm" className="min-w-0" aria-label="App conectada">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_APP}>Ninguna: la URL de arriba</SelectItem>
              {apps.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.url ? ` · ${a.url}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <Textarea aria-label="Notas" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notas (cómo se levanta, qué datos tiene)" className="min-h-14 text-sm" />
      <FormButtons saving={saving} disabled={!name.trim()} onCancel={onDone} label={environment ? "Guardar" : "Crear entorno"} />
    </form>
  )
}

function CredentialForm({ environmentId, credential, onDone }: { environmentId: string; credential?: Credential; onDone: () => void }) {
  const [name, setName] = useState(credential?.name ?? "")
  const [username, setUsername] = useState(credential?.username ?? "")
  // Al editar, el secreto arranca vacío: solo se cambia si escribís uno.
  const [secret, setSecret] = useState("")
  const [loginUrl, setLoginUrl] = useState(credential?.loginUrl ?? "")
  const [notes, setNotes] = useState(credential?.notes ?? "")
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const fields = { name, username: username.trim() || null, loginUrl: loginUrl.trim() || null, notes: notes.trim() || null, ...(secret || !credential ? { secret: secret || null } : {}) }
      if (credential) await api.updateCredential(credential.id, fields)
      else await api.createCredential(environmentId, fields)
      toast.success(credential ? "Credencial guardada" : "Credencial agregada", { description: fields.name })
      onDone()
    } catch (err) {
      fail(credential ? "guardar la credencial" : "agregar la credencial")(err)
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      className="space-y-2 rounded-xl bg-muted/50 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <Input aria-label="Nombre de la credencial" value={name} onChange={(e) => setName(e.target.value)} placeholder="Inquilino, Usuario admin…" autoFocus />
        <Input aria-label="Usuario" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Usuario o email" autoComplete="off" className="font-mono text-xs" />
        <Input
          aria-label="Secreto"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={credential?.hasSecret ? "Secreto (vacío: queda el que está)" : "Contraseña o token"}
          autoComplete="new-password"
          className="font-mono text-xs"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
        <Input aria-label="URL de login" value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} placeholder="URL de login (opcional)" className="font-mono text-xs" />
        <Input aria-label="Notas" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notas (permisos, datos)" />
      </div>
      <FormButtons saving={saving} disabled={!name.trim()} onCancel={onDone} label={credential ? "Guardar" : "Agregar"} />
    </form>
  )
}

function FormButtons({ saving, disabled, onCancel, label }: { saving: boolean; disabled: boolean; onCancel: () => void; label: string }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancelar
      </Button>
      <Button type="submit" size="sm" disabled={saving || disabled}>
        {saving && <Spinner />}
        {label}
      </Button>
    </div>
  )
}

/** "Entornos" del proyecto (en su pestaña): los locales o de staging, con sus credenciales de prueba. */
export function ProjectEnvironments({ project }: { project: Project }) {
  const envs = useProjectEnvironments(project.id)
  const [adding, setAdding] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const pending = useUi((s) => s.reveal)
  const setUi = useUi((s) => s.set)
  const credentials = envs.reduce((n, e) => n + e.credentials.length, 0)

  // Llegaste desde un aviso ("ALFA dejó una credencial") o desde el panel de la sesión: el tablero ya
  // abrió esta pestaña, acá se marca.
  useEffect(() => {
    if (pending?.kind !== "environments" || pending.id !== project.id) return
    const raf = requestAnimationFrame(() => {
      if (ref.current) reveal(ref.current)
      setUi({ reveal: null })
    })
    return () => cancelAnimationFrame(raf)
  }, [pending, project.id, setUi])

  return (
    <section ref={ref} id="entornos" className="surface-card scroll-mt-4 overflow-hidden">
      <SectionHeader
        icon={<KeyRound />}
        title="Entornos"
        summary={
          envs.length
            ? plural(credentials, "credencial", "credenciales")
            : "URLs y usuarios de prueba, locales o de staging"
        }
        actions={
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)} disabled={adding}>
            <Plus />
            Agregar entorno
          </Button>
        }
      />
      <div className="px-4 py-3">
        {adding && <EnvironmentForm projectId={project.id} onDone={() => setAdding(false)} />}
        {envs.length > 0 && (
          <div className={cn("divide-y", adding && "mt-3")}>
            {envs.map((e) => (
              <EnvironmentBlock key={e.id} env={e} />
            ))}
          </div>
        )}
        {!envs.length && !adding && (
          <p className="text-sm text-muted-foreground">
            Las sesiones que levantan un entorno local o de staging lo dejan acá, con sus usuarios de prueba. También podés cargarlos vos.
          </p>
        )}
      </div>
    </section>
  )
}

/** En el panel de la sesión: "Dejó N credenciales", con link a Entornos. */
export function SessionCredentialsLine({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const envs = useProjectEnvironments(projectId)
  const setUi = useUi((s) => s.set)
  const n = envs.reduce((sum, e) => sum + e.credentials.filter((c) => c.createdBy === sessionId).length, 0)
  if (!n) return null
  return (
    <Link
      href={`/p/${projectId}?tab=entornos`}
      onClick={() => setUi({ reveal: { kind: "environments", id: projectId, at: Date.now() } })}
      className="flex items-center gap-2 border-b py-3 pr-4 pl-3 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
    >
      <KeyRound className="size-3.5" />
      Dejó {plural(n, "credencial", "credenciales")}
      <span className="ml-auto">Ver en Entornos →</span>
    </Link>
  )
}
