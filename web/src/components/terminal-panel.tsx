import "@xterm/xterm/css/xterm.css"

import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { ChevronDown, LockKeyhole, RotateCcw, SquareTerminal, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { pasteText } from "@shared/command-values"
import type { Session } from "@shared/types"

import { Button } from "@/components/ui/button"
import { ConfirmAction } from "@/components/ui/confirm-action"
import { Shortcut } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { api } from "@/lib/api"
import { isNotFound, STALE_SERVER } from "@/lib/server-version"
import { toneSoft } from "@/lib/status"
import { useTerminal } from "@/lib/terminal"
import { cn } from "@/lib/utils"

type Status = "connecting" | "open" | "exited" | "error"

/**
 * Un color de los tokens (que están en oklch) como rgb, que es lo que entiende xterm. El canvas
 * hace la conversión: anda igual en el navegador, en WebKitGTK y en WKWebView.
 */
function tokenColor(name: string, alpha = 1): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!ctx || !value) return alpha < 1 ? `rgba(128,128,128,${alpha})` : "#808080"
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgba(${r},${g},${b},${alpha})`
}

/** Los colores de la terminal salen de los del tema (claro u oscuro): fondo de tarjeta y texto. */
function themeColors() {
  return {
    background: tokenColor("--card"),
    foreground: tokenColor("--foreground"),
    cursor: tokenColor("--foreground"),
    cursorAccent: tokenColor("--card"),
    selectionBackground: tokenColor("--status-working", 0.28),
  }
}

const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--ff-mono").trim() || "ui-monospace, monospace"

const MIN_HEIGHT = 160
/** Lo mínimo que le queda al chat cuando agrandás la terminal. */
const MIN_CHAT = 200

/**
 * La terminal de la sesión, al pie de la vista. La shell corre en el server (en la carpeta de la
 * sesión) y sigue viva al cambiar de sesión o recargar: al volver, se ve lo último que mostró.
 * `embedded`: adentro de otra cosa (la hoja de "Llevar a la terminal" desde el tablero), sin
 * tirador ni "esconder", y abierta siempre.
 */
export function TerminalPanel({ session, embedded = false, onClose }: { session: Session; embedded?: boolean; onClose?: () => void }) {
  const open = useTerminal((s) => !!s.open[session.id]) || embedded
  const setOpen = useTerminal((s) => s.setOpen)
  const height = useTerminal((s) => s.height)
  const setHeight = useTerminal((s) => s.setHeight)
  const section = useRef<HTMLElement>(null)
  const [confirmClose, setConfirmClose] = useState<string[] | null>(null)
  const pending = useTerminal((s) =>
    s.pending?.sessionId === session.id ? s.pending.at : null
  )
  const host = useRef<HTMLDivElement>(null)
  /** Pega lo pendiente de "Llevar a la terminal" (cuando hay una terminal conectada). */
  const pastePending = useRef<() => void>(() => {})
  const [status, setStatus] = useState<Status>("connecting")
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  /** Lo que tipeás no se muestra (una contraseña o un secreto): lo avisa el server. */
  const [secure, setSecure] = useState(false)
  /** El candado junto al cursor, mientras la entrada está oculta. */
  const cursorLock = useRef<HTMLDivElement>(null)
  const placeLock = useRef<() => void>(() => {})

  useEffect(() => {
    if (!open || !host.current) return
    const t = new Terminal({
      fontFamily: monoFont(),
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeColors(),
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(host.current)
    fit.fit()
    // La fuente puede llegar después de abrir: xterm vuelve a medir las celdas al cambiarla.
    void document.fonts?.load(`13px ${monoFont()}`).then(() => {
      if (disposed) return
      t.options.fontFamily = monoFont()
      fit.fit()
    })
    // Sigue el tema: al pasar de claro a oscuro (o al revés), cambian los colores.
    const themeWatch = new MutationObserver(() => {
      t.options.theme = themeColors()
    })
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
    setStatus("connecting")
    setError(null)
    setSecure(false)

    let ws: WebSocket | null = null
    let disposed = false
    const send = (msg: unknown) =>
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg))

    void api
      .openTerminal(session.id, t.cols, t.rows)
      .then(({ token }) => {
        if (disposed) return
        const proto = location.protocol === "https:" ? "wss" : "ws"
        ws = new WebSocket(
          `${proto}://${location.host}/ws/terminal?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(token)}`
        )
        ws.onopen = () => {
          setStatus("open")
          send({ t: "r", c: t.cols, r: t.rows })
          pastePending.current()
          t.focus()
        }
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as
            | { t: "o"; d: string }
            | { t: "x"; code: number | null }
            | { t: "secure"; on: boolean }
          if (msg.t === "o") {
            lastOutput = Date.now()
            t.write(msg.d)
          } else if (msg.t === "secure") setSecure(msg.on)
          else {
            setSecure(false)
            setStatus("exited")
          }
        }
        ws.onclose = (ev) => {
          if (disposed) return
          setSecure(false)
          // 4403: la cerraron (desde otra pestaña o se venció). No es una falla.
          if (ev.code === 4403) {
            setError("La terminal se cerró.")
            setStatus("exited")
            return
          }
          setStatus((s) => (s === "exited" ? s : "error"))
        }
      })
      .catch((err: Error) => {
        setError(isNotFound(err) ? STALE_SERVER : err.message)
        setStatus("error")
      })

    // Copiar y pegar, como en las terminales de Linux (Ctrl+C y Ctrl+V son de la shell):
    // - Ctrl+Shift+C copia la selección (en Chrome, además, abriría las herramientas).
    // - Ctrl+Shift+V y Shift+Insert no los toma xterm: los hace el navegador o el webview, con un
    //   pegado de verdad que xterm recibe como evento paste (leer el portapapeles desde JS no está
    //   permitido en la app). En la Mac, ⌘C y ⌘V ya andan.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.altKey || e.metaKey) return true
      const key = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && key === "c") {
        const selected = t.getSelection()
        if (selected) void navigator.clipboard.writeText(selected).catch(() => {})
        e.preventDefault()
        return false
      }
      if ((e.ctrlKey && e.shiftKey && key === "v") || (e.shiftKey && !e.ctrlKey && e.key === "Insert")) return false
      return true
    })
    // Un archivo soltado sobre la terminal no se escribe en la shell: va al composer (la columna
    // del chat lo recibe) o se ignora.
    const noDrop = (e: DragEvent) => e.preventDefault()
    host.current.addEventListener("dragover", noDrop, true)
    host.current.addEventListener("drop", noDrop, true)
    const hostEl = host.current

    // El candado va justo después del cursor, como en Ghostty. xterm no dice cuánto mide una
    // celda, pero la pantalla mide cols × rows celdas.
    placeLock.current = () => {
      const lock = cursorLock.current
      const screen = hostEl.querySelector<HTMLElement>(".xterm-screen")
      if (!lock || !screen) return
      const at = screen.getBoundingClientRect()
      const box = lock.parentElement!.getBoundingClientRect()
      const w = at.width / t.cols
      const h = at.height / t.rows
      const c = t.buffer.active
      lock.style.left = `${at.left - box.left + Math.min(c.cursorX + 1, t.cols - 1) * w}px`
      lock.style.top = `${at.top - box.top + c.cursorY * h}px`
      lock.style.height = `${h}px`
    }
    const moved = t.onCursorMove(() => placeLock.current())
    const rendered = t.onResize(() => placeLock.current())

    // Lo que tipeás (y lo que se pega) va a la shell; xterm ya lo manda como bracketed paste si
    // la shell lo pidió, así un comando de varias líneas no se ejecuta solo.
    const input = t.onData((d) => send({ t: "i", d }))
    const ro = new ResizeObserver(() => {
      fit.fit()
      send({ t: "r", c: t.cols, r: t.rows })
    })
    ro.observe(host.current)
    // Se pega recién cuando la shell ya mostró su prompt y se quedó quieta: antes, lo pegado lo
    // lee la terminal sin la shell lista y un salto de línea se ejecuta.
    let lastOutput = 0
    let waiting = 0
    pastePending.current = () => {
      window.clearTimeout(waiting)
      const tryPaste = (tries: number) => {
        const quiet = lastOutput > 0 && Date.now() - lastOutput > 350
        if (!quiet && tries < 40) {
          waiting = window.setTimeout(() => tryPaste(tries + 1), 150)
          return
        }
        const text = useTerminal.getState().take(session.id)
        if (!text) return
        t.paste(pasteText(text, t.modes.bracketedPasteMode))
        t.focus()
      }
      tryPaste(0)
    }

    return () => {
      disposed = true
      themeWatch.disconnect()
      input.dispose()
      moved.dispose()
      rendered.dispose()
      placeLock.current = () => {}
      ro.disconnect()
      hostEl.removeEventListener("dragover", noDrop, true)
      hostEl.removeEventListener("drop", noDrop, true)
      ws?.close()
      window.clearTimeout(waiting)
      pastePending.current = () => {}
      t.dispose()
    }
  }, [open, session.id, generation])

  useEffect(() => {
    if (secure) placeLock.current()
  }, [secure])

  // "Llevar a la terminal" con el panel ya abierto y conectado.
  useEffect(() => {
    if (pending && status === "open") pastePending.current()
  }, [pending, status])

  if (!open) return null

  const restart = async () => {
    await api.closeTerminal(session.id).catch(() => {})
    setGeneration((g) => g + 1)
  }

  const close = async () => {
    try {
      await api.closeTerminal(session.id)
    } catch (err) {
      toast.error("No se pudo cerrar la terminal", { description: err instanceof Error ? err.message : String(err) })
      return
    }
    setOpen(session.id, false)
    onClose?.()
  }

  // Si corre algo adentro (un servidor, un build), cerrarla lo corta: se pregunta antes.
  const askClose = async () => {
    const running = status === "open" ? await api.terminalStatus(session.id).then((s) => s.running, () => []) : []
    if (running.length) setConfirmClose(running)
    else await close()
  }

  // El tirador: el alto se cambia arrastrando o con las flechas, y se recuerda.
  const maxHeight = () => Math.max(MIN_HEIGHT, (section.current?.parentElement?.clientHeight ?? 800) - MIN_CHAT)
  const clampHeight = (px: number) => Math.min(maxHeight(), Math.max(MIN_HEIGHT, px))
  const current = () => section.current?.getBoundingClientRect().height ?? MIN_HEIGHT
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = current()
    const move = (ev: PointerEvent) => {
      if (section.current) section.current.style.height = `${clampHeight(startH + startY - ev.clientY)}px`
    }
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", up)
      handle.removeEventListener("pointercancel", up)
      setHeight(clampHeight(startH + startY - ev.clientY))
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", up)
    handle.addEventListener("pointercancel", up)
  }
  const keyResize = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 96 : 32
    if (e.key === "ArrowUp") setHeight(clampHeight(current() + step))
    else if (e.key === "ArrowDown") setHeight(clampHeight(current() - step))
    else return
    e.preventDefault()
  }

  const names = confirmClose ? [...new Set(confirmClose)] : []

  return (
    <section
      ref={section}
      data-terminal=""
      className={cn("relative flex shrink-0 flex-col bg-card", embedded ? "h-full" : "min-h-40 border-t", !embedded && !height && "h-[40%]")}
      style={!embedded && height ? { height: `min(${height}px, calc(100% - ${MIN_CHAT}px))` } : undefined}
      aria-label="Terminal"
    >
      {!embedded && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Alto de la terminal"
          aria-valuemin={MIN_HEIGHT}
          aria-valuenow={Math.round(height ?? 0) || undefined}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={keyResize}
          onDoubleClick={() => setHeight(clampHeight((section.current?.parentElement?.clientHeight ?? 800) * 0.4))}
          title="Arrastrá para cambiar el alto (o usá ↑ y ↓; doble clic lo vuelve al de siempre)"
          className="group/handle absolute inset-x-0 -top-1.5 z-10 flex h-3 cursor-row-resize touch-none items-center justify-center outline-none"
        >
          <span className="h-1 w-10 rounded-full bg-border transition-colors group-hover/handle:bg-ring group-focus-visible/handle:bg-ring" />
        </div>
      )}
      <header className="flex min-w-0 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
        <SquareTerminal className="size-3.5 shrink-0" />
        {!embedded && <span className="shrink-0 font-medium text-foreground">Terminal</span>}
        <span className="min-w-0 truncate font-mono" title={session.cwd}>
          {session.cwd}
        </span>
        <span className={cn("ml-1 shrink-0", status === "error" && "text-status-error")}>
          {status === "connecting"
            ? "Conectando…"
            : status === "exited"
              ? (error ?? "La shell terminó")
              : status === "error"
                ? (error ?? "Sin conexión")
                : ""}
        </span>
        {secure && (
          <span
            data-terminal-secure=""
            role="status"
            className={cn("flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium", toneSoft.attention, "text-foreground")}
          >
            <LockKeyhole className="size-3.5 shrink-0 text-status-attention" />
            <span className="truncate">
              Escribiendo sin mostrar: pegá o escribí el valor y apretá Enter
            </span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {(status === "exited" || status === "error") && (
            <Button size="sm" variant="ghost" onClick={() => void restart()}>
              <RotateCcw />
              Abrir otra
            </Button>
          )}
          {!embedded && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" onClick={() => setOpen(session.id, false)} aria-label="Esconder la terminal (sigue abierta)">
                  <ChevronDown />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Esconder: sigue abierta <Shortcut keys="ctrl+backtick" />
              </TooltipContent>
            </Tooltip>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void askClose()}
            aria-label="Cerrar la terminal"
            title="Cerrar: corta la shell y lo que esté corriendo"
          >
            <X />
          </Button>
        </span>
      </header>
      <ConfirmAction
        open={confirmClose !== null}
        onOpenChange={(v) => !v && setConfirmClose(null)}
        title="¿Cerrar la terminal?"
        description={
          <p>
            Adentro corre <span className="font-mono text-foreground">{names.slice(0, 3).join(", ")}</span>
            {names.length > 3 ? ` y ${names.length - 3} más` : ""}. Al cerrarla se corta la shell y todo lo que lanzó. Si solo querés
            sacarla de la vista, escondela: sigue corriendo.
          </p>
        }
        confirmLabel="Cerrar y cortar"
        cancelLabel="Dejarla abierta"
        onConfirm={close}
      />
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="h-full px-2 py-1" />
        {secure && (
          <div
            ref={cursorLock}
            aria-hidden
            className="pointer-events-none absolute flex items-center px-1"
          >
            <LockKeyhole className="size-3.5 text-status-attention" />
          </div>
        )}
      </div>
    </section>
  )
}
