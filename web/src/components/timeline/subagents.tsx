import { Bot, ChevronRight } from "lucide-react"
import { createContext, useContext, useMemo } from "react"

import type { StoredEvent, TimelineEvent } from "@shared/types"

import type { ToolCall } from "@/components/timeline/tool-card"
import { Lamp } from "@/components/status"
import { useNow } from "@/hooks/use-now"
import { duration } from "@/lib/format"
import type { Tone } from "@/lib/status"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

export type SubagentEvent = Extract<TimelineEvent, { kind: "subagent" }>
export type SubagentMap = Map<string, SubagentEvent>

/** Estado de cada subagente de la sesión, por id de la llamada Agent que lo lanzó. */
export function subagentMap(events: StoredEvent[]): SubagentMap {
  const map: SubagentMap = new Map()
  for (const e of events) if (e.event.kind === "subagent") map.set(e.event.toolUseId, e.event)
  return map
}

export const SubagentContext = createContext<{ sessionId: string; map: SubagentMap }>({ sessionId: "", map: new Map() })

export const STATUS_VIEW: Record<SubagentEvent["status"], { label: string; tone: Tone }> = {
  running: { label: "Trabajando", tone: "working" },
  completed: { label: "Terminó", tone: "done" },
  failed: { label: "Falló", tone: "error" },
  killed: { label: "Detenido", tone: "idle" },
}

type AgentInput = { description?: string; prompt?: string; subagent_type?: string; model?: string; name?: string; run_in_background?: boolean }

/** Resultado final limpio del subagente (sin el marco que agrega el harness). */
export function subagentReport(call: ToolCall): string | null {
  const s = call.result?.structured as { status?: string; content?: { type: string; text?: string }[] } | undefined
  if (s?.status === "completed" && Array.isArray(s.content)) {
    const text = s.content.map((c) => c.text ?? "").join("\n").trim()
    if (text) return text
  }
  const raw = call.result?.content ?? ""
  if (!raw || /Async agent launched/i.test(raw)) return null
  const start = raw.indexOf("The report follows:")
  let body = start >= 0 ? raw.slice(start + "The report follows:".length) : raw
  body = body.split(/\nagentId: /)[0] ?? body
  return body
    .split("\n")
    .map((l) => l.replace(/^ {2}/, ""))
    .join("\n")
    .trim()
}

export function subagentStatus(call: ToolCall, state: SubagentEvent | undefined, live: boolean): SubagentEvent["status"] {
  if (state) return state.status
  const s = call.result?.structured as { status?: string } | undefined
  if (call.result?.isError) return "failed"
  if (s?.status === "completed") return "completed"
  if (s?.status === "async_launched" || !call.result) return live ? "running" : "killed"
  return "completed"
}

function compactTokens(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** Tarjeta de un subagente en la conversación: qué es, cómo va y un clic para ver su trabajo. */
export function SubagentCard({ call, live }: { call: ToolCall; live: boolean }) {
  const { sessionId, map } = useContext(SubagentContext)
  const setUi = useUi((s) => s.set)
  const state = map.get(call.use.id)
  const input = (call.use.input ?? {}) as AgentInput
  const status = subagentStatus(call, state, live)
  const view = STATUS_VIEW[status]
  const now = useNow(status === "running" ? 1000 : 60_000)
  const name = state?.name || input.name || null
  const title = name ?? state?.description ?? input.description ?? "Subagente"
  const type = state?.subagentType ?? input.subagent_type ?? null
  const model = state?.model ?? input.model ?? null
  const background = state?.background ?? input.run_in_background !== false
  const elapsed = state ? (state.endedAt ?? now) - state.startedAt : null
  const steps = call.children.filter((c) => c.event.kind === "tool_use").length
  const toolUses = state?.usage?.toolUses ?? steps
  const report = status === "running" ? null : subagentReport(call)
  const lines = report?.split("\n").map((l) => l.trim()).filter(Boolean) ?? []
  const firstLine =
    (lines.find((l) => !l.startsWith("#")) ?? lines[0] ?? "").replace(/^[#>*\s-]+/, "").replace(/\*\*/g, "").trim() || null
  const activity = status === "running" ? state?.lastActivity : (state?.summary ?? firstLine ?? state?.lastActivity ?? null)

  return (
    <button
      type="button"
      onClick={() => setUi({ subagent: { sessionId, toolUseId: call.use.id } })}
      className={cn(
        "group/sub w-full rounded-xl border bg-card px-3.5 py-3 text-left shadow-xs transition-all hover:border-foreground/25 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
        status === "running" && "border-status-working/40"
      )}
    >
      <div className="flex items-center gap-2">
        <Bot className={cn("size-4 shrink-0", status === "running" ? "text-status-working" : "text-muted-foreground")} />
        <span className="truncate font-mono text-[0.84rem] font-semibold">{title}</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">
          {[type, model, background ? "en segundo plano" : null].filter(Boolean).join(" · ")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
          <Lamp tone={view.tone} pulse={status === "running"} className="size-1.5" />
          <span className="font-medium">{view.label}</span>
          {elapsed !== null && <span className="font-mono text-muted-foreground">{duration(elapsed)}</span>}
        </span>
      </div>
      {name && (state?.description || input.description) && (
        <p className="mt-1 truncate text-xs text-muted-foreground">{state?.description ?? input.description}</p>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono">{activity ?? (status === "running" ? "arrancando…" : "—")}</span>
        {(toolUses > 0 || state?.usage) && (
          <span className="shrink-0 font-mono">
            {toolUses} {toolUses === 1 ? "herramienta" : "herramientas"}
            {state?.usage?.tokens ? ` · ${compactTokens(state.usage.tokens)} tokens` : ""}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-0.5 font-medium text-foreground/70 group-hover/sub:text-foreground">
          Ver trabajo
          <ChevronRight className="size-3.5" />
        </span>
      </div>
    </button>
  )
}

/** Lista compacta de subagentes (panel de la sesión y popover del encabezado). */
export function SubagentList({ sessionId, events, limit }: { sessionId: string; events: StoredEvent[]; limit?: number }) {
  const setUi = useUi((s) => s.set)
  const now = useNow(1000)
  const list = useMemo(() => {
    const subs = [...subagentMap(events).values()]
    return subs.sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || b.startedAt - a.startedAt)
  }, [events])
  if (!list.length) return <p className="text-xs text-muted-foreground">Todavía no lanzó subagentes.</p>
  return (
    <ul className="space-y-1">
      {list.slice(0, limit).map((s) => {
        const view = STATUS_VIEW[s.status]
        return (
          <li key={s.toolUseId}>
            <button
              type="button"
              onClick={() => setUi({ subagent: { sessionId, toolUseId: s.toolUseId } })}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
            >
              <Lamp tone={view.tone} pulse={s.status === "running"} className="mt-1.5 size-1.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-mono text-[0.8rem] font-medium">{s.name ?? s.description}</span>
                  <span className="ml-auto shrink-0 font-mono text-[0.7rem] text-muted-foreground">
                    {duration((s.endedAt ?? now) - s.startedAt)}
                  </span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {s.status === "running" ? (s.lastActivity ?? "arrancando…") : (s.summary ?? view.label)}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
