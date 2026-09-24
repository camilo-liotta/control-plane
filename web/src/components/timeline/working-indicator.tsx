import { useEffect, useState } from "react"

import type { Session, TurnProgress } from "@shared/types"

import { tokens } from "@/lib/format"

/** Los símbolos que usa Claude Code mientras piensa. */
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]

/** Un verbo por turno, como el "Swirling…" de la terminal. */
const VERBS = [
  "Pensando",
  "Maquinando",
  "Rumiando",
  "Cocinando",
  "Tejiendo",
  "Hilando",
  "Destilando",
  "Tramando",
  "Desenredando",
  "Cavilando",
  "Puliendo",
  "Amasando",
  "Ensamblando",
  "Afinando",
  "Barajando",
  "Fermentando",
  "Mateando",
  "Garabateando",
]

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * "✻ Maquinando… (3m 4s · ↓ 12,3k tokens)" y debajo qué está haciendo: el indicador de la terminal,
 * mientras la sesión trabaja.
 */
export function WorkingIndicator({
  session,
  turn,
  block,
}: {
  session: Session
  turn?: TurnProgress
  /** Qué está llegando del modelo en este momento, si algo. */
  block?: "text" | "thinking"
}) {
  const [tick, setTick] = useState(0)
  const still = reducedMotion()
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), still ? 1000 : 120)
    return () => clearInterval(t)
  }, [still])

  const starting = session.status === "starting"
  const verb = starting ? "Iniciando" : VERBS[Math.abs(Math.floor((turn?.startedAt ?? 0) / 1000)) % VERBS.length]
  const glyph = still ? "✻" : GLYPHS[tick % GLYPHS.length]
  const time = turn ? elapsed(Date.now() - turn.startedAt) : null
  // lastActivity queda de turnos anteriores (la usan las tarjetas): acá solo cuenta la de este turno.
  const fresh = turn && session.lastActivityAt != null && session.lastActivityAt >= turn.startedAt ? session.lastActivity : null
  const detail = starting
    ? "levantando la sesión…"
    : block === "thinking"
      ? "pensando…"
      : block === "text"
        ? "escribiendo la respuesta…"
        : (fresh ?? "pensando…")
  void tick

  return (
    <div className="px-1 font-mono text-[0.78rem] leading-relaxed" role="status" aria-live="polite">
      <div className="flex items-baseline gap-2">
        <span className="inline-block w-3 text-center text-claude" aria-hidden>
          {glyph}
        </span>
        <span className="text-claude">{verb}…</span>
        {(time || turn?.tokens) && (
          <span className="text-muted-foreground">
            ({[time, turn?.tokens ? `↓ ${tokens(turn.tokens)} tokens` : null].filter(Boolean).join(" · ")})
          </span>
        )}
      </div>
      {detail && (
        <div className="flex gap-2 pl-5 text-muted-foreground">
          <span aria-hidden>⎿</span>
          <span className="min-w-0 truncate">{detail}</span>
        </div>
      )}
    </div>
  )
}
