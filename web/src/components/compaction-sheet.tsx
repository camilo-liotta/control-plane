import { Hourglass, Plus, RotateCcw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { CompactionDraft } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { timeAgo, tokens } from "@/lib/format"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

interface Point {
  id: string
  text: string
  keep: boolean
  edited: boolean
  added: boolean
}

interface Section {
  title: string
  points: Point[]
}

let added = 0

function fromDraft(draft: CompactionDraft): Section[] {
  return draft.sections.map((s) => ({
    title: s.title,
    points: s.points.map((p) => ({ id: p.id, text: p.text, keep: true, edited: false, added: false })),
  }))
}

function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, deadline - now)
  const m = Math.floor(left / 60_000)
  const s = Math.floor((left % 60_000) / 1000)
  return (
    <span className="font-mono">
      {m}:{String(s).padStart(2, "0")}
    </span>
  )
}

function PointRow({ point, onChange }: { point: Point; onChange: (patch: Partial<Point>) => void }) {
  const [editing, setEditing] = useState(point.added && !point.text)
  const [value, setValue] = useState(point.text)
  useEffect(() => setValue(point.text), [point.text])
  const save = () => {
    setEditing(false)
    const text = value.trim()
    if (text && text !== point.text) onChange({ text, edited: true })
    else setValue(point.text)
  }
  return (
    <li className="group flex items-start gap-3 py-1.5">
      <Checkbox
        checked={point.keep}
        onCheckedChange={(v) => onChange({ keep: v === true })}
        className="mt-0.5"
        aria-label={point.keep ? "Se conserva" : "Se descarta"}
      />
      {editing ? (
        <Textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              save()
            }
            if (e.key === "Escape") {
              setValue(point.text)
              setEditing(false)
            }
          }}
          placeholder="Lo que Claude tiene que recordar…"
          className="min-h-9 flex-1 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Tocá para editar"
          className={cn(
            "flex-1 rounded-sm text-left text-sm leading-snug break-words hover:bg-muted/60",
            !point.keep && "text-muted-foreground line-through decoration-muted-foreground/60"
          )}
        >
          {point.text}
          {(point.edited || point.added) && (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-px align-middle text-[0.65rem] text-muted-foreground no-underline">
              {point.added ? "agregado" : "editado"}
            </span>
          )}
        </button>
      )}
    </li>
  )
}

/**
 * Compactación moldeable: el resumen que haría Claude, punto por punto, para elegir qué sobrevive.
 * Lo que queda tildado es exactamente lo que va a tener el resumen.
 */
export function CompactionSheet() {
  const sessionId = useUi((s) => s.compactFor)
  const setUi = useUi((s) => s.set)
  const session = useStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const state = useStore((s) => (sessionId ? s.compactions[sessionId] : undefined))
  const [sections, setSections] = useState<Section[]>([])
  const [extra, setExtra] = useState("")
  const [busy, setBusy] = useState(false)
  const draft = state?.draft ?? null

  // Al abrir, si no hay borrador, se pide uno.
  useEffect(() => {
    if (!sessionId || state?.draft || state?.drafting || state?.error) return
    api.compactionDraft(sessionId).catch((err: Error) => toast.error(err.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    setSections(draft ? fromDraft(draft) : [])
    setExtra("")
  }, [draft?.createdAt, sessionId])

  const counts = useMemo(() => {
    let kept = 0
    let dropped = 0
    for (const s of sections) for (const p of s.points) if (p.text.trim()) p.keep ? kept++ : dropped++
    return { kept, dropped }
  }, [sections])

  const close = () => setUi({ compactFor: null })
  const patchPoint = (si: number, id: string, patch: Partial<Point>) =>
    setSections((list) => list.map((s, i) => (i === si ? { ...s, points: s.points.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : s)))
  const setAll = (si: number, keep: boolean) =>
    setSections((list) => list.map((s, i) => (i === si ? { ...s, points: s.points.map((p) => ({ ...p, keep })) } : s)))
  const addPoint = (si: number) =>
    setSections((list) =>
      list.map((s, i) => (i === si ? { ...s, points: [...s.points, { id: `n${++added}`, text: "", keep: true, edited: false, added: true }] } : s))
    )

  const redo = () => sessionId && api.compactionDraft(sessionId).catch((err: Error) => toast.error(err.message))

  const apply = async () => {
    if (!sessionId) return
    setBusy(true)
    try {
      await api.compactionApply(sessionId, {
        sections: sections.map((s) => ({ title: s.title, points: s.points.filter((p) => p.text.trim()).map((p) => ({ text: p.text, keep: p.keep })) })),
        extra: extra.trim() || undefined,
      })
      toast.success("Compactando con tu selección", {
        description: `${counts.kept} ${counts.kept === 1 ? "punto se conserva" : "puntos se conservan"}${counts.dropped ? `, ${counts.dropped} se ${counts.dropped === 1 ? "descarta" : "descartan"}` : ""}.`,
      })
      close()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const direct = async () => {
    if (!sessionId) return
    setBusy(true)
    try {
      await api.compactionDirect(sessionId)
      toast.success(state?.waiting ? "Claude compacta como siempre" : "Compactando", { description: "Claude arma el resumen sin tu selección." })
      close()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const ctx = session?.context
  const stale = Boolean(draft && ctx && draft.contextTokens !== null && ctx.tokens - draft.contextTokens > ctx.max * 0.1)

  return (
    <Sheet open={Boolean(sessionId)} onOpenChange={(v) => !v && close()}>
      <SheetContent
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <SheetHeader className="border-b">
          <SheetTitle>Elegí qué sobrevive a la compactación</SheetTitle>
          <SheetDescription>
            {session ? <span className="font-mono text-foreground">{session.name}</span> : null}
            {ctx ? ` · ${tokens(ctx.tokens)} de contexto` : ""}. Destildá lo que Claude no necesita recordar; tocá un punto para
            editarlo. El resumen va a tener exactamente lo que quede tildado.
          </SheetDescription>
        </SheetHeader>

        {state?.waiting && (
          <div className="flex items-center gap-2.5 border-b bg-status-attention/10 px-4 py-2.5 text-sm">
            <Hourglass className="size-4 shrink-0 text-status-attention" />
            <span>
              {session?.name} está esperando para compactar. Si no elegís, compacta como siempre en <Countdown deadline={state.waiting.deadline} />.
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {!draft && state?.drafting && (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                Claude está armando el borrador con lo que sabe de la conversación. No se agrega nada al chat.
              </p>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-11/12" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              ))}
            </div>
          )}

          {!draft && !state?.drafting && state?.error && (
            <div className="space-y-3 rounded-lg border border-status-error/30 bg-status-error/5 p-4 text-sm">
              <p className="font-medium">No se pudo armar el borrador</p>
              <p className="text-muted-foreground">{state.error}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void redo()}>
                  <RotateCcw />
                  Reintentar
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                También podés escribir abajo instrucciones para el resumen, o compactar sin revisar.
              </p>
            </div>
          )}

          {draft && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>Borrador de {timeAgo(draft.createdAt)}</span>
                {stale && <span className="text-status-attention">la conversación siguió desde entonces</span>}
                <button
                  type="button"
                  onClick={() => void redo()}
                  disabled={state?.drafting}
                  className="inline-flex items-center gap-1 text-foreground hover:underline disabled:opacity-50"
                >
                  {state?.drafting ? <Spinner className="size-3" /> : <RotateCcw className="size-3" />}
                  Rehacer borrador
                </button>
              </div>
              {sections.map((s, si) => {
                const kept = s.points.filter((p) => p.keep).length
                return (
                  <section key={s.title + si}>
                    <div className="mb-1 flex items-center gap-2">
                      <h3 className="eyebrow">{s.title}</h3>
                      <span className="font-mono text-xs text-muted-foreground">
                        {kept}/{s.points.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAll(si, kept < s.points.length)}
                        className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                      >
                        {kept < s.points.length ? "Conservar todos" : "Descartar todos"}
                      </button>
                    </div>
                    <ul className="divide-y divide-border/60">
                      {s.points.map((p) => (
                        <PointRow key={p.id} point={p} onChange={(patch) => patchPoint(si, p.id, patch)} />
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => addPoint(si)}
                      className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Plus className="size-3" />
                      Agregar un punto
                    </button>
                  </section>
                )
              })}
            </div>
          )}

          <div className="mt-6 space-y-1.5">
            <label htmlFor="compact-extra" className="text-sm font-medium">
              Instrucciones extra <span className="font-normal text-muted-foreground">(opcional)</span>
            </label>
            <Textarea
              id="compact-extra"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="Ej: mantené los nombres exactos de las tablas y de los endpoints."
              className="min-h-16 text-sm"
            />
            <p className="text-xs leading-snug text-muted-foreground">
              Lo que descartes sale del contexto de Claude. La conversación completa queda guardada: si algún día lo necesita, la
              puede volver a leer.
            </p>
          </div>
        </div>

        <SheetFooter className="flex-row items-center gap-2 border-t">
          <span className="mr-auto text-xs text-muted-foreground">
            {draft ? (
              <>
                <span className="font-mono text-foreground">{counts.kept}</span> se conservan ·{" "}
                <span className="font-mono text-foreground">{counts.dropped}</span> se descartan
              </>
            ) : null}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void direct()} disabled={busy}>
            {state?.waiting ? "Dejar que Claude decida" : "Compactar sin revisar"}
          </Button>
          <Button size="sm" onClick={() => void apply()} disabled={busy || state?.applying || (!counts.kept && !extra.trim())}>
            {busy && <Spinner />}
            {state?.waiting ? "Compactar con esto" : "Compactar"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
