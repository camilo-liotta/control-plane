import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Eraser,
  ListChecks,
  Lock,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  SkipForward,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import { draftEditMode } from "@shared/remote-access"
import type { Draft, ModelOption, PlanStep, Session } from "@shared/types"

import { FileRefScope, RefText } from "@/components/file-ref"
import { ModelPill, useSessionModelName } from "@/components/model-choice"
import { DraftAfkMarks } from "@/components/afk-summary"
import { Lamp, TonePill } from "@/components/status"
import { SubagentSpecList } from "@/components/subagent-specs"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmAction } from "@/components/ui/confirm-action"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useAccess, useCan } from "@/lib/access"
import { api, type PlanStepEdit } from "@/lib/api"
import { failed } from "@/lib/errors"
import { timeAgo } from "@/lib/format"
import { modelName } from "@/lib/models"
import { reveal } from "@/lib/reveal"
import { limitText, limitTitle } from "@/lib/limit"
import { draftStateView, planStateView, planStepView, toneBg, toneSoft, type Tone } from "@/lib/status"
import { undoable } from "@/lib/undo"
import { useModels, useStore } from "@/lib/store"
import { useAction } from "@/lib/use-action"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

/** Un plan aprobado que todavía no terminó. */
export const planActive = (d: Draft) => d.kind === "plan" && d.state === "sent" && (d.planState === "running" || d.planState === "paused")

/** La nota del plan con mayúscula inicial (por si llega una vieja, armada para seguir una oración). */
const note = (text: string | null) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : null)

/** El paso en curso (o el último que corrió). */
const currentOf = (d: Draft): PlanStep | undefined => (d.currentStep === null ? undefined : d.steps[d.currentStep])

/** Pausado porque un paso volvió bloqueado o parcial: frena hasta que la orquestadora (o vos) decida. */
export const planStuck = (d: Draft) => {
  const cur = currentOf(d)
  return d.planState === "paused" && (cur?.state === "blocked" || cur?.state === "partial")
}

/** Ocupada, como la cuenta el server (plans.ts): trabajando, arrancando o esperando una respuesta tuya. */
const BUSY = new Set<Session["status"]>(["working", "starting", "needs_input"])

/**
 * En pausa con el paso "en curso" pero la sesión ya no lo está haciendo (se reinició el server, se detuvo
 * la sesión): el paso quedó cortado y hay que repetirlo o seguir.
 */
export const planCut = (d: Draft, target: Pick<Session, "status"> | undefined) =>
  d.planState === "paused" && currentOf(d)?.state === "running" && !!target && !BUSY.has(target.status)

/** El estado del plan para la pastilla: ámbar solo si frena. */
function planView(d: Draft, target?: Pick<Session, "status" | "limited">): { label: string; tone: Tone } {
  if (!d.planState) return draftStateView[d.state]
  // Sin uso el plan espera (no es una falla ni una alarma): pending.
  if (d.planState === "running" && target?.limited) return { label: "Esperando el uso", tone: "pending" }
  if (planStuck(d) || planCut(d, target)) return { label: "Espera una decisión", tone: "attention" }
  return planStateView[d.planState]
}

/** "Paso 2 de 4 · WEB · Sonnet 5.5" (o cómo terminó). */
/** Con `target` dice también la sesión (en el panel de la sesión ya se sabe cuál es). */
function progressText(d: Draft, models: ModelOption[], target: Session | undefined, fallback: string): string {
  const n = d.steps.length
  if (d.planState === "done") return `Terminado · ${n === 1 ? "1 paso" : `${n} pasos`}`
  const done = d.steps.filter((s) => s.state === "done").length
  if (d.planState === "cancelled") return `Cancelado · ${done} de ${n} ${n === 1 ? "paso hecho" : "pasos hechos"}`
  const i = d.currentStep ?? 0
  const step = d.steps[i]
  const model = step ? (step.model ? modelName(models, step.model) : stepFallback(d.steps, i, models, fallback)) : fallback
  return [`Paso ${i + 1} de ${n}`, target?.name, model].filter(Boolean).join(" · ")
}

/** Con qué modelo sigue un paso que no elige uno: el del último paso que eligió, o el de la sesión. */
function stepFallback(steps: Pick<PlanStep, "model">[], i: number, models: ModelOption[], session: string): string {
  for (let j = i - 1; j >= 0; j--) {
    const m = steps[j]?.model
    if (m) return modelName(models, m)
  }
  return session
}

const toEdit = (s: PlanStep): PlanStepEdit => ({
  title: s.title,
  prompt: s.prompt,
  model: s.model,
  effort: s.effort,
  fresh: s.fresh,
  subagents: s.subagents,
})

/** La barra del progreso: un segmento por paso, con el tono de su estado. */
function PlanProgress({ steps, className }: { steps: PlanStep[]; className?: string }) {
  return (
    <div className={cn("flex gap-1", className)} aria-hidden>
      {steps.map((s, i) => (
        <span
          key={i}
          className={cn("h-1.5 min-w-2 flex-1 rounded-full", s.state === "pending" || s.state === "skipped" ? "bg-muted" : toneBg[planStepView[s.state].tone])}
        />
      ))}
    </div>
  )
}

/**
 * Un plan: varios pasos para una misma sesión, cada uno con su modelo. Antes de enviarlo se revisan y
 * se cambian los pasos; enviado, avanza solo y se puede pausar, reanudar o cancelar.
 */
export function PlanCard({ draft, compact = false, bare = false, className }: { draft: Draft; compact?: boolean; bare?: boolean; className?: string }) {
  const models = useModels()
  const target = useStore((s) => (draft.targetSessionId ? s.sessions[draft.targetSessionId] : undefined))
  const original = useStore((s) => (draft.revises ? s.drafts[draft.revises] : undefined))
  const revision = useStore((s) => Object.values(s.drafts).find((d) => d.revises === draft.id && (d.state === "ready" || d.state === "staged")))
  // Un plan para una sesión nueva arranca con el modelo del proyecto.
  const isNew = !target && draft.newSession !== null
  const fallback = useSessionModelName(draft.projectId, target)
  const action = useAction()
  // Desde otro dispositivo, editar, enviar, pausar y cancelar piden el nivel "responder".
  const respond = useCan("respond")
  // Reanudar un plan es de control; los pasos (modelo, esfuerzo, prompts) solo se editan desde esta máquina.
  const control = useCan("control")
  const fullEdit = draftEditMode(useAccess((s) => s.caps)) === "full"
  const [steps, setSteps] = useState<PlanStepEdit[]>(() => draft.steps.map(toEdit))
  const [hidden, setHidden] = useState(false)
  // Si la orquestadora (o el server, al avanzar) cambia el plan, la copia local la sigue.
  // Solo cuando cambia lo editable: que un paso avance (su estado) no pisa lo que estás cambiando.
  const serverSteps = JSON.stringify(draft.steps.map(toEdit))
  // Una clave por paso, que no cambia al sacar uno (así no se mezcla qué paso estaba abierto o en edición).
  const lastKey = useRef(draft.steps.length)
  const [keys, setKeys] = useState(() => draft.steps.map((_, i) => i))
  useEffect(() => {
    const list = JSON.parse(serverSteps) as PlanStepEdit[]
    setSteps(list)
    setKeys(list.map(() => lastKey.current++))
  }, [serverSteps, draft.revision])

  const ready = draft.state === "ready"
  const approved = draft.state === "sent" && draft.planState !== null
  const paused = draft.planState === "paused"
  // Sin uso la sesión del plan no recibe nada: el paso en curso (o el que sigue) espera a que se renueve.
  const waitingUse = draft.planState === "running" && !!target?.limited
  const open = ready || draft.state === "staged" || draft.planState === "running" || paused
  const edited = useMemo(() => JSON.stringify(steps) !== serverSteps, [steps, serverSteps])
  const stuck = planStuck(draft)
  const cut = planCut(draft, target)
  const view = planView(draft, target)
  const current = currentOf(draft)
  const next = draft.currentStep !== null && draft.currentStep + 1 < draft.steps.length ? draft.currentStep + 1 : null

  // Se cambian los pasos que faltan: todos antes de enviarlo, los pendientes con el plan en pausa.
  // El paso que volvió trabado también, para corregirlo antes de repetirlo.
  const editable = (i: number) => respond && fullEdit && (ready || paused) && ((draft.steps[i]?.state ?? "pending") === "pending" || ((stuck || cut) && i === draft.currentStep))
  const removable = respond && fullEdit && ready && steps.length > 1 && !draft.revises
  const busy = action.busy()

  const patch = (i: number, p: Partial<PlanStepEdit>) => setSteps((list) => list.map((s, j) => (j === i ? { ...s, ...p } : s)))
  const remove = (i: number) => {
    setSteps((list) => list.filter((_, j) => j !== i))
    setKeys((list) => list.filter((_, j) => j !== i))
  }
  const edits = edited ? { steps } : {}

  const send = () =>
    action.run("send", () =>
      api
        .sendDraft(draft.id, edits)
        .then(
          () =>
            toast.success(
              draft.revises
                ? "Cambios al plan enviados"
                : isNew
                  ? `Sesión ${draft.newSession?.name} creada con el plan`
                  : `Plan enviado a ${target?.name ?? "la sesión"}`
            ),
          failed(draft.revises ? "enviar los cambios al plan" : "enviar el plan")
        )
    )
  const save = () => action.run("save", () => api.editDraft(draft.id, { steps }).then(() => toast.success("Pasos guardados"), failed("guardar los pasos")))
  const pause = () => action.run("pause", () => api.pausePlan(draft.id).then(() => toast.success("Plan pausado"), failed("pausar el plan")))
  const resume = (mode?: "retry" | "next") =>
    action.run(`resume-${mode ?? ""}`, async () => {
      try {
        if (edited) await api.editDraft(draft.id, { steps })
        await api.resumePlan(draft.id, mode)
        toast.success("Plan reanudado")
      } catch (err) {
        failed("reanudar el plan")(err)
      }
    })
  const discard = () =>
    undoable({
      message: "Propuesta descartada",
      failMessage: "No se pudo descartar la propuesta",
      run: () => api.discardDraft(draft.id),
      onHide: () => setHidden(true),
      onRestore: () => setHidden(false),
    })

  return (
    <FileRefScope projectId={draft.projectId} sessionId={draft.targetSessionId ?? undefined}>
      <article
        id={`plan-${draft.id}`}
        data-draft-id={draft.id}
        data-draft-state={draft.state}
        data-plan-state={draft.planState ?? undefined}
        hidden={hidden}
        className={cn(bare ? "p-1" : "surface-card p-4", !open && "opacity-70", className)}
      >
        {/* Desplegada en una fila (el resumen del proyecto), la fila ya dice el título y el progreso. */}
        {!bare && (
          <>
            <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <ListChecks className="size-3.5" />
                {draft.revises ? "Cambios al plan" : "Plan"}
              </span>
              <span className="inline-flex items-center gap-1">
                <ArrowRight className="size-3.5" />
                {isNew ? (
                  <span className="inline-flex items-center gap-1">
                    <Sparkles className="size-3.5" /> Sesión nueva <span className="name text-foreground">{draft.newSession?.name}</span>
                  </span>
                ) : target ? (
                  <Link href={`/p/${target.projectId}/s/${target.id}`} className="name text-foreground hover:underline">
                    {target.name}
                  </Link>
                ) : (
                  <span>una sesión que ya no está</span>
                )}
              </span>
              <TonePill tone={view.tone}>
                {draft.state === "staged" && <Lock className="size-3" />}
                {view.label}
              </TonePill>
              <DraftAfkMarks draft={draft} />
              {draft.revision > 1 && <span>rev. {draft.revision}</span>}
              {draft.edited && approved && <span>con tus cambios</span>}
              <span className="ml-auto" title={new Date(draft.decidedAt ?? draft.updatedAt).toLocaleString("es-AR")}>
                {timeAgo(draft.decidedAt ?? draft.updatedAt)}
              </span>
            </header>

            <h3 className="mt-2 text-base leading-snug font-medium">{draft.title}</h3>
            {draft.revises && (
              <p className="text-xs text-muted-foreground">
                Cambia los pasos que faltan de {original ? `"${original.title}"` : "un plan que ya enviaste"}. Los pasos hechos quedan como están.
              </p>
            )}

            {approved && (
              <div className="mt-3 space-y-1.5">
                <p className="text-sm">{progressText(draft, models, target, fallback)}</p>
                <PlanProgress steps={draft.steps} />
              </div>
            )}
          </>
        )}

        {waitingUse && target?.limited && (
          <p className={cn("mt-3 rounded-lg px-3 py-2 text-xs", toneSoft.pending)} title={limitTitle(target.limited)}>
            Esperando que se renueve el uso · {limitText(target.limited)}. El paso sigue solo.
          </p>
        )}
        {paused && (
          <p className={cn("mt-3 rounded-lg px-3 py-2 text-xs", toneSoft[stuck || cut ? "attention" : "idle"])}>
            {cut
              ? `El paso ${(draft.currentStep ?? 0) + 1} quedó cortado: ${target?.name ?? "la sesión"} no lo terminó. ${next !== null ? "Repetilo o seguí con el siguiente." : "Repetilo o cancelá el plan."}`
              : stuck
              ? `El paso ${(draft.currentStep ?? 0) + 1} volvió ${current?.state === "blocked" ? "bloqueado" : "parcial"}. El plan espera a la orquestadora: puede proponer cambios a los pasos, o lo reanudás vos.`
              : current?.state === "running"
                ? `En pausa: el paso ${(draft.currentStep ?? 0) + 1} termina lo que está haciendo y el siguiente sale cuando lo reanudes.`
                : "En pausa: el paso siguiente sale cuando lo reanudes."}
            {/* Trabado, lo que reportó el paso dice más que la nota (que es para la orquestadora). */}
            {(stuck && current?.summary ? current.summary : note(draft.planNote)) && (
              <span className="mt-1 block whitespace-pre-wrap">{stuck && current?.summary ? current.summary : note(draft.planNote)}</span>
            )}
          </p>
        )}
        {!paused && draft.planNote && (draft.planState === "done" || draft.planState === "cancelled") && (
          <p className="mt-2 text-xs text-muted-foreground">{note(draft.planNote)}</p>
        )}
        {revision && (
          <p className="mt-2 text-xs text-muted-foreground">
            La orquestadora propone cambios a este plan: "{revision.title}", {revision.state === "ready" ? "lista para enviar" : "en preparación"}.
          </p>
        )}

        <ol className="mt-3 divide-y border-y">
          {steps.map((step, i) => (
            <StepRow
              key={keys[i] ?? i}
              index={i}
              step={step}
              live={draft.steps[i]}
              approved={approved}
              current={approved && draft.currentStep === i}
              cut={cut && draft.currentStep === i}
              waiting={waitingUse && draft.currentStep === i}
              defaultOpen={!compact && !approved && steps.length <= 2}
              fallback={stepFallback(steps, i, models, fallback)}
              newSession={isNew && i === 0}
              editable={editable(i)}
              busy={busy}
              onChange={(p) => patch(i, p)}
              onRemove={removable ? () => remove(i) : undefined}
            />
          ))}
        </ol>

        {draft.state === "staged" && (
          <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            La orquestadora sigue revisando resultados. La propuesta se libera cuando termine con la cola vacía.
          </p>
        )}

        {ready && respond && (
          <footer className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={send} disabled={busy}>
              {action.busy("send") ? <Spinner /> : <Send />}
              {edited ? "Enviar con cambios" : draft.revises ? "Enviar cambios" : "Enviar plan"}
            </Button>
            {edited && (
              <>
                <Button size="sm" variant="outline" onClick={save} disabled={busy}>
                  {action.busy("save") && <Spinner />}
                  Guardar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSteps(draft.steps.map(toEdit))} disabled={busy}>
                  Deshacer cambios
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" disabled={busy} onClick={discard}>
              <Trash2 />
              Descartar
            </Button>
          </footer>
        )}

        {approved && respond && (draft.planState === "running" || paused) && (
          <footer className="mt-3 flex flex-wrap items-center gap-2">
            {paused ? (
              !control ? null : stuck || cut ? (
                <>
                  <Button size="sm" onClick={() => resume("retry")} disabled={busy}>
                    {action.busy("resume-retry") ? <Spinner /> : <RotateCcw />}
                    Repetir el paso {(draft.currentStep ?? 0) + 1}
                  </Button>
                  {next !== null && (
                    <Button size="sm" variant="outline" onClick={() => resume("next")} disabled={busy}>
                      {action.busy("resume-next") ? <Spinner /> : <SkipForward />}
                      Seguir con el paso {next + 1}
                    </Button>
                  )}
                </>
              ) : (
                <Button size="sm" onClick={() => resume()} disabled={busy}>
                  {action.busy("resume-") ? <Spinner /> : <Play />}
                  Reanudar
                </Button>
              )
            ) : (
              <Button size="sm" variant="outline" onClick={pause} disabled={busy}>
                {action.busy("pause") ? <Spinner /> : <Pause />}
                Pausar
              </Button>
            )}
            {paused && edited && (
              <Button size="sm" variant="outline" onClick={save} disabled={busy}>
                {action.busy("save") && <Spinner />}
                Guardar pasos
              </Button>
            )}
            <ConfirmAction
              title="¿Cancelar el plan?"
              description={`${target?.name ?? "La sesión"} no recibe los pasos que faltan. Lo que ya hizo queda como está.${current?.state === "running" && !cut ? " El paso que está haciendo lo termina: si querés cortarlo, interrumpilo desde su chat." : ""}`}
              confirmLabel="Cancelar plan"
              cancelLabel="Volver"
              failMessage="No se pudo cancelar el plan"
              onConfirm={async () => {
                await api.cancelPlan(draft.id)
                toast.success("Plan cancelado")
              }}
            >
              <Button size="sm" variant="outline" className="ml-auto" disabled={busy}>
                <X />
                Cancelar plan…
              </Button>
            </ConfirmAction>
          </footer>
        )}
      </article>
    </FileRefScope>
  )
}

/** Un paso: título, modelo, si empieza de cero y, desplegado, el prompt y lo que reportó. */
function StepRow({
  index,
  step,
  live,
  approved,
  current,
  cut,
  waiting = false,
  defaultOpen,
  fallback,
  newSession,
  editable,
  busy,
  onChange,
  onRemove,
}: {
  index: number
  step: PlanStepEdit
  /** El paso como está en el server (estado y resultado). */
  live: PlanStep | undefined
  approved: boolean
  current: boolean
  /** El paso en curso espera que se renueve el uso (la sesión está sin uso). */
  waiting?: boolean
  /** El paso en curso quedó cortado (la sesión no lo está haciendo). */
  cut: boolean
  defaultOpen: boolean
  fallback: string
  /** El primer paso de un plan para una sesión nueva: sin modelo, arranca con el del proyecto. */
  newSession: boolean
  editable: boolean
  /** Hay un pedido en vuelo: los controles quedan deshabilitados (sin desmontarse, para no perder el foco). */
  busy: boolean
  onChange: (p: Partial<PlanStepEdit>) => void
  onRemove?: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [editing, setEditing] = useState(false)
  const state = live?.state ?? "pending"
  // Sin uso: el paso espera (o el siguiente todavía no salió). No es una falla: va en pending.
  const view = cut ? { label: "Cortado", tone: "attention" as const } : waiting ? { label: "Esperando que se renueve el uso", tone: "pending" as const } : planStepView[state]
  const showState = approved && (state !== "pending" || waiting)
  const result = live?.summary
  useEffect(() => {
    if (!editable) setEditing(false)
  }, [editable])

  return (
    <li className={cn("px-3 py-2.5", current && "bg-accent/50")} aria-current={current ? "step" : undefined}>
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-medium tabular-nums",
            showState ? toneSoft[view.tone] : "bg-muted text-muted-foreground"
          )}
          aria-hidden
        >
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex min-w-0 items-center gap-1 text-left text-sm font-medium hover:underline"
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 wrap-anywhere">{step.title || `Paso ${index + 1}`}</span>
            </button>
            {showState && (
              <TonePill tone={view.tone}>
                {state === "running" && !cut && !waiting && <Lamp tone="working" pulse className="size-1.5" />}
                {view.label}
              </TonePill>
            )}
            <span className="sr-only">
              Paso {index + 1}
              {showState ? "" : ": por hacer"}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <ModelPill
              model={step.model}
              effort={step.effort}
              fallback={fallback}
              newSession={newSession}
              onChange={editable ? (m) => onChange(m) : undefined}
              disabled={busy}
            />
            {step.fresh && (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                title="/clear antes del paso: arranca sin la conversación anterior y recibe lo que reportó el paso anterior"
              >
                <Eraser className="size-3" /> empieza de cero
              </span>
            )}
          </div>

          {open && (
            <div className="mt-2 space-y-2">
              {result && (
                <div>
                  <p className="eyebrow">Lo que reportó</p>
                  <p className="mt-1 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">
                    <RefText text={result} />
                  </p>
                </div>
              )}
              {editing ? (
                <div className="space-y-2">
                  <Input
                    value={step.title}
                    onChange={(e) => onChange({ title: e.target.value })}
                    placeholder="Título"
                    aria-label={`Título del paso ${index + 1}`}
                  />
                  <Textarea
                    value={step.prompt}
                    onChange={(e) => onChange({ prompt: e.target.value })}
                    aria-label={`Prompt del paso ${index + 1}`}
                    className="min-h-32 text-sm leading-relaxed"
                    autoFocus
                  />
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox checked={step.fresh} onCheckedChange={(v) => onChange({ fresh: v === true })} />
                    Empezar de cero
                    <span className="text-xs text-muted-foreground">· /clear antes del paso</span>
                  </label>
                  <Button size="xs" variant="outline" onClick={() => setEditing(false)}>
                    Listo
                  </Button>
                </div>
              ) : (
                <div>
                  {result && <p className="eyebrow">Prompt</p>}
                  <p className="mt-1 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap text-foreground/85">
                    <RefText text={step.prompt} />
                  </p>
                  <SubagentSpecList specs={step.subagents} />
                </div>
              )}
            </div>
          )}
        </div>
        {(editable || onRemove) && (
          <div className="-mt-0.5 -mr-1.5 flex shrink-0 items-center">
            {editable && !editing && (
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={busy}
                aria-label={`Editar el paso ${index + 1}`}
                title="Editar el paso"
                onClick={() => {
                  setOpen(true)
                  setEditing(true)
                }}
              >
                <Pencil />
              </Button>
            )}
            {onRemove && (
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={busy}
                aria-label={`Sacar el paso ${index + 1}`}
                title="Sacar el paso"
                onClick={onRemove}
              >
                <X />
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/** El plan en curso de una sesión, si tiene uno. */
export function useSessionPlan(sessionId: string): Draft | undefined {
  return useStore((s) => Object.values(s.drafts).find((d) => d.targetSessionId === sessionId && planActive(d)))
}

/**
 * Adónde lleva un link a un plan: si sigue en curso, a su tarjeta en el resumen del proyecto (la abre y
 * la lleva a la vista); si ya terminó, al chat de la orquestadora que lo propuso.
 */
export function usePlanLink(draft: Draft | undefined): { href: string; onClick?: () => void } | null {
  const setUi = useUi((s) => s.set)
  if (!draft) return null
  if (planActive(draft))
    return { href: `/p/${draft.projectId}`, onClick: () => setUi({ reveal: { kind: "plan", id: draft.projectId, item: draft.id, at: Date.now() } }) }
  return { href: draft.createdBy ? `/p/${draft.projectId}/s/${draft.createdBy}` : `/p/${draft.projectId}` }
}

/**
 * Para el panel de la sesión: "Plan · Paso 2 de 4 · Sonnet 5.5", con su estado y el link a la tarjeta.
 * No muestra nada si la sesión no está en un plan.
 */
export function SessionPlanLine({ session, className }: { session: Session; className?: string }) {
  const models = useModels()
  const draft = useSessionPlan(session.id)
  const fallback = useSessionModelName(session.projectId, session)
  const link = usePlanLink(draft)
  if (!draft || !link) return null
  const view = planView(draft, session)
  return (
    <Link
      {...link}
      className={cn(
        "flex items-center gap-2.5 rounded-xl bg-muted/60 px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none",
        className
      )}
      title={`Plan "${draft.title}": ver los pasos`}
    >
      <ListChecks className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{draft.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{progressText(draft, models, undefined, fallback)}</span>
      </span>
      <TonePill tone={view.tone}>{view.label}</TonePill>
    </Link>
  )
}

/**
 * Los planes en curso del proyecto, para el resumen: una línea por plan que despliega su tarjeta.
 * Llegando desde otro lado (la Bandeja, el panel de la sesión) abre ese plan y lo lleva a la vista.
 */
export function ProjectPlans({ projectId }: { projectId: string }) {
  const drafts = useStore((s) => s.drafts)
  const plans = useMemo(
    () =>
      Object.values(drafts)
        .filter((d) => d.projectId === projectId && planActive(d))
        .sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0)),
    [drafts, projectId]
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const pending = useUi((s) => s.reveal)
  const refs = useRef(new Map<string, HTMLLIElement>())
  useEffect(() => {
    if (pending?.kind !== "plan" || pending.id !== projectId || !pending.item) return
    const id = pending.item
    useUi.getState().set({ reveal: null })
    setOpenId(id)
    requestAnimationFrame(() => {
      const el = refs.current.get(id)
      if (el) reveal(el)
    })
  }, [pending, projectId])

  if (!plans.length) return null
  return (
    <section aria-label="Planes en marcha">
      <h2 className="eyebrow mb-2 flex items-center gap-1.5">
        Planes en marcha <span className="font-normal">{plans.length}</span>
      </h2>
      <ul className="surface-card divide-y overflow-hidden">
        {plans.map((d) => (
          <li key={d.id} ref={(el) => void (el ? refs.current.set(d.id, el) : refs.current.delete(d.id))}>
            <PlanRow draft={d} open={openId === d.id} onToggle={() => setOpenId((v) => (v === d.id ? null : d.id))} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function PlanRow({ draft, open, onToggle }: { draft: Draft; open: boolean; onToggle: () => void }) {
  const models = useModels()
  const target = useStore((s) => (draft.targetSessionId ? s.sessions[draft.targetSessionId] : undefined))
  const fallback = useSessionModelName(draft.projectId, target)
  const view = planView(draft, target)
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none focus-visible:ring-inset"
      >
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{draft.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{progressText(draft, models, target, fallback)}</span>
        </span>
        <PlanProgress steps={draft.steps} className="hidden w-24 shrink-0 sm:flex" />
        <span className="hidden shrink-0 md:inline-flex">
          <DraftAfkMarks draft={draft} />
        </span>
        <TonePill tone={view.tone}>{view.label}</TonePill>
      </button>
      {open && (
        <div className="border-t px-2 pt-1 pb-2 sm:px-3">
          <PlanCard draft={draft} compact bare />
        </div>
      )}
    </>
  )
}
