import {
  Bot,
  ChevronRight,
  CircleCheck,
  CircleX,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  MessageSquareShare,
  NotebookPen,
  Plug,
  Search,
  Terminal,
  Users,
  Workflow,
  Wrench,
} from "lucide-react"
import { useState } from "react"

import type { StoredEvent, TimelineEvent } from "@shared/types"

import { ImageThumb } from "@/components/attachments"
import { DiffView, diffStats } from "@/components/timeline/diff-view"
import { Markdown } from "@/components/timeline/markdown"
import { Spinner } from "@/components/ui/spinner"
import { plural, shortPath } from "@/lib/format"
import { cn } from "@/lib/utils"

type ToolUse = Extract<TimelineEvent, { kind: "tool_use" }>
type ToolResult = Extract<TimelineEvent, { kind: "tool_result" }>

export interface ToolCall {
  use: ToolUse
  result: ToolResult | null
  children: StoredEvent[]
}

type Input = Record<string, unknown>

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v))

function Pre({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-[0.75rem] leading-relaxed whitespace-pre-wrap break-words",
        className
      )}
    >
      {children}
    </pre>
  )
}

function lines(text: string, max = 60) {
  const all = text.split("\n")
  return all.length > max ? all.slice(0, max).join("\n") + `\n… (${all.length - max} líneas más)` : text
}

function bashOutput(result: ToolResult | null): { out: string; err: string } {
  const s = result?.structured as { stdout?: string; stderr?: string } | undefined
  if (s && (typeof s.stdout === "string" || typeof s.stderr === "string"))
    return { out: s.stdout ?? "", err: s.stderr ?? "" }
  return { out: result?.content ?? "", err: "" }
}

interface Described {
  icon: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  meta?: React.ReactNode
  detail?: React.ReactNode
}

function describe(call: ToolCall, root?: string): Described {
  const { name } = call.use
  const input = (call.use.input ?? {}) as Input
  const result = call.result
  const path = (key = "file_path") => shortPath(str(input[key]), root)

  switch (name) {
    case "Bash": {
      const { out, err } = bashOutput(result)
      return {
        icon: Terminal,
        title: <span className="font-mono text-[0.8rem]">$ {str(input.command).split("\n")[0]}</span>,
        meta: input.description ? str(input.description) : undefined,
        detail: (
          <div className="space-y-1.5">
            {str(input.command).includes("\n") && <Pre>{str(input.command)}</Pre>}
            {out.trim() && <Pre>{lines(out, 120)}</Pre>}
            {err.trim() && <Pre className="text-status-error">{lines(err, 60)}</Pre>}
            {!out.trim() && !err.trim() && result && <p className="text-xs text-muted-foreground">Sin salida.</p>}
          </div>
        ),
      }
    }
    case "Read":
      return {
        icon: FileText,
        title: <>Leyó <span className="font-mono">{path()}</span></>,
        meta: input.offset || input.limit ? `líneas ${str(input.offset) || "1"}–${input.limit ? Number(input.offset ?? 1) + Number(input.limit) : "…"}` : undefined,
        detail: result?.content && !result.images?.length ? <Pre>{lines(result.content, 40)}</Pre> : null,
      }
    case "Edit": {
      const oldText = str(input.old_string)
      const newText = str(input.new_string)
      const st = diffStats(oldText, newText)
      return {
        icon: FilePen,
        title: <>Editó <span className="font-mono">{path()}</span></>,
        meta: (
          <span className="font-mono">
            <span className="text-diff-add">+{st.add}</span> <span className="text-diff-del">−{st.del}</span>
          </span>
        ),
        detail: <DiffView oldText={oldText} newText={newText} />,
      }
    }
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : []
      return {
        icon: FilePen,
        title: <>Editó <span className="font-mono">{path()}</span></>,
        meta: `${edits.length} cambios`,
        detail: (
          <div className="space-y-2">
            {edits.map((e, i) => (
              <DiffView key={i} oldText={str(e.old_string)} newText={str(e.new_string)} maxLines={40} />
            ))}
          </div>
        ),
      }
    }
    case "Write": {
      const content = str(input.content)
      return {
        icon: FilePlus,
        title: <>Escribió <span className="font-mono">{path()}</span></>,
        meta: plural(content.split("\n").length, "línea", "líneas"),
        detail: <Pre>{lines(content, 80)}</Pre>,
      }
    }
    case "NotebookEdit":
      return { icon: NotebookPen, title: <>Editó <span className="font-mono">{path("notebook_path")}</span></> }
    case "Grep":
      return {
        icon: Search,
        title: (
          <>
            Buscó <span className="font-mono">“{str(input.pattern)}”</span>
            {input.path ? <> en <span className="font-mono">{shortPath(str(input.path), root)}</span></> : null}
          </>
        ),
        detail: result?.content ? <Pre>{lines(result.content, 60)}</Pre> : null,
      }
    case "Glob":
      return {
        icon: FolderSearch,
        title: <>Buscó archivos <span className="font-mono">{str(input.pattern)}</span></>,
        detail: result?.content ? <Pre>{lines(result.content, 60)}</Pre> : null,
      }
    case "WebFetch":
      return {
        icon: Globe,
        title: <>Leyó <span className="font-mono">{str(input.url)}</span></>,
        detail: result?.content ? <Pre>{lines(result.content, 40)}</Pre> : null,
      }
    case "WebSearch":
      return {
        icon: Search,
        title: <>Buscó en la web “{str(input.query)}”</>,
        detail: result?.content ? <Pre>{lines(result.content, 40)}</Pre> : null,
      }
    case "ListAgents":
      return { icon: Users, title: "Listó las sesiones", detail: result?.content ? <Pre>{result.content}</Pre> : null }
    case "Task":
    case "Agent":
      return {
        icon: Bot,
        title: <>Subagente: {str(input.description) || str(input.subagent_type) || "tarea"}</>,
        meta: call.children.length ? `${call.children.filter((c) => c.event.kind === "tool_use").length} herramientas` : undefined,
        detail: (
          <div className="space-y-2">
            {input.prompt ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Prompt del subagente</summary>
                <Pre className="mt-1">{str(input.prompt)}</Pre>
              </details>
            ) : null}
            <SubagentSteps events={call.children} root={root} />
            {result?.content && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <Markdown text={result.content} />
              </div>
            )}
          </div>
        ),
      }
    default: {
      const isCp = name.startsWith("mcp__control-plane__")
      const isMcp = name.startsWith("mcp__")
      const label = isMcp ? name.split("__").slice(2).join("__") : name
      const server = isMcp ? name.split("__")[1] : null
      return {
        icon: isCp ? Workflow : isMcp ? Plug : Wrench,
        title: (
          <>
            {server && !isCp && <span className="text-muted-foreground">{server} · </span>}
            <span className="font-mono">{label}</span>
          </>
        ),
        detail: (
          <div className="space-y-1.5">
            {Object.keys(input).length > 0 && <Pre>{JSON.stringify(input, null, 2)}</Pre>}
            {result?.content && !(result.images?.length && /^(\[imagen\]\s*)+$/.test(result.content)) && (
              <Pre>{lines(result.content, 60)}</Pre>
            )}
          </div>
        ),
      }
    }
  }
}

/** Una llamada a herramienta: una línea compacta que se expande para ver el detalle. */
export function ToolRow({ call, root, live }: { call: ToolCall; root?: string; live: boolean }) {
  const images = call.result?.images ?? []
  const [open, setOpen] = useState(images.length > 0)
  const base = describe(call, root)
  // Las imágenes que devuelve una herramienta (capturas, imágenes leídas) se ven en el detalle.
  const d: Described = images.length
    ? {
        ...base,
        meta: base.meta ?? `${images.length} ${images.length === 1 ? "imagen" : "imágenes"}`,
        detail: (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {images.map((img) => (
                <ImageThumb key={img.id} att={img} className={images.length === 1 ? "max-h-72 max-w-md" : "size-28"} />
              ))}
            </div>
            {base.detail}
          </div>
        ),
      }
    : base
  const Icon = d.icon
  const error = call.result?.isError
  const pending = !call.result
  const errorLine = error ? call.result?.content.split("\n").find((l) => l.trim()) : null
  return (
    <div className="group/tool">
      <button
        type="button"
        onClick={() => d.detail && setOpen((v) => !v)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[0.82rem] text-foreground/80 transition-colors",
          d.detail && "hover:bg-muted/70",
          open && "bg-muted/50"
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{d.title}</span>
        {d.meta && <span className="shrink-0 truncate text-xs text-muted-foreground">{d.meta}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {pending ? (
            live ? (
              <Spinner className="size-3.5 text-status-working" />
            ) : (
              <span className="text-xs text-muted-foreground">sin terminar</span>
            )
          ) : error ? (
            <CircleX className="size-3.5 text-status-error" />
          ) : (
            <CircleCheck className="size-3.5 text-status-done/80" />
          )}
          {d.detail && (
            <ChevronRight className={cn("size-3.5 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
          )}
        </span>
      </button>
      {errorLine && !open && <p className="truncate pl-7.5 font-mono text-[0.72rem] text-status-error">{errorLine}</p>}
      {open && d.detail && <div className="mt-1 mb-2 ml-7.5">{d.detail}</div>}
    </div>
  )
}

/** Pasos internos de un subagente, en versión condensada. */
function SubagentSteps({ events, root }: { events: StoredEvent[]; root?: string }) {
  const calls = new Map<string, ToolCall>()
  const items: ({ type: "text"; text: string; id: number } | { type: "tool"; call: ToolCall; id: number })[] = []
  for (const e of events) {
    const ev = e.event
    if (ev.kind === "tool_use") {
      const call: ToolCall = { use: ev, result: null, children: [] }
      calls.set(ev.id, call)
      items.push({ type: "tool", call, id: e.id })
    } else if (ev.kind === "tool_result") {
      const call = calls.get(ev.toolUseId)
      if (call) call.result = ev
    } else if (ev.kind === "text") {
      items.push({ type: "text", text: ev.text, id: e.id })
    }
  }
  if (!items.length) return null
  return (
    <div className="space-y-0.5 border-l-2 pl-2">
      {items.map((it) =>
        it.type === "tool" ? (
          <ToolRow key={it.id} call={it.call} root={root} live={false} />
        ) : (
          <p key={it.id} className="px-2 py-0.5 text-xs text-muted-foreground">
            {it.text.length > 280 ? it.text.slice(0, 279) + "…" : it.text}
          </p>
        )
      )}
    </div>
  )
}

/** Lista de tareas (TodoWrite) como checklist. */
export function TodoCard({ call }: { call: ToolCall }) {
  const todos = Array.isArray((call.use.input as Input)?.todos)
    ? ((call.use.input as Input).todos as { content?: string; status?: string; activeForm?: string }[])
    : []
  if (!todos.length) return null
  const done = todos.filter((t) => t.status === "completed").length
  return (
    <div className="rounded-lg border bg-card/60 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <ListChecks className="size-3.5" />
        <span className="font-medium">Plan de trabajo</span>
        <span className="ml-auto font-mono">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[0.82rem]">
            <span
              className={cn(
                "mt-1 size-3 shrink-0 rounded-[3px] border",
                t.status === "completed" && "border-status-done bg-status-done",
                t.status === "in_progress" && "border-status-working bg-status-working/20"
              )}
            />
            <span className={cn(t.status === "completed" && "text-muted-foreground line-through", t.status === "in_progress" && "font-medium")}>
              {t.status === "in_progress" ? t.activeForm || t.content : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Mensaje que esta sesión le mandó a otra (SendMessage). */
export function OutgoingMessage({ call }: { call: ToolCall }) {
  const input = (call.use.input ?? {}) as Input
  const to = str(input.to ?? input.recipient)
  const text = str(input.message ?? input.content)
  const failed = call.result?.isError
  return (
    <div className="ml-auto max-w-[85%] rounded-xl border border-dashed px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquareShare className="size-3.5" />
        Mensaje a <span className="font-mono font-medium text-foreground">{to || "otra sesión"}</span>
        {failed && <span className="text-status-error">· no se entregó</span>}
      </div>
      <p className="text-[0.85rem] whitespace-pre-wrap">{text}</p>
    </div>
  )
}

export function planOf(call: ToolCall): string {
  return str(((call.use.input ?? {}) as Input).plan)
}

