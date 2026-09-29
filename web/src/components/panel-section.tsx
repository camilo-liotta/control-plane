import { ChevronRight } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useSectionOpen, usePanelSections, type PanelSection } from "@/lib/panel-sections"
import { cn } from "@/lib/utils"

/**
 * Una sección plegable del panel de la sesión. Plegada sigue mostrando lo importante: el conteo, un
 * punto si algo te espera y, si hace falta, un resumen de una línea.
 */
export function Section({
  id,
  title,
  children,
  count,
  attention,
  summary,
  action,
}: {
  id: PanelSection
  title: string
  children: React.ReactNode
  count?: number
  /** Hay algo esperándote adentro (una propuesta lista, un resultado sin revisar). */
  attention?: boolean
  /** Una línea que se ve con la sección plegada. */
  summary?: React.ReactNode
  /** Un botón al lado del título (fuera del que pliega). */
  action?: React.ReactNode
}) {
  const open = useSectionOpen(id)
  const toggle = usePanelSections((s) => s.toggle)
  return (
    <Collapsible open={open} onOpenChange={(v) => toggle(id, v)} asChild>
      <section className="border-b last:border-b-0" data-panel-section={id}>
        <div className="flex items-center gap-1 pr-2">
          <h3 className="min-w-0 flex-1">
            <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 py-3 pr-2 pl-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              <span className="eyebrow shrink-0 group-hover:text-foreground">{title}</span>
              {count !== undefined && count > 0 && (
                <span className={cn("shrink-0 font-mono text-xs", attention ? "font-medium text-status-attention" : "text-muted-foreground")}>
                  {count}
                </span>
              )}
              {attention && (
                <span className="size-1.5 shrink-0 rounded-full bg-status-attention">
                  <span className="sr-only">: te espera algo</span>
                </span>
              )}
              {!open && summary && <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{summary}</span>}
            </CollapsibleTrigger>
          </h3>
          {action}
        </div>
        <CollapsibleContent className="px-4 pb-4">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  )
}
