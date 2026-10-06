import { Shortcut } from "@/components/ui/kbd"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * El encabezado de una página: el nombre (en Bricolage) con lo que lo acompaña, y debajo una línea
 * de datos. Crece si hace falta en vez de apretar las dos líneas en 56 px.
 */
export function PageHeader({
  title,
  subtitle,
  leading,
  actions,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  leading?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-3 py-2.5 sm:px-5">
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarTrigger className="-ml-1 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-2">
          Barra lateral <Shortcut keys="mod+b" />
        </TooltipContent>
      </Tooltip>
      {leading}
      <div className="min-w-0 flex-1">
        <h1
          className="page-title truncate text-base leading-snug"
          title={typeof title === "string" ? title : undefined}
        >
          {title}
        </h1>
        {subtitle && <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground sm:truncate">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  )
}
