import { Bot, Compass, Inbox, LockOpen } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { Draft, Project, Report, Session } from "@shared/types"

import { ReviewGate } from "@/components/review-gate"
import { StatusPill, TonePill } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useNow } from "@/hooks/use-now"
import { api } from "@/lib/api"
import { timeAgo, tokens } from "@/lib/format"
import { reportStatusView } from "@/lib/status"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

export function WorkerCard({ session, lastReport }: { session: Session; lastReport?: Report }) {
  const unread = useStore((s) => s.unread[session.id] ?? 0)
  const now = useNow(30_000)
  return (
    <Link
      href={`/p/${session.projectId}/s/${session.id}`}
      className={cn(
        "surface-card group flex flex-col p-4 text-left transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        session.status === "needs_input" && "ring-2 ring-status-attention-lamp/45"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="name truncate text-sm" title={session.name}>
          {session.name}
        </span>
        {unread > 0 && (
          <span className="rounded-full bg-foreground px-1.5 text-2xs font-medium text-background" title={`${unread} ${unread === 1 ? "mensaje sin leer" : "mensajes sin leer"}`}>
            {unread}
          </span>
        )}
        {session.subagentsRunning > 0 && (
          <span
            className="inline-flex items-center gap-1 text-2xs text-status-working"
            title={session.subagentsRunning === 1 ? "1 subagente trabajando" : `${session.subagentsRunning} subagentes trabajando`}
          >
            <Bot className="size-3.5" />
            {session.subagentsRunning}
          </span>
        )}
        <StatusPill session={session} className="ml-auto" />
      </div>
      {session.role && (
        <p className="mt-1 truncate text-xs text-muted-foreground" title={session.role}>
          {session.role}
        </p>
      )}
      <div className="mt-3">
        <div className="eyebrow">Tarea</div>
        <p className={cn("mt-0.5 line-clamp-2 text-sm", !session.taskTitle && "text-muted-foreground")} title={session.taskTitle ?? undefined}>
          {session.taskTitle ?? "Sin tarea asignada"}
        </p>
      </div>
      <div className="mt-auto pt-3">
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <span className="truncate" title={session.lastActivity ?? undefined}>
            {session.lastActivity ?? "—"}
          </span>
          <span className="ml-auto shrink-0">
            {session.tokens && session.tokens.total > 0 && (
              <span title={`${session.tokens.total.toLocaleString("es-AR")} tokens`}>{tokens(session.tokens.total)} · </span>
            )}
            {timeAgo(session.lastActivityAt, now)}
          </span>
        </div>
        {lastReport && (
          <div className="mt-2 flex items-center gap-2 border-t pt-2 text-xs">
            <TonePill tone={reportStatusView[lastReport.status].tone}>{reportStatusView[lastReport.status].label}</TonePill>
            <span className="truncate text-muted-foreground" title={lastReport.summary.split("\n")[0]}>
              {lastReport.summary.split("\n")[0]}
            </span>
          </div>
        )}
      </div>
    </Link>
  )
}

export function OrchestratorCard({
  project,
  orchestrator,
  drafts,
}: {
  project: Project
  orchestrator: Session | null
  drafts: Draft[]
}) {
  const [busy, setBusy] = useState<null | "review" | "release">(null)
  const { queued, inReview, paused } = project.review
  const status = orchestrator?.status ?? "stopped"
  const working = status === "working" || status === "needs_input" || status === "starting"
  const staged = drafts.filter((d) => d.state === "staged").length

  const act = async (kind: "review" | "release", fn: () => Promise<unknown>, ok: string, failed: string) => {
    setBusy(kind)
    try {
      await fn()
      toast.success(ok)
    } catch (err) {
      toast.error(failed, { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="surface-card p-5">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Compass className="size-4.5" />
            <h2 className="text-base font-semibold">Orquestadora</h2>
            {orchestrator && <span className="name text-xs text-muted-foreground">{orchestrator.name}</span>}
            {orchestrator && <StatusPill session={orchestrator} />}
          </div>
          <p className={cn("mt-2 line-clamp-3 text-sm leading-relaxed", !orchestrator?.lastText && "text-muted-foreground")} title={orchestrator?.lastText ?? undefined}>
            {orchestrator?.lastText ??
              "Contale el objetivo y pedile que arme el plan: te va a proponer los prompts de cada sesión para que los apruebes."}
          </p>
          {paused && (
            <p className="mt-2 text-xs text-status-attention">
              Revisión en pausa: la interrumpiste a mitad de camino. Escribile para que siga, o liberá sus propuestas.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {orchestrator && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/p/${project.id}/s/${orchestrator.id}`}>Abrir chat</Link>
              </Button>
            )}
            {queued > 0 && !working && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => act("review", () => api.reviewNow(project.id), "Cola entregada a la orquestadora", "No se pudo entregar la cola")}
              >
                {busy === "review" ? <Spinner /> : <Inbox />}
                Revisar ahora
              </Button>
            )}
            {queued === 0 && (inReview > 0 || staged > 0) && !working && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => act("release", () => api.releaseReview(project.id), "Propuestas liberadas", "No se pudieron liberar las propuestas")}
              >
                {busy === "release" ? <Spinner /> : <LockOpen />}
                Liberar propuestas
              </Button>
            )}
          </div>
        </div>
        <ReviewGate project={project} orchestrator={orchestrator} drafts={drafts} className="w-full xl:w-[30rem]" />
      </div>
    </section>
  )
}
