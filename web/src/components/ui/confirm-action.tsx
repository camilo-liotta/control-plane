import * as React from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"

/**
 * Confirmar algo que no se puede deshacer (borrar un proyecto, quitar una cuenta, detener todas las
 * sesiones). Para lo que sí se puede deshacer, no preguntes: usá `undoable()` (lib/undo).
 *
 * - Con hijo, el hijo abre el diálogo (asChild). Sin hijo, se controla con `open` y `onOpenChange`
 *   (por ejemplo desde un ítem de menú).
 * - `onConfirm` puede ser asíncrono: hay spinner, no se cierra hasta que termina y, si falla, queda
 *   abierto con un toast "No se pudo …" (o `failMessage`) y el motivo abajo.
 * - `confirmText`: hay que escribirlo para habilitar el botón (solo para lo grave, como borrar un
 *   proyecto). Con el texto ya escrito, Enter confirma.
 */
export function ConfirmAction({
  children,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancelar",
  destructive = true,
  confirmText,
  failMessage,
  onConfirm,
}: {
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  confirmText?: string
  /** El título del toast si falla (el motivo va abajo). Por defecto, "No se pudo <confirmLabel>". */
  failMessage?: string
  onConfirm: () => unknown
}) {
  const [typed, setTyped] = React.useState("")
  const id = React.useId()
  const ready = !confirmText || typed.trim() === confirmText
  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setTyped("")
        onOpenChange?.(v)
      }}
    >
      {children && <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription asChild><div className="space-y-2">{description}</div></AlertDialogDescription>}
        </AlertDialogHeader>
        {confirmText && (
          <div className="space-y-1.5">
            <label htmlFor={id} className="text-ui font-medium">
              Para confirmar, escribí <code className="rounded-sm bg-muted px-1">{confirmText}</code>
            </label>
            <Input
              id={id}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                // Enter confirma cuando lo escrito ya coincide (como el botón).
                if (e.key !== "Enter" || !ready) return
                e.preventDefault()
                e.currentTarget.closest("[data-slot=alert-dialog-content]")?.querySelector<HTMLButtonElement>("[data-slot=alert-dialog-action]")?.click()
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={!ready}
            onAction={async () => {
              try {
                await onConfirm()
              } catch (err) {
                toast.error(failMessage ?? `No se pudo ${confirmLabel.charAt(0).toLowerCase()}${confirmLabel.slice(1)}`, {
                  description: err instanceof Error ? err.message : String(err),
                })
                throw err
              }
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
