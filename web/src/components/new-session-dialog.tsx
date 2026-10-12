import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import type { Project } from "@shared/types"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { EFFORTS, effortName, effortsFor, modelName, projectDefaults } from "@/lib/models"
import { useModels } from "@/lib/store"

const DEFAULT = "__default"

export function ModelSelect({
  value,
  onChange,
  placeholder = "El de tu configuración",
  id,
  "aria-label": ariaLabel,
}: {
  value: string | null
  onChange: (v: string | null) => void
  placeholder?: string
  id?: string
  "aria-label"?: string
}) {
  const models = useModels()
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? null : v)}>
      <SelectTrigger id={id} aria-label={ariaLabel} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{placeholder}</SelectItem>
        {models
          .filter((m) => m.value !== "default")
          .map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

/** Esfuerzo: ofrece solo los que soporta el modelo (`efforts`, de `effortsFor`). */
export function EffortSelect({
  value,
  onChange,
  efforts = EFFORTS,
  placeholder = "El de tu configuración",
  id,
  "aria-label": ariaLabel,
}: {
  value: string | null
  onChange: (v: string | null) => void
  efforts?: string[]
  placeholder?: string
  id?: string
  "aria-label"?: string
}) {
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? null : v)} disabled={efforts.length === 0}>
      <SelectTrigger id={id} aria-label={ariaLabel} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{efforts.length ? placeholder : "No se elige con este modelo"}</SelectItem>
        {efforts.map((e) => (
          <SelectItem key={e} value={e}>
            {effortName(e)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function NewSessionDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [, navigate] = useLocation()
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [prompt, setPrompt] = useState("")
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<string | null>(null)
  const [worktree, setWorktree] = useState(false)
  const [creating, setCreating] = useState(false)
  const models = useModels()

  useEffect(() => {
    if (open) {
      setName("")
      setRole("")
      setPrompt("")
      setModel(null)
      setEffort(null)
      setWorktree(false)
    }
  }, [open])

  if (!project) return null

  // Sin modelo ni esfuerzo propios, la sesión arranca con los de las sesiones del proyecto.
  const inherited = projectDefaults(project.settings, "worker")
  const efforts = effortsFor(models, model ?? inherited.model)

  const create = async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      const s = await api.createSession(project.id, {
        name,
        role,
        prompt: prompt.trim() || undefined,
        model,
        effort,
        worktree,
      })
      toast.success(`Sesión ${s.name} creada`)
      onOpenChange(false)
      navigate(`/p/${project.id}/s/${s.id}`)
    } catch (err) {
      toast.error("No se pudo crear la sesión", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nueva sesión en {project.name}</DialogTitle>
          <DialogDescription>
            Arranca con el protocolo de trabajo en paralelo ya cargado: sabe quiénes son las otras sesiones, cómo
            coordinarse y cómo reportarle a la orquestadora al terminar.
          </DialogDescription>
        </DialogHeader>
        {/* Enter en un campo crea; en el prompt es un salto de línea, y Ctrl/⌘+Enter crea. */}
        <form
          id="new-session-form"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
            <Field>
              <FieldLabel htmlFor="session-name">Nombre</FieldLabel>
              <Input
                id="session-name"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                placeholder="BACKEND"
                className="name"
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="session-role">Rol</FieldLabel>
              <Input
                id="session-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="API y base de datos"
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="session-prompt">Primer prompt (opcional)</FieldLabel>
            <Textarea
              id="session-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="Si lo dejás vacío, la sesión arranca y espera. La orquestadora le puede proponer la tarea después."
              className="min-h-28"
            />
          </Field>
          <Field>
            <div className="grid gap-4 sm:grid-cols-[1.4fr_1fr]">
              <Field>
                <FieldLabel htmlFor="session-model">Modelo</FieldLabel>
                <ModelSelect
                  id="session-model"
                  value={model}
                  onChange={(v) => {
                    setModel(v)
                    if (effort && !effortsFor(models, v ?? inherited.model).includes(effort)) setEffort(null)
                  }}
                  placeholder={inherited.model ? `El del proyecto (${modelName(models, inherited.model)})` : "El de tu configuración"}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="session-effort">Esfuerzo</FieldLabel>
                <EffortSelect
                  id="session-effort"
                  value={effort}
                  onChange={setEffort}
                  efforts={efforts}
                  placeholder={inherited.effort ? `El del proyecto (${effortName(inherited.effort)})` : "El de tu configuración"}
                />
              </Field>
            </div>
            <FieldDescription>
              {inherited.model || inherited.effort
                ? "Arranca con los de las sesiones del proyecto. Se cambian en la configuración del proyecto, en Modelos."
                : "Arranca con los de tu configuración de Claude Code. En la configuración del proyecto, en Modelos, podés elegir otros para todas las sesiones."}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="session-worktree">Worktree aparte</FieldLabel>
              <FieldDescription>
                Trabaja en su propia rama y carpeta en lugar del checkout compartido. Después hay que mergear.
              </FieldDescription>
            </FieldContent>
            <Switch id="session-worktree" checked={worktree} onCheckedChange={setWorktree} />
          </Field>
        </FieldGroup>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="new-session-form" disabled={!name.trim() || creating}>
            {creating && <Spinner />}
            {prompt.trim() ? "Crear y enviar" : "Crear sesión"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
