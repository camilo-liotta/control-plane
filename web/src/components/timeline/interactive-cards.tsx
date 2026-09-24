import { CircleHelp, ShieldQuestion } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import type { TimelineEvent } from "@shared/types"

import { Markdown } from "@/components/timeline/markdown"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

type QuestionEvent = Extract<TimelineEvent, { kind: "question" }>
type PermissionEvent = Extract<TimelineEvent, { kind: "permission" }>

/** Pregunta de Claude (AskUserQuestion) con sus opciones, respondible desde acá. */
export function QuestionCard({ sessionId, event }: { sessionId: string; event: QuestionEvent }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const pending = event.state === "pending"

  const toggle = (q: string, label: string, multi: boolean) =>
    setPicked((p) => {
      const cur = p[q] ?? []
      if (!multi) return { ...p, [q]: cur[0] === label ? [] : [label] }
      return { ...p, [q]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
    })

  const answers = Object.fromEntries(
    event.questions.map((q) => {
      const chosen = [...(picked[q.question] ?? [])]
      const extra = other[q.question]?.trim()
      if (extra) chosen.push(extra)
      return [q.question, chosen.join(", ")]
    })
  )
  const complete = event.questions.every((q) => answers[q.question])

  const submit = async () => {
    setSending(true)
    try {
      await api.answer(sessionId, event.requestId, answers)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        pending ? "border-status-attention/50 bg-status-attention/5" : "bg-card/60"
      )}
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <CircleHelp className={cn("size-4", pending ? "text-status-attention" : "text-muted-foreground")} />
        {pending ? "Claude te pregunta" : event.state === "answered" ? "Respondiste" : "Pregunta cancelada"}
      </div>
      <div className="space-y-4">
        {event.questions.map((q) => {
          const answered = event.answers?.[q.question]
          return (
            <div key={q.question}>
              <div className="flex items-baseline gap-2">
                {q.header && <span className="eyebrow">{q.header}</span>}
                <p className="text-sm">{q.question}</p>
              </div>
              {pending ? (
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {q.options.map((o) => {
                    const on = picked[q.question]?.includes(o.label)
                    return (
                      <button
                        key={o.label}
                        type="button"
                        onClick={() => toggle(q.question, o.label, Boolean(q.multiSelect))}
                        className={cn(
                          "rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/60",
                          on && "border-foreground/40 bg-muted ring-2 ring-ring/30"
                        )}
                      >
                        <span className="block text-sm font-medium">{o.label}</span>
                        {o.description && <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>}
                        {o.preview && (
                          <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[0.7rem] leading-snug">
                            {o.preview}
                          </pre>
                        )}
                      </button>
                    )
                  })}
                  <Input
                    className="sm:col-span-2"
                    placeholder="Otra respuesta…"
                    value={other[q.question] ?? ""}
                    onChange={(e) => setOther((p) => ({ ...p, [q.question]: e.target.value }))}
                  />
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">
                  {answered ? <span className="font-medium text-foreground">{answered}</span> : "Sin respuesta"}
                </p>
              )}
            </div>
          )
        })}
      </div>
      {pending && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={submit} disabled={!complete || sending}>
            {sending && <Spinner />}
            Responder
          </Button>
        </div>
      )}
    </div>
  )
}

/** Pedido de aprobación de una herramienta (por ejemplo, salir del modo plan). */
export function PermissionCard({ sessionId, event }: { sessionId: string; event: PermissionEvent }) {
  const [sending, setSending] = useState<null | boolean>(null)
  const pending = event.state === "pending"
  const input = (event.input ?? {}) as Record<string, unknown>
  const plan = typeof input.plan === "string" ? input.plan : null

  const decide = async (allow: boolean) => {
    setSending(allow)
    try {
      await api.permission(sessionId, event.requestId, allow)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(null)
    }
  }

  return (
    <div className={cn("rounded-xl border p-4", pending ? "border-status-attention/50 bg-status-attention/5" : "bg-card/60")}>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ShieldQuestion className={cn("size-4", pending ? "text-status-attention" : "text-muted-foreground")} />
        {event.toolName === "ExitPlanMode" ? "Claude propone este plan" : `Claude pide usar ${event.toolName}`}
        {!pending && (
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {event.state === "allowed" ? "Aprobado" : event.state === "denied" ? "Rechazado" : "Cancelado"}
          </span>
        )}
      </div>
      {plan ? (
        <div className="max-h-96 overflow-auto rounded-lg bg-muted/40 p-3">
          <Markdown text={plan} />
        </div>
      ) : (
        <pre className="max-h-60 overflow-auto rounded-lg bg-muted/40 p-2.5 font-mono text-[0.75rem]">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
      {pending && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => decide(false)} disabled={sending !== null}>
            {sending === false && <Spinner />}
            Rechazar
          </Button>
          <Button size="sm" onClick={() => decide(true)} disabled={sending !== null}>
            {sending === true && <Spinner />}
            Aprobar
          </Button>
        </div>
      )}
    </div>
  )
}
