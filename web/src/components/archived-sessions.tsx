import { Archive, ChevronRight, RotateCcw, Trash2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { Session } from "@shared/types"

import { Button } from "@/components/ui/button"
import { ConfirmAction } from "@/components/ui/confirm-action"
import { LoadError } from "@/components/ui/load-error"
import { api } from "@/lib/api"
import { reveal } from "@/lib/reveal"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { timeAgo, tokens } from "@/lib/format"
import { useAction } from "@/lib/use-action"
import { cn } from "@/lib/utils"

/**
 * Las sesiones en vivo del proyecto, como una clave: cambia cuando una se archiva (el server la manda
 * con `archivedAt` y el store la saca) o se restaura (vuelve a aparecer), venga de donde venga.
 */
function useLiveKey(projectId: string) {
  return useStore((s) =>
    Object.values(s.sessions)
      .filter((x) => x.projectId === projectId)
      .map((x) => x.id)
      .sort()
      .join(",")
  )
}

/**
 * Sesiones archivadas del proyecto: no aparecen en el tablero ni en el mapa. Se pueden restaurar o
 * borrar del dashboard (la conversación de Claude Code queda en disco).
 */
export function ArchivedSessions({ projectId }: { projectId: string }) {
  const [list, setList] = useState<Session[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [open, setOpen] = useState(false)
  const [purging, setPurging] = useState<Session | null>(null)
  const action = useAction()
  const live = useLiveKey(projectId)

  const load = useCallback(
    () =>
      api.archivedSessions(projectId).then(
        (l) => {
          setList(l)
          setError(null)
        },
        (err: unknown) => setError(err)
      ),
    [projectId]
  )

  useEffect(() => {
    void load()
  }, [load, live])

  // "Sesiones archivadas" desde la paleta: se abre y baja hasta acá (o avisa que no hay).
  const pendingReveal = useUi((s) => s.reveal)
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    if (pendingReveal?.kind !== "archived" || pendingReveal.id !== projectId || (list === null && !error)) return
    useUi.getState().set({ reveal: null })
    if (list && !list.length) {
      toast.message("Este proyecto no tiene sesiones archivadas")
      return
    }
    setOpen(true)
    requestAnimationFrame(() => section.current && reveal(section.current))
  }, [pendingReveal, projectId, list, error])

  if (error && !list?.length)
    return (
      <section ref={section}>
        <LoadError what="las sesiones archivadas" error={error} onRetry={load} />
      </section>
    )
  if (!list?.length) return null

  const restore = async (s: Session) => {
    try {
      await api.restoreSession(s.id)
      toast.success("Sesión restaurada", { description: s.name })
      void load()
    } catch (err) {
      toast.error(`No se pudo restaurar ${s.name}`, { description: err instanceof Error ? err.message : String(err) })
    }
  }

  const purge = async (s: Session) => {
    await api.purgeSession(s.id)
    toast.success("Sesión borrada", { description: s.name })
    void load()
  }

  return (
    <section ref={section}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mb-3 flex items-center gap-2 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <Archive className="size-3.5" />
        <span className="eyebrow text-current">Archivadas</span>
        <span className="text-xs">{list.length}</span>
      </button>
      {open && (
        <ul className="surface-card divide-y">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="name truncate text-sm" title={s.name}>
                    {s.name}
                  </span>
                  {s.role && (
                    <span className="truncate text-xs text-muted-foreground" title={s.role}>
                      {s.role}
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground" title={s.taskTitle ?? undefined}>
                  {s.taskTitle ? `${s.taskTitle} · ` : ""}
                  archivada {timeAgo(s.archivedAt)}
                  {s.tokens?.total ? ` · ${tokens(s.tokens.total)} tokens` : ""}
                </p>
              </div>
              <Button size="xs" variant="outline" disabled={action.busy(s.id)} onClick={() => void action.run(s.id, () => restore(s))}>
                <RotateCcw />
                Restaurar
              </Button>
              <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setPurging(s)}>
                <Trash2 />
                Borrar…
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmAction
        open={Boolean(purging)}
        onOpenChange={(v) => !v && setPurging(null)}
        title={`¿Borrar ${purging?.name ?? ""} del dashboard?`}
        description={
          <p>
            Se borran del dashboard su historial, sus adjuntos y sus resultados. La conversación de Claude Code no se toca: la podés retomar
            desde una terminal con <code className="font-mono">claude --resume {purging?.claudeSessionId}</code>.
          </p>
        }
        confirmLabel="Borrar sesión"
        onConfirm={async () => {
          if (purging) await purge(purging)
          setPurging(null)
        }}
      />
    </section>
  )
}
