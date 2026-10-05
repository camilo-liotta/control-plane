import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { retryUpdate } from "@/lib/notify"
import { useUi } from "@/lib/ui"

async function copyLog(log: string) {
  try {
    await navigator.clipboard.writeText(log)
    toast.success("Log copiado")
  } catch {
    toast.error("No se pudo copiar el log")
  }
}

/** "Ver log" del toast de una actualización que falló: lo último que dijo el instalador. */
export function UpdateFailureDialog() {
  const failure = useUi((s) => s.updateFailure)
  const set = useUi((s) => s.set)
  const close = () => set({ updateFailure: null })
  return (
    <Dialog open={Boolean(failure)} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>No se pudo actualizar a v{failure?.version}</DialogTitle>
          <DialogDescription>
            {failure?.error} La versión que tenés sigue andando. El log completo está en{" "}
            <span className="font-mono break-all">{failure?.logPath}</span>.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[50svh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {failure?.log || "El log está vacío."}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cerrar
          </Button>
          <Button variant="outline" disabled={!failure?.log} onClick={() => failure && void copyLog(failure.log)}>
            Copiar log
          </Button>
          {failure?.retryUrl && (
            <Button
              onClick={() => {
                retryUpdate(failure)
                close()
              }}
            >
              Reintentar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
