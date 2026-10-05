import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import { adjacentSession, needsYou, needsYouHref, nextNeedsYou } from "@shared/navigation"
import { EscCounter, keysFor, matchShortcut, OTHER_SHORTCUTS, SHORTCUTS } from "@shared/shortcuts"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { isEditable, inTerminal } from "@/lib/edit-keys"
import { isMac } from "@/lib/nav"
import { interruptSession, jumpToEnd } from "@/lib/session-actions"
import { useProjects, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

/** Dónde estás: el proyecto y la sesión de la ruta. */
export function routeIds(location: string): { projectId: string | null; sessionId: string | null } {
  const m = /^\/p\/([^/]+)(?:\/s\/([^/]+))?/.exec(location)
  return { projectId: m?.[1] ?? null, sessionId: m?.[2] ?? null }
}

/** Algo abierto encima (diálogo, menú, lista): un Esc es para cerrarlo, no para interrumpir. */
const overlayOpen = () => document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null

/**
 * Los atajos globales (ver shared/shortcuts.ts). Escucha en `window` en la fase de burbuja: lo que
 * ya usó otro (el menú de comandos del composer, un diálogo que se cierra con Esc) llega con
 * `defaultPrevented` y no cuenta.
 */
export function GlobalShortcuts() {
  const [location, navigate] = useLocation()
  const projects = useProjects()
  const here = useRef({ location, projectIds: new Set<string>() })
  here.current = { location, projectIds: new Set(projects.map((p) => p.id)) }
  const esc = useRef(new EscCounter(1000))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctx = { mac: isMac, editable: isEditable(e.target), terminal: inTerminal(e.target) }
      const id = matchShortcut(e, ctx)
      if (id !== "interrupt") esc.current.reset()
      if (!id) return
      const { location: loc, projectIds } = here.current
      const { projectId, sessionId } = routeIds(loc)
      const { sessions, drafts, tasks } = useStore.getState()
      const setUi = useUi.getState().set

      switch (id) {
        case "palette":
          e.preventDefault()
          setUi({ palette: !useUi.getState().palette })
          return
        case "help":
          e.preventDefault()
          setUi({ shortcuts: true, palette: false })
          return
        case "prev-session":
        case "next-session": {
          if (!projectId) return
          e.preventDefault()
          const to = adjacentSession(Object.values(sessions), projectId, sessionId, id === "next-session" ? 1 : -1)
          if (to) navigate(`/p/${to.projectId}/s/${to.id}`)
          return
        }
        case "next-needs-you": {
          e.preventDefault()
          const list = needsYou({ sessions: Object.values(sessions), drafts: Object.values(drafts), tasks: Object.values(tasks), projectIds })
          const to = nextNeedsYou(list, loc)
          if (!to) {
            toast.message(list.length ? "No hay otra que te necesite" : "Ninguna sesión te necesita ahora", { id: "next-needs-you" })
            return
          }
          if (to.kind === "proposals") setUi({ reveal: { kind: "proposals", id: to.orchestratorId, at: Date.now() } })
          if (to.kind === "task") setUi({ reveal: { kind: "tasks", id: to.task.projectId, at: Date.now() } })
          navigate(needsYouHref(to))
          return
        }
        case "jump-to-end":
          if (!sessionId) return
          e.preventDefault()
          jumpToEnd()
          return
        case "interrupt": {
          const session = sessionId ? sessions[sessionId] : undefined
          if (e.defaultPrevented || overlayOpen() || session?.status !== "working") {
            esc.current.reset()
            return
          }
          if (esc.current.press(Date.now()) === "arm") {
            toast.message("Esc otra vez para interrumpir el turno", { id: "esc-interrupt", duration: 1000 })
            return
          }
          e.preventDefault()
          toast.dismiss("esc-interrupt")
          void interruptSession(session.id)
          return
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate])

  return <ShortcutsDialog />
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <KbdGroup>
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </KbdGroup>
  )
}

/** La ayuda: todos los atajos, con las teclas de este sistema. */
function ShortcutsDialog() {
  const open = useUi((s) => s.shortcuts)
  const setUi = useUi((s) => s.set)
  const rows: { label: string; where?: string; keys: { linux: string[]; mac: string[] } }[] = [...SHORTCUTS, ...OTHER_SHORTCUTS]
  return (
    <Dialog open={open} onOpenChange={(v) => setUi({ shortcuts: v })}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Atajos de teclado</DialogTitle>
          <DialogDescription>
            Andan también con el foco en el composer, salvo los de una tecla sola. En la terminal, las teclas son de la shell.
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y text-sm">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                {r.label}
                {r.where && <span className="block text-xs text-muted-foreground">{r.where}</span>}
              </span>
              <Keys keys={keysFor(r, isMac)} />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
