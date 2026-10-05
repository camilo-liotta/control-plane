import type { Session } from "@shared/types"

import { cn } from "@/lib/utils"
import { sessionStatus, toneBg, toneSoft, toneText, type Tone } from "@/lib/status"

/**
 * La luz de un estado. Es decorativa: si nadie más dice el estado en texto, pasale `label` y lo lee
 * el lector de pantalla. El error es un rombo, para no depender solo del color.
 */
export function Lamp({ tone, pulse = false, label, className }: { tone: Tone; pulse?: boolean; label?: string; className?: string }) {
  return (
    <>
      <span aria-hidden data-tone={tone} data-pulse={pulse} className={cn("lamp", toneBg[tone], toneText[tone], className)} />
      {label && <span className="sr-only">{label}</span>}
    </>
  )
}

/** La luz de una sesión, con su estado para el lector de pantalla (salvo `quiet`, si ya se lee al lado). */
export function SessionLamp({ session, quiet = false, className }: { session: Session; quiet?: boolean; className?: string }) {
  const s = sessionStatus(session)
  return <Lamp tone={s.tone} pulse={s.pulse} label={quiet ? undefined : s.label} className={className} />
}

/** Una pastilla con tono: el texto dice qué es; el color solo lo acompaña. */
export function TonePill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      data-tone={tone}
      className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-2xs font-semibold whitespace-nowrap", toneSoft[tone], className)}
    >
      {children}
    </span>
  )
}

/** El estado de una sesión: luz y texto. */
export function StatusPill({ session, className }: { session: Session; className?: string }) {
  const s = sessionStatus(session)
  return (
    <TonePill tone={s.tone} className={cn("gap-1.5", className)}>
      <Lamp tone={s.tone} pulse={s.pulse} className="size-1.5" />
      {s.label}
    </TonePill>
  )
}
