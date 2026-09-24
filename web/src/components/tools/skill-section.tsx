import { FilePen, Plus, Sparkles, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { CatalogSkill, SkillInfo, SkillState, ToolsView } from "@shared/types"

import { DiffView } from "@/components/timeline/diff-view"
import { Markdown } from "@/components/timeline/markdown"
import { AiSkillSearch, SkillMarketplaces } from "@/components/tools/skill-market"
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
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { shortPath, tokens } from "@/lib/format"

export const SKILL_STATE: Record<SkillState, { label: string; description: string }> = {
  on: { label: "Activa", description: "Claude la ve y la usa cuando hace falta." },
  "name-only": { label: "Solo el nombre", description: "Claude ve el nombre sin la descripción (ocupa menos contexto)." },
  "user-invocable-only": { label: "Solo si la pedís", description: "Claude no la ve; la usás vos con /nombre." },
  off: { label: "Desactivada", description: "No la ve Claude ni aparece en /." },
}

const GROUPS: { source: string; title: string }[] = [
  { source: "user", title: "Tuyas" },
  { source: "project", title: "Del proyecto" },
  { source: "plugin", title: "De plugins" },
  { source: "bundled", title: "Incluidas en Claude Code" },
  { source: "managed", title: "De tu organización" },
]

const SCOPE_NOTE: Record<string, string> = {
  user: "definido en tu cuenta",
  project: "definido en el proyecto",
  local: "definido solo para vos en este proyecto",
}

function StateSelect({ skill, view, onChanged }: { skill: SkillInfo; view: ToolsView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  if (skill.source === "plugin") return <span className="shrink-0 text-xs text-muted-foreground">se maneja con el plugin</span>
  const scope = view.projectId ? "local" : "user"
  const change = async (state: SkillState) => {
    setBusy(true)
    try {
      await api.setSkillState(view.accountId, skill.name, state, scope, view.projectId)
      toast.success(`${skill.name}: ${SKILL_STATE[state].label.toLowerCase()}`, {
        description: view.projectId ? "Solo para vos, en este proyecto." : "En todos tus proyectos. Las sesiones abiertas lo toman al instante.",
      })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Select value={skill.state} onValueChange={(v) => void change(v as SkillState)} disabled={busy}>
      <SelectTrigger size="sm" className="w-40 shrink-0 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(SKILL_STATE) as SkillState[]).map((s) => (
          <SelectItem key={s} value={s} className="text-xs">
            {SKILL_STATE[s].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SkillSheet({ skill, view, onClose, onChanged }: { skill: SkillInfo | null; view: ToolsView; onClose: () => void; onChanged: () => void }) {
  const [file, setFile] = useState<{ path: string; content: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [instruction, setInstruction] = useState("")
  const [proposal, setProposal] = useState<string | null>(null)
  const [proposing, setProposing] = useState(false)

  useEffect(() => {
    setFile(null)
    setError(null)
    setEditing(false)
    setProposal(null)
    setInstruction("")
    if (!skill?.path) return
    api.readSkill(view.accountId, skill.name, view.projectId).then(
      (f) => {
        setFile(f)
        setDraft(f.content)
      },
      (err: Error) => setError(err.message)
    )
  }, [skill?.name, skill?.path, view.accountId, view.projectId])

  const save = async () => {
    if (!skill) return
    setBusy(true)
    try {
      await api.saveSkill(view.accountId, skill.name, draft, view.projectId)
      setFile((f) => (f ? { ...f, content: draft } : f))
      setEditing(false)
      toast.success("Skill guardada", { description: "Las sesiones abiertas la recargan." })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const propose = async () => {
    if (!skill || !instruction.trim()) return
    setProposing(true)
    try {
      const r = await api.aiEditSkill(view.accountId, skill.name, instruction, view.projectId)
      setProposal(r.content)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setProposing(false)
    }
  }

  const applyProposal = async () => {
    if (!skill || !proposal) return
    setBusy(true)
    try {
      await api.saveSkill(view.accountId, skill.name, proposal, view.projectId)
      setFile((f) => (f ? { ...f, content: proposal } : f))
      setDraft(proposal)
      setProposal(null)
      setInstruction("")
      toast.success("Cambio aplicado", { description: "Las sesiones abiertas recargan la skill." })
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!skill) return
    try {
      const r = await api.deleteSkill(view.accountId, skill.name, view.projectId)
      toast.success(`${skill.name} quitada`, { description: `Quedó en la papelera del dashboard: ${shortPath(r.movedTo)}` })
      onClose()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const body = file?.content.replace(/^---\n[\s\S]*?\n---\n?/, "") ?? ""
  return (
    <Sheet open={Boolean(skill)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="font-mono">{skill?.name}</SheetTitle>
          <SheetDescription>{skill?.description}</SheetDescription>
          {file && <p className="font-mono text-[0.7rem] text-muted-foreground">{shortPath(file.path)}</p>}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {!skill?.path && (
            <p className="text-sm text-muted-foreground">
              {skill?.source === "plugin"
                ? "Viene con un plugin: se actualiza y se quita con el plugin."
                : "Viene incluida en Claude Code: podés cambiar su estado, pero no su contenido."}
            </p>
          )}
          {error && <p className="text-sm text-status-error">{error}</p>}
          {skill?.path && !file && !error && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          )}
          {file && skill?.editable && !editing && (
            <div className="mb-4 space-y-2 rounded-lg border bg-muted/30 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <Sparkles className="size-3.5 text-claude" />
                Modificar con IA
              </p>
              <div className="flex gap-2">
                <Input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void propose()}
                  placeholder="Ej: agregá un paso para correr los tests antes de terminar"
                  className="text-sm"
                />
                <Button size="sm" variant="outline" onClick={() => void propose()} disabled={proposing || !instruction.trim()}>
                  {proposing ? <Spinner /> : <Sparkles />}
                  Proponer
                </Button>
              </div>
              {proposing && <p className="text-xs text-muted-foreground">Claude está reescribiendo la skill…</p>}
              {proposal && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Esto cambiaría. No se guarda hasta que lo apliques.</p>
                  <DiffView oldText={file.content} newText={proposal} maxLines={200} />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
                      Descartar
                    </Button>
                    <Button size="sm" onClick={() => void applyProposal()} disabled={busy}>
                      {busy && <Spinner />}
                      Aplicar el cambio
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {file && !editing && !proposal && <Markdown text={body || "_(vacía)_"} />}
          {file && editing && <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-[60svh] font-mono text-xs" />}
        </div>
        {file && skill?.editable && (
          <SheetFooter className="flex-row items-center gap-2 border-t">
            <Button variant="ghost" size="sm" className="mr-auto text-muted-foreground" onClick={() => setRemoving(true)}>
              <Trash2 />
              Quitar
            </Button>
            {editing ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => (setEditing(false), setDraft(file.content))}>
                  Cancelar
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={busy}>
                  {busy && <Spinner />}
                  Guardar
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <FilePen />
                Editar
              </Button>
            )}
          </SheetFooter>
        )}
        <AlertDialog open={removing} onOpenChange={setRemoving}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Quitar {skill?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                La carpeta de la skill se mueve a la papelera del dashboard (~/.control-plane/trash): no se borra, la podés recuperar de ahí.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={() => void remove()}>Quitar</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  )
}

function NewSkillDialog({ view, open, onOpenChange, onCreated }: { view: ToolsView; open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const [scope, setScope] = useState<"user" | "project">(view.projectId ? "project" : "user")
  const [mode, setMode] = useState<"ai" | "manual">("ai")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [body, setBody] = useState("")
  const [need, setNeed] = useState("")
  const [generated, setGenerated] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const generate = async () => {
    setGenerating(true)
    try {
      const r = await api.aiDraftSkill(view.accountId, need, scope, view.projectId)
      setGenerated(r.content)
      setName(r.name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }
  const save = async () => {
    setSaving(true)
    try {
      await api.createSkill(view.accountId, {
        scope,
        name,
        description,
        body,
        ...(mode === "ai" && generated ? { content: generated } : {}),
        projectId: view.projectId,
      })
      toast.success(`Skill ${name} creada`, { description: "Las sesiones abiertas la cargan al instante." })
      onOpenChange(false)
      setName("")
      setDescription("")
      setBody("")
      setNeed("")
      setGenerated(null)
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nueva skill</DialogTitle>
          <DialogDescription>Una carpeta con su SKILL.md, como las que crea Claude Code.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
          {(["ai", "manual"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={mode === m ? "flex-1 rounded-md bg-background px-3 py-1 font-medium shadow-xs" : "flex-1 rounded-md px-3 py-1 text-muted-foreground"}
            >
              {m === "ai" ? "Que la escriba Claude" : "Escribirla yo"}
            </button>
          ))}
        </div>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="sk-name">Nombre</FieldLabel>
              <Input
                id="sk-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
                placeholder={mode === "ai" ? "lo propone Claude" : "revisar-migraciones"}
                className="font-mono"
                disabled={mode === "ai"}
              />
            </Field>
            <Field>
              <FieldLabel>Dónde</FieldLabel>
              <Select value={scope} onValueChange={(v) => setScope(v as "user" | "project")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">En tu cuenta</SelectItem>
                  {view.projectId && <SelectItem value="project">En este proyecto (.claude/skills)</SelectItem>}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {mode === "ai" ? (
            <>
              <Field>
                <FieldLabel htmlFor="sk-need">Qué tiene que saber hacer</FieldLabel>
                <Textarea
                  id="sk-need"
                  value={need}
                  onChange={(e) => setNeed(e.target.value)}
                  placeholder="Ej: revisar una migración SQL de Postgres antes de aplicarla: locks, índices concurrentes, backfills en lotes."
                  className="min-h-20"
                />
                <FieldDescription>
                  {scope === "project" ? "Para una skill del proyecto, Claude puede leer el repo (sin tocar nada) para adaptarla." : "Claude la escribe; la revisás antes de crearla."} Usa tu plan.
                </FieldDescription>
              </Field>
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => void generate()} disabled={generating || !need.trim()}>
                  {generating ? <Spinner /> : <Sparkles />}
                  {generated ? "Rehacer" : "Escribirla"}
                </Button>
              </div>
              {generating && <p className="text-xs text-muted-foreground">Claude está escribiendo la skill (tarda unos segundos)…</p>}
              {generated !== null && (
                <Field>
                  <FieldLabel htmlFor="sk-generated">SKILL.md (podés editarlo)</FieldLabel>
                  <Textarea id="sk-generated" value={generated} onChange={(e) => setGenerated(e.target.value)} className="min-h-64 font-mono text-xs" />
                </Field>
              )}
            </>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="sk-desc">Para qué sirve</FieldLabel>
                <Input id="sk-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Usala antes de aplicar una migración de base de datos…" />
                <FieldDescription>Claude lee esto para decidir cuándo usarla.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="sk-body">Instrucciones</FieldLabel>
                <Textarea id="sk-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Pasos, reglas, ejemplos…" className="min-h-40 font-mono text-xs" />
              </Field>
            </>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || (mode === "ai" ? !generated?.trim() : !name.trim() || !description.trim())}
          >
            {saving && <Spinner />}
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SkillSection({ view, onChanged, readOnly = false }: { view: ToolsView; onChanged: () => void; readOnly?: boolean }) {
  const [open, setOpen] = useState<SkillInfo | null>(null)
  const [creating, setCreating] = useState(false)
  const [marketSkill, setMarketSkill] = useState<CatalogSkill | null>(null)
  const total = view.skills.reduce((n, s) => n + (s.state === "off" ? 0 : (s.tokens ?? 0)), 0)
  return (
    <div className="space-y-5">
      {!readOnly && <AiSkillSearch view={view} onChanged={onChanged} onOpenSkill={setMarketSkill} />}
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted-foreground">
          {view.skills.length} skills{total ? ` · su listado ocupa ~${tokens(total)} tokens en cada sesión` : ""}.
          {!readOnly && (view.projectId ? " Los cambios de estado aplican solo para vos en este proyecto." : " Los cambios de estado aplican en todos tus proyectos.")}
        </p>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus />
            Nueva skill
          </Button>
        )}
      </div>
      {GROUPS.map((g) => {
        const list = view.skills.filter((s) => s.source === g.source)
        if (!list.length) return null
        return (
          <section key={g.source}>
            <h3 className="eyebrow mb-2">
              {g.title} <span className="font-mono text-muted-foreground">{list.length}</span>
            </h3>
            <ul className="divide-y rounded-xl border bg-card">
              {list.map((s) => (
                <li key={s.name} className="flex items-center gap-3 px-4 py-2.5">
                  <button type="button" onClick={() => setOpen(s)} className="min-w-0 flex-1 text-left">
                    <span className="flex items-center gap-2">
                      <span className={s.state === "off" ? "font-mono text-sm text-muted-foreground line-through" : "font-mono text-sm"}>{s.name}</span>
                      {s.tokens ? <span className="font-mono text-[0.68rem] text-muted-foreground">~{s.tokens} tok</span> : null}
                      {s.stateScope && <span className="text-[0.68rem] text-muted-foreground">{SCOPE_NOTE[s.stateScope]}</span>}
                    </span>
                    {s.description && <span className="line-clamp-1 text-xs text-muted-foreground">{s.description}</span>}
                  </button>
                  {readOnly ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{SKILL_STATE[s.state].label}</span>
                  ) : (
                    <StateSelect skill={s} view={view} onChanged={onChanged} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {!readOnly && <SkillMarketplaces view={view} onChanged={onChanged} openSkill={marketSkill} setOpenSkill={setMarketSkill} />}
      <SkillSheet skill={open} view={view} onClose={() => setOpen(null)} onChanged={onChanged} />
      {!readOnly && <NewSkillDialog view={view} open={creating} onOpenChange={setCreating} onCreated={onChanged} />}
    </div>
  )
}
