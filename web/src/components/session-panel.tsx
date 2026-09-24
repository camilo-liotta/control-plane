import { Check, Copy, TerminalSquare } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import type { Project, Report, Session } from "@shared/types"

import { DraftCard } from "@/components/draft-card"
import { ReportCard } from "@/components/report-card"
import { ReviewGate } from "@/components/review-gate"
import { api } from "@/lib/api"
import { shortPath, timeAgo, usd } from "@/lib/format"
import { openDrafts, projectReports, useModels, useStore } from "@/lib/store"

function Section({ title, children, count }: { title: string; children: React.ReactNode; count?: number }) {
  return (
    <section className="border-b px-4 py-4 last:border-b-0">
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="eyebrow">{title}</h3>
        {count !== undefined && count > 0 && <span className="font-mono text-xs text-muted-foreground">{count}</span>}
      </div>
      {children}
    </section>
  )
}

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
      className="group flex w-full items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 text-left hover:bg-muted"
      title={label}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[0.7rem]">{value}</span>
      {copied ? <Check className="size-3.5 text-status-done" /> : <Copy className="size-3.5 text-muted-foreground" />}
    </button>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2 py-0.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
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
  const models = useModels()
  const [history, setHistory] = useState<Report[] | null>(null)
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
    api.sessionReports(session.id).then(
      (list) => !cancelled && setHistory(list.reverse()),
      () => !cancelled && setHistory([])
    )
    return () => {
      cancelled = true
    }
  }, [session.id, isOrch, Object.keys(allReports).length])

  const model = models.find((m) => m.value === (session.model ?? project.settings.defaultModel))
  const resume = `cd ${session.cwd} && claude --resume ${session.claudeSessionId}`

  return (
    <div className="text-sm">
      {isOrch ? (
        <>
          <Section title="Cola y revisión">
            <ReviewGate project={project} orchestrator={session} drafts={drafts} className="grid-cols-1 [&>svg]:hidden" />
          </Section>
          <Section title="Propuestas" count={drafts.length}>
            {drafts.length ? (
              <div className="space-y-2.5">
                {drafts.map((d) => (
                  <DraftCard key={d.id} draft={d} compact />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No hay propuestas abiertas.</p>
            )}
          </Section>
          <Section title="Resultados sin revisar" count={pending.length}>
            {pending.length ? (
              <div className="space-y-2.5">
                {pending.map((r) => (
                  <ReportCard key={r.id} report={r} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">La cola está vacía.</p>
            )}
          </Section>
        </>
      ) : (
        <>
          <Section title="Tarea actual">
            <p className={session.taskTitle ? "leading-snug" : "text-muted-foreground"}>
              {session.taskTitle ?? "Sin tarea asignada"}
            </p>
            {session.taskTitle && <p className="mt-1 text-xs text-muted-foreground">{TASK_STATE[session.taskState]}</p>}
          </Section>
          {drafts.length > 0 && (
            <Section title="Propuestas para esta sesión" count={drafts.length}>
              <div className="space-y-2.5">
                {drafts.map((d) => (
                  <DraftCard key={d.id} draft={d} compact />
                ))}
              </div>
            </Section>
          )}
          <Section title="Resultados reportados" count={history?.length}>
            {history === null ? (
              <p className="text-xs text-muted-foreground">Cargando…</p>
            ) : history.length ? (
              <div className="space-y-2.5">
                {history.slice(0, 6).map((r) => (
                  <ReportCard key={r.id} report={r} showSession={false} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Todavía no reportó nada.</p>
            )}
          </Section>
        </>
      )}
      <Section title="Detalles">
        <dl>
          {session.role && <Detail label="Rol">{session.role}</Detail>}
          <Detail label="Modelo">{model?.label ?? session.model ?? project.settings.defaultModel ?? "El de tu configuración"}</Detail>
          <Detail label="Esfuerzo">{session.effort ?? project.settings.defaultEffort ?? "El de tu configuración"}</Detail>
          <Detail label="Carpeta">
            <span className="font-mono" title={session.cwd}>
              {shortPath(session.cwd)}
            </span>
          </Detail>
          {session.worktree && <Detail label="Checkout">Worktree propio</Detail>}
          <Detail label="Costo">
            <span title="Lo que costaría por API. Con tu plan no se cobra aparte: sirve para comparar cuánto trabajó cada sesión.">
              {usd(session.costUsd)} (equivalente API)
            </span>
          </Detail>
          <Detail label="Creada">{timeAgo(session.createdAt)}</Detail>
        </dl>
        <div className="mt-3 space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TerminalSquare className="size-3.5" />
            Para abrirla en una terminal, detenela acá primero:
          </p>
          <CopyLine label="Copiar comando" value={resume} />
        </div>
      </Section>
    </div>
  )
}
