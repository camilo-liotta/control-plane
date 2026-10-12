import { ChevronRight, Hourglass } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Link } from "wouter"

import type { AfkLog, AfkLogDraft, Draft, Project } from "@shared/types"

import { comeBackFromAfk } from "@/components/afk-dialog"
import { TonePill } from "@/components/status"
import { Button } from "@/components/ui/button"
import { afkEndText, afkOf, afkPillText, afkSeen, afkSpent, markAfkSeen } from "@/lib/afk"
import { api } from "@/lib/api"
import { clock, plural, timeAgo, usd } from "@/lib/format"
import { costsByModel } from "@/lib/models"
import { reportStatusView } from "@/lib/status"
import { useModels, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/** El costo de las sesiones del proyecto (lo que el server resta de `spentAtStart`). */
function useProjectCost(projectId: string): number {
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => Object.values(sessions).filter((s) => s.projectId === projectId).reduce((n, s) => n + s.costUsd, 0), [sessions, projectId])
}

/** La marca del encabezado mientras el proyecto está AFK: hasta cuándo, cuánto se gastó y "Volver". AFK no es una alarma: va neutra. */
export function AfkPill({ project }: { project: Project }) {
  const afk = afkOf(project)
  const cost = useProjectCost(project.id)
  if (!afk) return null
  const text = afkPillText(afk, afkSpent(afk, cost))
  return (
    <span
      data-afk-pill
      className="inline-flex h-7 items-center gap-1 rounded-full bg-muted pr-1 pl-2.5 text-xs font-medium text-muted-foreground"
      title={`La orquestadora envía sus propuestas sin esperar tu aprobación (salvo las que esperan tu vuelta).\n${text}`}
    >
      <span className="truncate">{text}</span>
      <Button size="xs" variant="ghost" className="h-5 rounded-full px-2 text-foreground" onClick={() => void comeBackFromAfk(project)}>
        Volver
      </Button>
    </span>
  )
}

/** En una propuesta: "Salió sola (AFK)" si la envió el AFK, y "Espera tu vuelta" si la orquestadora pidió que la apruebes vos. */
export function DraftAfkMarks({ draft }: { draft: Pick<Draft, "sentBy" | "hold" | "state"> }) {
  const open = draft.state === "ready" || draft.state === "staged"
  return (
    <>
      {draft.sentBy === "afk" && draft.state === "sent" && (
        <TonePill tone="idle" className="font-medium" >
          <Hourglass className="size-3" /> Salió sola (AFK)
        </TonePill>
      )}
      {draft.hold && open && (
        <TonePill tone="pending" >
          <Hourglass className="size-3" /> Espera tu vuelta
        </TonePill>
      )}
    </>
  )
}

const KIND: Record<AfkLogDraft["kind"], string> = { prompt: "Prompt", plan: "Plan", session: "Sesión nueva" }

function when(ts: number, now = Date.now()) {
  const day = new Date(ts).toDateString() === new Date(now).toDateString() ? "" : `${new Date(ts).toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "numeric" }).replace(",", "")} `
  return `${day}${clock(ts)}`
}

function Rows({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <section className="px-4 py-3">
      <h3 className="eyebrow mb-1.5 flex items-center gap-1.5">
        {title}
        <span className="font-normal">{count}</span>
      </h3>
      <ul className="-mx-2 divide-y">{children}</ul>
    </section>
  )
}

const rowClass = "flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-sm"

function DraftRow({ d, projectId, link = true }: { d: AfkLogDraft; projectId: string; link?: boolean }) {
  const inner = (
    <>
      <span className="w-20 shrink-0 text-2xs font-semibold text-muted-foreground">{KIND[d.kind]}</span>
      <span className="min-w-0 flex-1 truncate" title={d.title}>
        {d.title}
      </span>
      {d.sessionName && <span className="name max-w-[30%] shrink-0 truncate text-xs text-muted-foreground">{d.sessionName}</span>}
      {d.sentAt && <span className="shrink-0 text-2xs text-muted-foreground">{clock(d.sentAt)}</span>}
    </>
  )
  return (
    <li>
      {link && d.sessionId ? (
        <Link href={`/p/${projectId}/s/${d.sessionId}`} className={cn(rowClass, "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none")} title={d.createdSession ? "Ver la sesión que se creó" : "Ver la sesión"}>
          {inner}
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ) : (
        <div className={rowClass}>{inner}</div>
      )}
    </li>
  )
}

/** "Mientras estabas AFK": lo que pasó en el último período, hasta que lo cierres con "Listo". Sale arriba del Resumen al volver. */
export function AfkSummaryCard({ project }: { project: Project }) {
  const afk = afkOf(project)
  const sinceNow = afk?.since ?? null
  const [log, setLog] = useState<AfkLog | null>(null)
  const [seen, setSeen] = useState<number | null>(() => afkSeen(project.id))
  const models = useModels()

  // Se vuelve a pedir cuando cambia el período (empieza o termina uno).
  useEffect(() => {
    let live = true
    api.afkLog(project.id).then(
      (l) => live && setLog(l && typeof l.since === "number" ? l : null),
      () => live && setLog(null)
    )
    return () => {
      live = false
    }
  }, [project.id, sinceNow])

  if (afk || !log || log.endedAt === null || seen === log.since) return null

  const byModel = costsByModel(models, log.costByModel).filter((c) => c.usd >= 0.005)
  const nothing = !log.sent.length && !log.held.length && !log.results.length
  const close = () => {
    markAfkSeen(project.id, log.since)
    setSeen(log.since)
  }
  return (
    <section data-afk-summary className="surface-card overflow-hidden" aria-labelledby="afk-summary-title">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Mientras estabas AFK</p>
          <h2 id="afk-summary-title" className="mt-0.5 text-base leading-snug font-medium">
            De {when(log.since, log.endedAt)} a {when(log.endedAt, log.endedAt)}
          </h2>
          <p className="text-xs text-muted-foreground">{log.endReason ? afkEndText[log.endReason] : ""}</p>
        </div>
        <Button size="sm" onClick={close}>
          Listo
        </Button>
      </header>
      <div className="divide-y border-t">
        {nothing && <p className="px-4 py-3 text-sm text-muted-foreground">No pasó nada: no salió ninguna propuesta ni llegó un resultado.</p>}
        <Rows title="Salió sola" count={log.sent.length}>
          {log.sent.map((d) => (
            <DraftRow key={d.id} d={d} projectId={project.id} />
          ))}
        </Rows>
        <Rows title="Espera tu aprobación" count={log.held.length}>
          {log.held.map((d) => (
            <DraftRow key={d.id} d={d} projectId={project.id} link={false} />
          ))}
        </Rows>
        <Rows title="Resultados que llegaron" count={log.results.length}>
          {log.results.map((r) => {
            const view = reportStatusView[r.status]
            const session = Object.values(useStore.getState().sessions).find((s) => s.projectId === project.id && s.name === r.sessionName)
            const inner = (
              <>
                <span className="name w-24 shrink-0 truncate text-sm" title={r.sessionName}>
                  {r.sessionName}
                </span>
                <TonePill tone={view.tone}>{view.label}</TonePill>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={r.summary}>
                  {r.summary}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground" title={new Date(r.createdAt).toLocaleString("es-AR")}>
                  {timeAgo(r.createdAt)}
                </span>
              </>
            )
            return (
              <li key={r.id}>
                {session ? (
                  <Link href={`/p/${project.id}/s/${session.id}`} className={cn(rowClass, "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none")}>
                    {inner}
                  </Link>
                ) : (
                  <div className={rowClass}>{inner}</div>
                )}
              </li>
            )
          })}
        </Rows>
        <section className="px-4 py-3">
          <h3 className="eyebrow mb-1.5">Costo</h3>
          <p className="text-sm">
            <span className="font-medium">{usd(log.spentUsd)}</span>
            {log.budgetUsd !== null && <span className="text-muted-foreground"> de {usd(log.budgetUsd)} de tope</span>}
            {byModel.length > 0 && <span className="text-muted-foreground"> · {byModel.map((c) => `${c.name} ${usd(c.usd)}`).join(" · ")}</span>}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {plural(log.sent.length, "propuesta salió sola", "propuestas salieron solas")}
            {log.held.length > 0 && ` · ${plural(log.held.length, "espera", "esperan")} tu aprobación`}
          </p>
        </section>
      </div>
    </section>
  )
}
