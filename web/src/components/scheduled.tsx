import { AlarmClock, CalendarClock, ChevronRight, CircleX, Cloud, Repeat } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import { cancelState, type CancelState } from "@shared/cancel-scheduled"
import { deliver } from "@shared/deliver"
import type { ScheduledItem, Session } from "@shared/types"

import { Section } from "@/components/panel-section"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useNow } from "@/hooks/use-now"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { usePanelSections, useSectionOpen } from "@/lib/panel-sections"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/** "en 20 min", "en 2 h 10 min", "el 30/9 a las 9:00". */
export function untilText(t: number, now: number): string {
  const diff = t - now
  if (diff < 45_000) return diff < -60_000 ? timeAgo(t, now) : "ahora"
  const min = Math.round(diff / 60_000)
  if (min < 60) return `en ${min} min`
  if (min < 24 * 60) {
    const h = Math.floor(min / 60)
    const m = min % 60
    return m ? `en ${h} h ${m} min` : `en ${h} h`
  }
  const d = new Date(t)
  return `el ${d.getDate()}/${d.getMonth() + 1} a las ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`
}

const STATUS: Record<ScheduledItem["status"], { label: string; className: string }> = {
  active: { label: "activa", className: "bg-status-done/12 text-status-done" },
  done: { label: "ya corrió", className: "bg-muted text-muted-foreground" },
  cancelled: { label: "cancelada", className: "bg-muted text-muted-foreground" },
  expired: { label: "venció (7 días)", className: "bg-muted text-muted-foreground" },
  lost: { label: "se perdió", className: "bg-status-error/10 text-status-error" },
  missed: { label: "no corrió", className: "bg-status-attention/12 text-status-attention" },
}

function StatusChip({ item, pending }: { item: ScheduledItem; pending: boolean }) {
  const s = pending
    ? { label: "cancelación pedida", className: "bg-status-working/12 text-status-working" }
    : item.paused
      ? { label: "en pausa", className: "bg-status-attention/12 text-status-attention" }
      : STATUS[item.status]
  return <span className={cn("shrink-0 rounded px-1.5 py-px text-[0.66rem] font-medium", s.className)}>{s.label}</span>
}

function KindIcon({ item }: { item: ScheduledItem }) {
  const Icon = item.kind === "wakeup" ? AlarmClock : item.kind === "routine" ? Cloud : item.recurring ? Repeat : CalendarClock
  return <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
}

/** Cuándo corre, en palabras, y cuánto falta. */
function When({ item, now }: { item: ScheduledItem; now: number }) {
  const until = item.nextAt && item.status === "active" ? untilText(item.nextAt, now) : null
  return (
    <span className="min-w-0 text-xs">
      <span className="font-medium">{item.when}</span>
      {until && item.kind !== "wakeup" && <span className="text-muted-foreground"> · {until}</span>}
      {until && item.kind === "wakeup" && <span className="text-muted-foreground"> ({until})</span>}
      {item.kind === "wakeup" && item.reason && <span className="text-foreground/80">: {item.reason}</span>}
    </span>
  )
}

/** Lo que se avisa antes de mandar el pedido, según qué está haciendo la sesión (null: alcanza con un confirm chico). */
function cancelWarning(status: Session["status"]): string | null {
  if (status === "stopped" || status === "error") return "La sesión está detenida: el mensaje la reanuda para que la cancele."
  if (status === "working") return "La sesión está trabajando: la va a cancelar cuando termine lo que está haciendo."
  return null
}

/**
 * "Pedir que la cancele": solo la sesión puede cancelar lo que programó, así que le manda un mensaje
 * (por el mismo camino que el composer). Mientras no llega la cancelación, queda pedida; si la sesión
 * termina su turno sin hacerlo, avisa y deja volver a pedirlo.
 */
function CancelControl({ item, session, state }: { item: ScheduledItem; session: Session; state: CancelState }) {
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const warning = cancelWarning(session.status)

  const send = async () => {
    setConfirming(false)
    setSending(true)
    const clientId = `x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    try {
      await deliver({
        send: () => api.cancelScheduled(session.id, item.id, clientId),
        echoed: () => (useStore.getState().events[session.id] ?? []).some((e) => e.event.kind === "user" && e.event.clientId === clientId),
      })
    } catch (err) {
      toast.error("No se pudo mandar el pedido", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSending(false)
    }
  }

  if (state === "pending")
    return <p className="text-[0.68rem] text-status-working">Le pedimos a {session.name} que la cancele: se actualiza sola cuando lo haga.</p>

  return (
    <div className="pt-0.5">
      {state === "failed" && <p className="text-[0.68rem] font-medium text-status-attention">No la canceló: mirá el chat.</p>}
      {confirming && !warning ? (
        <div className="flex items-center gap-1.5 text-[0.7rem]">
          <span className="text-muted-foreground">¿Le pedís a {session.name} que la cancele?</span>
          <Button size="xs" variant="destructive" onClick={() => void send()}>
            Pedir
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
            No
          </Button>
        </div>
      ) : (
        <button
          type="button"
          disabled={sending}
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1 rounded text-[0.7rem] text-muted-foreground hover:text-status-error disabled:opacity-50"
        >
          <CircleX className="size-3" />
          {state === "failed" ? "Pedírselo de nuevo" : "Pedir que la cancele"}
        </button>
      )}
      <AlertDialog open={confirming && warning !== null} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Pedirle a {session.name} que la cancele?</AlertDialogTitle>
            <AlertDialogDescription>
              {warning} Solo la sesión puede cancelar lo que programó, así que se lo pedimos con un mensaje en el chat.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void send()}>
              Pedir que la cancele
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Una tarea programada: cuándo, si se repite, el prompt (entero al expandir) y su estado. */
function ScheduledRow({ item, now, session, showSession }: { item: ScheduledItem; now: number; session: Session; showSession?: boolean }) {
  const [open, setOpen] = useState(false)
  const cancel = cancelState(item.cancelRequest, item, session.status, now)
  const done = item.status !== "active"
  const facts = [
    item.kind === "cron" ? (item.recurring ? "se repite" : "una vez") : null,
    item.kind === "cron" ? (item.durable ? "sobrevive al cierre" : "solo mientras la sesión esté abierta") : null,
    item.kind === "routine" ? "corre en la nube, no en esta máquina" : null,
    item.fires > 0 && item.lastFiredAt ? `corrió ${item.fires === 1 ? "1 vez" : `${item.fires} veces`}, la última ${timeAgo(item.lastFiredAt, now)}` : null,
  ].filter(Boolean)
  const prompt = item.prompt.trim()
  return (
    <li className={cn("rounded-md border bg-background px-2.5 py-2", done && "opacity-70")}>
      <div className="flex items-start gap-2">
        <KindIcon item={item} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1">
              {showSession && (
                <Link href={`/p/${session.projectId}/s/${session.id}`} className="mr-1.5 font-mono text-xs font-medium hover:underline">
                  {session.name}
                </Link>
              )}
              <When item={item} now={now} />
            </p>
            <StatusChip item={item} pending={cancel === "pending"} />
          </div>
          {prompt && item.kind !== "wakeup" && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              title={open ? undefined : prompt}
              aria-expanded={open}
              className={cn("block w-full text-left text-xs text-muted-foreground hover:text-foreground", open ? "whitespace-pre-wrap" : "line-clamp-2")}
            >
              {prompt}
            </button>
          )}
          {facts.length > 0 && <p className="text-[0.68rem] text-muted-foreground/80">{facts.join(" · ")}</p>}
          {item.status === "active" && <CancelControl item={item} session={session} state={cancel} />}
        </div>
      </div>
    </li>
  )
}

const LOST_HINT = "Era solo de esa corrida de la sesión: Claude Code no la guarda y se pierde cuando el proceso termina."

/** "Programado" en el panel de la sesión: sus crons, sus wakeups de /loop y sus rutinas. */
export function SessionScheduled({ session }: { session: Session }) {
  const now = useNow(30_000)
  const items = session.scheduled ?? []
  const active = items.filter((i) => i.status === "active")
  const paused = active.filter((i) => i.paused)
  const next = active.filter((i) => i.nextAt).sort((a, b) => a.nextAt! - b.nextAt!)[0]
  if (!items.length) return null
  const summary = paused.length
    ? `${paused.length} en pausa: la sesión está detenida`
    : active.length
      ? `${active.length} ${active.length === 1 ? "activa" : "activas"}${next ? ` · la próxima ${untilText(next.nextAt!, now)}` : ""}`
      : "nada activo"
  return (
    <Section id="scheduled" title="Programado" count={active.length || undefined} attention={paused.length > 0} summary={summary}>
      <div className="space-y-2">
        {paused.length > 0 && (
          <p className="rounded-md border border-status-attention/40 bg-status-attention/5 px-2.5 py-1.5 text-xs leading-snug">
            La sesión está detenida: lo programado no corre hasta que la reanudes. Si al volver ya pasó la hora de algo de una vez,
            Claude Code te pregunta antes de correrlo.
          </p>
        )}
        {items.some((i) => i.status === "lost") && <p className="text-[0.7rem] leading-snug text-muted-foreground">{LOST_HINT}</p>}
        <ul className="space-y-1.5">
          {items.map((i) => (
            <ScheduledRow key={i.id} item={i} now={now} session={session} />
          ))}
        </ul>
      </div>
    </Section>
  )
}

/** "Programado" en el resumen del proyecto: lo activo de todas sus sesiones, por la próxima ejecución. */
export function ProjectScheduled({ sessions }: { sessions: Session[] }) {
  const now = useNow(30_000)
  const open = useSectionOpen("project-scheduled")
  const toggle = usePanelSections((s) => s.toggle)
  const rows = useMemo(
    () =>
      sessions
        .flatMap((s) => (s.scheduled ?? []).filter((i) => i.status === "active").map((item) => ({ item, session: s })))
        .sort((a, b) => (a.item.nextAt ?? Infinity) - (b.item.nextAt ?? Infinity)),
    [sessions]
  )
  if (!rows.length) return null
  const paused = rows.filter((r) => r.item.paused).length
  const next = rows.find((r) => r.item.nextAt)
  return (
    <Collapsible open={open} onOpenChange={(v) => toggle("project-scheduled", v)} className="border-b">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
          <span className="font-medium">Programado</span>
          <span className="text-xs text-muted-foreground">
            {" · "}
            {rows.length} {rows.length === 1 ? "programada" : "programadas"}
            {next && (
              <>
                {" · la próxima "}
                <span className="text-foreground/80">{untilText(next.item.nextAt!, now)}</span> <span className="font-mono">({next.session.name})</span>
              </>
            )}
            {paused > 0 && (
              <>
                {" · "}
                <span className="font-medium text-status-attention">{paused} en pausa (sesión detenida)</span>
              </>
            )}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4 pl-10">
        <ul className="grid gap-1.5 lg:grid-cols-2">
          {rows.map(({ item, session }) => (
            <ScheduledRow key={`${session.id}-${item.id}`} item={item} now={now} session={session} showSession />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
