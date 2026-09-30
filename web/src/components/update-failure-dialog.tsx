import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useUi } from "@/lib/ui"

/** "Ver log" del toast de una actualización que falló: lo último que dijo el instalador. */
export function UpdateFailureDialog() {
  const failure = useUi((s) => s.updateFailure)
  const set = useUi((s) => s.set)
  return (
    <Dialog open={Boolean(failure)} onOpenChange={(v) => !v && set({ updateFailure: null })}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>No pude actualizar a v{failure?.version}</DialogTitle>
          <DialogDescription>
            {failure?.error} La versión que tenés sigue andando. El log completo está en{" "}
            <span className="font-mono break-all">{failure?.logPath}</span>.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[50svh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {failure?.log || "El log está vacío."}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => set({ updateFailure: null })}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
