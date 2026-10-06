import { ChevronDown, X } from "lucide-react"
import { useState } from "react"
import { Link } from "wouter"

import type { Report } from "@shared/types"

import { FileRefScope, RefText } from "@/components/file-ref"
import { Markdown } from "@/components/timeline/markdown"
import { TonePill } from "@/components/status"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { reportStateLabel, reportStatusView, toneText } from "@/lib/status"
import { undoable } from "@/lib/undo"
import { cn } from "@/lib/utils"

/** Un resultado que reportó un worker. */
export function ReportCard({ report, showSession = true, className }: { report: Report; showSession?: boolean; className?: string }) {
  const [open, setOpen] = useState(false)
  // Quitado de la cola: se esconde al toque y vuelve si se deshace o falla.
  const [hidden, setHidden] = useState(false)
  const status = reportStatusView[report.status]
  const pending = report.state === "queued" || report.state === "in_review"
  const dismiss = () =>
    undoable({
      message: "Resultado quitado de la cola",
      failMessage: "No se pudo quitar de la cola",
      run: () => api.dismissReport(report.id),
      onHide: () => setHidden(true),
      onRestore: () => setHidden(false),
    })
  return (
    <FileRefScope projectId={report.projectId} sessionId={report.sessionId}>
      <article hidden={hidden} className={cn("surface-card p-4", !pending && "bg-card/70", className)}>
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {showSession && (
            <Link href={`/p/${report.projectId}/s/${report.sessionId}`} className="name text-foreground hover:underline">
              {report.sessionName}
            </Link>
          )}
          <TonePill tone={status.tone}>{status.label}</TonePill>
          <span
            className={cn(
              "font-medium",
              report.state === "queued" && toneText.pending,
              report.state === "in_review" && toneText.working
            )}
          >
            {reportStateLabel[report.state].toLocaleLowerCase("es-AR")}
          </span>
          <span className="ml-auto" title={new Date(report.createdAt).toLocaleString("es-AR")}>
            {timeAgo(report.createdAt)}
          </span>
        </header>
        {report.taskTitle && (
          <p className="mt-1.5 truncate text-xs text-muted-foreground" title={report.taskTitle}>
            Tarea: {report.taskTitle}
          </p>
        )}
        <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
          <RefText text={report.summary} />
        </p>
        {(report.details || report.state === "queued") && (
          <div className="mt-2 flex items-center gap-2">
            {report.details && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
                {open ? "Ocultar detalles" : "Ver detalles"}
              </button>
            )}
            {report.state === "queued" && (
              <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={dismiss}>
                <X />
                Quitar de la cola
              </Button>
            )}
          </div>
        )}
        {open && report.details && (
          <div className="mt-2 rounded-xl bg-muted/60 p-3">
            <Markdown text={report.details} />
          </div>
        )}
      </article>
    </FileRefScope>
  )
}
