import { Blocks, Check, ChevronRight, Copy, TerminalSquare } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import type { Attachment, Project, Report, Session } from "@shared/types"

import { FileChip, ImageThumb, isImage } from "@/components/attachments"
import { SubagentList } from "@/components/timeline/subagents"
import { DraftCard } from "@/components/draft-card"
import { SessionCredentialsLine } from "@/components/project-environments"
import { Section } from "@/components/panel-section"
import { ReportCard } from "@/components/report-card"
import { ReviewGate } from "@/components/review-gate"
import { SessionScheduled } from "@/components/scheduled"
import { ChangesSection } from "@/components/session-changes"
import { Button } from "@/components/ui/button"
import { LoadError } from "@/components/ui/load-error"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import { basename, timeAgo, tokens, tokensFull, usd } from "@/lib/format"
import { openDrafts, projectReports, useModels, useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className="group flex w-full items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      title={`${label}: ${value}`}
      aria-label={copied ? "Copiado" : label}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-2xs">{value}</span>
      {copied ? <Check className="size-3.5 text-status-done" /> : <Copy className="size-3.5 text-muted-foreground" />}
    </button>
  )
}

function Detail({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2 py-0.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate" title={hint ?? (typeof children === "string" ? children : undefined)}>
        {children}
      </dd>
    </div>
  )
}

const TASK_STATE: Record<Session["taskState"], string> = {
  none: "Sin tarea",
  assigned: "Asignada",
  reported_done: "Reportada como terminada",
  reported_blocked: "Reportada como bloqueada",
  reported_partial: "Reportada como parcial",
}

export function SessionPanel({ session, project }: { session: Session; project: Project }) {
  const allDrafts = useStore((s) => s.drafts)
  const allReports = useStore((s) => s.reports)
  const events = useStore((s) => s.events[session.id])
  const models = useModels()
  const [history, setHistory] = useState<Report[] | null>(null)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [historyTry, setHistoryTry] = useState(0)
  const [files, setFiles] = useState<Attachment[]>([])
  const attachmentCount = useMemo(
    () =>
      (events ?? []).reduce((n, e) => {
        if (e.event.kind === "user") return n + (e.event.attachments?.length ?? 0)
        if (e.event.kind === "tool_result") return n + (e.event.images?.length ?? 0)
        return n
      }, 0),
    [events]
  )
  const hasSubagents = useMemo(() => (events ?? []).some((e) => e.event.kind === "subagent"), [events])

  useEffect(() => {
    let cancelled = false
    api.attachments(session.id).then(
      (list) => !cancelled && setFiles(list),
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [session.id, attachmentCount])
  const isOrch = session.kind === "orchestrator"

  const drafts = useMemo(
    () => openDrafts(allDrafts, project.id).filter((d) => isOrch || d.targetSessionId === session.id),
    [allDrafts, project.id, session.id, isOrch]
  )
  const pending = useMemo(
    () => projectReports(allReports, project.id).filter((r) => r.state === "queued" || r.state === "in_review"),
    [allReports, project.id]
  )

  useEffect(() => {
    if (isOrch) return
    let cancelled = false
    setHistoryError(null)
    api.sessionReports(session.id).then(
      (list) => !cancelled && setHistory(list.reverse()),
      (err: unknown) => !cancelled && setHistoryError(err)
    )
    return () => {
      cancelled = true
    }
  }, [session.id, isOrch, Object.keys(allReports).length, historyTry])

  const readyCount = drafts.filter((d) => d.state === "ready").length
  const model = models.find((m) => m.value === (session.model ?? project.settings.defaultModel))
  const resume = `cd ${session.cwd} && claude --resume ${session.claudeSessionId}`

  return (
    <div className="text-sm">
      {isOrch ? (
        <>
          <Section id="review" title="Cola y revisión" pending={pending.length > 0} summary={pending.length ? `${pending.length} en la cola` : "cola vacía"}>
            <ReviewGate project={project} orchestrator={session} drafts={drafts} className="grid-cols-1 [&>svg]:hidden" />
          </Section>
          <Section id="proposals" title="Propuestas" count={drafts.length} pending={readyCount > 0} summary={readyCount ? `${readyCount} para enviar` : undefined}>
            {drafts.length ? (
              <div className="space-y-2.5">
                {drafts.map((d) => (
                  <DraftCard key={d.id} draft={d} compact />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Las propuestas que arme la orquestadora aparecen acá para que las revises y las envíes.</p>
            )}
          </Section>
          <Section id="pending-reports" title="Resultados sin revisar" count={pending.length} pending={pending.length > 0}>
            {pending.length ? (
              <div className="space-y-2.5">
                {pending.map((r) => (
                  <ReportCard key={r.id} report={r} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Cuando una sesión reporte su resultado, queda acá hasta que la orquestadora lo revise.</p>
            )}
          </Section>
        </>
      ) : (
        <>
          <Section id="task" title="Tarea actual" summary={session.taskTitle ?? "sin tarea"}>
            <p className={session.taskTitle ? "leading-snug" : "text-xs text-muted-foreground"}>
              {session.taskTitle ?? "Sin tarea asignada. Cuando la orquestadora le mande una, aparece acá."}
            </p>
            {session.taskTitle && <p className="mt-1 text-xs text-muted-foreground">{TASK_STATE[session.taskState]}</p>}
          </Section>
          {drafts.length > 0 && (
            <Section id="proposals" title="Propuestas para esta sesión" count={drafts.length} pending={readyCount > 0} summary={readyCount ? `${readyCount} para enviar` : undefined}>
              <div className="space-y-2.5">
                {drafts.map((d) => (
                  <DraftCard key={d.id} draft={d} compact />
                ))}
              </div>
            </Section>
          )}
          <Section id="reports" title="Resultados reportados" count={history?.length}>
            {historyError ? (
              <LoadError compact what="los resultados" error={historyError} onRetry={() => setHistoryTry((n) => n + 1)} />
            ) : history === null ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            ) : history.length ? (
              <div className="space-y-2.5">
                {history.slice(0, 6).map((r) => (
                  <ReportCard key={r.id} report={r} showSession={false} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Todavía no reportó nada. Lo que reporte al terminar una tarea queda acá.</p>
            )}
          </Section>
        </>
      )}
      <SessionCredentialsLine sessionId={session.id} projectId={project.id} />
      <ChangesSection session={session} />
      <SessionScheduled session={session} />
      {hasSubagents && (
        <Section id="subagents" title="Subagentes" count={session.subagentsRunning || undefined} summary={session.subagentsRunning ? "trabajando" : undefined}>
          <SubagentList sessionId={session.id} events={events ?? []} limit={12} />
        </Section>
      )}
      {files.length > 0 && (
        <Section id="attachments" title="Adjuntos" count={files.length}>
          {files.some(isImage) && (
            <div className="mb-2 grid grid-cols-4 gap-1.5">
              {files.filter(isImage).slice(0, 16).map((f) => (
                <ImageThumb key={f.id} att={f} className="aspect-square" />
              ))}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {files
              .filter((f) => !isImage(f))
              .slice(0, 20)
              .map((f) => (
                <FileChip key={f.id} att={f} />
              ))}
          </div>
        </Section>
      )}
      <Section id="tools" title="Herramientas" summary="MCP, skills y plugins">
        <Button size="sm" variant="secondary" className="w-full justify-start" onClick={() => useUi.getState().set({ toolsFor: session.id })}>
          <Blocks className="text-muted-foreground" />
          <span className="flex-1 text-left">Ver lo que tiene cargado</span>
          <ChevronRight className="text-muted-foreground" />
        </Button>
      </Section>
      <Section id="details" title="Detalles" summary={model?.label ?? session.model ?? undefined}>
        <dl>
          {session.role && <Detail label="Rol">{session.role}</Detail>}
          <Detail label="Modelo">{model?.label ?? session.model ?? project.settings.defaultModel ?? "El de tu configuración"}</Detail>
          <Detail label="Esfuerzo">{session.effort ?? project.settings.defaultEffort ?? "El de tu configuración"}</Detail>
          <Detail label="Carpeta" hint={session.cwd}>
            {basename(session.cwd)}
          </Detail>
          {session.worktree && <Detail label="Checkout">Worktree propio</Detail>}
          <Detail label="Costo" hint="Lo que costaría por API. Con tu plan no se cobra aparte: sirve para comparar cuánto trabajó cada sesión.">
            {usd(session.costUsd)} (equivalente API)
          </Detail>
          {session.tokens && session.tokens.total > 0 && (
            <>
              <Detail label="Tokens" hint={`${tokensFull(session.tokens.total)} tokens en total (incluye subagentes)`}>
                {tokensFull(session.tokens.total)}
              </Detail>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 pb-1 pl-24 text-2xs whitespace-nowrap text-muted-foreground">
                <span>entrada</span>
                <span>{tokens(session.tokens.input)}</span>
                <span>salida</span>
                <span>{tokens(session.tokens.output)}</span>
                <span>caché leída</span>
                <span>{tokens(session.tokens.cacheRead)}</span>
                <span>caché escrita</span>
                <span>{tokens(session.tokens.cacheWrite)}</span>
              </div>
            </>
          )}
          <Detail label="Creada" hint={new Date(session.createdAt).toLocaleString("es-AR")}>
            {timeAgo(session.createdAt)}
          </Detail>
        </dl>
        <div className="mt-3 space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TerminalSquare className="size-3.5 shrink-0" />
            Para seguirla en una terminal, detenela acá primero:
          </p>
          <CopyLine label="Copiar comando" value={resume} />
        </div>
      </Section>
    </div>
  )
}
