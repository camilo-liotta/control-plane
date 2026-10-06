import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useLocation } from "wouter"

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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

/**
 * Renombrar y archivar una sesión: un solo diálogo de cada uno para toda la app, que abren el menú
 * de la sesión y la paleta (ver session-actions.ts).
 */
export function SessionDialogs() {
  return (
    <>
      <RenameDialog />
      <ArchiveDialog />
    </>
  )
}

function RenameDialog() {
  const id = useUi((s) => s.renameFor)
  const setUi = useUi((s) => s.set)
  const session = useStore((s) => (id ? s.sessions[id] : undefined))
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const open = Boolean(id && session)
  useEffect(() => {
    if (open && session) setValue(session.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id])
  const close = () => setUi({ renameFor: null })
  const save = async () => {
    if (!id || !value.trim() || saving) return
    setSaving(true)
    try {
      await api.updateSession(id, { name: value })
      toast.success("Sesión renombrada")
      close()
    } catch (err) {
      toast.error("No se pudo renombrar la sesión", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Renombrar sesión</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          className="contents"
        >
          <Input value={value} onChange={(e) => setValue(e.target.value.toUpperCase())} className="name" autoFocus aria-label="Nombre de la sesión" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!value.trim() || saving}>
              {saving && <Spinner />}
              Renombrar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ArchiveDialog() {
  const id = useUi((s) => s.archiveFor)
  const setUi = useUi((s) => s.set)
  const session = useStore((s) => (id ? s.sessions[id] : undefined))
  const [location, navigate] = useLocation()
  const close = () => setUi({ archiveFor: null })
  const archive = async () => {
    if (!session) return
    try {
      await api.archiveSession(session.id)
    } catch (err) {
      toast.error("No se pudo archivar la sesión", { description: err instanceof Error ? err.message : String(err) })
      throw err
    }
    toast.success("Sesión archivada", { description: "Está en Archivadas, en el resumen del proyecto." })
    // Si la estabas mirando, volvés al tablero.
    if (location.startsWith(`/p/${session.projectId}/s/${session.id}`)) navigate(`/p/${session.projectId}`)
    close()
  }
  return (
    <AlertDialog open={Boolean(id && session)} onOpenChange={(v) => !v && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            ¿Archivar <span className="name">{session?.name}</span>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Se detiene y sale del tablero, con su conversación guardada. La podés restaurar cuando quieras desde Archivadas, en el
            resumen del proyecto, y sigue donde quedó.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onAction={archive}>Archivar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
