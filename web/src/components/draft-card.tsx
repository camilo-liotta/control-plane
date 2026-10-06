import { ArrowRight, Eraser, Lock, Pencil, Send, Sparkles, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { Draft } from "@shared/types"

import { FileRefScope, RefText } from "@/components/file-ref"
import { TonePill } from "@/components/status"
import { cleanSpecs, SubagentSpecEditor, SubagentSpecList } from "@/components/subagent-specs"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { draftStateView } from "@/lib/status"
import { undoable } from "@/lib/undo"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Una propuesta de la orquestadora: se aprueba tal cual, se edita o se descarta. */
export function DraftCard({ draft, compact = false, className }: { draft: Draft; compact?: boolean; className?: string }) {
  const target = useStore((s) => (draft.targetSessionId ? s.sessions[draft.targetSessionId] : undefined))
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(!compact)
  const [title, setTitle] = useState(draft.title)
  const [prompt, setPrompt] = useState(draft.prompt)
  const [name, setName] = useState(draft.newSession?.name ?? "")
  const [role, setRole] = useState(draft.newSession?.role ?? "")
  const [subagents, setSubagents] = useState(draft.subagents)
  const [fresh, setFresh] = useState(draft.fresh)
  const [busy, setBusy] = useState<null | "send" | "save">(null)
  // Descartada: se esconde al toque (sin desmontar, así no se pierde lo que estabas editando) y
  // vuelve si se deshace o falla.
  const [hidden, setHidden] = useState(false)
  // Si la orquestadora cambia la propuesta, la casilla la sigue.
  useEffect(() => setFresh(draft.fresh), [draft.fresh, draft.revision])

  const view = draftStateView[draft.state]
  const open = draft.state === "ready" || draft.state === "staged"
  const long = draft.prompt.length > 420 || draft.prompt.split("\n").length > 8

  const startEdit = () => {
    setTitle(draft.title)
    setPrompt(draft.prompt)
    setName(draft.newSession?.name ?? "")
    setRole(draft.newSession?.role ?? "")
    setSubagents(draft.subagents)
    setEditing(true)
  }

  const run = async (kind: "send" | "save", fn: () => Promise<unknown>, ok: string, failed: string) => {
    setBusy(kind)
    try {
      await fn()
      toast.success(ok)
      setEditing(false)
    } catch (err) {
      toast.error(failed, { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const send = () =>
    run(
      "send",
      () =>
        api.sendDraft(
          draft.id,
          editing
            ? { title, prompt, subagents: cleanSpecs(subagents), ...(draft.kind === "session" ? { name, role } : { fresh }) }
            : draft.kind === "prompt"
              ? { fresh }
              : {}
        ),
      draft.kind === "session" ? `Sesión ${name || draft.newSession?.name} creada` : `Propuesta enviada a ${target?.name ?? "la sesión"}`,
      draft.kind === "session" ? "No se pudo crear la sesión" : "No se pudo enviar la propuesta"
    )

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
        data-draft-id={draft.id}
        data-draft-state={draft.state}
        hidden={hidden}
        className={cn("surface-card p-4", !open && "opacity-70", className)}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {draft.kind === "session" ? (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Sparkles className="size-3.5" /> Sesión nueva
              <span className="name">{draft.newSession?.name}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <ArrowRight className="size-3.5" />
              {target ? (
                <Link href={`/p/${target.projectId}/s/${target.id}`} className="name text-foreground hover:underline">
                  {target.name}
                </Link>
              ) : (
                <span>una sesión que ya no está</span>
              )}
            </span>
          )}
          <TonePill tone={view.tone}>
            {draft.state === "staged" && <Lock className="size-3" />}
            {view.label}
          </TonePill>
          {draft.revision > 1 && <span>rev. {draft.revision}</span>}
          {draft.fresh && draft.state === "sent" && (
            <span className="inline-flex items-center gap-1">
              <Eraser className="size-3" /> empezó de cero
            </span>
          )}
          {draft.edited && draft.state === "sent" && <span>con tus cambios</span>}
          <span className="ml-auto" title={new Date(draft.decidedAt ?? draft.updatedAt).toLocaleString("es-AR")}>
            {timeAgo(draft.decidedAt ?? draft.updatedAt)}
          </span>
        </header>

        {editing ? (
          <div className="mt-3 space-y-2">
            {draft.kind === "session" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre" aria-label="Nombre de la sesión" />
                <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Rol" aria-label="Rol de la sesión" />
              </div>
            )}
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título" aria-label="Título de la propuesta" />
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              aria-label="Prompt"
              className="min-h-40 text-sm leading-relaxed"
              autoFocus
            />
            <SubagentSpecEditor specs={subagents} onChange={setSubagents} />
          </div>
        ) : (
          <>
            <h3 className="mt-2 text-base leading-snug font-medium">{draft.title}</h3>
            {draft.kind === "session" && draft.newSession?.role && (
              <p className="text-xs text-muted-foreground">Rol: {draft.newSession.role}</p>
            )}
            <div className="relative mt-2">
              <p
                className={cn(
                  "text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere text-foreground/85",
                  !expanded && long && "max-h-28 overflow-hidden"
                )}
              >
                <RefText text={draft.prompt} />
              </p>
              {!expanded && long && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
              )}
            </div>
            {long && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {expanded ? "Ver menos" : "Ver el prompt completo"}
              </button>
            )}
            <SubagentSpecList specs={draft.subagents} />
          </>
        )}

        {draft.kind === "prompt" && open && (
          <FreshToggle
            checked={fresh}
            onChange={setFresh}
            disabled={draft.state !== "ready" || busy !== null}
            targetName={target?.name}
            context={target?.context ?? null}
          />
        )}

        {draft.state === "staged" && (
          <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            La orquestadora sigue revisando resultados. La propuesta se libera cuando termine con la cola vacía.
          </p>
        )}

        {draft.state === "ready" && (
          <footer className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={send} disabled={busy !== null}>
              {busy === "send" ? <Spinner /> : <Send />}
              {editing ? "Enviar con cambios" : draft.kind === "session" ? "Crear y enviar" : "Enviar"}
            </Button>
            {editing ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    run(
                      "save",
                      () => api.editDraft(draft.id, { title, prompt, subagents: cleanSpecs(subagents), ...(draft.kind === "prompt" ? { fresh } : {}) }),
                      "Propuesta guardada",
                      "No se pudo guardar la propuesta"
                    )
                  }
                >
                  {busy === "save" && <Spinner />}
                  Guardar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy !== null}>
                  Cancelar
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={startEdit} disabled={busy !== null}>
                <Pencil />
                Editar
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              disabled={busy !== null}
              onClick={discard}
            >
              <Trash2 />
              Descartar
            </Button>
          </footer>
        )}
      </article>
    </FileRefScope>
  )
}

/** Empezar de cero (/clear) antes del prompt: con cuánto contexto viene hoy la sesión, para decidir. */
function FreshToggle({
  checked,
  onChange,
  disabled,
  targetName,
  context,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled: boolean
  targetName?: string
  context: { tokens: number; max: number } | null
}) {
  const pct = context?.max ? Math.round((context.tokens / context.max) * 100) : null
  return (
    <label className={cn("mt-3 flex items-start gap-2.5 text-sm", !disabled && "cursor-pointer")}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} className="mt-0.5" />
      <span className="min-w-0">
        <span className="font-medium">Empezar de cero</span>
        <span className="text-muted-foreground"> · /clear antes del prompt</span>
        <span className="block text-xs text-muted-foreground">
          {checked ? "La sesión arranca sin la conversación anterior (conserva su rol y el CLAUDE.md). " : "Sigue con lo que trae en contexto. "}
          {pct !== null && `${targetName ?? "La sesión"} usa hoy el ${pct}% del contexto.`}
        </span>
      </span>
    </label>
  )
}
