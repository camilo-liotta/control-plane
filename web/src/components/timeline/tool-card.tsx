import {
  Bot,
  Check,
  ChevronRight,
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
        "max-h-80 overflow-auto rounded-xl bg-muted/60 px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
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
  /** El título en texto plano, para el `title` cuando se corta. */
  label?: string
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
        title: <span className="font-mono text-xs">$ {str(input.command).split("\n")[0]}</span>,
        label: str(input.command),
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
        title: <>Leyó <span className="font-mono text-xs">{path()}</span></>,
        label: str(input.file_path),
        meta: input.offset || input.limit ? `líneas ${str(input.offset) || "1"}–${input.limit ? Number(input.offset ?? 1) + Number(input.limit) : "…"}` : undefined,
        detail: result?.content && !result.images?.length ? <Pre>{lines(result.content, 40)}</Pre> : null,
      }
    case "Edit": {
      const oldText = str(input.old_string)
      const newText = str(input.new_string)
      const st = diffStats(oldText, newText)
      return {
        icon: FilePen,
        title: <>Editó <span className="font-mono text-xs">{path()}</span></>,
        label: str(input.file_path),
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
        title: <>Editó <span className="font-mono text-xs">{path()}</span></>,
        label: str(input.file_path),
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
        title: <>Escribió <span className="font-mono text-xs">{path()}</span></>,
        label: str(input.file_path),
        meta: plural(content.split("\n").length, "línea", "líneas"),
        detail: <Pre>{lines(content, 80)}</Pre>,
      }
    }
    case "NotebookEdit":
      return { icon: NotebookPen, title: <>Editó <span className="font-mono text-xs">{path("notebook_path")}</span></>, label: str(input.notebook_path) }
    case "Grep":
      return {
        icon: Search,
        title: (
          <>
            Buscó <span className="font-mono text-xs">"{str(input.pattern)}"</span>
            {input.path ? <> en <span className="font-mono text-xs">{shortPath(str(input.path), root)}</span></> : null}
          </>
        ),
        label: `${str(input.pattern)}${input.path ? ` en ${str(input.path)}` : ""}`,
        detail: result?.content ? <Pre>{lines(result.content, 60)}</Pre> : null,
      }
    case "Glob":
      return {
        icon: FolderSearch,
        title: <>Buscó archivos <span className="font-mono text-xs">{str(input.pattern)}</span></>,
        label: str(input.pattern),
        detail: result?.content ? <Pre>{lines(result.content, 60)}</Pre> : null,
      }
    case "WebFetch":
      return {
        icon: Globe,
        title: <>Leyó <span className="font-mono text-xs">{str(input.url)}</span></>,
        label: str(input.url),
        detail: result?.content ? <Pre>{lines(result.content, 40)}</Pre> : null,
      }
    case "WebSearch":
      return {
        icon: Search,
        title: <>Buscó en la web "{str(input.query)}"</>,
        label: str(input.query),
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
              <div className="rounded-xl bg-muted/60 px-3 py-2.5">
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
            <span className="font-mono text-xs">{label}</span>
          </>
        ),
        label: server && !isCp ? `${server} · ${label}` : label,
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
        aria-expanded={d.detail ? open : undefined}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ui text-foreground/80 transition-colors",
          d.detail ? "hover:bg-muted/70" : "cursor-default",
          open && "bg-muted/50"
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate" title={d.label}>
          {d.title}
        </span>
        {d.meta && <span className="hidden max-w-40 shrink-0 truncate text-xs text-muted-foreground sm:inline">{d.meta}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {pending ? (
            live ? (
              <Spinner className="size-3.5 text-status-working" />
            ) : (
              <span className="text-xs text-muted-foreground">Sin terminar</span>
            )
          ) : error ? (
            <CircleX className="size-3.5 text-status-error" aria-label="Falló" />
          ) : null}
          {d.detail && (
            <ChevronRight className={cn("size-3.5 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
          )}
        </span>
      </button>
      {errorLine && !open && (
        <p className="truncate pl-7.5 font-mono text-2xs text-status-error" title={errorLine}>
          {errorLine}
        </p>
      )}
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
          <p key={it.id} className="px-2 py-0.5 text-xs text-muted-foreground" title={it.text.length > 280 ? it.text : undefined}>
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
    <div className="surface-card px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <ListChecks className="size-3.5" />
        <span className="eyebrow">Plan de trabajo</span>
        <span className="ml-auto">
          {done}/{todos.length}
          <span className="sr-only"> hechas</span>
        </span>
      </div>
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2.5 text-ui">
            <span
              className={cn(
                "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-input",
                t.status === "completed" && "border-status-done-lamp bg-status-done-lamp text-background",
                t.status === "in_progress" && "border-status-working-lamp"
              )}
            >
              {t.status === "completed" && <Check className="size-2.5" strokeWidth={3} />}
              {t.status === "in_progress" && <span className="size-1.5 rounded-full bg-status-working-lamp" />}
              <span className="sr-only">{t.status === "completed" ? "Hecha: " : t.status === "in_progress" ? "En curso: " : "Pendiente: "}</span>
            </span>
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
    <div className="ml-auto max-w-[85%] rounded-2xl bg-muted/60 px-4 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquareShare className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          Mensaje a <span className="name text-foreground">{to || "otra sesión"}</span>
        </span>
        {failed && <span className="shrink-0 text-status-error">· No se entregó</span>}
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{text}</p>
    </div>
  )
}

export function planOf(call: ToolCall): string {
  return str(((call.use.input ?? {}) as Input).plan)
}

