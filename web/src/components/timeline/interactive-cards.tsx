import { ChevronRight, CircleHelp, ShieldQuestion } from "lucide-react"
import { useState } from "react"

import type { TimelineEvent } from "@shared/types"

import { TonePill } from "@/components/status"
import { Markdown } from "@/components/timeline/markdown"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { failed } from "@/lib/errors"

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
      failed("mandar la respuesta")(err)
    } finally {
      setSending(false)
    }
  }

  if (!pending) return <Settled icon={CircleHelp} title={event.state === "answered" ? "Respondiste" : "Pregunta cancelada"}>
    {event.questions.map((q) => (
      <p key={q.question} className="truncate" title={`${q.question}: ${event.answers?.[q.question] ?? "sin respuesta"}`}>
        <span className="text-muted-foreground">{q.header || q.question}:</span>{" "}
        <span className="text-foreground">{event.answers?.[q.question] || "sin respuesta"}</span>
      </p>
    ))}
  </Settled>

  return (
    <div className={WAITING}>
      <WaitingHead icon={CircleHelp}>Claude te pregunta</WaitingHead>
      <div className="space-y-4">
        {event.questions.map((q) => {
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
                        aria-pressed={on}
                        className={cn(
                          "rounded-xl bg-accent/70 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          on && "bg-accent ring-2 ring-ring"
                        )}
                      >
                        <span className="block text-sm font-medium">{o.label}</span>
                        {o.description && <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>}
                        {o.preview && (
                          <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-2 font-mono text-2xs leading-snug">
                            {o.preview}
                          </pre>
                        )}
                      </button>
                    )
                  })}
                  <Input
                    className="sm:col-span-2"
                    placeholder="Otra respuesta…"
                    aria-label={`Otra respuesta a: ${q.question}`}
                    value={other[q.question] ?? ""}
                    onChange={(e) => setOther((p) => ({ ...p, [q.question]: e.target.value }))}
                  />
                </div>
              ) : null}
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
      failed(allow ? "aprobar" : "rechazar")(err)
    } finally {
      setSending(null)
    }
  }

  const title = event.toolName === "ExitPlanMode" ? "Claude propone este plan" : `Claude pide usar ${event.toolName}`
  const body = plan ? (
    <div className="max-h-96 overflow-auto rounded-xl bg-muted/60 px-4 py-3">
      <Markdown text={plan} />
    </div>
  ) : (
    <pre className="max-h-60 overflow-auto rounded-xl bg-muted/60 px-3 py-2.5 font-mono text-xs">{JSON.stringify(input, null, 2)}</pre>
  )

  if (!pending)
    return (
      <Settled
        icon={ShieldQuestion}
        title={title}
        state={event.state === "allowed" ? "Aprobado" : event.state === "denied" ? "Rechazado" : "Cancelado"}
        detail={body}
      />
    )

  return (
    <div className={WAITING}>
      <WaitingHead icon={ShieldQuestion}>{title}</WaitingHead>
      {body}
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

/** Lo que te espera: una tarjeta con el anillo ámbar (la alarma de DESIGN.md). */
const WAITING = "surface-card px-4 py-4 ring-2 ring-status-attention-lamp/70"

function WaitingHead({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 text-sm font-medium">
      <Icon className="size-4 shrink-0 text-status-attention" />
      <span className="min-w-0 flex-1">{children}</span>
      <TonePill tone="attention">Te necesita</TonePill>
    </div>
  )
}

/** Una pregunta o un permiso que ya se resolvió: una línea, como los pasos del trabajo. */
function Settled({
  icon: Icon,
  title,
  state,
  detail,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  state?: string
  detail?: React.ReactNode
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-ui">
      <button
        type="button"
        onClick={() => detail && setOpen((v) => !v)}
        aria-expanded={detail ? open : undefined}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-foreground/80",
          detail ? "hover:bg-muted/70" : "cursor-default",
          open && "bg-muted/50"
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate" title={title}>
          {title}
        </span>
        {state && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{state}</span>}
        {detail && <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground/60 transition-transform", !state && "ml-auto", open && "rotate-90")} />}
      </button>
      {children && <div className="space-y-0.5 pl-7.5 text-xs">{children}</div>}
      {open && detail && <div className="mt-1 mb-2 ml-7.5">{detail}</div>}
    </div>
  )
}
