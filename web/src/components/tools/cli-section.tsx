import { Check, Copy, Download, ExternalLink, KeyRound, LogIn, RefreshCw, Search, Square, TerminalSquare } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { CliCredential, CliInfo, CliJob, CliView } from "@shared/types"

import { TonePill } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import type { Tone } from "@/lib/status"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const STATE: Record<CliCredential["state"], { label: string; tone: Tone }> = {
  ok: { label: "Logueado", tone: "done" },
  expired: { label: "Vencido", tone: "attention" },
  logged_out: { label: "Sin login", tone: "idle" },
  unknown: { label: "No se sabe", tone: "idle" },
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success("Copiado"),
    () => toast.error("No pude copiar")
  )
}

/**
 * Los CLIs de la máquina, como un marketplace: los instalados con su login (y el botón para
 * loguearte o reautenticarte) y el catálogo para instalar. Son de tu usuario del sistema: los usan
 * todas las cuentas y todos los proyectos.
 */
export function CliSection() {
  const [view, setView] = useState<CliView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [q, setQ] = useState("")
  const tick = useStore((s) => s.clisTick)

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    try {
      setView(await api.clis(refresh))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Un login o una instalación avanzó: se relee (con un poco de espera, llegan varios avisos juntos).
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => void load(), 400)
    return () => clearTimeout(t)
  }, [tick, load])

  const jobFor = (id: string) => view?.jobs.filter((j) => j.cliId === id).at(-1)
  const installed = view?.clis.filter((c) => c.installed) ?? []
  const available = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (view?.clis ?? [])
      .filter((c) => !c.installed)
      .filter((c) => !needle || `${c.name} ${c.id} ${c.description} ${c.category}`.toLowerCase().includes(needle))
      .sort((a, b) => b.wanted - a.wanted)
  }, [view, q])
  const pending = installed.filter((c) => c.credentials.some((k) => k.state === "expired" || k.state === "logged_out")).length

  if (error) {
    return (
      <div className="rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-sm">
        <p className="font-medium">No pude leer los CLIs</p>
        <p className="text-muted-foreground">{error}</p>
      </div>
    )
  }
  if (!view) {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Buscando los CLIs y chequeando sus logins…
        </p>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">
          Los CLIs de esta máquina: los usan todas las cuentas y todos los proyectos, y las sesiones los consultan con list_clis.
          {pending > 0 && <span className="text-status-attention"> {pending === 1 ? "Uno necesita" : `${pending} necesitan`} login.</span>}
        </span>
        <span className="text-xs">revisado {timeAgo(view.at)}</span>
        <Button size="sm" variant="ghost" onClick={() => void load(true)} disabled={refreshing}>
          {refreshing ? <Spinner /> : <RefreshCw />}
          Volver a revisar
        </Button>
      </div>

      <section>
        <h3 className="eyebrow mb-2">Instalados {installed.length}</h3>
        <ul className="divide-y rounded-xl border bg-card">
          {installed.map((c) => (
            <InstalledCli key={c.id} cli={c} job={jobFor(c.id)} />
          ))}
          {!installed.length && <li className="px-4 py-3 text-sm text-muted-foreground">No encontré ninguno del catálogo.</li>}
        </ul>
      </section>

      <section>
        <h3 className="eyebrow mb-1">Usados por tus sesiones {view.used.length || ""}</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Otros programas que corrieron tus sesiones en los últimos 30 días y no están en el catálogo. Sin login desde acá: no sé cómo se chequea.
          {view.usageScanning && " Leyendo los transcripts…"}
        </p>
        {view.used.length > 0 ? (
          <ul className="divide-y rounded-xl border bg-card">
            {view.used.map((u) => (
              <li key={u.name} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                <span className="font-mono font-medium">{u.name}</span>
                <span className="min-w-0 truncate font-mono text-[0.7rem] text-muted-foreground">{u.path}</span>
                <span className="text-xs text-muted-foreground" title={u.projects.join(", ")}>
                  en {u.projects.length === 1 ? u.projects[0] : `${u.projects.length} proyectos`}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {u.count.toLocaleString("es-AR")} {u.count === 1 ? "vez" : "veces"} · {timeAgo(u.lastAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          !view.usageScanning && <p className="text-sm text-muted-foreground">Nada fuera del catálogo.</p>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-3">
          <h3 className="eyebrow">Para instalar {available.length}</h3>
          <div className="relative ml-auto w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar un CLI…" className="h-8 pl-8 text-sm" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((c) => (
            <AvailableCli key={c.id} cli={c} job={jobFor(c.id)} />
          ))}
        </div>
      </section>
    </div>
  )
}

function InstalledCli({ cli, job }: { cli: CliInfo; job?: CliJob }) {
  const [starting, setStarting] = useState<number | null>(null)
  const login = async (k: CliCredential) => {
    setStarting(k.index)
    try {
      await api.cliLogin(cli.id, k.index)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(null)
    }
  }
  const busy = job?.status === "running"
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{cli.name}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {cli.id}
          {cli.version ? ` ${cli.version}` : ""}
        </span>
        <span className="text-xs text-muted-foreground">· {cli.description}</span>
        {cli.usage && (
          <span className="ml-auto text-[0.7rem] text-muted-foreground" title={`Última vez: ${timeAgo(cli.usage.lastAt)}`}>
            tus sesiones lo usaron {cli.usage.count.toLocaleString("es-AR")} {cli.usage.count === 1 ? "vez" : "veces"}
          </span>
        )}
      </div>
      {cli.credentials.map((k) => (
        <div key={k.index} className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {k.label && <span className="text-muted-foreground">{k.label}</span>}
          <TonePill tone={STATE[k.state].tone}>{STATE[k.state].label}</TonePill>
          {k.account && <span className="font-mono text-xs">{k.account}</span>}
          {k.detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{k.detail}</span>}
          {k.state !== "ok" && k.terminalLogin && (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-[0.7rem] hover:bg-muted/70"
              title="El login pide pegar una credencial: corrélo en una terminal"
              onClick={() => copy(k.terminalLogin!)}
            >
              <Copy className="size-3" />
              {k.terminalLogin}
            </button>
          )}
          {k.state !== "ok" && !k.terminalLogin && (
            <Button
              size="xs"
              variant={k.state === "expired" ? "default" : "outline"}
              className="ml-auto"
              disabled={busy || starting !== null}
              onClick={() => void login(k)}
            >
              {starting === k.index ? <Spinner /> : k.state === "expired" ? <KeyRound /> : <LogIn />}
              {k.state === "expired" ? "Reautenticar" : "Iniciar sesión"}
            </Button>
          )}
        </div>
      ))}
      {job && <JobPanel job={job} />}
    </li>
  )
}

function AvailableCli({ cli, job }: { cli: CliInfo; job?: CliJob }) {
  const [starting, setStarting] = useState(false)
  const install = async () => {
    setStarting(true)
    try {
      await api.cliInstall(cli.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }
  return (
    <div className="flex flex-col rounded-xl border bg-card p-3">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{cli.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{cli.id}</span>
        <span className="ml-auto text-[0.7rem] text-muted-foreground">{cli.category}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{cli.description}</p>
      {cli.wanted > 0 && (
        <p className="mt-1 text-[0.7rem] font-medium text-status-attention">
          Tus sesiones lo quisieron usar {cli.wanted === 1 ? "una vez" : `${cli.wanted} veces`} y no estaba instalado.
        </p>
      )}
      {cli.install ? (
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[0.7rem]" title={cli.install.command}>
            {cli.install.command}
          </code>
          {cli.install.runnable ? (
            <Button size="xs" onClick={() => void install()} disabled={starting || job?.status === "running"}>
              {starting ? <Spinner /> : <Download />}
              Instalar
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={() => copy(cli.install!.command)} title="Pide sudo: corrélo en una terminal">
              <Copy />
              Copiar
            </Button>
          )}
        </div>
      ) : (
        <a href={cli.docs} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-3" /> Cómo instalarlo
        </a>
      )}
      {cli.install && !cli.install.runnable && <p className="mt-1 text-[0.7rem] text-muted-foreground">Pide sudo: copialo y corrélo en una terminal.</p>}
      {job && <JobPanel job={job} />}
    </div>
  )
}

/** Un login o una instalación en curso: links, el código si hay, lo que imprime y para contestarle. */
function JobPanel({ job }: { job: CliJob }) {
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
