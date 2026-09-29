import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { Project } from "@shared/types"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { useStore } from "@/lib/store"

/** Borra el proyecto del dashboard (no el repo): hay que escribir su nombre para confirmar. */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [typed, setTyped] = useState("")
  const [deleting, setDeleting] = useState(false)
  const running = useStore(
    (s) =>
      Object.values(s.sessions).filter((x) => x.projectId === project.id && x.status !== "stopped" && x.status !== "error")
        .length
  )

  useEffect(() => {
    if (open) setTyped("")
  }, [open])

  const matches = typed.trim() === project.name

  const remove = async () => {
    if (!matches) return
    setDeleting(true)
    try {
      await api.deleteProject(project.id, typed.trim())
      onOpenChange(false)
      // Si estabas adentro, LeaveDeletedProject te lleva al inicio (con este mismo aviso).
      toast.success(`Borré el proyecto ${project.name}`, { id: `deleted-${project.id}` })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => !deleting && onOpenChange(v)}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>¿Borrar {project.name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2 text-left">
              <p>
                Se borra el proyecto del dashboard con sus sesiones, su historial, propuestas, resultados, tareas y
                adjuntos. <strong className="text-foreground">No se puede deshacer.</strong>
              </p>
              <p>
                No se tocan el repo ni sus archivos, ni los worktrees, ni las conversaciones de Claude Code: siguen en tu
                cuenta y las podés abrir con <code className="font-mono">claude --resume</code>.
              </p>
              {running > 0 && (
                <p className="text-foreground">
                  {running === 1 ? "Hay 1 sesión corriendo: se va a detener." : `Hay ${running} sesiones corriendo: se van a detener.`}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor="delete-project-name">
            Para confirmar, escribí <span className="font-mono">{project.name}</span>
          </FieldLabel>
          <Input
            id="delete-project-name"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            disabled={deleting}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void remove()}
          />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
          <Button variant="destructive" disabled={!matches || deleting} onClick={() => void remove()}>
            {deleting && <Spinner />}
            Borrar proyecto
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
