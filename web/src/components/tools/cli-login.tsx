import { Check, Copy, ExternalLink, KeyRound, LogIn, Square, TerminalSquare } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { CliCredential, CliJob, CliView } from "@shared/types"

import { TonePill } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import type { Tone } from "@/lib/status"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/**
 * Lo del login de un CLI que se usa en Herramientas → CLIs y en las tareas para vos que piden
 * loguear uno: el estado de la credencial, el botón y el panel del login en curso.
 */

export const STATE: Record<CliCredential["state"], { label: string; tone: Tone }> = {
  ok: { label: "Logueado", tone: "done" },
  expired: { label: "Vencido", tone: "attention" },
  logged_out: { label: "Sin login", tone: "idle" },
  unknown: { label: "No se sabe", tone: "idle" },
}

export function copy(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success("Copiado"),
    () => toast.error("No pude copiar")
  )
}

/** La vista de los CLIs, compartida entre los que la piden y releída cuando un login avanza. */
let shared: { view: CliView | null; loading: Promise<CliView> | null } = { view: null, loading: null }
const listeners = new Set<(v: CliView) => void>()
function loadClis(): Promise<CliView> {
  shared.loading ??= api
    .clis()
    .then((view) => {
      shared = { view, loading: null }
      for (const l of listeners) l(view)
      return view
    })
    .catch((err: unknown) => {
      shared.loading = null
      throw err
    })
  return shared.loading
}

export function useCliView(): CliView | null {
  const [view, setView] = useState(shared.view)
  const tick = useStore((s) => s.clisTick)
  useEffect(() => {
    listeners.add(setView)
    return () => void listeners.delete(setView)
  }, [])
  // Un login avanzó (llegan varios avisos juntos): se relee con un poco de espera.
  const first = useRef(true)
  useEffect(() => {
    const t = setTimeout(() => void loadClis().catch(() => {}), first.current && !shared.view ? 0 : 400)
    first.current = false
    return () => clearTimeout(t)
  }, [tick])
  return view
}

/** El botón de login de una credencial: "Reautenticar" si venció, "Iniciar sesión" si no tiene. */
export function LoginButton({
  state,
  disabled,
  starting,
  onClick,
  label,
  className,
}: {
  state: CliCredential["state"]
  disabled: boolean
  /** Este botón arrancó el login y todavía no contestó el server. */
  starting: boolean
  onClick: () => void
  label?: string
  className?: string
}) {
  const expired = state === "expired" || state === "ok"
  return (
    <Button size="xs" variant={state === "expired" ? "default" : "outline"} className={className} disabled={disabled} onClick={onClick}>
      {starting ? <Spinner /> : expired ? <KeyRound /> : <LogIn />}
      {label ?? (state === "expired" ? "Reautenticar" : "Iniciar sesión")}
    </Button>
  )
}

export function CredentialState({ credential }: { credential: CliCredential }) {
  return (
    <>
      <TonePill tone={STATE[credential.state].tone}>{STATE[credential.state].label}</TonePill>
      {credential.account && <span className="font-mono text-xs">{credential.account}</span>}
    </>
  )
}

export function TerminalLoginButton({ command, className }: { command: string; className?: string }) {
  return (
    <button
      type="button"
      className={cn("inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-[0.7rem] hover:bg-muted/70", className)}
      title="El login pide pegar una credencial: corrélo en una terminal"
      onClick={() => copy(command)}
    >
      <Copy className="size-3" />
      {command}
    </button>
  )
}

/** Un login o una instalación en curso: links, el código si hay, lo que imprime y para contestarle. */
export function JobPanel({ job }: { job: CliJob }) {
  const [answer, setAnswer] = useState("")
  const [open, setOpen] = useState(job.status !== "done")
  const running = job.status === "running"
  const send = async () => {
    try {
      await api.cliAnswer(job.id, answer)
      setAnswer("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  const head = running
    ? job.kind === "login"
      ? "Terminá el login en el navegador…"
      : "Instalando…"
    : job.status === "done"
      ? job.kind === "login"
        ? "Login terminado"
        : "Instalado"
      : `Terminó con error${job.exitCode !== null ? ` (código ${job.exitCode})` : ""}`
  return (
    <div className={cn("mt-3 rounded-lg border p-3 text-sm", running ? "border-claude/40 bg-claude/5" : job.status === "failed" ? "border-status-error/30" : "")}>
      <div className="flex items-center gap-2">
        {running ? <Spinner className="size-3.5" /> : job.status === "done" ? <Check className="size-3.5 text-status-done" /> : <TerminalSquare className="size-3.5 text-status-error" />}
        <span className="font-medium">{head}</span>
        <code className="min-w-0 truncate font-mono text-[0.7rem] text-muted-foreground">{job.command}</code>
        {running ? (
          <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => void api.cliCancel(job.id)}>
            <Square />
            Cancelar
          </Button>
        ) : (
          <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)}>
            {open ? "Ocultar" : "Ver salida"}
          </button>
        )}
      </div>
      {running && job.code && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Código:</span>
          <code className="rounded bg-muted px-2 py-0.5 font-mono text-base font-semibold tracking-widest">{job.code}</code>
          <Button size="xs" variant="outline" onClick={() => copy(job.code!)}>
            <Copy />
            Copiar
          </Button>
        </div>
      )}
      {running && job.urls.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {job.urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-xs text-claude hover:underline">
              <ExternalLink className="size-3 shrink-0" />
              <span className="truncate">{u}</span>
            </a>
          ))}
        </div>
      )}
      {open && job.output.trim() && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[0.7rem] whitespace-pre-wrap">{job.output.trim()}</pre>
      )}
      {running && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <Input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Si pregunta algo (Y/n, una opción), contestale acá" className="h-8 text-xs" />
          <Button size="xs" variant="outline" type="submit">
            Enviar
          </Button>
        </form>
      )}
    </div>
  )
}
