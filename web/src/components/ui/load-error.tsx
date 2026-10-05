import { RotateCw } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/**
 * Lo que va en lugar de una lista o un panel cuando no se pudo cargar: nunca "vacío" ni un esqueleto
 * eterno. `what` completa la frase "No se pudo cargar …". `compact` es para dentro de una fila o una
 * sección chica.
 */
export function LoadError({
  what,
  error,
  onRetry,
  compact = false,
  className,
}: {
  what: string
  error?: unknown
  onRetry?: () => unknown
  compact?: boolean
  className?: string
}) {
  const [retrying, setRetrying] = React.useState(false)
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : null
  const retry = async () => {
    if (!onRetry) return
    setRetrying(true)
    try {
      await onRetry()
    } catch {
      // el error nuevo lo muestra quien llama
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-3 text-sm",
        compact ? "py-1" : "rounded-xl bg-status-error-lamp/8 px-4 py-3",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-status-error">No se pudo cargar {what}.</p>
        {detail && <p className="truncate text-xs text-muted-foreground" title={detail}>{detail}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={() => void retry()} disabled={retrying}>
          {retrying ? <Spinner /> : <RotateCw />}
          Reintentar
        </Button>
      )}
    </div>
  )
}
