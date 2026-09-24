import type { UsageWindow } from "@shared/types"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useNow } from "@/hooks/use-now"
import { percent } from "@/lib/format"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

function resetIn(ts: number, now: number) {
  const mins = Math.max(0, Math.round((ts - now) / 60_000))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  if (h < 48) return `${h} h ${mins % 60} min`
  return `${Math.round(h / 24)} días`
}

function Row({ label, window, now }: { label: string; window: UsageWindow; now: number }) {
  const pct = Math.min(1, Math.max(0, window.utilization))
  const tone = pct >= 0.9 ? "bg-status-error" : pct >= 0.7 ? "bg-status-attention" : "bg-status-working"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="grid grid-cols-[2.2rem_1fr_2.6rem] items-center gap-2">
          <span className="font-condensed text-[0.7rem] font-semibold tracking-wide text-muted-foreground uppercase">
            {label}
          </span>
          <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent">
            <div className={cn("h-full rounded-full transition-[width]", tone)} style={{ width: `${pct * 100}%` }} />
          </div>
          <span className="text-right font-mono text-[0.7rem] tabular-nums text-muted-foreground">{percent(pct)}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">Se renueva en {resetIn(window.resetsAt, now)}</TooltipContent>
    </Tooltip>
  )
}

/** Cuánto del límite del plan llevás usado (lo informa el propio Claude Code). */
export function UsageMeter() {
  const usage = useStore((s) => s.usage)
  const now = useNow(30_000)
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return null
  return (
    <div className="space-y-1.5 px-2 py-1">
      <div className="eyebrow">Uso del plan</div>
      {usage.fiveHour && <Row label="5 h" window={usage.fiveHour} now={now} />}
      {usage.sevenDay && <Row label="7 d" window={usage.sevenDay} now={now} />}
    </div>
  )
}
