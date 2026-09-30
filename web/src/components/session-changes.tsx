import { GitBranch, RotateCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { ChangeGroup, FileChange, Session, SessionChanges } from "@shared/types"

import { Section } from "@/components/panel-section"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { EDITOR_NAMES, useEditor } from "@/lib/editor"
import { useSectionOpen } from "@/lib/panel-sections"
import { isNotFound, STALE_SERVER } from "@/lib/server-version"
import { cn } from "@/lib/utils"

function Delta({ added, deleted, className }: { added: number; deleted: number; className?: string }) {
  return (
    <span className={cn("shrink-0 font-mono text-[0.7rem] tabular-nums", className)}>
      <span className="text-status-done">+{added}</span> <span className="text-status-error">−{deleted}</span>
    </span>
  )
}

function FileRow({ file, onOpen, editor }: { file: FileChange; onOpen: () => void; editor: string }) {
  const slash = file.path.lastIndexOf("/")
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ""
  const name = file.path.slice(slash + 1)
  const hint = file.removed
    ? `Abrir la versión anterior en ${editor}`
    : file.untracked
      ? `Abrir en ${editor}`
      : `Abrir el diff en ${editor}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted"
        >
          <span className={cn("min-w-0 flex-1 truncate font-mono text-[0.72rem]", file.removed && "line-through decoration-muted-foreground/60")}>
            <span className="text-muted-foreground">{dir}</span>
            <span className="font-medium text-foreground">{name}</span>
          </span>
          {file.untracked && <span className="shrink-0 text-[0.68rem] text-status-done">nuevo</span>}
          {file.removed && <span className="shrink-0 text-[0.68rem] text-status-error">borrado</span>}
          {file.binary ? (
            <span className="shrink-0 text-[0.68rem] text-muted-foreground">binario</span>
          ) : file.added === null ? null : file.untracked ? (
            <span className="shrink-0 font-mono text-[0.7rem] text-status-done tabular-nums">+{file.added}</span>
          ) : file.removed ? (
            <span className="shrink-0 font-mono text-[0.7rem] text-status-error tabular-nums">−{file.deleted ?? 0}</span>
          ) : (
            <Delta added={file.added} deleted={file.deleted ?? 0} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{hint}</TooltipContent>
    </Tooltip>
  )
}

function Group({
  title,
  detail,
  group,
  onOpen,
  editor,
}: {
  title: string
  detail?: string
  group: ChangeGroup
  onOpen: (f: FileChange) => void
  editor: string
}) {
  const count = group.files.length + group.more
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 px-1.5">
        <span className="text-xs font-medium">{title}</span>
        <span className="min-w-0 flex-1 truncate text-[0.7rem] text-muted-foreground">
          {count} {count === 1 ? "archivo" : "archivos"}
          {detail ? ` · ${detail}` : ""}
        </span>
        <Delta added={group.added} deleted={group.deleted} />
      </div>
      <div>
        {group.files.map((f) => (
          <FileRow key={f.path} file={f} editor={editor} onOpen={() => onOpen(f)} />
        ))}
      </div>
      {group.more > 0 && <p className="px-1.5 text-[0.7rem] text-muted-foreground">y {group.more} más</p>}
    </div>
  )
}

/** "Cambios": lo que cambió en la carpeta de la sesión, sin commitear y en su rama. */
export function ChangesSection({ session }: { session: Session }) {
  const open = useSectionOpen("changes")
  const settings = useEditor()
  const editor = settings ? EDITOR_NAMES[settings.kind] : "VS Code"
  const [data, setData] = useState<SessionChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const current = useRef(session.id)
  current.current = session.id

  const load = useCallback(async () => {
    const id = session.id
    setLoading(true)
    try {
      const next = await api.sessionChanges(id)
      if (current.current !== id) return
      setData(next)
      setError(null)
    } catch (err) {
      if (current.current !== id) return
      setError(isNotFound(err) ? STALE_SERVER : err instanceof Error ? err.message : String(err))
    } finally {
      if (current.current === id) setLoading(false)
    }
  }, [session.id])

  // Al entrar a la sesión (para el resumen de la sección plegada) y cada vez que la abrís.
  useEffect(() => {
    setData(null)
    setError(null)
  }, [session.id])
  useEffect(() => {
    void load()
  }, [load])
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current) void load()
    wasOpen.current = open
  }, [open, load])

  // Cuando termina un turno: lo que la sesión tocó ya está en disco.
  const status = useRef(session.status)
  useEffect(() => {
    const was = status.current
    status.current = session.status
    if (was === "working" && session.status !== "working") void load()
  }, [session.status, load])

  const openFile = async (f: FileChange, side: "uncommitted" | "committed") => {
    try {
      await api.openFile(session.id, f.path, side)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const total = data ? data.uncommitted.files.length + data.uncommitted.more + (data.committed ? data.committed.files.length + data.committed.more : 0) : 0
  const added = data ? data.uncommitted.added + (data.committed?.added ?? 0) : 0
  const deleted = data ? data.uncommitted.deleted + (data.committed?.deleted ?? 0) : 0

  return (
    <Section
      id="changes"
      title="Cambios"
      count={total || undefined}
      summary={
        error ? (
          "sin datos de git"
        ) : data ? (
          <>
            {data.branch ?? "sin rama"}
            {total > 0 && (
              <>
                {" · "}
                <Delta added={added} deleted={deleted} />
              </>
            )}
          </>
        ) : null
      }
      action={
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void load()}
              aria-label="Actualizar los cambios"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RotateCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Actualizar</TooltipContent>
        </Tooltip>
      }
    >
      {error ? (
        <p className="text-xs text-muted-foreground">{error}</p>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">Cargando…</p>
      ) : (
        <div className="space-y-3">
          <p className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
            <GitBranch className="size-3.5" />
            <span className="truncate font-mono text-foreground">{data.branch ?? "HEAD suelto"}</span>
          </p>
          {data.uncommitted.files.length > 0 ? (
            <Group title="Sin commitear" group={data.uncommitted} editor={editor} onOpen={(f) => void openFile(f, "uncommitted")} />
          ) : (
            <p className="px-1.5 text-xs text-muted-foreground">No hay cambios sin commitear.</p>
          )}
          {data.committed && (
            <Group
              title="En la rama"
              detail={`${data.committed.commits} ${data.committed.commits === 1 ? "commit" : "commits"} desde ${data.committed.base}`}
              group={data.committed}
              editor={editor}
              onOpen={(f) => void openFile(f, "committed")}
            />
          )}
        </div>
      )}
    </Section>
  )
}
