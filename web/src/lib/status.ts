import type { DraftState, ReportState, ReportStatus, Session } from "@shared/types"

export type Tone = "working" | "attention" | "done" | "error" | "idle"

export interface StatusView {
  label: string
  tone: Tone
  pulse: boolean
}

/** Estado que ves en pantalla: combina el proceso con la tarea. */
export function sessionStatus(s: Session): StatusView {
  switch (s.status) {
    case "needs_input":
      if (!s.pending && s.statusDetail?.startsWith("Por compactar")) return { label: "Por compactar", tone: "attention", pulse: true }
      return { label: "Te necesita", tone: "attention", pulse: false }
    case "error":
      return { label: "Error", tone: "error", pulse: false }
    case "working":
      return { label: "Trabajando", tone: "working", pulse: true }
    case "starting":
      return { label: "Iniciando", tone: "working", pulse: true }
    case "stopped":
      if (s.taskState === "reported_done") return { label: "Terminó", tone: "done", pulse: false }
      return { label: "Detenida", tone: "idle", pulse: false }
    case "idle":
      if (s.kind === "worker") {
        if (s.taskState === "reported_done") return { label: "Terminó", tone: "done", pulse: false }
        if (s.taskState === "reported_blocked") return { label: "Bloqueada", tone: "attention", pulse: false }
        if (s.taskState === "reported_partial") return { label: "Parcial", tone: "attention", pulse: false }
      }
      return { label: "Esperando", tone: "idle", pulse: false }
  }
}

export const toneText: Record<Tone, string> = {
  working: "text-status-working",
  attention: "text-status-attention",
  done: "text-status-done",
  error: "text-status-error",
  idle: "text-status-idle",
}

export const toneBg: Record<Tone, string> = {
  working: "bg-status-working",
  attention: "bg-status-attention",
  done: "bg-status-done",
  error: "bg-status-error",
  idle: "bg-status-idle",
}

export const toneSoft: Record<Tone, string> = {
  working: "bg-status-working/10 text-status-working",
  attention: "bg-status-attention/15 text-status-attention",
  done: "bg-status-done/12 text-status-done",
  error: "bg-status-error/12 text-status-error",
  idle: "bg-muted text-muted-foreground",
}

export const reportStatusView: Record<ReportStatus, { label: string; tone: Tone }> = {
  done: { label: "Terminado", tone: "done" },
  blocked: { label: "Bloqueado", tone: "attention" },
  partial: { label: "Parcial", tone: "attention" },
}

export const reportStateLabel: Record<ReportState, string> = {
  queued: "En cola",
  in_review: "En revisión",
  reviewed: "Revisado",
  dismissed: "Quitado",
}

export const draftStateView: Record<DraftState, { label: string; tone: Tone }> = {
  staged: { label: "En preparación", tone: "working" },
  ready: { label: "Lista para enviar", tone: "attention" },
  sent: { label: "Enviada", tone: "done" },
  discarded: { label: "Descartada", tone: "idle" },
}
