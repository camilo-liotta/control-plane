import type { Session } from "@shared/types"

import { cn } from "@/lib/utils"
import { sessionStatus, toneBg, toneSoft, toneText, type Tone } from "@/lib/status"

export function Lamp({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      data-pulse={pulse}
      className={cn("lamp", toneBg[tone], toneText[tone], className)}
    />
  )
}

export function SessionLamp({ session, className }: { session: Session; className?: string }) {
  const s = sessionStatus(session)
  return <Lamp tone={s.tone} pulse={s.pulse} className={className} />
}

export function StatusPill({ session, className }: { session: Session; className?: string }) {
  const s = sessionStatus(session)
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 font-condensed text-[0.72rem] font-semibold tracking-wide whitespace-nowrap",
        toneSoft[s.tone],
        className
      )}
    >
      <Lamp tone={s.tone} pulse={s.pulse} className="size-1.5" />
      {s.label}
    </span>
  )
}

export function TonePill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full px-2 font-condensed text-[0.72rem] font-semibold tracking-wide whitespace-nowrap",
        toneSoft[tone],
        className
      )}
    >
      {children}
    </span>
  )
}
