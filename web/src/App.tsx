import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Redirect, Route, Switch, useLocation } from "wouter"
import { X } from "lucide-react"

import { AccountsDialog } from "@/components/accounts"
import { AppSidebar, useInboxCount } from "@/components/app-sidebar"
import { Lightbox } from "@/components/attachments"
import { ClaudeSettingsDialog } from "@/components/claude-settings-dialog"
import { DeleteProjectDialog } from "@/components/delete-project-dialog"
import { CommandPalette } from "@/components/command-palette"
import { SessionDialogs } from "@/components/session-dialogs"
import { GlobalShortcuts } from "@/components/shortcuts"
import { ImportSessionDialog } from "@/components/import-session-dialog"
import { InboxSheet } from "@/components/inbox-sheet"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { NewSessionDialog } from "@/components/new-session-dialog"
import { ProjectSettingsDialog } from "@/components/project-settings-dialog"
import { CompactionSheet } from "@/components/compaction-sheet"
import { SubagentSheet } from "@/components/subagent-sheet"
import { SessionToolsSheet } from "@/components/tools/session-tools-sheet"
import { UpdateFailureDialog } from "@/components/update-failure-dialog"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { restartHint, versionMismatch } from "@/lib/server-version"
import { useCurrentAccount, useStore } from "@/lib/store"
import { toneSoft, type Tone } from "@/lib/status"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"
import { inDesktop, trayIconPlace } from "@/lib/notify"
import { lastRoute } from "@/lib/nav"
import { connect } from "@/lib/ws"
import { restorableRoute } from "@shared/navigation"
import { Home } from "@/pages/home"
import { ProjectBoard } from "@/pages/project-board"
import { SessionPage } from "@/pages/session-page"
import { ToolsPage } from "@/pages/tools-page"

function Dialogs() {
  const ui = useUi()
  const projects = useStore((s) => s.projects)
  const sessionProject = ui.newSessionFor ? (projects[ui.newSessionFor] ?? null) : null
  const settingsProject = ui.settingsFor ? projects[ui.settingsFor] : undefined
  const importProject = ui.importFor ? (projects[ui.importFor] ?? null) : null
  const deleteProject = ui.deleteFor ? projects[ui.deleteFor] : undefined
  return (
    <>
      <NewProjectDialog open={ui.newProject} onOpenChange={(v) => ui.set({ newProject: v })} />
      <NewSessionDialog
        project={sessionProject}
        open={Boolean(sessionProject)}
        onOpenChange={(v) => !v && ui.set({ newSessionFor: null })}
      />
      {settingsProject && (
        <ProjectSettingsDialog
          project={settingsProject}
          open={Boolean(settingsProject)}
          onOpenChange={(v) => !v && ui.set({ settingsFor: null })}
        />
      )}
      {deleteProject && (
        <DeleteProjectDialog
          project={deleteProject}
          open={Boolean(deleteProject)}
          onOpenChange={(v) => !v && ui.set({ deleteFor: null })}
        />
      )}
      <ImportSessionDialog
        project={importProject}
        open={Boolean(importProject)}
        onOpenChange={(v) => !v && ui.set({ importFor: null })}
      />
      <InboxSheet />
      <CommandPalette />
      <SessionDialogs />
      <GlobalShortcuts />
      <SubagentSheet />
      <CompactionSheet />
      <SessionToolsSheet />
      <Lightbox />
      <AccountsDialog />
      <ClaudeSettingsDialog />
      <UpdateFailureDialog />
    </>
  )
}

/**
 * Al cambiar de cuenta, si estabas en un proyecto (su chat, tablero o herramientas) de otra cuenta,
 * volvés al inicio de la nueva: la cuenta funciona como una organización.
 */
function LeaveOtherAccount() {
  const [location, navigate] = useLocation()
  const account = useCurrentAccount()
  const projects = useStore((s) => s.projects)
  const previous = useRef(account?.id)
  useEffect(() => {
    if (previous.current === account?.id) return
    previous.current = account?.id
    const id = /^\/p\/([^/]+)/.exec(location)?.[1]
    const project = id ? projects[id] : undefined
    if (!account || !project) return
    const mine = project.accountId ? project.accountId === account.id : account.isDefault
    if (!mine) navigate("/")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id])
  return null
}

/** Si se borró el proyecto que estás mirando (desde esta pestaña o desde otra), volvés al inicio. */
function LeaveDeletedProject() {
  const [location, navigate] = useLocation()
  const removed = useStore((s) => s.removedProject)
  useEffect(() => {
    if (!removed) return
    if (location !== `/p/${removed.id}` && !location.startsWith(`/p/${removed.id}/`)) return
    navigate("/")
    toast.success(`Proyecto ${removed.name} borrado`, { id: `deleted-${removed.id}` })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removed])
  return null
}

/**
 * La última pantalla: se guarda en cada cambio de ruta (salvo el inicio). En la app de escritorio,
 * al abrir se vuelve ahí sola; en la web, el inicio ofrece "Seguir donde estabas" (ver Home).
 */
function RememberRoute() {
  const [location, navigate] = useLocation()
  const loaded = useStore((s) => s.loaded)
  const restored = useRef(false)
  useEffect(() => {
    if (!loaded || restored.current) return
    restored.current = true
    if (!inDesktop() || location !== "/") return
    const { projects, sessions } = useStore.getState()
    const alive = {
      projects: new Set(Object.values(projects).filter((p) => !p.archivedAt).map((p) => p.id)),
      sessions: new Set(Object.values(sessions).filter((x) => !x.archivedAt).map((x) => x.id)),
    }
    const to = restorableRoute(lastRoute.get(), alive)
    if (to) navigate(to, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])
  useEffect(() => {
    if (loaded && restored.current && location !== "/") lastRoute.set(location)
  }, [location, loaded])
  return null
}

function ConnectionBanner() {
  const connected = useStore((s) => s.connected)
  const loaded = useStore((s) => s.loaded)
  if (connected || !loaded) return null
  return (
    <Banner tone="error">
      <Spinner className="size-3.5 shrink-0" />
      <span>
        <span className="font-semibold">Se cortó la conexión con el server local.</span> Reintentando…{" "}
        {inDesktop()
          ? "Si el server se cerró, la app lo vuelve a lanzar o te muestra cómo seguir."
          : "Si lo cerraste, volvé a levantarlo con npm start."}
      </span>
    </Banner>
  )
}

/** Un aviso de toda la app, arriba de la hoja: el tono dice qué tan urgente es y el texto, qué pasa. */
function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <div role="status" className={cn("flex items-center justify-center gap-2 px-4 py-2 text-center text-xs leading-snug text-balance", toneSoft[tone])}>
      {children}
    </div>
  )
}

const UPDATE_DISMISSED_KEY = "control-plane:update-dismissed"

/** La app de escritorio avisa que hay una versión nueva. Solo informa: se actualiza desde el menú del ícono. */
/** Si el server es de otra versión que la app o la página: algunas funciones no andan. */
function VersionBanner() {
  const server = useStore((s) => s.meta?.version)
  const mismatch = versionMismatch(server)
  if (!mismatch) return null
  return (
    <Banner tone="attention">
      <span>
        El server es la v{mismatch.server} y {mismatch.where === "app" ? "la app" : "esta página"} es la v{mismatch.expected}: algunas funciones no van a andar hasta que lo reinicies, {restartHint()}.
      </span>
    </Banner>
  )
}

function UpdateBanner() {
  const update = useUi((s) => s.desktopUpdate)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(UPDATE_DISMISSED_KEY)
    } catch {
      return null
    }
  })
  if (!update || dismissed === update.version) return null
  const hide = () => {
    try {
      localStorage.setItem(UPDATE_DISMISSED_KEY, update.version)
    } catch {
      // sin almacenamiento local: vale para esta pestaña
    }
    setDismissed(update.version)
  }
  return (
    <Banner tone="pending">
      <span>
        Hay una versión nueva (v{update.version}). Actualizala desde {trayIconPlace()} → Actualizar a v{update.version}.{" "}
        <a href={update.notesUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          Qué trae
        </a>
      </span>
      <Button size="icon-xs" variant="ghost" onClick={hide} aria-label="Ocultar este aviso" className="text-current hover:bg-transparent hover:text-foreground">
        <X />
      </Button>
    </Banner>
  )
}

/** La barra lateral: 256 px en pantallas anchas y nunca más de lo que hace falta en una angosta (a 900 px, 216). */
const SIDEBAR_WIDTH = "clamp(13.5rem, 24vw, 16rem)"

export default function App() {
  const loaded = useStore((s) => s.loaded)
  const pending = useInboxCount()

  useEffect(() => connect(), [])

  useEffect(() => {
    document.title = pending ? `(${pending}) control-plane` : "control-plane"
  }, [pending])

  return (
    <SidebarProvider className="h-svh overflow-hidden" style={{ "--sidebar-width": SIDEBAR_WIDTH } as React.CSSProperties}>
      <AppSidebar />
      <LeaveOtherAccount />
      <LeaveDeletedProject />
      <RememberRoute />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <ConnectionBanner />
        <VersionBanner />
        <UpdateBanner />
        {!loaded ? (
          <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Conectando con el server local…
          </div>
        ) : (
          <Switch>
            <Route path="/">
              <Home />
            </Route>
            <Route path="/tools">
              <ToolsPage />
            </Route>
            <Route path="/p/:projectId/tools">{(params) => <ToolsPage key={params.projectId} projectId={params.projectId} />}</Route>
            <Route path="/p/:projectId">{(params) => <ProjectBoard projectId={params.projectId} />}</Route>
            <Route path="/p/:projectId/s/:sessionId">
              {(params) => <SessionPage key={params.sessionId} projectId={params.projectId} sessionId={params.sessionId} />}
            </Route>
            <Route>
              <Redirect to="/" />
            </Route>
          </Switch>
        )}
      </SidebarInset>
      <Dialogs />
    </SidebarProvider>
  )
}
