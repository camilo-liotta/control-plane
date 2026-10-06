import { Bell, BellOff, BellRing, Blocks, ChevronRight, Inbox, Monitor, Moon, Plus, Search, Sun } from "lucide-react"
import { useEffect, useMemo } from "react"
import { toast } from "sonner"
import { Link, useLocation } from "wouter"

import { draftWaits, inboxCounts, sessionWaits, taskWaits } from "@shared/inbox-count"
import type { Project, Session } from "@shared/types"

import { AccountSwitcher } from "@/components/accounts"
import { GithubMark } from "@/components/github-mark"
import { SettingsMenu } from "@/components/settings-menu"
import { SoundsMenu } from "@/components/sounds-menu"
import { Lamp, SessionLamp } from "@/components/status"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { UsageMeter } from "@/components/usage-meter"
import { inDesktop, requestNotifications, setOsNotificationsEnabled, systemNotification, trayIconPlace, useNotifications } from "@/lib/notify"
import { openDrafts, projectSessions, useProjects, useStore } from "@/lib/store"
import { useNav } from "@/lib/nav"
import { useUi } from "@/lib/ui"
import { Shortcut } from "@/components/ui/kbd"
import { toneSoft } from "@/lib/status"
import { cn } from "@/lib/utils"

/** Marca: la orquestadora (un punto adentro de un aro) y sus 6 sesiones, en la versión simplificada del ícono (se lee a 18–24 px). */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M8 5.25 8 4.25M10.38 6.62l.87-.5M10.38 9.38l.87.5M8 10.75v1M5.62 9.38l-.87.5M5.62 6.62l-.87-.5"
        stroke="currentColor"
        strokeWidth=".75"
        strokeLinecap="round"
        opacity=".6"
      />
      <circle cx="8" cy="2.8" r="1.45" fill="currentColor" />
      <circle cx="12.5" cy="5.4" r="1.45" fill="currentColor" />
      <circle cx="12.5" cy="10.6" r="1.45" fill="currentColor" />
      <circle cx="8" cy="13.2" r="1.45" fill="currentColor" />
      <circle cx="3.5" cy="10.6" r="1.45" fill="currentColor" />
      <circle cx="3.5" cy="5.4" r="1.45" fill="currentColor" />
      <circle cx="8" cy="8" r="2.3" stroke="currentColor" strokeWidth=".9" />
      <circle cx="8" cy="8" r="1.05" fill="currentColor" />
    </svg>
  )
}

function SessionLink({ session, active }: { session: Session; active: boolean }) {
  const unread = useStore((s) => s.unread[session.id] ?? 0)
  const name = session.kind === "orchestrator" ? "Orquestadora" : session.name
  // Si te necesita, ya lo dice la luz: no se suma el punto de no leído.
  const showUnread = unread > 0 && session.status !== "needs_input"
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active} className="h-7 text-ui">
        <Link href={`/p/${session.projectId}/s/${session.id}`} title={name}>
          <SessionLamp session={session} className="shrink-0" />
          <span className={cn("name min-w-0 flex-1 truncate", session.kind === "orchestrator" && "text-muted-foreground", showUnread && "text-foreground")}>
            {name}
          </span>
          {showUnread && (
            <span className="size-1.5 shrink-0 rounded-full bg-foreground/70">
              <span className="sr-only">, mensajes sin leer</span>
            </span>
          )}
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

function ProjectMenu({ project }: { project: Project }) {
  const [location] = useLocation()
  const sessions = useStore((s) => s.sessions)
  const drafts = useStore((s) => s.drafts)
  const setUi = useUi((s) => s.set)
  // Plegado o no, se recuerda entre recargas.
  const open = !useNav((s) => s.folded[project.id])
  const setOpen = (v: boolean) => useNav.getState().setFolded(project.id, !v)
  const { orchestrator, workers } = projectSessions(sessions, project.id)
  const ready = openDrafts(drafts, project.id).filter((d) => d.state === "ready").length
  const needs = [orchestrator, ...workers].filter((s) => s?.status === "needs_input").length
  const base = `/p/${project.id}`

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={open ? `Ocultar las sesiones de ${project.name}` : `Mostrar las sesiones de ${project.name}`}
            className="absolute top-1.5 left-1 z-10 flex size-5 items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <ChevronRight className="size-3.5 transition-transform data-[open=true]:rotate-90" data-open={open} />
          </button>
        </CollapsibleTrigger>
        <SidebarMenuButton asChild isActive={location === base} className="h-8 pl-7 text-ui">
          <Link href={base} title={`${project.name} · ${project.repoPath}`}>
            <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
            {/* Plegado, que se vea igual si alguna sesión te necesita. */}
            {!open && needs > 0 && <Lamp tone="attention" label={`${needs} ${needs === 1 ? "te necesita" : "te necesitan"}`} className="shrink-0" />}
          </Link>
        </SidebarMenuButton>
        {ready > 0 && (
          <SidebarMenuBadge
            className={cn("right-1.5 rounded-full px-1.5 text-2xs font-semibold", toneSoft.pending, "group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0")}
          >
            {ready}
            <span className="sr-only">{ready === 1 ? " propuesta lista" : " propuestas listas"}</span>
          </SidebarMenuBadge>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarMenuAction showOnHover aria-label={`Nueva sesión en ${project.name}`} onClick={() => setUi({ newSessionFor: project.id })}>
              <Plus />
            </SidebarMenuAction>
          </TooltipTrigger>
          <TooltipContent side="right">Nueva sesión</TooltipContent>
        </Tooltip>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 ml-3.5 gap-0.5 pr-0 pl-2">
            {orchestrator && <SessionLink session={orchestrator} active={location === `${base}/s/${orchestrator.id}`} />}
            {workers.map((w) => (
              <SessionLink key={w.id} session={w} active={location === `${base}/s/${w.id}`} />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light"
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor
  const label = theme === "light" ? "Tema claro" : theme === "dark" ? "Tema oscuro" : "Tema del sistema"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setTheme(next)}
          className="rounded-md p-1.5 text-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label={label}
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Dentro de la app de escritorio: los avisos del sistema son de ella. */
function DesktopNotificationsMenu() {
  const label = "Avisos del sistema: los manda la app de escritorio"
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="rounded-md p-1.5 text-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              aria-label={label}
            >
              <Bell className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start" className="w-80 gap-3 p-3.5">
        <div>
          <p className="text-sm font-medium">Avisos del sistema</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            Los manda la app de escritorio cuando una sesión te necesita, hay propuestas listas o algo va a compactarse.
            Los prendés o apagás desde {trayIconPlace()} → Avisos.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function NotificationsMenu() {
  if (inDesktop()) return <DesktopNotificationsMenu />
  return <BrowserNotificationsMenu />
}

function BrowserNotificationsMenu() {
  const { permission, enabled } = useNotifications()
  const desktop = useStore((s) => s.desktopConnected)
  if (permission === "unsupported") return null
  const on = permission === "granted" && enabled
  const Icon = on ? BellRing : permission === "denied" || !enabled ? BellOff : Bell
  const label = desktop
    ? "Avisos del sistema: los manda la app de escritorio"
    : on
      ? "Avisos del sistema: activados"
      : permission === "denied"
        ? "Avisos del sistema: bloqueados por el navegador"
        : permission === "default"
          ? "Avisos del sistema: sin activar"
          : "Avisos del sistema: apagados"

  const allow = async () => {
    const result = await requestNotifications()
    if (result === "granted") {
      setOsNotificationsEnabled(true)
      test()
    } else if (result === "denied") toast.error("El navegador bloqueó los avisos", { description: "Mirá abajo cómo permitirlos." })
  }
  const test = () => {
    const ok = systemNotification("Aviso de prueba de control-plane", "Así te vamos a avisar cuando una sesión te necesite.")
    toast.success(ok ? "Aviso de prueba enviado" : "El navegador no dejó mostrar el aviso", {
      description: ok
        ? "Si no lo ves, revisá los ajustes de notificaciones del sistema para tu navegador."
        : "Revisá el permiso de notificaciones del sitio.",
    })
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative rounded-md p-1.5 text-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                on && "text-foreground"
              )}
              aria-label={label}
            >
              <Icon className="size-4" />
              {permission === "denied" && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-status-error-lamp" />}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start" className="w-80 gap-3 p-3.5">
        <div>
          <p className="text-sm font-medium">Avisos del sistema</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            Una notificación del sistema cuando una sesión te necesita, hay propuestas listas o algo va a compactarse, si no
            estás mirando el dashboard.
          </p>
        </div>
        {desktop && (
          <p className="rounded-lg bg-muted p-2.5 text-xs leading-snug">
            La app de escritorio está conectada: los avisos del sistema los manda ella. Cuando la cierres, vuelven a salir
            desde acá.
          </p>
        )}
        {permission === "granted" && (
          <>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{enabled ? "Activados" : "Apagados"}</span>
              <Switch checked={enabled} onCheckedChange={setOsNotificationsEnabled} aria-label="Avisos del sistema" />
            </label>
            {!desktop && (
              <Button size="sm" variant="outline" onClick={test} disabled={!enabled}>
                Probar un aviso
              </Button>
            )}
          </>
        )}
        {permission === "default" && (
          <Button size="sm" onClick={() => void allow()}>
            Permitir avisos
          </Button>
        )}
        {permission === "denied" && (
          <div className="space-y-1.5 rounded-lg bg-muted p-2.5 text-xs leading-snug">
            <p className="font-medium text-foreground">El navegador los tiene bloqueados para este sitio.</p>
            <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
              <li>Tocá el ícono a la izquierda de la dirección ({location.host}).</li>
              <li>En Notificaciones, elegí Permitir.</li>
              <li>Recargá la página.</li>
            </ol>
            <p className="text-muted-foreground">
              Si igual no aparecen, revisá que tu navegador tenga permiso en los ajustes de notificaciones del sistema.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Lo que hay en la Bandeja: lo que frena (te necesita) y lo que mirás cuando puedas (propuestas listas). */
export function useInboxParts() {
  const drafts = useStore((s) => s.drafts)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  // Las mismas reglas que el número del ícono de escritorio (inboxCounts), separadas por tono.
  return useMemo(() => {
    const ready = Object.values(drafts).filter(draftWaits).length
    const blocking = Object.values(sessions).filter(sessionWaits).length + Object.values(tasks).filter(taskWaits).length
    return { blocking, ready }
  }, [drafts, sessions, tasks])
}

/** El número de la Bandeja: el mismo que el del ícono de la app de escritorio. */
export function useInboxCount() {
  const drafts = useStore((s) => s.drafts)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  return useMemo(
    () => inboxCounts({ sessions: Object.values(sessions), drafts: Object.values(drafts), tasks: Object.values(tasks) }).total,
    [drafts, sessions, tasks]
  )
}

function NavLink({ icon: Icon, label, active, onClick, href, children }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active?: boolean
  onClick?: () => void
  href?: string
  children?: React.ReactNode
}) {
  const inner = (
    <>
      <Icon />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </>
  )
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild={Boolean(href)} isActive={active} onClick={onClick} className="h-8 text-ui">
        {href ? <Link href={href}>{inner}</Link> : inner}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  const projects = useProjects()
  const connected = useStore((s) => s.connected)
  const claudeVersion = useStore((s) => s.meta?.claudeVersion)
  const version = useStore((s) => s.meta?.version)
  const repoUrl = useStore((s) => s.meta?.repoUrl)
  const setUi = useUi((s) => s.set)
  const inbox = useInboxParts()
  const [location] = useLocation()
  // En móvil la barra es un panel encima de la página: se cierra al ir a otro lado.
  const { isMobile, setOpenMobile } = useSidebar()
  useEffect(() => {
    if (isMobile) setOpenMobile(false)
  }, [location, isMobile, setOpenMobile])

  return (
    <Sidebar variant="inset">
      <SidebarHeader className="gap-2 pb-1">
        <div className="flex h-8 items-center gap-2 px-2">
          <Link href="/" className="flex items-center gap-2 rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring" aria-label="Inicio">
            <Mark className="size-4.5" />
            <span className="brand-word">control-plane</span>
          </Link>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto flex size-5 items-center justify-center" tabIndex={0}>
                <Lamp tone={connected ? "done" : "error"} pulse={!connected} label={connected ? "Conectado al server local" : "Sin conexión con el server"} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{connected ? "Conectado al server local" : "Sin conexión con el server: reintentando…"}</TooltipContent>
          </Tooltip>
        </div>
        <AccountSwitcher />
        <button
          type="button"
          onClick={() => setUi({ palette: true })}
          className="flex h-8 items-center gap-2 rounded-lg bg-background px-2.5 text-ui text-muted-foreground shadow-raised transition-colors outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <Search className="size-4" />
          Buscar…
          <Shortcut keys="mod+k" className="ml-auto" />
        </button>
        <SidebarMenu className="gap-0.5 pt-1">
          <NavLink icon={Inbox} label="Bandeja" onClick={() => setUi({ inbox: true })}>
            {inbox.blocking + inbox.ready > 0 && (
              <span
                className={cn(
                  "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-2xs font-semibold",
                  inbox.blocking > 0 ? toneSoft.attention : toneSoft.pending
                )}
              >
                {inbox.blocking + inbox.ready}
                <span className="sr-only">
                  {inbox.blocking > 0 ? `, ${inbox.blocking} te ${inbox.blocking === 1 ? "necesita" : "necesitan"}` : ""}
                  {inbox.ready > 0 ? `, ${inbox.ready} ${inbox.ready === 1 ? "propuesta lista" : "propuestas listas"}` : ""}
                </span>
              </span>
            )}
          </NavLink>
          <NavLink icon={Blocks} label="Herramientas" href="/tools" active={location.endsWith("/tools")} />
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-1">
          <SidebarGroupLabel className="eyebrow">Proyectos</SidebarGroupLabel>
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarGroupAction aria-label="Nuevo proyecto" onClick={() => setUi({ newProject: true })}>
                <Plus />
              </SidebarGroupAction>
            </TooltipTrigger>
            <TooltipContent side="right">Nuevo proyecto</TooltipContent>
          </Tooltip>
          <SidebarMenu className="gap-0.5">
            {projects.map((p) => (
              <ProjectMenu key={p.id} project={p} />
            ))}
            {projects.length === 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setUi({ newProject: true })} className="text-ui text-muted-foreground">
                  <Plus />
                  <span>Crear el primero</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-3">
        <UsageMeter />
        <div className="flex items-center gap-1 px-1">
          <ThemeToggle />
          <NotificationsMenu />
          <SoundsMenu />
          <SettingsMenu />
          {repoUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto rounded-md p-1.5 text-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  aria-label="control-plane en GitHub"
                >
                  <GithubMark className="size-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent>control-plane en GitHub</TooltipContent>
            </Tooltip>
          )}
        </div>
        {(version || claudeVersion) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p tabIndex={0} className="-mt-2 truncate rounded-md px-2 font-mono text-2xs text-muted-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring">
                {version && <span className="text-foreground/80">v{version}</span>}
                {version && claudeVersion && " · "}
                {claudeVersion && <span>claude {claudeVersion}</span>}
              </p>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              {version && <p>control-plane v{version}</p>}
              {claudeVersion && <p>Claude Code {claudeVersion}</p>}
            </TooltipContent>
          </Tooltip>
        )}
      </SidebarFooter>
    </Sidebar>
  )
}
