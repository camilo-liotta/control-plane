import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { Project } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { afkUntil, endAfk, startAfk } from "@/lib/afk"

type Until = "1h" | "4h" | "tomorrow" | "custom" | "none"

/** Mañana a las 9:00, hora local. */
function tomorrowAt9(now: number): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

/** El valor de un `datetime-local` para una marca de tiempo, en hora local. */
function localInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

/** Vuelve de AFK, con el aviso de siempre. */
export async function comeBackFromAfk(project: Pick<Project, "id" | "name">) {
  try {
    await endAfk(project.id)
    toast.success(`${project.name}: volviste de AFK`)
  } catch (err) {
    toast.error("No se pudo volver de AFK", { description: err instanceof Error ? err.message : String(err) })
  }
}

/** "Ponerse AFK": hasta cuándo, con un tope de gasto opcional. Lo abren la barra lateral, el encabezado, los ajustes y la paleta. */
export function AfkDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [until, setUntil] = useState<Until>("4h")
  const [custom, setCustom] = useState("")
  const [budget, setBudget] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setUntil("4h")
    setCustom(localInput(Date.now() + 2 * 3_600_000))
    setBudget("")
  }, [open])

  const now = Date.now()
  const untilTs = until === "1h" ? now + 3_600_000 : until === "4h" ? now + 4 * 3_600_000 : until === "tomorrow" ? tomorrowAt9(now) : until === "custom" ? new Date(custom).getTime() : null
  const customBad = until === "custom" && !(untilTs !== null && untilTs > now)
  const budgetUsd = budget.trim() === "" ? null : Number(budget.replace(",", "."))
  const budgetBad = budgetUsd !== null && !(budgetUsd > 0)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (customBad || budgetBad) return
    setBusy(true)
    try {
      await startAfk(project.id, { until: untilTs, budgetUsd })
      toast.success(`${project.name} quedó en AFK ${afkUntil(untilTs)}`)
      onOpenChange(false)
    } catch (err) {
      toast.error("No se pudo ponerse AFK", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Ponerse AFK en {project.name}</DialogTitle>
            <DialogDescription>
              La orquestadora envía sus prompts, planes y sesiones nuevas sin esperar tu aprobación. Lo que no se puede
              deshacer lo deja esperando tu vuelta. Cuando vuelvas, vas a ver un resumen de lo que pasó.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="afk-until">Hasta cuándo</FieldLabel>
              <Select value={until} onValueChange={(v) => setUntil(v as Until)}>
                <SelectTrigger id="afk-until" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">1 hora</SelectItem>
                  <SelectItem value="4h">4 horas</SelectItem>
                  <SelectItem value="tomorrow">Hasta mañana a las 9:00</SelectItem>
                  <SelectItem value="custom">Hasta una hora que elija…</SelectItem>
                  <SelectItem value="none">Sin límite de tiempo</SelectItem>
                </SelectContent>
              </Select>
              {until === "custom" && (
                <Input type="datetime-local" value={custom} min={localInput(now)} onChange={(e) => setCustom(e.target.value)} aria-label="Hasta qué día y hora" aria-invalid={customBad} />
              )}
              <FieldDescription>
                {customBad ? "Elegí una hora que no haya pasado." : untilTs === null ? "Dura hasta que vuelvas." : `Dura ${afkUntil(untilTs)}, o menos si volvés.`}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="afk-budget">Tope de gasto (opcional)</FieldLabel>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">US$</span>
                <Input id="afk-budget" inputMode="decimal" placeholder="Sin tope" value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={budgetBad} className="w-32" />
              </div>
              <FieldDescription>
                {budgetBad ? "Poné un monto mayor a cero, o dejalo vacío." : "Si el proyecto gasta esto estando AFK, vuelve a esperar tu aprobación."}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || customBad || budgetBad}>
              {busy && <Spinner />}
              Ponerse AFK
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
