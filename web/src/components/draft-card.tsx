import { ArrowRight, Lock, Pencil, Send, Sparkles, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Link } from "wouter"

import type { Draft } from "@shared/types"

import { TonePill } from "@/components/status"
import { cleanSpecs, SubagentSpecEditor, SubagentSpecList } from "@/components/subagent-specs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { draftStateView } from "@/lib/status"
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
  const [busy, setBusy] = useState<null | "send" | "discard" | "save">(null)

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

  const run = async (kind: "send" | "discard" | "save", fn: () => Promise<unknown>, ok: string) => {
    setBusy(kind)
    try {
      await fn()
      toast.success(ok)
      setEditing(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
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
            ? { title, prompt, subagents: cleanSpecs(subagents), ...(draft.kind === "session" ? { name, role } : {}) }
            : {}
        ),
      draft.kind === "session" ? `Sesión ${name || draft.newSession?.name} creada` : `Enviado a ${target?.name ?? "la sesión"}`
    )

  return (
    <article
      className={cn(
        "rounded-xl border bg-card p-4 shadow-xs transition-colors",
        draft.state === "ready" && "border-status-attention/40",
        !open && "opacity-70",
        className
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {draft.kind === "session" ? (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Sparkles className="size-3.5" /> Sesión nueva
            <span className="font-mono">{draft.newSession?.name}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <ArrowRight className="size-3.5" />
            {target ? (
              <Link href={`/p/${target.projectId}/s/${target.id}`} className="font-mono font-medium text-foreground hover:underline">
                {target.name}
              </Link>
            ) : (
              <span className="font-mono">sesión eliminada</span>
            )}
          </span>
        )}
        <TonePill tone={view.tone}>
          {draft.state === "staged" && <Lock className="size-3" />}
          {view.label}
        </TonePill>
        {draft.revision > 1 && <span className="font-mono">rev. {draft.revision}</span>}
        {draft.edited && draft.state === "sent" && <span>con tus cambios</span>}
        <span className="ml-auto">{timeAgo(draft.decidedAt ?? draft.updatedAt)}</span>
      </header>

      {editing ? (
        <div className="mt-3 space-y-2">
          {draft.kind === "session" && (
            <div className="grid grid-cols-2 gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre" className="font-mono uppercase" />
              <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Rol" />
            </div>
          )}
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título" />
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="min-h-40 text-sm leading-relaxed"
            autoFocus
          />
          <SubagentSpecEditor specs={subagents} onChange={setSubagents} />
        </div>
      ) : (
        <>
          <h3 className="mt-2 text-[0.95rem] leading-snug font-medium">{draft.title}</h3>
          {draft.kind === "session" && draft.newSession?.role && (
            <p className="text-xs text-muted-foreground">Rol: {draft.newSession.role}</p>
          )}
          <div className="relative mt-2">
            <p
              className={cn(
                "text-sm leading-relaxed whitespace-pre-wrap text-foreground/85",
                !expanded && long && "max-h-28 overflow-hidden"
              )}
            >
              {draft.prompt}
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

      {draft.state === "staged" && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
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
                  run("save", () => api.editDraft(draft.id, { title, prompt, subagents: cleanSpecs(subagents) }), "Cambios guardados")
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
            onClick={() => run("discard", () => api.discardDraft(draft.id), "Propuesta descartada")}
          >
            {busy === "discard" ? <Spinner /> : <Trash2 />}
            Descartar
          </Button>
        </footer>
      )}
    </article>
  )
}
