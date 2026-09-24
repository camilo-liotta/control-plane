import { SidebarTrigger } from "@/components/ui/sidebar"

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
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SidebarTrigger className="-ml-1 text-muted-foreground" />
      {leading}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[0.95rem] leading-tight font-semibold">{title}</h1>
        {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  )
}
