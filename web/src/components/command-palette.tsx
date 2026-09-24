import { Compass, FolderGit2, Inbox, Plus } from "lucide-react"
import { useEffect } from "react"
import { useLocation } from "wouter"

import { SessionLamp } from "@/components/status"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { projectSessions, useProjects, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

/** Ctrl/⌘ K: saltar a cualquier proyecto o sesión. */
export function CommandPalette() {
  const open = useUi((s) => s.palette)
  const setUi = useUi((s) => s.set)
  const projects = useProjects()
  const sessions = useStore((s) => s.sessions)
  const [, navigate] = useLocation()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setUi({ palette: !useUi.getState().palette })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setUi])

  const go = (href: string) => {
    setUi({ palette: false })
    navigate(href)
  }

  return (
    <CommandDialog open={open} onOpenChange={(v) => setUi({ palette: v })} title="Ir a…" description="Buscá un proyecto o una sesión">
      <CommandInput placeholder="Buscá un proyecto o una sesión…" />
      <CommandList>
        <CommandEmpty>No hay coincidencias.</CommandEmpty>
        {projects.map((p) => {
          const { orchestrator, workers } = projectSessions(sessions, p.id)
          return (
            <CommandGroup key={p.id} heading={p.name}>
              <CommandItem value={`${p.name} tablero`} onSelect={() => go(`/p/${p.id}`)}>
                <FolderGit2 />
                Tablero de {p.name}
              </CommandItem>
              {orchestrator && (
                <CommandItem value={`${p.name} orquestadora ${orchestrator.name}`} onSelect={() => go(`/p/${p.id}/s/${orchestrator.id}`)}>
                  <Compass />
                  Orquestadora
                </CommandItem>
              )}
              {workers.map((w) => (
                <CommandItem key={w.id} value={`${p.name} ${w.name} ${w.role}`} onSelect={() => go(`/p/${p.id}/s/${w.id}`)}>
                  <SessionLamp session={w} className="mx-1" />
                  <span className="font-mono">{w.name}</span>
                  {w.role && <span className="truncate text-muted-foreground">{w.role}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )
        })}
        <CommandSeparator />
        <CommandGroup heading="Acciones">
          <CommandItem onSelect={() => setUi({ palette: false, inbox: true })}>
            <Inbox />
            Abrir la bandeja
          </CommandItem>
          <CommandItem onSelect={() => setUi({ palette: false, newProject: true })}>
            <Plus />
            Nuevo proyecto
          </CommandItem>
          {projects.map((p) => (
            <CommandItem key={p.id} value={`nueva sesión ${p.name}`} onSelect={() => setUi({ palette: false, newSessionFor: p.id })}>
              <Plus />
              Nueva sesión en {p.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
