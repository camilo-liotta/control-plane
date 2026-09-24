import { Bell, BellOff, BellRing, ChevronRight, Compass, Inbox, Monitor, Moon, Plus, Sun } from "lucide-react"
import { useState } from "react"
import { Link, useLocation } from "wouter"

import type { Project, Session } from "@shared/types"

import { SessionLamp } from "@/components/status"
import { useTheme } from "@/components/theme-provider"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
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
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { UsageMeter } from "@/components/usage-meter"
import { enableNotifications, notificationsSupported } from "@/lib/notify"
import { openDrafts, projectSessions, useProjects, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

/** Marca: una orquestadora arriba y sus sesiones abajo. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path d="M8 5.2 3.2 11.4M8 5.2v6.2M8 5.2l4.8 6.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity=".55" />
      <circle cx="8" cy="3.6" r="2.1" fill="currentColor" />
      <circle cx="3" cy="12.6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="12.6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="13" cy="12.6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
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
          <span className={cn("truncate font-mono text-[0.78rem]", unread > 0 && "font-semibold")}>
            {session.kind === "orchestrator" ? "Orquestadora" : session.name}
          </span>
          {session.kind === "orchestrator" && <SessionLamp session={session} className="ml-auto" />}
          {session.kind === "worker" && (attention || unread > 0) && (
            <span
              className={cn(
                "ml-auto size-1.5 rounded-full",
                attention ? "bg-status-attention" : "bg-foreground/60"
              )}
            />
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
  const [open, setOpen] = useState(true)
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

function NotificationsToggle() {
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : "denied"))
  if (!notificationsSupported()) return null
  const Icon = perm === "granted" ? BellRing : perm === "denied" ? BellOff : Bell
  const label =
    perm === "granted"
      ? "Avisos del sistema activados"
      : perm === "denied"
        ? "El navegador bloqueó los avisos"
        : "Activar avisos del sistema"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void enableNotifications().then(() => setPerm(Notification.permission))}
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

export function useInboxCount() {
  const drafts = useStore((s) => s.drafts)
  const sessions = useStore((s) => s.sessions)
  const ready = Object.values(drafts).filter((d) => d.state === "ready").length
  const needs = Object.values(sessions).filter((s) => s.status === "needs_input").length
  return ready + needs
}

export function AppSidebar() {
  const projects = useProjects()
  const connected = useStore((s) => s.connected)
  const account = useStore((s) => s.meta?.account)
  const setUi = useUi((s) => s.set)
  const inbox = useInboxCount()

  return (
    <Sidebar>
      <SidebarHeader className="gap-3">
        <div className="flex items-center gap-2 px-2 pt-1.5">
          <Link href="/" className="flex items-center gap-2">
            <Mark className="size-4.5" />
            <span className="font-condensed text-[0.82rem] font-semibold tracking-[0.14em] uppercase">control-plane</span>
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
        <button
          type="button"
          onClick={() => setUi({ inbox: true })}
          className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-muted"
        >
          <Inbox className="size-4" />
          Bandeja
          {inbox > 0 && (
            <span className="ml-auto rounded-full bg-status-attention px-1.5 font-mono text-[0.7rem] text-background">{inbox}</span>
          )}
        </button>
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
          <NotificationsToggle />
          {account && (
            <span className="ml-auto truncate text-[0.7rem] text-muted-foreground" title={account.email}>
              {account.organization ?? account.email}
            </span>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
