import { SquareTerminal } from "lucide-react"
import { createContext, useContext, useState } from "react"
import { useLocation } from "wouter"

import {
  commandValues,
  fillCommand,
  type CommandValue,
} from "@shared/command-values"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { rememberedValues, rememberValues, useTerminal } from "@/lib/terminal"
import { cn } from "@/lib/utils"

/** A qué terminal van los comandos de lo que se muestra adentro (la de una sesión). */
export interface TerminalTarget {
  sessionId: string
  projectId: string
}

const TargetContext = createContext<TerminalTarget | null>(null)
export const TerminalTargetProvider = TargetContext.Provider
export const useTerminalTarget = () => useContext(TargetContext)

/**
 * "Llevar a la terminal": pega el comando en la terminal de la sesión, sin Enter (lo revisás y lo
 * corrés vos). Si tiene valores para completar ({{NOMBRE: descripción}}), antes los pide.
 */
export function TakeToTerminal({
  command,
  className,
  compact,
}: {
  command: string
  className?: string
  compact?: boolean
}) {
  const target = useTerminalTarget()
  const send = useTerminal((s) => s.send)
  const [location, navigate] = useLocation()
  const [asking, setAsking] = useState<CommandValue[] | null>(null)
  if (!target) return null

  const deliver = (text: string) => {
    send(target.sessionId, text)
    const page = `/p/${target.projectId}/s/${target.sessionId}`
    if (location !== page) navigate(page)
  }
  const start = () => {
    const values = commandValues(command)
    if (values.length) setAsking(values)
    else deliver(command)
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        aria-label="Llevar a la terminal"
        title="Llevar a la terminal (se pega sin Enter)"
        className={cn(
          "inline-flex items-center gap-1 rounded-md border bg-background text-muted-foreground hover:text-foreground",
          compact ? "p-0.5 align-middle" : "p-1",
          className
        )}
      >
        <SquareTerminal className={compact ? "size-3" : "size-3.5"} />
      </button>
      {asking && (
        <ValuesDialog
          values={asking}
          projectId={target.projectId}
          command={command}
          onCancel={() => setAsking(null)}
          onDone={(filled) => {
            setAsking(null)
            deliver(filled)
          }}
        />
      )}
    </>
  )
}

function ValuesDialog({
  values,
  projectId,
  command,
  onCancel,
  onDone,
}: {
  values: CommandValue[]
  projectId: string
  command: string
  onCancel: () => void
  onDone: (text: string) => void
}) {
  const [form, setForm] = useState<Record<string, string>>(() => {
    const known = rememberedValues(projectId)
    return Object.fromEntries(
      values.map((v) => [v.name, known[v.name] ?? v.suggested ?? ""])
    )
  })
  const ready = values.every((v) => form[v.name]!.trim() !== "")
  const preview = fillCommand(command, form)
  const submit = () => {
    if (!ready) return
    rememberValues(projectId, form)
    onDone(preview)
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Completá el comando</DialogTitle>
          <DialogDescription>
            Se pega en la terminal sin Enter: revisalo y correlo vos.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {values.map((v, i) => (
            <div key={v.name} className="space-y-1">
              <Label htmlFor={`val-${v.name}`} className="font-mono text-xs">
                {v.name}
              </Label>
              <Input
                id={`val-${v.name}`}
                autoFocus={i === 0}
                value={form[v.name]}
                placeholder={v.suggested ?? ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, [v.name]: e.target.value }))
                }
              />
              {v.description && (
                <p className="text-xs text-muted-foreground">{v.description}</p>
              )}
            </div>
          ))}
          <pre className="max-h-40 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
            {preview}
          </pre>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!ready}>
              Llevar a la terminal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
