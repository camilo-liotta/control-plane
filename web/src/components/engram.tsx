import { Brain } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { canInstallEngram, ENGRAM_ABOUT, ENGRAM_LABEL, summarizeEngram } from "@shared/engram"
import type { Account } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { shortPath } from "@/lib/format"
import { useAccounts } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Estado de Engram en la cuenta, qué es (salvo `about={false}`), y el botón para instalarlo (solo si no está listo). */
export function EngramLine({ account, about = true, bordered = true }: { account: Account; about?: boolean; bordered?: boolean }) {
  const [busy, setBusy] = useState(false)
  const { state, binaryHint } = account.engram

  const install = async () => {
    setBusy(true)
    try {
      const r = await api.installEngram(account.id)
      if ("needsConfirm" in r) {
        toast.warning("Engram pide correr un comando para instalarse", { description: "Instalalo desde la pestaña Plugins: ahí te muestra el comando antes." })
      } else {
        toast.success(r.message)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn(bordered && "mt-2 border-t pt-2")}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{ENGRAM_LABEL[state]}</span>
        {canInstallEngram(state) && (
          <Button size="xs" variant="outline" onClick={install} disabled={busy}>
            {busy && <Spinner />}
            Instalar Engram
          </Button>
        )}
      </div>
      {about && <p className="mt-1 text-xs text-muted-foreground">{ENGRAM_ABOUT}</p>}
      {binaryHint && (
        <p className="mt-1 text-xs text-muted-foreground">
          Falta el programa: <code className="font-mono break-all">{binaryHint.command}</code> o bajalo de{" "}
          <a href={binaryHint.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            GitHub
          </a>
          .
        </p>
      )}
    </div>
  )
}

/** Tarjeta del home: qué es Engram y en cuántas cuentas está listo. "Ver estado" abre el detalle de todas. */
export function EngramCard() {
  const accounts = useAccounts()
  const [open, setOpen] = useState(false)
  const { ready, total, allReady } = summarizeEngram(accounts.map((a) => a.engram.state))
  if (!total) return null
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 shadow-xs sm:col-span-2 xl:col-span-3">
      <Brain className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 basis-72">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Memoria con Engram</span>
          <span
            className={cn(
              "rounded-full px-2 font-condensed text-[0.72rem] font-semibold",
              allReady ? "bg-status-done/15 text-status-done" : "bg-status-attention/15 text-status-attention"
            )}
          >
            {ready} de {total} {total === 1 ? "cuenta" : "cuentas"} con Engram listo
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{ENGRAM_ABOUT}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Ver estado
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] overflow-x-hidden overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Engram en tus cuentas</DialogTitle>
            <DialogDescription>{ENGRAM_ABOUT}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="rounded-lg border p-3">
                <div className="font-medium">{a.name}</div>
                <p className="truncate font-mono text-[0.72rem] text-muted-foreground" title={a.configDir}>
                  {shortPath(a.configDir)}
                </p>
                <div className="mt-1.5">
                  <EngramLine account={a} about={false} bordered={false} />
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  )
}
