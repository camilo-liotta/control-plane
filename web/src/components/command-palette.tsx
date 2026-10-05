import {
  Archive,
  ArrowDownToLine,
  Blocks,
  ClipboardList,
  Compass,
  FolderGit2,
  Import,
  Inbox,
  Keyboard,
  Layers,
  Monitor,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings2,
  Square,
  SquareTerminal,
  Sun,
  UserRound,
  Users,
} from "lucide-react"
import { useMemo } from "react"
import { useLocation } from "wouter"

import { needsYou, needsYouHref, type NeedsYou } from "@shared/navigation"
import type { Session } from "@shared/types"

import { appAction, appIsRunning } from "@/components/project-apps"
import { routeIds } from "@/components/shortcuts"
import { SessionLamp } from "@/components/status"
import { useTheme } from "@/components/theme-provider"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { isMac, useNav } from "@/lib/nav"
import {
  archiveSession,
  interruptSession,
  jumpToEnd,
  openCompaction,
  openSessionTools,
  renameSession,
  startSession,
  stopSession,
  toggleTerminal,
} from "@/lib/session-actions"
import { projectSessions, useAccounts, useCurrentAccount, useProjects, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { shortcutText } from "@shared/shortcuts"

const sessionLabel = (s: Session) => (s.kind === "orchestrator" ? "Orquestadora" : s.name)

/**
 * Ctrl/⌘ K: el centro de comandos. Arriba lo que te necesita y lo reciente; después lo que se puede
 * hacer en la sesión y en el proyecto donde estás, ir a cualquier lado y lo general. Cada acción
 * llama a la misma función que su botón (session-actions.ts, appAction, los diálogos de useUi).
 * El atajo lo maneja GlobalShortcuts.
 */
export function CommandPalette() {
  const open = useUi((s) => s.palette)
  const setUi = useUi((s) => s.set)
  const projects = useProjects()
  const sessions = useStore((s) => s.sessions)
  const drafts = useStore((s) => s.drafts)
  const tasks = useStore((s) => s.tasks)
  const apps = useStore((s) => s.apps)
  const recent = useNav((s) => s.recent)
  const accounts = useAccounts()
  const account = useCurrentAccount()
  const { setTheme } = useTheme()
  const [location, navigate] = useLocation()
  const { projectId, sessionId } = routeIds(location)
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined
  const session = sessionId ? sessions[sessionId] : undefined
  const projectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects])
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? ""

  const pending = useMemo(
    () => (open ? needsYou({ sessions: Object.values(sessions), drafts: Object.values(drafts), tasks: Object.values(tasks), projectIds }) : []),
    [open, sessions, drafts, tasks, projectIds]
  )
  const recents = recent
    .map((id) => sessions[id])
    .filter((s): s is Session => Boolean(s && !s.archivedAt && projectIds.has(s.projectId) && s.id !== sessionId))
    .slice(0, 5)

  /** Cierra la paleta y hace lo que se eligió (después, para que el foco no vuelva a la paleta). */
  const run = (fn: () => unknown) => () => {
    setUi({ palette: false })
    requestAnimationFrame(() => void fn())
  }
  const go = (href: string) => run(() => navigate(href))
  const goNeeds = (n: NeedsYou) =>
    run(() => {
      if (n.kind === "proposals") setUi({ reveal: { kind: "proposals", id: n.orchestratorId, at: Date.now() } })
      if (n.kind === "task") setUi({ reveal: { kind: "tasks", id: n.task.projectId, at: Date.now() } })
      navigate(needsYouHref(n))
    })

  const running = session && session.status !== "stopped" && session.status !== "error"
  const projectApps = projectId ? (apps[projectId] ?? []) : []

  return (
    <CommandDialog open={open} onOpenChange={(v) => setUi({ palette: v })} title="Paleta de comandos" description="Buscá una sesión, un proyecto o una acción">
      <CommandInput placeholder="Buscá una sesión, un proyecto o una acción…" />
      <CommandList>
        <CommandEmpty>No hay coincidencias.</CommandEmpty>

        {pending.length > 0 && (
          <CommandGroup heading="Te necesitan">
            {pending.map((n) =>
              n.kind === "session" ? (
                <CommandItem key={`n-${n.session.id}`} value={`te necesita ${n.session.name} ${projectName(n.session.projectId)}`} onSelect={goNeeds(n)}>
                  <SessionLamp session={n.session} className="mx-1" />
                  <span className="font-mono">{sessionLabel(n.session)}</span>
                  <span className="truncate text-muted-foreground">{n.session.statusDetail ?? "te necesita"} · {projectName(n.session.projectId)}</span>
                </CommandItem>
              ) : n.kind === "proposals" ? (
                <CommandItem key={`p-${n.projectId}`} value={`propuestas listas ${projectName(n.projectId)}`} onSelect={goNeeds(n)}>
                  <Compass />
                  {n.count === 1 ? "1 propuesta lista" : `${n.count} propuestas listas`}
                  <span className="truncate text-muted-foreground">· {projectName(n.projectId)}</span>
                </CommandItem>
              ) : (
                <CommandItem key={`t-${n.task.id}`} value={`tarea ${n.task.title} ${projectName(n.task.projectId)}`} onSelect={goNeeds(n)}>
                  <ClipboardList />
                  <span className="truncate">{n.task.title}</span>
                  <span className="shrink-0 text-muted-foreground">· te espera</span>
                </CommandItem>
              )
            )}
          </CommandGroup>
        )}

        {recents.length > 0 && (
          <CommandGroup heading="Recientes">
            {recents.map((s) => (
              <CommandItem key={`r-${s.id}`} value={`reciente ${s.name} ${s.role} ${projectName(s.projectId)}`} onSelect={go(`/p/${s.projectId}/s/${s.id}`)}>
                <SessionLamp session={s} className="mx-1" />
                <span className="font-mono">{sessionLabel(s)}</span>
                <span className="truncate text-muted-foreground">{projectName(s.projectId)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {session && (
          <CommandGroup heading={`Esta sesión · ${sessionLabel(session)}`}>
            {session.status === "working" && (
              <CommandItem value="interrumpir el turno" onSelect={run(() => interruptSession(session.id))}>
                <Pause />
                Interrumpir el turno
                <CommandShortcut>Esc Esc</CommandShortcut>
              </CommandItem>
            )}
            {running ? (
              <CommandItem value="detener la sesión" onSelect={run(() => stopSession(session.id))}>
                <Square />
                Detener la sesión
              </CommandItem>
            ) : (
              <CommandItem value="reanudar la sesión" onSelect={run(() => startSession(session.id))}>
                <Play />
                Reanudar la sesión
              </CommandItem>
            )}
            <CommandItem value="ir a lo último del chat" onSelect={run(jumpToEnd)}>
              <ArrowDownToLine />
              Ir a lo último del chat
              <CommandShortcut>{shortcutText("jump-to-end", isMac)}</CommandShortcut>
            </CommandItem>
            <CommandItem value="terminal de la sesión" onSelect={run(() => toggleTerminal(session.id))}>
              <SquareTerminal />
              Abrir o esconder la terminal
              <CommandShortcut>{isMac ? "⌃`" : "Ctrl+`"}</CommandShortcut>
            </CommandItem>
            <CommandItem value="renombrar la sesión" onSelect={run(() => renameSession(session.id))}>
              <Pencil />
              Renombrar
            </CommandItem>
            <CommandItem value="compactar eligiendo qué queda" onSelect={run(() => openCompaction(session.id))}>
              <Layers />
              Compactar eligiendo qué queda…
            </CommandItem>
            <CommandItem value="herramientas de la sesión mcp skills plugins" onSelect={run(() => openSessionTools(session.id))}>
              <Blocks />
              Herramientas de la sesión
            </CommandItem>
            {session.kind === "worker" && (
              <CommandItem value="archivar la sesión" onSelect={run(() => archiveSession(session.id))}>
                <Archive />
                Archivar la sesión…
              </CommandItem>
            )}
          </CommandGroup>
        )}

        {project && (
          <CommandGroup heading={`Este proyecto · ${project.name}`}>
            <CommandItem value={`nueva sesión en ${project.name}`} onSelect={run(() => setUi({ newSessionFor: project.id }))}>
              <Plus />
              Nueva sesión en {project.name}
            </CommandItem>
            {location !== `/p/${project.id}` && (
              <CommandItem value={`tablero de ${project.name}`} onSelect={go(`/p/${project.id}`)}>
                <FolderGit2 />
                Tablero
              </CommandItem>
            )}
            <CommandItem value={`ajustes del proyecto ${project.name}`} onSelect={run(() => setUi({ settingsFor: project.id }))}>
              <Settings2 />
              Ajustes del proyecto
            </CommandItem>
            <CommandItem value={`importar una sesión a ${project.name}`} onSelect={run(() => setUi({ importFor: project.id }))}>
              <Import />
              Importar una sesión…
            </CommandItem>
            <CommandItem value={`herramientas del proyecto ${project.name}`} onSelect={go(`/p/${project.id}/tools`)}>
              <Blocks />
              Herramientas del proyecto
            </CommandItem>
            <CommandItem
              value={`sesiones archivadas de ${project.name}`}
              onSelect={run(() => {
                setUi({ reveal: { kind: "archived", id: project.id, at: Date.now() } })
                navigate(`/p/${project.id}`)
              })}
            >
              <Archive />
              Sesiones archivadas
            </CommandItem>
            {projectApps.map((a) => {
              const up = appIsRunning(a)
              return (
                <CommandItem key={`app-${a.id}`} value={`${up ? "bajar" : "levantar"} app ${a.name}`} onSelect={run(() => appAction(a.id, up ? "stop" : "start"))}>
                  {up ? <Square /> : <Play />}
                  {up ? "Bajar" : "Levantar"} {a.name}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        <CommandSeparator />
        {projects.map((p) => {
          const { orchestrator, workers } = projectSessions(sessions, p.id)
          return (
            <CommandGroup key={p.id} heading={`Ir a · ${p.name}`}>
              <CommandItem value={`${p.name} tablero`} onSelect={go(`/p/${p.id}`)}>
                <FolderGit2 />
                Tablero de {p.name}
              </CommandItem>
              {orchestrator && (
                <CommandItem value={`${p.name} orquestadora ${orchestrator.name}`} onSelect={go(`/p/${p.id}/s/${orchestrator.id}`)}>
                  <Compass />
                  Orquestadora
                </CommandItem>
              )}
              {workers.map((w) => (
                <CommandItem key={w.id} value={`${p.name} ${w.name} ${w.role}`} onSelect={go(`/p/${p.id}/s/${w.id}`)}>
                  <SessionLamp session={w} className="mx-1" />
                  <span className="font-mono">{w.name}</span>
                  {w.role && <span className="truncate text-muted-foreground">{w.role}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )
        })}

        <CommandSeparator />
        <CommandGroup heading="General">
          <CommandItem value="abrir la bandeja" onSelect={run(() => setUi({ inbox: true }))}>
            <Inbox />
            Abrir la Bandeja
          </CommandItem>
          <CommandItem value="nuevo proyecto" onSelect={run(() => setUi({ newProject: true }))}>
            <Plus />
            Nuevo proyecto
          </CommandItem>
          {projects
            .filter((p) => p.id !== project?.id)
            .map((p) => (
              <CommandItem key={`ns-${p.id}`} value={`nueva sesión en ${p.name}`} onSelect={run(() => setUi({ newSessionFor: p.id }))}>
                <Plus />
                Nueva sesión en {p.name}
              </CommandItem>
            ))}
          <CommandItem value="herramientas skills plugins mcp clis" onSelect={go("/tools")}>
            <Blocks />
            Herramientas
          </CommandItem>
          <CommandItem value="cuentas de claude code" onSelect={run(() => setUi({ accountsDialog: true }))}>
            <Users />
            Cuentas…
          </CommandItem>
          {accounts.length > 1 &&
            accounts
              .filter((a) => a.id !== account?.id)
              .map((a) => (
                <CommandItem key={`acc-${a.id}`} value={`cambiar a la cuenta ${a.name}`} onSelect={run(() => useUi.getState().selectAccount(a.id))}>
                  <UserRound />
                  Cambiar a la cuenta {a.name}
                </CommandItem>
              ))}
          <CommandItem value="tema claro" onSelect={run(() => setTheme("light"))}>
            <Sun />
            Tema claro
          </CommandItem>
          <CommandItem value="tema oscuro" onSelect={run(() => setTheme("dark"))}>
            <Moon />
            Tema oscuro
          </CommandItem>
          <CommandItem value="tema del sistema" onSelect={run(() => setTheme("system"))}>
            <Monitor />
            Tema del sistema
          </CommandItem>
          <CommandItem value="atajos de teclado ayuda" onSelect={run(() => setUi({ shortcuts: true }))}>
            <Keyboard />
            Atajos de teclado
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
