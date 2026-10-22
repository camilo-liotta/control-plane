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
import { AfkDialog } from "@/components/afk-dialog"
import { PairDevice } from "@/components/pair-device"
import { RemoteDialog } from "@/components/remote-dialog"
import { ProjectSettingsDialog } from "@/components/project-settings-dialog"
import { CompactionSheet } from "@/components/compaction-sheet"
import { SubagentSheet } from "@/components/subagent-sheet"
import { SessionToolsSheet } from "@/components/tools/session-tools-sheet"
import { UpdateFailureDialog } from "@/components/update-failure-dialog"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { accessIndicator } from "@shared/remote-access"
import { useAccess, useCan } from "@/lib/access"
import { api } from "@/lib/api"
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
  // Desde otro dispositivo, lo que gestiona la máquina (proyectos, cuentas, herramientas, ajustes) no existe;
  // AFK necesita el nivel Control. El server lo exige igual: esto solo evita mostrar lo que no anda.
  const manage = useCan("manage")
  const control = useCan("control")
  const projects = useStore((s) => s.projects)
  const sessionProject = ui.newSessionFor ? (projects[ui.newSessionFor] ?? null) : null
  const settingsProject = ui.settingsFor ? projects[ui.settingsFor] : undefined
  const afkProject = ui.afkFor ? projects[ui.afkFor] : undefined
  const importProject = ui.importFor ? (projects[ui.importFor] ?? null) : null
  const deleteProject = ui.deleteFor ? projects[ui.deleteFor] : undefined
  return (
    <>
      {manage && <NewProjectDialog open={ui.newProject} onOpenChange={(v) => ui.set({ newProject: v })} />}
      {manage && (
        <NewSessionDialog
          project={sessionProject}
          open={Boolean(sessionProject)}
          onOpenChange={(v) => !v && ui.set({ newSessionFor: null })}
        />
      )}
      {manage && settingsProject && (
        <ProjectSettingsDialog
          project={settingsProject}
          open={Boolean(settingsProject)}
          onOpenChange={(v) => !v && ui.set({ settingsFor: null })}
        />
      )}
      {control && afkProject && <AfkDialog project={afkProject} open onOpenChange={(v) => !v && ui.set({ afkFor: null })} />}
      {manage && deleteProject && (
        <DeleteProjectDialog
          project={deleteProject}
          open={Boolean(deleteProject)}
          onOpenChange={(v) => !v && ui.set({ deleteFor: null })}
        />
      )}
      {manage && (
        <ImportSessionDialog
          project={importProject}
          open={Boolean(importProject)}
          onOpenChange={(v) => !v && ui.set({ importFor: null })}
        />
      )}
      <InboxSheet />
      <CommandPalette />
      {manage && <SessionDialogs />}
      <GlobalShortcuts />
      <SubagentSheet />
      {manage && <CompactionSheet />}
      {manage && <SessionToolsSheet />}
      <Lightbox />
      {manage && <AccountsDialog />}
      {manage && <ClaudeSettingsDialog />}
      <UpdateFailureDialog />
      {manage && <RemoteDialog />}
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

/**
 * El aviso permanente del acceso remoto, neutro (no es una alarma). Desde esta máquina: que hay acceso abierto
 * y cuántos dispositivos. Desde otro dispositivo: quién sos y con qué nivel.
 */
function AccessBanner() {
  const caps = useAccess((s) => s.caps)
  const local = useAccess((s) => s.local)
  const setUi = useUi((s) => s.set)
  // Salir de este dispositivo (revoca su vínculo) es de "responder" para arriba, igual que en el server.
  const canLogout = useCan("respond") && caps?.mode !== "local"
  const text = accessIndicator(caps, local)
  if (!text) return null
  const logout = () =>
    api.remoteLogout().then(
      () => {
        toast.success("Saliste de este dispositivo")
        useAccess.getState().unpair()
      },
      () => toast.error("No se pudo salir de este dispositivo")
    )
  return (
    <Banner tone="idle">
      <span>{text}</span>
      {caps?.mode === "local" && (
        <button type="button" onClick={() => setUi({ remoteDialog: true })} className="underline underline-offset-2 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Administrar
        </button>
      )}
      {canLogout && (
        <button type="button" onClick={() => void logout()} className="underline underline-offset-2 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Salir
        </button>
      )}
    </Banner>
  )
}

/** Desde otro dispositivo, las herramientas (cuentas, MCP, skills, CLIs) no existen: se vuelve al inicio. */
function ManageOnly({ children }: { children: React.ReactNode }) {
  return useCan("manage") ? children : <Redirect to="/" />
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
  const caps = useAccess((s) => s.caps)
  const known = caps !== null
  // Desde otro dispositivo sin vincular no hay nada que mirar: va la pantalla de vinculación.
  const unpaired = caps !== null && caps.mode !== "local" && caps.paired === false

  useEffect(() => {
    void useAccess.getState().load()
  }, [])

  // Primero se sabe desde dónde se entra; recién después se conecta (y se vuelve a conectar al vincular).
  useEffect(() => {
    if (!known || unpaired) return
    return connect()
  }, [known, unpaired])

  useEffect(() => {
    document.title = pending ? `(${pending}) control-plane` : "control-plane"
  }, [pending])

  if (!known) {
    return (
      <div role="status" className="flex h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Conectando con el server local…
      </div>
    )
  }
  if (unpaired) return <PairDevice />

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
        <AccessBanner />
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
              <ManageOnly>
                <ToolsPage />
              </ManageOnly>
            </Route>
            <Route path="/p/:projectId/tools">
              {(params) => (
                <ManageOnly>
                  <ToolsPage key={params.projectId} projectId={params.projectId} />
                </ManageOnly>
              )}
            </Route>
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
