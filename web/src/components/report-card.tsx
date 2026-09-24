import { ChevronDown, X } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { Report } from "@shared/types"

import { Markdown } from "@/components/timeline/markdown"
import { TonePill } from "@/components/status"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { reportStateLabel, reportStatusView } from "@/lib/status"
import { cn } from "@/lib/utils"

/** Un resultado que reportó un worker. */
export function ReportCard({ report, showSession = true, className }: { report: Report; showSession?: boolean; className?: string }) {
  const [open, setOpen] = useState(false)
  const status = reportStatusView[report.status]
  const pending = report.state === "queued" || report.state === "in_review"
  return (
    <article className={cn("rounded-xl border bg-card p-3.5", !pending && "bg-card/60", className)}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {showSession && (
          <Link
            href={`/p/${report.projectId}/s/${report.sessionId}`}
            className="font-mono font-medium text-foreground hover:underline"
          >
            {report.sessionName}
          </Link>
        )}
        <TonePill tone={status.tone}>{status.label}</TonePill>
        <span
          className={cn(
            "font-condensed font-semibold tracking-wide uppercase",
            report.state === "queued" && "text-status-attention",
            report.state === "in_review" && "text-status-working"
          )}
        >
          {reportStateLabel[report.state]}
        </span>
        <span className="ml-auto">{timeAgo(report.createdAt)}</span>
      </header>
      {report.taskTitle && <p className="mt-1.5 truncate text-xs text-muted-foreground">Tarea: {report.taskTitle}</p>}
      <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap">{report.summary}</p>
      {(report.details || report.state === "queued") && (
        <div className="mt-2 flex items-center gap-2">
          {report.details && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
              {open ? "Ocultar detalles" : "Ver detalles"}
            </button>
          )}
          {report.state === "queued" && (
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              onClick={() =>
                api.dismissReport(report.id).then(
                  () => toast.success("Resultado quitado de la cola"),
                  (err: Error) => toast.error(err.message)
                )
              }
            >
              <X />
              Quitar de la cola
            </Button>
          )}
        </div>
      )}
      {open && report.details && (
        <div className="mt-2 rounded-lg bg-muted/60 p-3">
          <Markdown text={report.details} />
        </div>
      )}
    </article>
  )
}
