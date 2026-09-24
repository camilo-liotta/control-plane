import { ArrowLeft, Bot, ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"

import type { StoredEvent, TimelineEvent } from "@shared/types"

import { Lamp } from "@/components/status"
import { Markdown } from "@/components/timeline/markdown"
import {
  STATUS_VIEW,
  SubagentContext,
  subagentMap,
  subagentReport,
  subagentStatus,
} from "@/components/timeline/subagents"
import { buildItems, TimelineItems } from "@/components/timeline/timeline"
import type { ToolCall } from "@/components/timeline/tool-card"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { useNow } from "@/hooks/use-now"
import { clock, duration } from "@/lib/format"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

type ToolUse = Extract<TimelineEvent, { kind: "tool_use" }>
type ToolResult = Extract<TimelineEvent, { kind: "tool_result" }>

/**
 * Eventos del subagente (y de sus propios subagentes). Los hijos directos pasan a primer nivel
 * para mostrarlos como una conversación normal.
 */
function descendants(events: StoredEvent[], root: string): StoredEvent[] {
  const inside = new Set([root])
  const out: StoredEvent[] = []
  for (const e of events) {
    const ev = e.event
    const parent = "parent" in ev ? ev.parent : null
    if (!parent || !inside.has(parent)) continue
    if (ev.kind === "tool_use") inside.add(ev.id)
    out.push(parent === root ? { ...e, event: { ...ev, parent: null } as TimelineEvent } : e)
  }
  return out
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 font-mono text-sm tabular-nums">{value}</div>
    </div>
  )
}

export function SubagentSheet() {
  const selected = useUi((s) => s.subagent)
  const setUi = useUi((s) => s.set)
  const events = useStore((s) => (selected ? s.events[selected.sessionId] : undefined))
  const session = useStore((s) => (selected ? s.sessions[selected.sessionId] : undefined))
  const [showPrompt, setShowPrompt] = useState(false)
  const now = useNow(1000)

  const data = useMemo(() => {
    if (!selected || !events) return null
    let use: ToolUse | null = null
    let result: ToolResult | null = null
    for (const e of events) {
      if (e.event.kind === "tool_use" && e.event.id === selected.toolUseId) use = e.event
      if (e.event.kind === "tool_result" && e.event.toolUseId === selected.toolUseId) result = e.event
    }
    const map = subagentMap(events)
    const state = map.get(selected.toolUseId)
    const inner = descendants(events, selected.toolUseId)
    return { use, result, state, map, items: buildItems(inner), steps: inner.filter((e) => e.event.kind === "tool_use").length }
  }, [selected, events])

  const open = Boolean(selected)
  const close = () => setUi({ subagent: null })

  let body: React.ReactNode = null
  if (selected && data?.use) {
    const input = (data.use.input ?? {}) as { description?: string; prompt?: string; subagent_type?: string; model?: string; name?: string }
    const call: ToolCall = { use: data.use, result: data.result, children: [] }
    const live = Boolean(session && (session.status === "working" || session.subagentsRunning > 0))
    const status = subagentStatus(call, data.state, live)
    const view = STATUS_VIEW[status]
    const report = subagentReport(call)
    const state = data.state
    const elapsed = state ? (state.endedAt ?? now) - state.startedAt : null
    const structured = data.result?.structured as { totalToolUseCount?: number; totalTokens?: number; resolvedModel?: string } | undefined
    const prompt = state?.prompt || input.prompt || ""
    const parentId = state?.parent ?? data.use.parent
    const parentState = parentId ? data.map.get(parentId) : undefined
    // Si el último texto del subagente ya es su informe, no lo repetimos abajo.
    const lastText = [...data.items].reverse().find((it) => it.type === "event" && it.ev.event.kind === "text")
    const norm = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 240)
    const reportShown =
      Boolean(report) &&
      lastText?.type === "event" &&
      lastText.ev.event.kind === "text" &&
      norm(lastText.ev.event.text) === norm(report!)

    body = (
      <>
        <SheetHeader className="border-b pb-4">
          {parentId && (
            <button
              type="button"
              onClick={() => setUi({ subagent: { sessionId: selected.sessionId, toolUseId: parentId } })}
              className="mb-1 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Volver a {parentState?.name ?? parentState?.description ?? "el subagente que lo lanzó"}
            </button>
          )}
          <div className="flex items-center gap-2 pr-8">
            <Bot className={cn("size-5", status === "running" ? "text-status-working" : "text-muted-foreground")} />
            <SheetTitle className="truncate font-mono text-base">{state?.name || input.name || state?.description || input.description || "Subagente"}</SheetTitle>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
              <Lamp tone={view.tone} pulse={status === "running"} className="size-1.5" />
              {view.label}
            </span>
          </div>
          <SheetDescription>
            {[
              state?.description ?? input.description,
              state?.subagentType ?? input.subagent_type,
              state?.model ?? input.model ?? structured?.resolvedModel,
              (state?.background ?? true) ? "en segundo plano" : "en primer plano",
              session ? `lanzado por ${session.name}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </SheetDescription>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <Stat label="Tiempo" value={elapsed !== null ? duration(elapsed) : "—"} />
            <Stat label="Herramientas" value={state?.usage?.toolUses ?? structured?.totalToolUseCount ?? data.steps} />
            <Stat
              label="Tokens"
              value={(state?.usage?.tokens ?? structured?.totalTokens)?.toLocaleString("es-AR") ?? "—"}
            />
          </div>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-8">
          {prompt && (
            <section>
              <button
                type="button"
                onClick={() => setShowPrompt((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronRight className={cn("size-3.5 transition-transform", showPrompt && "rotate-90")} />
                Tarea que recibió
              </button>
              {showPrompt ? (
                <div className="mt-2 rounded-lg border bg-muted/40 p-3">
                  <Markdown text={prompt} />
                </div>
              ) : (
                <p className="mt-1 line-clamp-2 pl-4.5 text-xs text-muted-foreground">{prompt}</p>
              )}
            </section>
          )}
          {state?.startedAt && <p className="text-[0.7rem] text-muted-foreground">Arrancó a las {clock(state.startedAt)}</p>}
          <SubagentContext.Provider value={{ sessionId: selected.sessionId, map: data.map }}>
            <div className="flex flex-col gap-3">
              {data.items.length ? (
                <TimelineItems items={data.items} sessionId={selected.sessionId} root={session?.cwd} live={status === "running"} />
              ) : status === "running" ? null : (
                <p className="text-sm text-muted-foreground">No hay pasos registrados.</p>
              )}
              {status === "running" && (
                <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
                  <Spinner className="size-3.5 text-status-working" />
                  <span className="truncate font-mono">{state?.lastActivity ?? "trabajando…"}</span>
                </div>
              )}
            </div>
          </SubagentContext.Provider>
          {report && status !== "running" && !reportShown && (
            <section className="rounded-xl border border-status-done/30 bg-status-done/5 p-4">
              <div className="eyebrow mb-2 text-status-done">Resultado</div>
              <Markdown text={report} />
            </section>
          )}
          {!report && state?.summary && status !== "running" && (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{state.summary}</p>
          )}
        </div>
      </>
    )
  } else if (selected) {
    body = (
      <SheetHeader>
        <SheetTitle>Subagente</SheetTitle>
        <SheetDescription>No encontré sus eventos: puede ser de una parte de la conversación que no está cargada.</SheetDescription>
      </SheetHeader>
    )
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && close()}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">{body}</SheetContent>
    </Sheet>
  )
}
