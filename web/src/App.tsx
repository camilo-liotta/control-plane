import { useEffect, useRef } from "react"
import { Redirect, Route, Switch, useLocation } from "wouter"

import { AccountsDialog } from "@/components/accounts"
import { AppSidebar, useInboxCount } from "@/components/app-sidebar"
import { Lightbox } from "@/components/attachments"
import { ClaudeSettingsDialog } from "@/components/claude-settings-dialog"
import { CommandPalette } from "@/components/command-palette"
import { ImportSessionDialog } from "@/components/import-session-dialog"
import { InboxSheet } from "@/components/inbox-sheet"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { NewSessionDialog } from "@/components/new-session-dialog"
import { ProjectSettingsDialog } from "@/components/project-settings-dialog"
import { CompactionSheet } from "@/components/compaction-sheet"
import { SubagentSheet } from "@/components/subagent-sheet"
import { SessionToolsSheet } from "@/components/tools/session-tools-sheet"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { useCurrentAccount, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { connect } from "@/lib/ws"
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
      <ImportSessionDialog
        project={importProject}
        open={Boolean(importProject)}
        onOpenChange={(v) => !v && ui.set({ importFor: null })}
      />
      <InboxSheet />
      <CommandPalette />
      <SubagentSheet />
      <CompactionSheet />
      <SessionToolsSheet />
      <Lightbox />
      <AccountsDialog />
      <ClaudeSettingsDialog />
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

function ConnectionBanner() {
  const connected = useStore((s) => s.connected)
  const loaded = useStore((s) => s.loaded)
  if (connected || !loaded) return null
  return (
    <div className="border-b border-status-error/30 bg-status-error/10 px-4 py-1.5 text-center text-xs text-status-error">
      Se cortó la conexión con el server local. Reintentando… Si lo cerraste, volvé a levantarlo con npm start.
    </div>
  )
}

export default function App() {
  const loaded = useStore((s) => s.loaded)
  const pending = useInboxCount()

  useEffect(() => connect(), [])

  useEffect(() => {
    document.title = pending ? `(${pending}) control-plane` : "control-plane"
  }, [pending])

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      <LeaveOtherAccount />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <ConnectionBanner />
        {!loaded ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
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
