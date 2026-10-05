import { cn } from "@/lib/utils"

/** Una tecla. Dentro de un tooltip se adapta sola al fondo oscuro. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-md bg-muted px-1 font-sans text-2xs font-semibold text-muted-foreground shadow-[inset_0_-1px_0_var(--border)] select-none in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background in-data-[slot=tooltip-content]:shadow-none dark:in-data-[slot=tooltip-content]:bg-background/15 [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <kbd data-slot="kbd-group" className={cn("inline-flex items-center gap-0.5", className)} {...props} />
}

/** En la Mac (navegador o app de escritorio, WKWebView): ⌘ en vez de Ctrl, ⌥ en vez de Alt. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)

const LABELS: Record<string, [mac: string, other: string]> = {
  mod: ["⌘", "Ctrl"],
  ctrl: ["⌃", "Ctrl"],
  alt: ["⌥", "Alt"],
  shift: ["⇧", "Shift"],
  enter: ["↩", "Enter"],
  esc: ["esc", "Esc"],
  up: ["↑", "↑"],
  down: ["↓", "↓"],
  backtick: ["`", "`"],
}

/** Cómo se escribe una tecla en esta plataforma ("mod" es ⌘ en la Mac y Ctrl en el resto). */
export function keyLabel(key: string): string {
  const k = LABELS[key.toLowerCase()]
  return k ? k[isMac ? 0 : 1] : key.length === 1 ? key.toUpperCase() : key
}

/** Un atajo, ej. <Shortcut keys="mod+k" />: ⌘K en la Mac, Ctrl K en Linux y Windows. */
function Shortcut({ keys, className }: { keys: string; className?: string }) {
  const parts = keys.split("+")
  return (
    <KbdGroup className={className} aria-label={parts.map(keyLabel).join(isMac ? "" : "+")}>
      {parts.map((k, i) => (
        <Kbd key={i}>{keyLabel(k)}</Kbd>
      ))}
    </KbdGroup>
  )
}

export { Kbd, KbdGroup, Shortcut }
