import { Brain, ChevronRight, Info, Inbox, Layers, MessageSquareReply, OctagonAlert, Rows3, TriangleAlert } from "lucide-react"
import { memo, useMemo, useState } from "react"

import type { Session, StoredEvent, TimelineEvent } from "@shared/types"

import { AttachmentList } from "@/components/attachments"
import { DraftCard } from "@/components/draft-card"
import { SubagentSpecList } from "@/components/subagent-specs"
import { TonePill } from "@/components/status"
import { PermissionCard, QuestionCard } from "@/components/timeline/interactive-cards"
import { Markdown } from "@/components/timeline/markdown"
import { SubagentCard, SubagentContext, subagentMap } from "@/components/timeline/subagents"
import { OutgoingMessage, TodoCard, ToolRow, type ToolCall } from "@/components/timeline/tool-card"
import { Spinner } from "@/components/ui/spinner"
import { clock, duration, tokens as tokensShort, usd } from "@/lib/format"
import { reportStatusView } from "@/lib/status"
import { useStore, type PartialBlock } from "@/lib/store"
import { cn } from "@/lib/utils"

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
        <span className="text-xs text-muted-foreground">
          Propuesta de la orquestadora{event.draftTitle ? ` · ${event.draftTitle}` : ""}
        </span>
      )}
      {event.origin === "external" && <span className="text-xs text-muted-foreground">Desde fuera del dashboard</span>}
      {event.attachments && event.attachments.length > 0 && <AttachmentList items={event.attachments} />}
      {event.text && (
        <div
          className={cn(
            "max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[0.9rem] leading-relaxed whitespace-pre-wrap break-words",
            event.origin === "draft" && "border border-status-working/25 bg-status-working/8"
          )}
        >
          {event.text}
        </div>
      )}
      {event.subagents && event.subagents.length > 0 && (
        <div className="w-full max-w-[85%] [&>div]:mt-0">
          <SubagentSpecList specs={event.subagents} />
        </div>
      )}
      <span className="font-mono text-[0.65rem] text-muted-foreground/70">{clock(ev.ts)}</span>
    </div>
  )
}

function PeerMessage({ ev }: { ev: Ev<"peer"> }) {
  return (
    <div className="max-w-[85%] rounded-xl border border-l-4 border-l-status-working/60 bg-card px-3.5 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquareReply className="size-3.5" />
        Mensaje de <span className="font-mono font-medium text-foreground">{ev.event.from}</span>
        <span className="ml-auto font-mono text-[0.65rem]">{clock(ev.ts)}</span>
      </div>
      <p className="text-[0.87rem] leading-relaxed whitespace-pre-wrap">{ev.event.body}</p>
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
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/60"
      >
        <Brain className="size-3.5" />
        Pensamiento
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <p className="mt-1 ml-2 border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
          {text}
        </p>
      )}
    </div>
  )
}

function Notice({ ev }: { ev: Ev<"notice"> }) {
  const { level, text } = ev.event
  const Icon = level === "error" ? OctagonAlert : level === "warn" ? TriangleAlert : Info
  const multiline = text.includes("\n")
  return (
    <div
      className={cn(
        "mx-auto flex max-w-[90%] items-start gap-2 rounded-lg px-3 py-1.5 text-xs",
        level === "error" && "bg-status-error/10 text-status-error",
        level === "warn" && "text-status-attention",
        level === "info" && "text-muted-foreground"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      {multiline ? <pre className="font-mono text-[0.72rem] whitespace-pre-wrap">{text}</pre> : <span>{text}</span>}
    </div>
  )
}

function TurnEnd({ ev }: { ev: Ev<"turn_end"> }) {
  const { ok, durationMs, costUsd, error, terminalReason, tokens } = ev.event
  const aborted = Boolean(terminalReason?.startsWith("aborted"))
  return (
    <div className="flex items-center gap-3 py-1 text-[0.7rem] text-muted-foreground/80">
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono">
        {aborted ? "interrumpido" : ok ? "turno terminado" : "error"} · {duration(durationMs)}
        {tokens ? ` · ${tokensShort(tokens)} tokens` : ""}
        {costUsd > 0 ? ` · ${usd(costUsd)} acumulado` : ""}
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
    <div className="rounded-xl border border-status-attention/40 bg-status-attention/5 p-3.5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Inbox className="size-4 text-status-attention" />
        {ev.event.followUp ? "Llegaron más resultados mientras analizaba" : "Cola de resultados"}
        <span className="font-mono text-xs text-muted-foreground">{ev.event.reportIds.length}</span>
        <span className="ml-auto font-mono text-[0.65rem] text-muted-foreground">{clock(ev.ts)}</span>
      </div>
      {reports.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {reports.map((r) => (
            <li key={r!.id} className="flex items-start gap-2 text-[0.85rem]">
              <TonePill tone={reportStatusView[r!.status].tone} className="mt-0.5 shrink-0">
                {r!.sessionName}
              </TonePill>
              <span className="line-clamp-2 text-foreground/85">{r!.summary}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {open ? "Ocultar el mensaje que recibió" : "Ver el mensaje que recibió"}
      </button>
      {open && <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-background/70 p-3 font-mono text-[0.72rem] whitespace-pre-wrap">{ev.event.text}</pre>}
    </div>
  )
}

function ReportCall({ call }: { call: ToolCall }) {
  const input = (call.use.input ?? {}) as { status?: "done" | "blocked" | "partial"; summary?: string; details?: string }
  const [open, setOpen] = useState(false)
  const status = reportStatusView[input.status ?? "done"] ?? reportStatusView.done
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Rows3 className="size-4 text-muted-foreground" />
        Reportó su resultado
        <TonePill tone={status.tone}>{status.label}</TonePill>
        {call.result?.isError && <span className="text-xs text-status-error">no se registró</span>}
      </div>
      {input.summary && <p className="mt-1.5 text-[0.87rem] leading-relaxed whitespace-pre-wrap">{input.summary}</p>}
      {input.details && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
            Detalles
          </button>
          {open && (
            <div className="mt-1.5 rounded-lg bg-muted/50 p-3">
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
      <div className="flex items-center gap-3 text-[0.7rem] text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => e.summary && setOpen((v) => !v)}
          className={cn("flex items-center gap-1.5 font-mono", e.summary && "hover:text-foreground")}
          disabled={!e.summary}
        >
          <Layers className="size-3" />
          contexto compactado {e.trigger === "auto" ? "solo" : "a mano"}
          {size ? ` · ${size} tokens` : ""}
          {curated ? ` · ${e.kept} conservados${e.dropped ? `, ${e.dropped} descartados` : ""}` : ""}
          {e.summary && <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />}
        </button>
        <div className="h-px flex-1 bg-border" />
      </div>
      {open && e.summary && (
        <div className="mt-2 rounded-lg border bg-muted/40 px-4 py-3">
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

function LiveTail({ session, partial }: { session: Session; partial?: PartialBlock }) {
  if (partial?.block === "text" && partial.text) {
    return (
      <div className="streaming-caret">
        <Markdown text={partial.text} className="inline" />
      </div>
    )
  }
  if (session.status === "working" || session.status === "starting") {
    return (
      <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5 text-status-working" />
        <span className="truncate font-mono">
          {partial?.block === "thinking" ? "pensando…" : session.status === "starting" ? "iniciando la sesión…" : session.lastActivity || "trabajando…"}
        </span>
      </div>
    )
  }
  return null
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
  return (
    <>
      {items.map((it, i) =>
        it.type === "tool" ? (
          <ToolItem key={it.id} call={it.call} root={root} live={live && i > lastTurnIndex} />
        ) : (
          <EventItem key={it.ev.id} ev={it.ev} sessionId={sessionId} />
        )
      )}
    </>
  )
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
        <LiveTail session={session} partial={partial} />
      </div>
    </SubagentContext.Provider>
  )
}
