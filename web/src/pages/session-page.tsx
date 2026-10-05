import { ArrowDown, Archive, Blocks, Compass, EllipsisVertical, Layers, PanelRight, Pencil, Play, Square, SquareTerminal } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Link, useLocation } from "wouter"

import { Composer } from "@/components/composer"
import { ContextMeter } from "@/components/context-meter"
import { ModelPicker, SubagentsChip } from "@/components/model-picker"
import { PageHeader } from "@/components/page-header"
import { SessionPanel } from "@/components/session-panel"
import { SessionLamp, StatusPill } from "@/components/status"
import { FileRefScope } from "@/components/file-ref"
import { TerminalTargetProvider } from "@/components/take-to-terminal"
import { TerminalPanel } from "@/components/terminal-panel"
import { Timeline } from "@/components/timeline/timeline"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { tokens, usd } from "@/lib/format"
import { usePanelSections } from "@/lib/panel-sections"
import { reveal } from "@/lib/reveal"
import { useStore } from "@/lib/store"
import { useTerminal } from "@/lib/terminal"
import { useUi } from "@/lib/ui"
import { useAction } from "@/lib/use-action"
import { cn } from "@/lib/utils"

function RenameDialog({ sessionId, name, open, onOpenChange }: { sessionId: string; name: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [value, setValue] = useState(name)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setValue(name)
  }, [open, name])
  const save = async () => {
    setSaving(true)
    try {
      await api.updateSession(sessionId, { name: value })
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Renombrar sesión</DialogTitle>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          className="font-mono"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && void save()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!value.trim() || saving}>
            {saving && <Spinner />}
            Renombrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SessionPage({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [, navigate] = useLocation()
  const session = useStore((s) => s.sessions[sessionId])
  const project = useStore((s) => s.projects[projectId])
  const events = useStore((s) => s.events[sessionId])
  const partial = useStore((s) => s.partials[sessionId])
  const hasMore = useStore((s) => s.hasMore[sessionId])
  const loadEvents = useStore((s) => s.loadEvents)
  const loadOlder = useStore((s) => s.loadOlder)
  const focus = useStore((s) => s.focus)
  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const setUi = useUi((s) => s.set)
  const pendingReveal = useUi((s) => s.reveal)
  const terminalOpen = useTerminal((s) => !!s.open[sessionId])
  const toggleTerminal = useTerminal((s) => s.toggle)

  // Ctrl+` abre y esconde la terminal (como en los editores). En la captura y sin seguir: si no, la
  // terminal lo recibe primero y le manda un NUL a la shell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault()
        e.stopPropagation()
        toggleTerminal(sessionId)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [sessionId, toggleTerminal])

  useEffect(() => {
    stick.current = true
    focus(sessionId)
    void loadEvents(sessionId).catch((err: Error) => toast.error(err.message))
    return () => focus(null)
  }, [sessionId, focus, loadEvents])

  // Pegado al final mientras llegan mensajes, salvo que hayas scrolleado hacia arriba.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stick.current) el.scrollTop = el.scrollHeight
    else setShowJump(true)
  }, [events, partial?.text])

  // Lo que crece sin un evento nuevo (el indicador de "trabajando", una imagen que carga) también se sigue.
  const shown = Boolean(session && project)
  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [shown])

  // Llegaste desde "Hay una propuesta lista": la vista baja hasta la primera propuesta lista del
  // chat. Si no está entre los mensajes cargados, se ve en el panel (en pantallas chicas, se abre).
  // En el panel, la sección de propuestas puede estar plegada: se abre sola antes de buscarla.
  useEffect(() => {
    if (pendingReveal?.kind !== "proposals" || pendingReveal.id !== sessionId || !events) return
    let inner = 0
    const raf = requestAnimationFrame(() => {
      const inChat = content.current?.querySelector<HTMLElement>('[data-draft-state="ready"]')
      if (inChat) {
        stick.current = false
        reveal(inChat)
        setUi({ reveal: null })
        return
      }
      usePanelSections.getState().reveal("proposals")
      inner = requestAnimationFrame(() => {
        const inPanel = document.querySelector<HTMLElement>('aside [data-draft-state="ready"]')
        if (inPanel?.offsetParent) reveal(inPanel)
        else if (document.querySelector('[data-draft-state="ready"]') || inPanel) setPanelOpen(true)
        setUi({ reveal: null })
      })
    })
    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(inner)
    }
  }, [pendingReveal, sessionId, events, setUi])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    stick.current = near
    if (near) setShowJump(false)
  }

  const jump = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    setShowJump(false)
  }

  const older = async () => {
    const el = scroller.current
    const before = el?.scrollHeight ?? 0
    stick.current = false
    setLoadingOlder(true)
    try {
      await loadOlder(sessionId)
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - before
      })
    } finally {
      setLoadingOlder(false)
    }
  }

  // Antes de los return tempranos: la cantidad de hooks no puede cambiar entre renders.
  const action = useAction()
  if (!session || !project) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Esta sesión no existe</EmptyTitle>
          <EmptyDescription>Puede que la hayas archivado.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const isOrch = session.kind === "orchestrator"
  const running = session.status !== "stopped" && session.status !== "error"
  const act = (key: string, fn: () => Promise<unknown>, ok?: string) =>
    action.run(key, () =>
      fn().then(
        () => ok && toast.success(ok),
        (err: Error) => toast.error(err.message)
      )
    )

  const panel = <SessionPanel session={session} project={project} />
  const terminalTarget = { sessionId: session.id, projectId: project.id }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={isOrch ? <Compass className="size-4.5 shrink-0" /> : <SessionLamp session={session} className="size-2.5" />}
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{isOrch ? "Orquestadora" : session.name}</span>
            <StatusPill session={session} />
          </span>
        }
        subtitle={
          <>
            <Link href={`/p/${project.id}`} className="hover:text-foreground hover:underline">
              {project.name}
            </Link>
            {isOrch ? ` · ${session.name}` : session.role ? ` · ${session.role}` : ""}
            {session.costUsd > 0 && ` · ${usd(session.costUsd)}`}
            {session.tokens && session.tokens.total > 0 && ` · ${tokens(session.tokens.total)} tokens`}
          </>
        }
        actions={
          <>
            {events && <SubagentsChip session={session} events={events} />}
            <ContextMeter session={session} />
            <ModelPicker session={session} />
            {running ? (
              <Button size="sm" variant="ghost" disabled={action.busy("run")} onClick={() => act("run", () => api.stop(session.id), "Sesión detenida")}>
                <Square />
                <span className="hidden sm:inline">Detener</span>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={action.busy("run")} onClick={() => act("run", () => api.start(session.id), "Sesión reanudada")}>
                <Play />
                Reanudar
              </Button>
            )}
            <Button size="icon-sm" variant={terminalOpen ? "secondary" : "ghost"} onClick={() => toggleTerminal(session.id)} aria-label="Terminal" title="Terminal (Ctrl+`)">
              <SquareTerminal />
            </Button>
            <Button size="icon-sm" variant="ghost" className="lg:hidden" onClick={() => setPanelOpen(true)} aria-label="Ver detalles">
              <PanelRight />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Más acciones">
                  <EllipsisVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-56">
                <DropdownMenuItem onClick={() => setRenaming(true)}>
                  <Pencil />
                  Renombrar
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setUi({ compactFor: session.id })}>
                  <Layers />
                  Compactar eligiendo qué queda…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setUi({ toolsFor: session.id })}>
                  <Blocks />
                  Herramientas de la sesión
                </DropdownMenuItem>
                {!isOrch && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setArchiving(true)}>
                      <Archive />
                      Archivar sesión
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <TerminalTargetProvider value={terminalTarget}>
        <FileRefScope projectId={session.projectId} sessionId={session.id}>
          <div className="flex min-h-0 flex-1">
          <div ref={column} className="relative flex min-w-0 flex-1 flex-col">
            <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
              <div ref={content} className="mx-auto max-w-3xl px-4 py-6">
                {hasMore && (
                  <div className="mb-4 flex justify-center">
                    <Button size="xs" variant="ghost" onClick={older} disabled={loadingOlder}>
                      {loadingOlder && <Spinner />}
                      Cargar mensajes anteriores
                    </Button>
                  </div>
                )}
                {!events ? (
                  <div className="space-y-3">
                    <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
                    <Skeleton className="h-4 w-5/6" />
                    <Skeleton className="h-4 w-3/5" />
                  </div>
                ) : events.length === 0 && session.status !== "working" ? (
                  <Empty className="border-0">
                    <EmptyHeader>
                      <EmptyTitle>{isOrch ? "Empezá por el objetivo" : `${session.name} está lista`}</EmptyTitle>
                      <EmptyDescription>
                        {isOrch
                          ? "Contale qué querés lograr. Va a proponer las sesiones y los prompts de cada una; vos los aprobás antes de que salgan."
                          : "Escribile directo, o esperá a que la orquestadora le proponga una tarea."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <Timeline session={session} events={events} />
                )}
              </div>
            </div>
            {showJump && (
              <button
                type="button"
                onClick={jump}
                className={cn(
                  "absolute bottom-32 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-md hover:bg-muted"
                )}
              >
                <ArrowDown className="size-3.5" />
                Ir a lo último
              </button>
            )}
            <Composer session={session} dropTarget={column} />
            <TerminalPanel session={session} />
          </div>
          <aside className="hidden w-[22rem] shrink-0 overflow-y-auto border-l bg-sidebar/40 lg:block">{panel}</aside>
          </div>
        </FileRefScope>
      </TerminalTargetProvider>

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent className="w-[22rem] overflow-y-auto p-0 sm:max-w-sm">
          <SheetHeader className="border-b">
            <SheetTitle>{isOrch ? "Orquestadora" : session.name}</SheetTitle>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>

      <RenameDialog sessionId={session.id} name={session.name} open={renaming} onOpenChange={setRenaming} />
      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Archivar {session.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Se detiene la sesión y sale del tablero. La conversación queda guardada en Claude Code y la podés retomar
              desde una terminal con claude --resume.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                act("archive", async () => {
                  await api.archiveSession(session.id)
                  navigate(`/p/${project.id}`)
                }, "Sesión archivada")
              }
            >
              Archivar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
