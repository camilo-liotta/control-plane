import { ArrowDown, Archive, Blocks, Compass, EllipsisVertical, Layers, PanelRight, Pencil, Play, RotateCcw, Square, SquareTerminal } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Link, useLocation } from "wouter"

import type { Session } from "@shared/types"

import { Composer } from "@/components/composer"
import { ContextMeter, Ring } from "@/components/context-meter"
import { ModelPicker, ModelSubmenu, SubagentsChip } from "@/components/model-picker"
import { PageHeader } from "@/components/page-header"
import { SessionPanel } from "@/components/session-panel"
import { StatusPill } from "@/components/status"
import { FileRefScope } from "@/components/file-ref"
import { TerminalTargetProvider } from "@/components/take-to-terminal"
import { TerminalPanel } from "@/components/terminal-panel"
import { Timeline } from "@/components/timeline/timeline"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { LoadError } from "@/components/ui/load-error"
import { Shortcut } from "@/components/ui/kbd"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { tokens, usd } from "@/lib/format"
import { usePanelSections } from "@/lib/panel-sections"
import { reveal } from "@/lib/reveal"
import { scrollSpot } from "@shared/navigation"
import { scrollMemory, useNav } from "@/lib/nav"
import { archiveSession, openCompaction, openSessionTools, renameSession, startSession, stopSession } from "@/lib/session-actions"
import { useStore } from "@/lib/store"
import { useTerminal } from "@/lib/terminal"
import { useUi } from "@/lib/ui"
import { useAction } from "@/lib/use-action"

export function SessionPage({ projectId, sessionId }: { projectId: string; sessionId: string }) {
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
  // Al volver a una sesión, aparecés donde la dejaste: pegado al final o en la misma posición.
  const remembered = useRef(scrollMemory.get(sessionId))
  const stick = useRef(remembered.current?.atEnd ?? true)
  const [showJump, setShowJump] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  // Arriba de los return tempranos: la cantidad de hooks no puede cambiar entre renders.
  const action = useAction()
  const jumpSignal = useUi((s) => s.jumpToEnd)
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

  // Si los mensajes no cargan, se dice en lugar del esqueleto (que si no, queda para siempre).
  const [eventsError, setEventsError] = useState<unknown>(null)
  const [eventsTry, setEventsTry] = useState(0)
  useEffect(() => {
    focus(sessionId)
    useNav.getState().visit(sessionId)
    setEventsError(null)
    // Si la sesión no está (archivada o borrada), lo dice la página.
    void loadEvents(sessionId).catch((err: unknown) => useStore.getState().sessions[sessionId] && setEventsError(err))
    return () => focus(null)
  }, [sessionId, focus, loadEvents, eventsTry])

  // Pegado al final mientras llegan mensajes, salvo que hayas scrolleado hacia arriba. La primera
  // vez que hay mensajes, si la dejaste leyendo más arriba, vuelve a esa posición.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !events) return
    const spot = remembered.current
    if (spot && !spot.atEnd) {
      remembered.current = undefined
      el.scrollTop = spot.top
      setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 140)
      return
    }
    remembered.current = undefined
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
    const spot = scrollSpot(el)
    stick.current = spot.atEnd
    scrollMemory.set(sessionId, spot)
    if (spot.atEnd) setShowJump(false)
  }

  const jump = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    scrollMemory.set(sessionId, { atEnd: true })
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    setShowJump(false)
  }

  // "Ir a lo último" desde el atajo o la paleta.
  const firstJump = useRef(jumpSignal)
  useEffect(() => {
    if (jumpSignal !== firstJump.current) jump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSignal])

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

  if (!session || !project) return <MissingSession projectId={projectId} sessionId={sessionId} />

  const isOrch = session.kind === "orchestrator"
  const running = session.status !== "stopped" && session.status !== "error"
  const act = (key: string, fn: () => Promise<unknown>) => action.run(key, fn)

  const panel = <SessionPanel session={session} project={project} />
  const subtitle = [
    project.name,
    isOrch ? session.name : session.role,
    session.costUsd > 0 ? usd(session.costUsd) : null,
    session.tokens && session.tokens.total > 0 ? `${tokens(session.tokens.total)} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const terminalTarget = { sessionId: session.id, projectId: project.id }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={isOrch ? <Compass className="size-4.5 shrink-0" /> : undefined}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="name min-w-0 truncate" title={isOrch ? "Orquestadora" : session.name}>
              {isOrch ? "Orquestadora" : session.name}
            </span>
            <StatusPill session={session} className="shrink-0" />
          </span>
        }
        subtitle={
          <span title={subtitle}>
            <Link href={`/p/${project.id}`} className="hover:text-foreground hover:underline">
              {project.name}
            </Link>
            {subtitle.slice(project.name.length)}
          </span>
        }
        actions={
          <>
            {/* En pantallas chicas, modelo, contexto y terminal van al menú ⋯. */}
            <div className="hidden items-center gap-1.5 sm:flex">
              {events && (
                <span className="hidden lg:contents">
                  <SubagentsChip session={session} events={events} />
                </span>
              )}
              <ContextMeter session={session} />
              <ModelPicker session={session} />
            </div>
            {running ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.busy("run")}
                onClick={() => act("run", () => stopSession(session.id))}
                aria-label="Detener la sesión"
                title="Detener la sesión"
              >
                <Square />
                <span className="hidden sm:inline">Detener</span>
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy("run")}
                onClick={() => act("run", () => startSession(session.id))}
                aria-label="Reanudar la sesión"
                title="Reanudar la sesión"
              >
                <Play />
                <span className="hidden sm:inline">Reanudar</span>
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant={terminalOpen ? "secondary" : "ghost"}
                  className="hidden sm:inline-flex"
                  onClick={() => toggleTerminal(session.id)}
                  aria-label={terminalOpen ? "Esconder la terminal" : "Abrir la terminal"}
                  aria-pressed={terminalOpen}
                >
                  <SquareTerminal />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Terminal <Shortcut keys="ctrl+backtick" />
              </TooltipContent>
            </Tooltip>
            <Button size="icon-sm" variant="ghost" className="lg:hidden" onClick={() => setPanelOpen(true)} aria-label="Ver el panel de la sesión" title="Panel de la sesión">
              <PanelRight />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Más acciones" title="Más acciones">
                  <EllipsisVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto max-w-[calc(100vw-1.5rem)] min-w-56">
                <div className="sm:hidden">
                  {session.context && (
                    <DropdownMenuLabel className="flex items-center gap-2 font-normal text-muted-foreground">
                      <Ring value={session.context.tokens / session.context.max} />
                      Contexto: {Math.round((session.context.tokens / session.context.max) * 100)} % usado
                    </DropdownMenuLabel>
                  )}
                  <ModelSubmenu session={session} />
                  <DropdownMenuItem onClick={() => toggleTerminal(session.id)}>
                    <SquareTerminal />
                    {terminalOpen ? "Esconder la terminal" : "Abrir la terminal"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </div>
                <DropdownMenuItem onClick={() => renameSession(session.id)}>
                  <Pencil />
                  Renombrar
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openCompaction(session.id)} title="Compactar eligiendo qué queda…">
                  <Layers />
                  Compactar eligiendo qué queda…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openSessionTools(session.id)}>
                  <Blocks />
                  Herramientas de la sesión
                </DropdownMenuItem>
                {!isOrch && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => archiveSession(session.id)}>
                      <Archive />
                      Archivar sesión…
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
            <div className="relative flex min-h-0 flex-1 flex-col">
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
                {!events && eventsError ? (
                  <LoadError what="los mensajes" error={eventsError} onRetry={() => setEventsTry((n) => n + 1)} />
                ) : !events ? (
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
                className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-popover px-3 py-1.5 text-xs font-medium shadow-overlay hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <ArrowDown className="size-3.5" />
                Ir a lo último
              </button>
            )}
            </div>
            <Composer session={session} dropTarget={column} />
            <TerminalPanel session={session} />
          </div>
          <aside aria-label="Panel de la sesión" className="session-panel hidden w-[22rem] shrink-0 overflow-y-auto lg:block">
            {panel}
          </aside>
          </div>
        </FileRefScope>
      </TerminalTargetProvider>

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent className="session-panel gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:w-[22rem] data-[side=right]:sm:max-w-none">
          <SheetHeader className="border-b">
            <SheetTitle className="name truncate pr-8">{isOrch ? "Orquestadora" : session.name}</SheetTitle>
            <SheetDescription className="sr-only">El panel de la sesión: tarea, resultados, cambios y detalles.</SheetDescription>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>

    </div>
  )
}

/**
 * La sesión no está entre las abiertas: si está archivada, se puede restaurar desde acá mismo;
 * si no, no existe (o se borró del dashboard).
 */
function MissingSession({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [archived, setArchived] = useState<Session | null | undefined>(undefined)
  const [error, setError] = useState<unknown>(null)
  const action = useAction()
  const [, navigate] = useLocation()
  const load = useCallback(() => {
    setError(null)
    api.archivedSessions(projectId).then(
      (list) => setArchived(list.find((s) => s.id === sessionId) ?? null),
      (err: unknown) => setError(err)
    )
  }, [projectId, sessionId])
  useEffect(load, [load])
  const restore = (s: Session) =>
    action.run("restore", async () => {
      try {
        await api.restoreSession(s.id)
        toast.success("Sesión restaurada")
      } catch (err) {
        toast.error("No se pudo restaurar la sesión", { description: err instanceof Error ? err.message : String(err) })
      }
    })
  if (error) return <LoadError what="la sesión" error={error} onRetry={load} className="m-auto" />
  if (archived === undefined)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    )
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>{archived ? <><span className="name">{archived.name}</span> está archivada</> : "Esta sesión no existe"}</EmptyTitle>
        <EmptyDescription>
          {archived
            ? "Restaurala para volver a verla en el tablero y seguir la conversación."
            : "Puede que se haya borrado del dashboard."}
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex gap-2">
        {archived && (
          <Button size="sm" disabled={action.busy("restore")} onClick={() => void restore(archived)}>
            {action.busy("restore") ? <Spinner /> : <RotateCcw />}
            Restaurar
          </Button>
        )}
        <Button size="sm" variant={archived ? "ghost" : "outline"} onClick={() => navigate(`/p/${projectId}`)}>
          Ir al proyecto
        </Button>
      </div>
    </Empty>
  )
}
