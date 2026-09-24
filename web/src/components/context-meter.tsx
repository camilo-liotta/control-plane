import { Layers } from "lucide-react"
import { toast } from "sonner"

import type { CompactMode, Session } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { api } from "@/lib/api"
import { tokens } from "@/lib/format"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

export const COMPACT_MODES: Record<CompactMode, { label: string; description: string }> = {
  auto: { label: "Claude decide", description: "Compacta sola, como siempre, sin avisarte." },
  notify: { label: "Avisarme", description: "Te avisa cuando el contexto se está llenando para que elijas qué conservar." },
  ask: { label: "Esperarme", description: "Además, cuando llega el momento, la sesión espera a que elijas." },
}

const SEGMENTS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"]

/** Qué tan lleno está el contexto respecto de donde compacta solo (0–1). */
export function contextLevel(ctx: NonNullable<Session["context"]>) {
  return ctx.tokens / Math.min(ctx.threshold ?? ctx.max, ctx.max)
}

function Ring({ value, className }: { value: number; className?: string }) {
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 -rotate-90", className)} aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2.2" opacity="0.18" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray={`${Math.max(0.02, Math.min(1, value)) * c} ${c}`}
      />
    </svg>
  )
}

/** Cuánto contexto usa la sesión, y la puerta para compactarla eligiendo qué queda. */
export function ContextMeter({ session }: { session: Session }) {
  const ctx = session.context
  const mode = useStore((s) => s.projects[session.projectId]?.settings.compactMode ?? "notify")
  const waiting = useStore((s) => Boolean(s.compactions[session.id]?.waiting))
  const setUi = useUi((s) => s.set)
  if (!ctx) return null
  const pct = Math.round((ctx.tokens / ctx.max) * 100)
  const level = contextLevel(ctx)
  const tone = waiting || level >= 0.85 ? "text-status-attention" : level >= 0.6 ? "text-foreground" : "text-muted-foreground"
  const used = ctx.categories.reduce((n, c) => n + c.tokens, 0) || ctx.tokens
  const running = session.status !== "stopped" && session.status !== "error"

  const direct = async () => {
    try {
      await api.compactionDirect(session.id)
      toast.success("Compactando", { description: "Claude arma el resumen como siempre." })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className={cn("gap-1.5 px-2 font-mono text-xs", tone)} aria-label={`Contexto: ${pct}%`}>
          <Ring value={ctx.tokens / ctx.max} className={waiting ? "animate-pulse" : undefined} />
          {pct}%
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3 p-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium">Contexto</p>
          <p className="font-mono text-xs text-muted-foreground">
            {tokens(ctx.tokens)} de {tokens(ctx.max)} · {pct}%
          </p>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-muted">
          {ctx.categories.map((c, i) => (
            <div
              key={c.name}
              className={SEGMENTS[i % SEGMENTS.length]}
              style={{ width: `${(c.tokens / ctx.max) * 100}%` }}
              title={`${c.name}: ${tokens(c.tokens)}`}
            />
          ))}
        </div>
        {ctx.categories.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {ctx.categories.map((c, i) => (
              <li key={c.name} className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", SEGMENTS[i % SEGMENTS.length])} />
                <span className="flex-1 truncate text-muted-foreground">{c.name}</span>
                <span className="font-mono">{tokens(c.tokens)}</span>
                <span className="w-9 text-right font-mono text-muted-foreground">{Math.round((c.tokens / used) * 100)}%</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs leading-snug text-muted-foreground">
          {!ctx.autoCompact
            ? "La compactación automática está apagada en la configuración de Claude Code."
            : ctx.threshold
              ? `Compacta sola cerca de ${tokens(ctx.threshold)}.`
              : "Compacta sola cuando se llena."}{" "}
          Al compactar: <span className="text-foreground">{COMPACT_MODES[mode].label}</span> (se cambia en la configuración del proyecto).
        </p>
        <div className="flex flex-col gap-1.5">
          <Button size="sm" onClick={() => setUi({ compactFor: session.id })}>
            <Layers />
            {waiting ? "Elegir qué conservar" : "Compactar eligiendo qué queda…"}
          </Button>
          {!waiting && (
            <Button size="sm" variant="ghost" onClick={() => void direct()} disabled={!running && session.status !== "stopped"}>
              Compactar sin revisar
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
