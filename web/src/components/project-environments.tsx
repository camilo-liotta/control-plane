import { ChevronRight, Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Server, SquareArrowOutUpRight, Trash2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { Credential, Environment, Project } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { usePanelSections, useSectionOpen } from "@/lib/panel-sections"
import { reveal } from "@/lib/reveal"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))
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
    <span className="text-[0.7rem] text-muted-foreground" title={new Date(at).toLocaleString("es-AR")}>
      {by ? (
        <>
          por{" "}
          {session ? (
            <Link href={`/p/${projectId}/s/${session.id}`} className="font-mono hover:text-foreground hover:underline">
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
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Borrar con confirmación en el mismo botón: el primer clic pregunta, el segundo borra. */
function DeleteButton({ label, onConfirm }: { label: string; onConfirm: () => Promise<unknown> }) {
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (!asking) return
    const t = setTimeout(() => setAsking(false), 4000)
    return () => clearTimeout(t)
  }, [asking])
  if (asking)
    return (
      <Button size="xs" variant="destructive" onClick={() => void onConfirm().catch(fail)}>
        ¿Borrar?
      </Button>
    )
  return (
    <IconButton label={label} onClick={() => setAsking(true)}>
      <Trash2 className="size-3.5" />
    </IconButton>
  )
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copié ${what}`)
  } catch {
    toast.error("No pude copiar al portapapeles")
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
      fail(err)
    }
  }
  const copySecret = async () => {
    try {
      const s = secret ?? (await fetchSecret())
      if (s) await copy(s, `el secreto de ${c.name}`)
    } catch (err) {
      fail(err)
    }
  }

  if (editing) return <CredentialForm environmentId={c.environmentId} credential={c} onDone={() => setEditing(false)} />
  return (
    <li className="group/cred grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,13rem)_6.5rem] sm:items-center">
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{c.name}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-mono text-xs" title={c.username ?? undefined}>
          {c.username ?? <span className="text-muted-foreground">sin usuario</span>}
        </span>
        {c.username && (
          <IconButton label="Copiar usuario" onClick={() => void copy(c.username!, `el usuario de ${c.name}`)}>
            <Copy className="size-3.5" />
          </IconButton>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1">
        {c.hasSecret ? (
          <>
            <span className="min-w-0 truncate font-mono text-xs" aria-label={secret === null ? "Secreto oculto" : "Secreto"}>
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
        <DeleteButton label="Borrar credencial" onConfirm={() => api.deleteCredential(c.id)} />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 sm:col-span-4">
        {c.notes && <span className="min-w-0 text-xs text-muted-foreground">{c.notes}</span>}
        <Author projectId={projectId} by={c.createdBy} at={c.updatedAt} />
      </span>
    </li>
  )
}

function EnvironmentBlock({ env }: { env: Environment }) {
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  if (editing) return <EnvironmentForm projectId={env.projectId} environment={env} onDone={() => setEditing(false)} />
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{env.name}</span>
        {env.url && (
          <a href={env.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">
            <span className="truncate">{env.url}</span>
            <SquareArrowOutUpRight className="size-3 shrink-0" />
          </a>
        )}
        <Author projectId={env.projectId} by={env.createdBy} at={env.createdAt} />
        <span className="ml-auto flex items-center gap-0.5">
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
            <Plus />
            Credencial
          </Button>
          <IconButton label="Editar entorno" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </IconButton>
          <DeleteButton label="Borrar entorno (con sus credenciales)" onConfirm={() => api.deleteEnvironment(env.id)} />
        </span>
      </div>
      {env.notes && <p className="text-xs text-muted-foreground">{env.notes}</p>}
      {adding && <CredentialForm environmentId={env.id} onDone={() => setAdding(false)} />}
      {env.credentials.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {env.credentials.map((c) => (
            <CredentialRow key={c.id} credential={c} projectId={env.projectId} />
          ))}
        </ul>
      ) : (
        !adding && <p className="text-xs text-muted-foreground">Sin credenciales.</p>
      )}
    </div>
  )
}

function EnvironmentForm({ projectId, environment, onDone }: { projectId: string; environment?: Environment; onDone: () => void }) {
  const [name, setName] = useState(environment?.name ?? "")
  const [url, setUrl] = useState(environment?.url ?? "")
  const [notes, setNotes] = useState(environment?.notes ?? "")
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const fields = { name, url: url.trim() || null, notes: notes.trim() || null }
      if (environment) await api.updateEnvironment(environment.id, fields)
      else await api.createEnvironment(projectId, fields)
      onDone()
    } catch (err) {
      fail(err)
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      className="space-y-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        <Input aria-label="Nombre del entorno" value={name} onChange={(e) => setName(e.target.value)} placeholder="Local, Staging…" autoFocus />
        <Input aria-label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000" className="font-mono text-xs" />
      </div>
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
      onDone()
    } catch (err) {
      fail(err)
    } finally {
      setSaving(false)
    }
  }
  return (
    <form
      className="space-y-2 rounded-lg border p-3"
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

/** "Entornos" en el resumen del proyecto: los locales o de staging, con sus credenciales de prueba. */
export function ProjectEnvironments({ project }: { project: Project }) {
  const envs = useProjectEnvironments(project.id)
  const open = useSectionOpen("project-environments")
  const toggleSection = usePanelSections((s) => s.toggle)
  const revealSection = usePanelSections((s) => s.reveal)
  const [adding, setAdding] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pending = useUi((s) => s.reveal)
  const setUi = useUi((s) => s.set)
  const credentials = envs.reduce((n, e) => n + e.credentials.length, 0)

  // Llegaste desde un aviso ("ALFA dejó una credencial") o desde el panel de la sesión.
  useEffect(() => {
    if (pending?.kind !== "environments" || pending.id !== project.id) return
    revealSection("project-environments")
    const raf = requestAnimationFrame(() => {
      if (ref.current) reveal(ref.current)
      setUi({ reveal: null })
    })
    return () => cancelAnimationFrame(raf)
  }, [pending, project.id, setUi, revealSection])

  return (
    <Collapsible ref={ref} id="entornos" open={open || adding} onOpenChange={(v) => {
        if (!v) setAdding(false)
        toggleSection("project-environments", v)
      }} className="scroll-mt-4 border-b">
      <div className="flex items-center gap-2 pr-4">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
            <span className="font-medium">Entornos</span>
            <span className="text-xs text-muted-foreground">
              {" · "}
              {envs.length ? `${plural(envs.length, "entorno", "entornos")} · ${plural(credentials, "credencial", "credenciales")}` : "ninguno todavía"}
            </span>
          </span>
        </CollapsibleTrigger>
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          onClick={() => {
            toggleSection("project-environments", true)
            setAdding(true)
          }}
        >
          <Plus />
          Entorno
        </Button>
      </div>
      <CollapsibleContent className="space-y-4 px-4 pb-4 pl-10">
        {adding && <EnvironmentForm projectId={project.id} onDone={() => setAdding(false)} />}
        {envs.map((e) => (
          <EnvironmentBlock key={e.id} env={e} />
        ))}
        {!envs.length && !adding && (
          <p className="text-sm text-muted-foreground">
            Las sesiones que levantan un entorno local o de staging y crean usuarios de prueba los dejan acá (con add_credential). También podés cargarlos vos.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
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
      href={`/p/${projectId}`}
      onClick={() => setUi({ reveal: { kind: "environments", id: projectId, at: Date.now() } })}
      className="flex items-center gap-2 border-b py-3 pr-4 pl-3 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
    >
      <KeyRound className="size-3.5" />
      Dejó {plural(n, "credencial", "credenciales")}
      <span className="ml-auto">Ver en Entornos →</span>
    </Link>
  )
}
