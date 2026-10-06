import type { DraftState, ReportState, ReportStatus, Session } from "@shared/types"

/**
 * Los tonos y qué significan (no cambies el significado por estética):
 * - working: trabajando o arrancando.
 * - attention (ámbar, la alarma): algo te espera y frena: una pregunta, un permiso, una tarea que
 *   frena, una sesión bloqueada, una compactación por decidir. Nada más va en ámbar.
 * - pending (violeta): para mirar cuando puedas, no frena: propuestas listas, resultados parciales,
 *   en cola, una conversación abierta en otro lado, cambios sin subir.
 * - done: terminó bien. error: falló (además del color, su luz es un rombo). idle: quieta o detenida.
 */
export type Tone = "working" | "attention" | "pending" | "done" | "error" | "idle"

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
      return { label: "Arrancando", tone: "working", pulse: true }
    case "stopped":
      if (s.external) return { label: s.external.kind === "background" ? "En segundo plano" : "En una terminal", tone: "pending", pulse: false }
      if (s.taskState === "reported_done") return { label: "Terminó", tone: "done", pulse: false }
      return { label: "Detenida", tone: "idle", pulse: false }
    case "idle":
      if (s.kind === "worker") {
        if (s.taskState === "reported_done") return { label: "Terminó", tone: "done", pulse: false }
        if (s.taskState === "reported_blocked") return { label: "Bloqueada", tone: "attention", pulse: false }
        if (s.taskState === "reported_partial") return { label: "Parcial", tone: "pending", pulse: false }
      }
      return { label: "Esperando", tone: "idle", pulse: false }
  }
}

/** La regla única de "te necesita" (ver DESIGN.md): una sesión esperando algo tuyo. "Bloqueada" no entra. */
export { sessionWaits as sessionNeedsYou } from "@shared/inbox-count"

export const toneText: Record<Tone, string> = {
  working: "text-status-working",
  attention: "text-status-attention",
  pending: "text-status-pending",
  done: "text-status-done",
  error: "text-status-error",
  idle: "text-status-idle",
}

/** Las luces: pueden ser más vivas que el texto (ver --lamp-* en index.css). */
export const toneBg: Record<Tone, string> = {
  working: "bg-status-working-lamp",
  attention: "bg-status-attention-lamp",
  pending: "bg-status-pending-lamp",
  done: "bg-status-done-lamp",
  error: "bg-status-error-lamp",
  idle: "bg-status-idle-lamp",
}

/** Fondo suave con su texto (pastillas, filas resaltadas). El texto pasa AA sobre ese fondo. */
export const toneSoft: Record<Tone, string> = {
  working: "bg-status-working-lamp/12 text-status-working",
  attention: "bg-status-attention-lamp/18 text-status-attention",
  pending: "bg-status-pending-lamp/12 text-status-pending",
  done: "bg-status-done-lamp/14 text-status-done",
  error: "bg-status-error-lamp/12 text-status-error",
  idle: "bg-muted text-muted-foreground",
}

export const reportStatusView: Record<ReportStatus, { label: string; tone: Tone }> = {
  done: { label: "Terminado", tone: "done" },
  blocked: { label: "Bloqueado", tone: "attention" },
  partial: { label: "Parcial", tone: "pending" },
}

export const reportStateLabel: Record<ReportState, string> = {
  queued: "En cola",
  in_review: "En revisión",
  reviewed: "Revisado",
  dismissed: "Quitado",
}

export const draftStateView: Record<DraftState, { label: string; tone: Tone }> = {
  staged: { label: "En preparación", tone: "working" },
  ready: { label: "Lista para enviar", tone: "pending" },
  sent: { label: "Enviada", tone: "done" },
  discarded: { label: "Descartada", tone: "idle" },
}
