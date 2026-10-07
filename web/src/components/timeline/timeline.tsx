import { Brain, ChevronRight, Compass, Info, ListTree, Inbox, Layers, ListChecks, MessageSquareReply, OctagonAlert, Rows3, TriangleAlert } from "lucide-react"
import { memo, useMemo, useState } from "react"

import type { Session, StoredEvent, TimelineEvent } from "@shared/types"

import { AttachmentList } from "@/components/attachments"
import { DraftCard } from "@/components/draft-card"
import { RefText } from "@/components/file-ref"
import { SubagentSpecList } from "@/components/subagent-specs"
import { TonePill } from "@/components/status"
import { PermissionCard, QuestionCard } from "@/components/timeline/interactive-cards"
import { Markdown } from "@/components/timeline/markdown"
import { SubagentCard, SubagentContext, subagentMap } from "@/components/timeline/subagents"
import { OutgoingMessage, TodoCard, ToolRow, type ToolCall } from "@/components/timeline/tool-card"
import { WorkingIndicator } from "@/components/timeline/working-indicator"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { clock, duration, tokens as tokensShort, usd } from "@/lib/format"
import { reportStatusView } from "@/lib/status"
import { useStore, type PartialBlock } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"
import { failed } from "@/lib/errors"

type Ev<K extends TimelineEvent["kind"]> = StoredEvent & { event: Extract<TimelineEvent, { kind: K }> }

export type Item =
  | { type: "event"; ev: StoredEvent }
  | { type: "tool"; id: number; call: ToolCall }

const HIDDEN_TOOLS = new Set(["ToolSearch", "AskUserQuestion"])

/** Arma la lista a mostrar: empareja cada herramienta con su resultado y anida los subagentes. */
export function buildItems(events: StoredEvent[]): Item[] {
  const items: Item[] = []
  const calls = new Map<string, ToolCall>()
  for (const e of events) {
    const ev = e.event
    // El estado de los subagentes se muestra dentro de su tarjeta, no como un ítem aparte.
    if (ev.kind === "subagent") continue
    const parent = "parent" in ev ? ev.parent : null
    if (parent) {
      const owner = calls.get(parent)
      if (owner) owner.children.push(e)
      if (ev.kind === "tool_use") calls.set(ev.id, { use: ev, result: null, children: [] })
      continue
    }
    if (ev.kind === "tool_use") {
      const call: ToolCall = { use: ev, result: null, children: [] }
      calls.set(ev.id, call)
      if (!HIDDEN_TOOLS.has(ev.name)) items.push({ type: "tool", id: e.id, call })
      continue
    }
    if (ev.kind === "tool_result") {
      const call = calls.get(ev.toolUseId)
      if (call) call.result = ev
      continue
    }
    items.push({ type: "event", ev: e })
  }
  return items
}

function UserBubble({ ev }: { ev: Ev<"user"> }) {
  const { event } = ev
  return (
    <div className="flex flex-col items-end gap-1">
      {event.origin === "draft" && (
        <span className="flex max-w-[85%] items-center gap-1.5 text-xs text-muted-foreground">
          <Compass className="size-3.5 shrink-0" />
          <span className="truncate" title={event.draftTitle ?? undefined}>
            Propuesta de la orquestadora{event.draftTitle ? ` · ${event.draftTitle}` : ""}
          </span>
        </span>
      )}
      {event.origin === "external" && <span className="text-xs text-muted-foreground">Desde fuera del dashboard</span>}
      {event.attachments && event.attachments.length > 0 && <AttachmentList items={event.attachments} />}
      {event.text && (
        <div className="bubble-user max-w-[85%] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {event.text}
        </div>
      )}
      {event.subagents && event.subagents.length > 0 && (
        <div className="w-full max-w-[85%] [&>div]:mt-0">
          <SubagentSpecList specs={event.subagents} />
        </div>
      )}
      <span className="text-2xs text-muted-foreground">{clock(ev.ts)}</span>
    </div>
  )
}

function PeerMessage({ ev }: { ev: Ev<"peer"> }) {
  return (
    <div className="surface-card max-w-[85%] px-4 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquareReply className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          Mensaje de <span className="name text-foreground">{ev.event.from}</span>
        </span>
        <span className="ml-auto shrink-0 text-2xs">{clock(ev.ts)}</span>
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{ev.event.body}</p>
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui text-muted-foreground hover:bg-muted/70 hover:text-foreground",
          open && "bg-muted/50"
        )}
      >
        <Brain className="size-3.5 shrink-0" />
        Pensamiento
        <ChevronRight className={cn("ml-auto size-3.5 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
      </button>
      {open && <p className="mt-1 mb-2 ml-7.5 border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</p>}
    </div>
  )
}

function Notice({ ev }: { ev: Ev<"notice"> }) {
  const { level, text } = ev.event
  const Icon = level === "error" ? OctagonAlert : level === "warn" ? TriangleAlert : Info
  const multiline = text.includes("\n")
  return (
    <div
      role={level === "info" ? undefined : "note"}
      title={clock(ev.ts)}
      className={cn(
        "notice-line",
        level === "error" && "border-status-error-lamp text-status-error",
        level === "warn" && "border-status-attention-lamp text-foreground [&>svg]:text-status-attention",
        level === "info" && "text-muted-foreground"
      )}
    >
      <Icon aria-label={level === "error" ? "Error" : level === "warn" ? "Aviso" : undefined} />
      {multiline ? <pre className="min-w-0 font-mono text-2xs whitespace-pre-wrap wrap-anywhere">{text}</pre> : <span className="min-w-0 wrap-anywhere">{text}</span>}
    </div>
  )
}

function TurnEnd({ ev }: { ev: Ev<"turn_end"> }) {
  const { ok, durationMs, costUsd, error, terminalReason, tokens } = ev.event
  const aborted = Boolean(terminalReason?.startsWith("aborted"))
  const failed = !ok && !aborted
  return (
    <div className="flex items-center gap-3 py-1 text-muted-foreground" title={error ?? undefined}>
      <div className="h-px flex-1 bg-border" />
      <span className="turn-rule flex items-center gap-1">
        {failed && <OctagonAlert className="size-3 text-status-error" />}
        <span className={cn(failed && "font-medium text-status-error")}>
          {aborted ? "Interrumpido" : ok ? "Turno terminado" : "Terminó con error"}
        </span>
        <span>
          · {duration(durationMs)}
          {tokens ? ` · ${tokensShort(tokens)} tokens` : ""}
          {costUsd > 0 ? ` · ${usd(costUsd)} acumulado` : ""}
        </span>
      </span>
      <div className="h-px flex-1 bg-border" />
      {error && <span className="sr-only">{error}</span>}
    </div>
  )
}

function BatchCard({ ev }: { ev: Ev<"batch"> }) {
  const all = useStore((s) => s.reports)
  const reports = useMemo(() => ev.event.reportIds.map((id) => all[id]).filter(Boolean), [all, ev.event.reportIds])
  const [open, setOpen] = useState(false)
  return (
    <div className="surface-card px-4 py-3.5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Inbox className="size-4 shrink-0 text-status-pending" />
        <span className="min-w-0 truncate">{ev.event.followUp ? "Llegaron más resultados mientras analizaba" : "Cola de resultados"}</span>
        <span className="text-xs font-normal text-muted-foreground">{ev.event.reportIds.length}</span>
        <span className="ml-auto shrink-0 text-2xs font-normal text-muted-foreground">{clock(ev.ts)}</span>
      </div>
      {reports.length > 0 && (
        <ul className="mt-2.5 space-y-2">
          {reports.map((r) => (
            <li key={r!.id} className="flex items-start gap-2.5 text-ui">
              <TonePill tone={reportStatusView[r!.status].tone} className="mt-px max-w-40 shrink-0">
                <span className="name truncate" title={r!.sessionName}>
                  {r!.sessionName}
                </span>
              </TonePill>
              <span className="line-clamp-2 text-foreground/85" title={r!.summary}>
                {r!.summary}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-2.5 inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {open ? "Ocultar el mensaje que recibió" : "Ver el mensaje que recibió"}
      </button>
      {open && <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-muted/60 p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap">{ev.event.text}</pre>}
    </div>
  )
}

function ReportCall({ call }: { call: ToolCall }) {
  const input = (call.use.input ?? {}) as { status?: "done" | "blocked" | "partial"; summary?: string; details?: string }
  const [open, setOpen] = useState(false)
  const status = reportStatusView[input.status ?? "done"] ?? reportStatusView.done
  return (
    <div className="surface-card px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <Rows3 className="size-4 text-muted-foreground" />
        Reportó su resultado
        <TonePill tone={status.tone}>{status.label}</TonePill>
        {call.result?.isError && <span className="text-xs text-status-error">No se registró</span>}
      </div>
      {input.summary && (
        <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
          <RefText text={input.summary} />
        </p>
      )}
      {input.details && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-2 inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
            Detalles
          </button>
          {open && (
            <div className="mt-2 border-t pt-3">
              <Markdown text={input.details} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ProposalCall({ call, root, live }: { call: ToolCall; root?: string; live: boolean }) {
  const draftId = /\b(d_[A-Za-z0-9]+)\b/.exec(call.result?.content ?? "")?.[1]
  const draft = useStore((s) => (draftId ? s.drafts[draftId] : undefined))
  if (!draft) return <ToolRow call={call} root={root} live={live} />
  return <DraftCard draft={draft} compact />
}

function ToolItem({ call, root, live }: { call: ToolCall; root?: string; live: boolean }) {
  switch (call.use.name) {
    case "TodoWrite":
      return <TodoCard call={call} />
    case "SendMessage":
      return <OutgoingMessage call={call} />
    case "mcp__control-plane__report_result":
      return <ReportCall call={call} />
    case "mcp__control-plane__propose_prompt":
    case "mcp__control-plane__propose_session":
      return <ProposalCall call={call} root={root} live={live} />
    case "Agent":
    case "Task":
      return <SubagentCard call={call} live={live} />
    default:
      return <ToolRow call={call} root={root} live={live} />
  }
}

/** Separador de compactación: cuánto se achicó el contexto y el resumen con el que siguió. */
function CompactCard({ ev }: { ev: Ev<"compact"> }) {
  const e = ev.event
  const [open, setOpen] = useState(false)
  const size = e.postTokens ? `${tokensShort(e.preTokens)} → ${tokensShort(e.postTokens)}` : e.preTokens ? tokensShort(e.preTokens) : null
  const curated = e.kept !== undefined
  return (
    <div className="py-1">
      <div className="flex items-center gap-3 text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => e.summary && setOpen((v) => !v)}
          aria-expanded={e.summary ? open : undefined}
          className={cn("turn-rule flex items-center gap-1.5 rounded-md", e.summary && "hover:text-foreground")}
          disabled={!e.summary}
        >
          <Layers className="size-3" />
          Contexto compactado {e.trigger === "auto" ? "solo" : "a mano"}
          {size ? ` · ${size} tokens` : ""}
          {curated ? ` · ${e.kept} conservados${e.dropped ? `, ${e.dropped} descartados` : ""}` : ""}
          {e.summary && <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />}
        </button>
        <div className="h-px flex-1 bg-border" />
      </div>
      {open && e.summary && (
        <div className="mt-2 rounded-2xl bg-muted/60 px-4 py-3">
          <p className="eyebrow mb-2">Con esto siguió la conversación</p>
          <Markdown text={e.summary} />
        </div>
      )}
    </div>
  )
}

const EventItem = memo(function EventItem({ ev, sessionId }: { ev: StoredEvent; sessionId: string }) {
  const e = ev.event
  switch (e.kind) {
    case "user":
      return <UserBubble ev={ev as Ev<"user">} />
    case "peer":
      return <PeerMessage ev={ev as Ev<"peer">} />
    case "text":
      return (
        <div>
          <Markdown text={e.text} />
          {e.aborted && <span className="text-xs text-muted-foreground"> (interrumpido)</span>}
        </div>
      )
    case "thinking":
      return <Thinking text={e.text} />
    case "turn_end":
      return <TurnEnd ev={ev as Ev<"turn_end">} />
    case "question":
      return <QuestionCard sessionId={sessionId} event={e} />
    case "permission":
      return <PermissionCard sessionId={sessionId} event={e} />
    case "notice":
      return <Notice ev={ev as Ev<"notice">} />
    case "batch":
      return <BatchCard ev={ev as Ev<"batch">} />
    case "compact":
      return <CompactCard ev={ev as Ev<"compact">} />
    default:
      return null
  }
})

/** El turno no salió porque la conversación ya no entra (la misma regla que usa el server). */
function contextFull(e: TimelineEvent): boolean {
  if (e.kind !== "turn_end" || e.ok) return false
  return e.terminalReason === "blocking_limit" || e.terminalReason === "prompt_too_long" || /^Prompt is too long/i.test(e.error ?? "")
}

/** Si el último turno no salió por el contexto lleno: compactar y reenviar, o elegir qué conservar. */
function ContextFullBar({ session, events }: { session: Session; events: StoredEvent[] }) {
  const [busy, setBusy] = useState(false)
  const setUi = useUi((s) => s.set)
  const last = useMemo(() => events.findLast((e) => e.event.kind === "turn_end"), [events])
  const pending = useStore((s) => s.compactions[session.id]?.resendPending ?? false)
  const stuck = pending || (last !== undefined && contextFull(last.event))
  if (!stuck || session.status === "working" || session.status === "starting") return null
  const resend = async () => {
    setBusy(true)
    try {
      await api.compactionResend(session.id)
    } catch (err) {
      failed("compactar y reenviar")(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div role="alert" className="surface-card flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm ring-2 ring-status-attention-lamp/70">
      <TriangleAlert className="size-4 shrink-0 text-status-attention" />
      <span className="min-w-0 flex-1">El contexto está lleno y el último mensaje no salió. Compactá la conversación y se reenvía.</span>
      <Button size="sm" onClick={() => void resend()} disabled={busy}>
        {busy ? <Spinner /> : <Layers />}
        Compactar y reenviar
      </Button>
      <Button size="sm" variant="outline" onClick={() => setUi({ compactFor: session.id })}>
        <ListChecks />
        Elegir qué conservar
      </Button>
    </div>
  )
}

function LiveTail({ session, partial }: { session: Session; partial?: PartialBlock }) {
  const turn = useStore((s) => s.turns[session.id])
  const working = session.status === "working" || session.status === "starting"
  const streaming = partial?.block === "text" && partial.text
  if (!streaming && !working) return null
  return (
    <div className="space-y-3">
      {streaming && (
        <div className="streaming-caret">
          <Markdown text={partial.text} className="inline" />
        </div>
      )}
      {working && <WorkingIndicator session={session} turn={turn} block={partial?.block} />}
    </div>
  )
}

/** Renderiza una lista de ítems ya armada (la usa el chat principal y el panel de cada subagente). */
export function TimelineItems({
  items,
  sessionId,
  root,
  live,
}: {
  items: Item[]
  sessionId: string
  root?: string
  live: boolean
}) {
  const lastTurnIndex = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.type === "event" && (it.ev.event.kind === "turn_end" || it.ev.event.kind === "user" || it.ev.event.kind === "batch"))
        return i
    }
    return -1
  }, [items])
  const render = (it: Item, i: number) =>
    it.type === "tool" ? (
      <ToolItem key={it.id} call={it.call} root={root} live={live && i > lastTurnIndex} />
    ) : (
      <EventItem key={it.ev.id} ev={it.ev} sessionId={sessionId} />
    )
  // Lo que hace la sesión entre mensaje y mensaje (herramientas y pensamiento) va junto, en un
  // bloque apretado: el chat se lee por los mensajes y las tarjetas, no por cada paso. Cuando el
  // turno terminó, el bloque se pliega en una línea que lo resume.
  const out: React.ReactNode[] = []
  let run: { it: Item; i: number }[] = []
  const flush = () => {
    if (run.length) {
      const list = run
      const first = list[0]!.it
      const key = `steps-${first.type === "tool" ? first.id : first.ev.id}`
      const settled = !(live && list[list.length - 1]!.i > lastTurnIndex)
      out.push(
        <StepRun key={key} settled={settled} items={list.map((r) => r.it)}>
          {(only) => list.filter((r) => !only || only(r.it)).map((r) => render(r.it, r.i))}
        </StepRun>
      )
    }
    run = []
  }
  items.forEach((it, i) => {
    if (isStep(it)) run.push({ it, i })
    else {
      flush()
      out.push(render(it, i))
    }
  })
  flush()
  return <>{out}</>
}

const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
const failedStep = (it: Item) => it.type === "tool" && Boolean(it.call.result?.isError)

/** "12 pasos · 2 archivos editados · 3 comandos": de qué se trató el bloque, sin abrirlo. */
function stepSummary(items: Item[]): string {
  const tools = items.filter((it): it is Extract<Item, { type: "tool" }> => it.type === "tool")
  const files = new Set(
    tools.filter((t) => EDITS.has(t.call.use.name)).map((t) => String((t.call.use.input as Record<string, unknown>)?.file_path ?? (t.call.use.input as Record<string, unknown>)?.notebook_path ?? t.id))
  )
  const commands = tools.filter((t) => t.call.use.name === "Bash").length
  const thoughts = items.length - tools.length
  return [
    tools.length ? (tools.length === 1 ? "1 paso" : `${tools.length} pasos`) : null,
    files.size ? (files.size === 1 ? "1 archivo editado" : `${files.size} archivos editados`) : null,
    commands ? (commands === 1 ? "1 comando" : `${commands} comandos`) : null,
    !tools.length && thoughts ? "Pensamiento" : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * Un bloque de pasos seguidos. Mientras el turno corre, se ven todos. Cuando terminó, se pliega en
 * una línea (si son dos o más); lo que falló queda siempre a la vista, debajo.
 */
function StepRun({
  items,
  settled,
  children,
}: {
  items: Item[]
  settled: boolean
  children: (only?: (it: Item) => boolean) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const foldable = settled && items.length > 1
  if (!foldable) return <div className="flex flex-col gap-0.5">{children()}</div>
  const failures = items.filter(failedStep).length
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ui text-muted-foreground hover:bg-muted/70 hover:text-foreground",
          open && "bg-muted/50"
        )}
      >
        <ListTree className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{stepSummary(items)}</span>
        {failures > 0 && (
          <span className="shrink-0 font-medium text-status-error">· {failures === 1 ? "1 falló" : `${failures} fallaron`}</span>
        )}
        <ChevronRight className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
      </button>
      {open ? <div className="ml-3 flex flex-col gap-0.5 border-l pl-2">{children()}</div> : failures > 0 && children(failedStep)}
    </div>
  )
}

/** Las herramientas que no son una tarjeta propia y el pensamiento: los pasos chicos del trabajo. */
const CARD_TOOLS = new Set([
  "TodoWrite",
  "SendMessage",
  "mcp__control-plane__report_result",
  "mcp__control-plane__propose_prompt",
  "mcp__control-plane__propose_session",
  "Agent",
  "Task",
])
function isStep(it: Item): boolean {
  return it.type === "tool" ? !CARD_TOOLS.has(it.call.use.name) : it.ev.event.kind === "thinking"
}

export function Timeline({ session, events }: { session: Session; events: StoredEvent[] }) {
  const partial = useStore((s) => s.partials[session.id])
  const items = useMemo(() => buildItems(events), [events])
  const subagents = useMemo(() => ({ sessionId: session.id, map: subagentMap(events) }), [events, session.id])
  const live = session.status === "working" || session.status === "needs_input" || session.subagentsRunning > 0

  return (
    <SubagentContext.Provider value={subagents}>
      <div className="flex flex-col gap-3">
        <TimelineItems items={items} sessionId={session.id} root={session.cwd} live={live} />
        <ContextFullBar session={session} events={events} />
        <LiveTail session={session} partial={partial} />
      </div>
    </SubagentContext.Provider>
  )
}
