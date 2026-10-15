import { toast } from "sonner"

import type { Project } from "@shared/types"

import { ConfirmAction } from "@/components/ui/confirm-action"
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
  const running = useStore(
    (s) =>
      Object.values(s.sessions).filter((x) => x.projectId === project.id && x.status !== "stopped" && x.status !== "error")
        .length
  )

  // Si falla, ConfirmAction muestra el error y queda abierto.
  const remove = async () => {
    await api.deleteProject(project.id, project.name)
    onOpenChange(false)
    // Si estabas adentro, LeaveDeletedProject te lleva al inicio (con este mismo aviso).
    toast.success(`Proyecto ${project.name} borrado`, { id: `deleted-${project.id}` })
  }

  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title={`¿Borrar ${project.name}?`}
      description={
        <>
          <p>
            Se borra el proyecto del dashboard con sus sesiones, su historial, propuestas, resultados, tareas y adjuntos.{" "}
            <strong className="text-foreground">No se puede deshacer.</strong>
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
        </>
      }
      confirmText={project.name}
      confirmLabel="Borrar proyecto"
      onConfirm={remove}
    />
  )
}
