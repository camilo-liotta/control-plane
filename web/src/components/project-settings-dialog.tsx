import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import type { Project, ProjectSettings } from "@shared/types"

import { EffortSelect, ModelSelect } from "@/components/new-session-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [, navigate] = useLocation()
  const [name, setName] = useState(project.name)
  const [settings, setSettings] = useState<ProjectSettings>(project.settings)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(project.name)
      setSettings(project.settings)
    }
  }, [open, project])

  const set = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }))

  const save = async () => {
    setSaving(true)
    try {
      await api.updateProject(project.id, { name, settings })
      toast.success("Configuración guardada")
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const archive = async () => {
    try {
      await api.archiveProject(project.id)
      toast.success(`Proyecto ${project.name} archivado`)
      onOpenChange(false)
      navigate("/")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configuración de {project.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{project.repoPath}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="p-name">Nombre</FieldLabel>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <FieldSeparator>Orquestación</FieldSeparator>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="p-auto">Enviar las propuestas solas</FieldLabel>
              <FieldDescription>
                Cuando la orquestadora termina de revisar la cola, sus prompts salen sin esperar tu aprobación. Las
                sesiones nuevas siempre las aprobás vos.
              </FieldDescription>
            </FieldContent>
            <Switch id="p-auto" checked={settings.autoDispatch} onCheckedChange={(v) => set("autoDispatch", v)} />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="p-window">Ventana para agrupar resultados</FieldLabel>
              <FieldDescription>
                Segundos que espera después del último resultado antes de entregarle la cola a la orquestadora, para
                juntar los que terminan casi al mismo tiempo.
              </FieldDescription>
            </FieldContent>
            <Input
              id="p-window"
              type="number"
              min={0}
              max={600}
              className="w-24 font-mono"
              value={settings.batchWindowSec}
              onChange={(e) => set("batchWindowSec", Number(e.target.value))}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="p-edit">La orquestadora puede editar archivos</FieldLabel>
              <FieldDescription>Por defecto solo lee el repo y escribe prompts. Aplica al reiniciarla.</FieldDescription>
            </FieldContent>
            <Switch
              id="p-edit"
              checked={settings.orchestratorCanEdit}
              onCheckedChange={(v) => set("orchestratorCanEdit", v)}
            />
          </Field>

          <FieldSeparator>Sesiones nuevas</FieldSeparator>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Modelo por defecto</FieldLabel>
              <ModelSelect value={settings.defaultModel} onChange={(v) => set("defaultModel", v)} />
            </Field>
            <Field>
              <FieldLabel>Esfuerzo por defecto</FieldLabel>
              <EffortSelect value={settings.defaultEffort} onChange={(v) => set("defaultEffort", v)} />
            </Field>
          </div>

          <FieldSeparator>Instrucciones del proyecto</FieldSeparator>
          <Field>
            <FieldLabel htmlFor="p-worker">Para todos los workers</FieldLabel>
            <Textarea
              id="p-worker"
              value={settings.workerInstructions}
              onChange={(e) => set("workerInstructions", e.target.value)}
              placeholder="Convenciones de commits, comandos para correr tests, zonas del repo que no se tocan…"
              className="min-h-24"
            />
            <FieldDescription>Se suman al protocolo de cada worker. Aplican al iniciar o reanudar la sesión.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="p-orch">Para la orquestadora</FieldLabel>
            <Textarea
              id="p-orch"
              value={settings.orchestratorInstructions}
              onChange={(e) => set("orchestratorInstructions", e.target.value)}
              placeholder="Objetivo del proyecto, prioridades, cómo te gusta que te resuma las revisiones…"
              className="min-h-24"
            />
          </Field>
        </FieldGroup>
        <DialogFooter className="sm:justify-between">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">Archivar proyecto</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>¿Archivar {project.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Se detienen todas sus sesiones y desaparece del dashboard. No se borra nada del repo ni de las
                  conversaciones de Claude Code.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={archive}>Archivar</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Spinner />}
              Guardar
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
