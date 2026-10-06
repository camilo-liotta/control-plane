import { History, TriangleAlert } from "lucide-react"
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api, type Importable } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Traer al dashboard una sesión que empezaste en una terminal (se retoma con su historial). */
export function ImportSessionDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [, navigate] = useLocation()
  const [items, setItems] = useState<Importable[] | null>(null)
  const [picked, setPicked] = useState<Importable | null>(null)
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [importing, setImporting] = useState(false)

  const load = () => {
    if (!project) return
    setItems(null)
    api.importable(project.id).then(setItems, (err: Error) => {
      toast.error("No se pudieron leer las conversaciones", { description: err.message })
      setItems([])
    })
  }

  useEffect(() => {
    if (open) {
      setPicked(null)
      setName("")
      setRole("")
      load()
    }
  }, [open, project?.id])

  if (!project) return null

  const pick = (it: Importable) => {
    setPicked(it)
    setName((it.name ?? "").toUpperCase())
  }

  const doImport = async () => {
    if (!picked) return
    setImporting(true)
    try {
      const s = await api.importSession(project.id, { claudeSessionId: picked.sessionId, name, role, allowLive: Boolean(picked.running) })
      toast.success(`${s.name} importada`, {
        description: picked.running
          ? "Cerrala en la terminal y después usala desde acá: mientras esté abierta, el dashboard no la reanuda."
          : "Reanudala cuando quieras: recibe el protocolo de control-plane.",
      })
      onOpenChange(false)
      navigate(`/p/${project.id}/s/${s.id}`)
    } catch (err) {
      toast.error("No se pudo importar la sesión", { description: err instanceof Error ? err.message : String(err) })
      load()
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Importar una sesión existente</DialogTitle>
          <DialogDescription>
            Conversaciones de Claude Code en la carpeta de {project.name}. Se traen con su historial y se retoman con{" "}
            <code className="font-mono">claude --resume</code>. Si está abierta en una terminal, se importa igual y el dashboard
            no la reanuda hasta que la cierres.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-y-auto rounded-xl bg-muted/50 p-1">
          {items === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner /> Buscando conversaciones…
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No hay conversaciones de Claude Code en esta carpeta.</p>
          ) : (
            items.map((it) => {
              const disabled = it.imported
              return (
                <button
                  key={it.sessionId}
                  type="button"
                  disabled={disabled}
                  onClick={() => pick(it)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors outline-hidden hover:bg-background focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                    picked?.sessionId === it.sessionId && "bg-background shadow-raised"
                  )}
                >
                  <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={cn("truncate text-sm font-medium", !it.name && "font-mono")} title={it.name ?? it.sessionId}>{it.name ?? it.sessionId.slice(0, 8)}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{timeAgo(it.updatedAt)}</span>
                    </span>
                    {it.preview && <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={it.preview}>{it.preview}</span>}
                    {it.imported && <span className="mt-0.5 block text-xs text-muted-foreground">Ya está en el dashboard</span>}
                    {it.running && (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-status-pending">
                        <TriangleAlert className="size-3" />
                        {it.running.kind === "background"
                          ? <>Corriendo en segundo plano: se importa igual y se usa acá después de <code className="font-mono">claude stop {it.running.id ?? ""}</code></>
                          : "Abierta en una terminal: se importa igual y se usa acá cuando la cierres"}
                      </span>
                    )}
                  </span>
                </button>
              )
            })
          )}
        </div>
        {picked && (
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
              <Field>
                <FieldLabel htmlFor="imp-name">Nombre</FieldLabel>
                <Input id="imp-name" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} className="name" />
              </Field>
              <Field>
                <FieldLabel htmlFor="imp-role">Rol</FieldLabel>
                <Input id="imp-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Qué hace esta sesión" />
              </Field>
            </div>
          </FieldGroup>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={doImport} disabled={!picked || !name.trim() || importing}>
            {importing && <Spinner />}
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
