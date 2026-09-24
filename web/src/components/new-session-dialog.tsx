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
import { useModels } from "@/lib/store"

const DEFAULT = "__default"

export function ModelSelect({
  value,
  onChange,
  placeholder = "El de tu configuración",
}: {
  value: string | null
  onChange: (v: string | null) => void
  placeholder?: string
}) {
  const models = useModels()
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? null : v)}>
      <SelectTrigger className="w-full">
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

export function EffortSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? null : v)}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>El de tu configuración</SelectItem>
        {["low", "medium", "high", "xhigh", "max"].map((e) => (
          <SelectItem key={e} value={e}>
            {e}
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

  const create = async () => {
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
      toast.error(err instanceof Error ? err.message : String(err))
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
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
            <Field>
              <FieldLabel htmlFor="session-name">Nombre</FieldLabel>
              <Input
                id="session-name"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase())}
                placeholder="BACKEND"
                className="font-mono"
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
              placeholder="Si lo dejás vacío, la sesión arranca y espera. La orquestadora le puede proponer la tarea después."
              className="min-h-28"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Modelo</FieldLabel>
              <ModelSelect value={model} onChange={setModel} placeholder={project.settings.defaultModel ? `El del proyecto (${project.settings.defaultModel})` : "El de tu configuración"} />
            </Field>
            <Field>
              <FieldLabel>Esfuerzo</FieldLabel>
              <EffortSelect value={effort} onChange={setEffort} />
            </Field>
          </div>
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={create} disabled={!name.trim() || creating}>
            {creating && <Spinner />}
            {prompt.trim() ? "Crear y enviar" : "Crear sesión"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
