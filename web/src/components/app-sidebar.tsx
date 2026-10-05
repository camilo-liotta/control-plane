import { Bell, BellOff, BellRing, Blocks, ChevronRight, Compass, Inbox, Monitor, Moon, Plus, Search, Sun } from "lucide-react"
import { useEffect } from "react"
import { toast } from "sonner"
import { Link, useLocation } from "wouter"

import type { Project, Session } from "@shared/types"

import { AccountSwitcher } from "@/components/accounts"
import { GithubMark } from "@/components/github-mark"
import { SettingsMenu } from "@/components/settings-menu"
import { SoundsMenu } from "@/components/sounds-menu"
import { SessionLamp } from "@/components/status"
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
import { isMac, useNav } from "@/lib/nav"
import { useUi } from "@/lib/ui"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
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
  const attention = session.status === "needs_input"
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        <Link href={`/p/${session.projectId}/s/${session.id}`}>
          {session.kind === "orchestrator" ? (
            <Compass className="!size-3.5" />
          ) : (
            <SessionLamp session={session} className="ml-0.5" />
          )}
          <span className={cn("name truncate text-ui", unread > 0 && "font-semibold")}>
            {session.kind === "orchestrator" ? "Orquestadora" : session.name}
          </span>
          {session.kind === "orchestrator" && <SessionLamp session={session} className="ml-auto" />}
          {session.kind === "worker" && !attention && unread > 0 && <span className="ml-auto size-1.5 rounded-full bg-foreground/60" />}
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
  const base = `/p/${project.id}`

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={location === base} tooltip={project.repoPath}>
          <Link href={base}>
            <span className="truncate font-medium">{project.name}</span>
          </Link>
        </SidebarMenuButton>
        {ready > 0 && (
          <SidebarMenuBadge className="right-7 bg-status-attention/15 font-mono text-status-attention">{ready}</SidebarMenuBadge>
        )}
        <CollapsibleTrigger asChild>
          <SidebarMenuAction className="transition-transform data-[state=open]:rotate-90" aria-label="Mostrar sesiones">
            <ChevronRight />
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {orchestrator && <SessionLink session={orchestrator} active={location === `${base}/s/${orchestrator.id}`} />}
            {workers.map((w) => (
              <SessionLink key={w.id} session={w} active={location === `${base}/s/${w.id}`} />
            ))}
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                asChild
                className="text-muted-foreground"
              >
                <button type="button" onClick={() => setUi({ newSessionFor: project.id })}>
                  <Plus className="!size-3.5" />
                  <span>Nueva sesión</span>
                </button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
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
          className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
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
              className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
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
    toast.success(ok ? "Mandé un aviso de prueba" : "El navegador no dejó mostrar el aviso", {
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
                "relative rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                on && "text-foreground"
              )}
              aria-label={label}
            >
              <Icon className="size-4" />
              {permission === "denied" && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-status-error" />}
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
          <p className="rounded-md border bg-muted/40 p-2.5 text-xs leading-snug">
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
          <div className="space-y-1.5 rounded-md border border-status-error/30 bg-status-error/5 p-2.5 text-xs leading-snug">
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

export function useInboxCount() {
  const drafts = useStore((s) => s.drafts)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const ready = Object.values(drafts).filter((d) => d.state === "ready").length
  const needs = Object.values(sessions).filter((s) => s.status === "needs_input").length
  // Las tareas que frenan a una sesión también esperan algo de vos.
  const waiting = Object.values(tasks).filter((t) => t.status === "open" && t.blocking).length
  return ready + needs + waiting
}

export function AppSidebar() {
  const projects = useProjects()
  const connected = useStore((s) => s.connected)
  const claudeVersion = useStore((s) => s.meta?.claudeVersion)
  const version = useStore((s) => s.meta?.version)
  const repoUrl = useStore((s) => s.meta?.repoUrl)
  const setUi = useUi((s) => s.set)
  const inbox = useInboxCount()
  const [location] = useLocation()
  // En móvil la barra es un panel encima de la página: se cierra al ir a otro lado.
  const { isMobile, setOpenMobile } = useSidebar()
  useEffect(() => {
    if (isMobile) setOpenMobile(false)
  }, [location, isMobile, setOpenMobile])

  return (
    <Sidebar variant="inset">
      <SidebarHeader className="gap-3">
        <div className="flex items-center gap-2 px-2 pt-1.5">
          <Link href="/" className="flex items-center gap-2">
            <Mark className="size-4.5" />
            <span className="brand-word">control-plane</span>
          </Link>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn("ml-auto size-2 rounded-full", connected ? "bg-status-done" : "animate-pulse bg-status-error")}
                aria-label={connected ? "Conectado" : "Sin conexión con el server"}
              />
            </TooltipTrigger>
            <TooltipContent>{connected ? "Conectado al server local" : "Sin conexión con el server: reintentando…"}</TooltipContent>
          </Tooltip>
        </div>
        <AccountSwitcher />
        <button
          type="button"
          onClick={() => setUi({ palette: true })}
          className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-muted hover:text-foreground"
        >
          <Search className="size-4" />
          Buscar…
          <KbdGroup className="ml-auto">
            <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </button>
        <button
          type="button"
          onClick={() => setUi({ inbox: true })}
          className="inbox-button flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-sm font-medium shadow-raised transition-colors hover:bg-muted"
        >
          <Inbox className="size-4" />
          Bandeja
          {inbox > 0 && (
            <span className="ml-auto rounded-full bg-status-attention-lamp px-1.5 font-mono text-2xs font-semibold text-background tabular-nums">{inbox}</span>
          )}
        </button>
        <Link
          href="/tools"
          className={cn(
            "-mt-1.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
            location.endsWith("/tools") && "bg-sidebar-accent text-foreground"
          )}
        >
          <Blocks className="size-4" />
          Herramientas
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="eyebrow">Proyectos</SidebarGroupLabel>
          <SidebarGroupAction title="Nuevo proyecto" onClick={() => setUi({ newProject: true })}>
            <Plus />
          </SidebarGroupAction>
          <SidebarMenu>
            {projects.map((p) => (
              <ProjectMenu key={p.id} project={p} />
            ))}
            {projects.length === 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setUi({ newProject: true })} className="text-muted-foreground">
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
                  className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
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
              <p className="-mt-2 truncate px-2 font-mono text-2xs text-muted-foreground">
                {version && <span className="text-foreground/80">control-plane v{version}</span>}
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
