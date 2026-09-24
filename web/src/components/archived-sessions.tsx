import { Archive, ChevronRight, RotateCcw, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { Session } from "@shared/types"

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
import { api } from "@/lib/api"
import { timeAgo, tokens } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Sesiones archivadas del proyecto: no aparecen en el tablero ni en el mapa. Se pueden restaurar o
 * eliminar del dashboard (la conversación de Claude Code queda en disco).
 */
export function ArchivedSessions({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [list, setList] = useState<Session[] | null>(null)
  const [open, setOpen] = useState(false)
  const [purging, setPurging] = useState<Session | null>(null)

  const load = () => api.archivedSessions(projectId).then(setList, () => setList([]))

  useEffect(() => {
    void load()
  }, [projectId, refreshKey])

  if (!list?.length) return null

  const restore = async (s: Session) => {
    try {
      await api.restoreSession(s.id)
      toast.success(`${s.name} restaurada`)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const purge = async (s: Session) => {
    try {
      await api.purgeSession(s.id)
      toast.success(`${s.name} eliminada del dashboard`)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-3 flex items-center gap-2 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <Archive className="size-3.5" />
        <span className="eyebrow text-current">Archivadas</span>
        <span className="font-mono text-xs">{list.length}</span>
      </button>
      {open && (
        <ul className="divide-y rounded-xl border bg-card">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{s.name}</span>
                  {s.role && <span className="truncate text-xs text-muted-foreground">{s.role}</span>}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {s.taskTitle ? `${s.taskTitle} · ` : ""}
                  archivada {timeAgo(s.archivedAt)}
                  {s.tokens?.total ? ` · ${tokens(s.tokens.total)} tokens` : ""}
                </p>
              </div>
              <Button size="xs" variant="outline" onClick={() => void restore(s)}>
                <RotateCcw />
                Restaurar
              </Button>
              <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setPurging(s)}>
                <Trash2 />
                Eliminar
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={Boolean(purging)} onOpenChange={(v) => !v && setPurging(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar {purging?.name} del dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              Se borran del dashboard su historial, sus adjuntos y sus resultados. La conversación de Claude Code no se toca: la podés
              retomar desde una terminal con <code className="font-mono">claude --resume {purging?.claudeSessionId}</code>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => purging && void purge(purging)}>Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
