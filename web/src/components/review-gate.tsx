import { ChevronRight, Lock, LockOpen } from "lucide-react"

import type { Draft, Project, Session } from "@shared/types"

import { Lamp } from "@/components/status"
import { useNow } from "@/hooks/use-now"
import { cn } from "@/lib/utils"

function Countdown({ at, windowSec, now }: { at: number; windowSec: number; now: number }) {
  const remaining = Math.max(0, at - now)
  const total = Math.max(1000, windowSec * 1000)
  const frac = Math.min(1, remaining / total)
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg viewBox="0 0 18 18" className="size-3.5 -rotate-90" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-status-attention/25" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="stroke-status-attention transition-[stroke-dashoffset] duration-500 ease-linear"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
        />
      </svg>
      entra en {Math.ceil(remaining / 1000)} s
    </span>
  )
}

function Segment({
  label,
  count,
  hint,
  active,
  className,
  icon,
}: {
  label: string
  count: number
  hint: React.ReactNode
  active: boolean
  className?: string
  icon?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg px-3 py-2 transition-colors",
        active ? className : "text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="eyebrow text-current opacity-80">{label}</span>
        {icon}
      </div>
      <div className="mt-1 font-mono text-xl leading-none font-medium tabular-nums">{count}</div>
      <div className="mt-1 text-[0.72rem] leading-snug">{hint}</div>
    </div>
  )
}

/**
 * La compuerta de la orquestadora: resultados en cola → revisión → propuestas.
 * Mientras haya algo sin leer, las propuestas quedan bloqueadas.
 */
export function ReviewGate({
  project,
  orchestrator,
  drafts,
  className,
}: {
  project: Project
  orchestrator: Session | null
  drafts: Draft[]
  className?: string
}) {
  const now = useNow(500)
  const { queued, inReview, paused, deliverAt } = project.review
  const staged = drafts.filter((d) => d.state === "staged").length
  const ready = drafts.filter((d) => d.state === "ready").length
  const status = orchestrator?.status ?? "stopped"
  const busy = status === "working" || status === "needs_input" || status === "starting"

  let queueHint: React.ReactNode = "vacía"
  if (queued) {
    if (paused) queueHint = "en pausa"
    else if (deliverAt) queueHint = <Countdown at={deliverAt} windowSec={project.settings.batchWindowSec} now={now} />
    else if (busy) queueHint = "al terminar el turno"
    else if (status === "stopped" || status === "error") queueHint = "orquestadora detenida"
    else queueHint = "entrando…"
  }

  let reviewHint: React.ReactNode = "sin revisión abierta"
  if (inReview) reviewHint = paused ? "en pausa" : busy ? "analizando" : "abierta"

  const proposalsHint = staged
    ? `${staged === 1 ? "bloqueada" : "bloqueadas"}${ready ? ` · ${ready} ${ready === 1 ? "lista" : "listas"}` : ""}`
    : ready
      ? ready === 1
        ? "lista para enviar"
        : "listas para enviar"
      : "ninguna"

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.2fr)] items-center rounded-xl border bg-background/60 p-1",
        className
      )}
    >
      <Segment
        label="Cola"
        count={queued}
        hint={queueHint}
        active={queued > 0}
        className="bg-status-attention/10 text-status-attention"
      />
      <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden />
      <Segment
        label="Revisando"
        count={inReview}
        hint={reviewHint}
        active={inReview > 0}
        className="bg-status-working/10 text-status-working"
        icon={inReview > 0 && busy ? <Lamp tone="working" pulse className="size-1.5" /> : null}
      />
      <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden />
      <Segment
        label="Propuestas"
        count={staged + ready}
        hint={proposalsHint}
        active={staged + ready > 0}
        className={staged ? "bg-muted text-foreground" : "bg-status-done/10 text-status-done"}
        icon={
          staged ? (
            <Lock className="size-3" aria-label="Bloqueadas" />
          ) : ready ? (
            <LockOpen className="size-3" aria-label="Liberadas" />
          ) : null
        }
      />
    </div>
  )
}
