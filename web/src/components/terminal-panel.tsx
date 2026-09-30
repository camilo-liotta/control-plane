import "@xterm/xterm/css/xterm.css"

import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { ChevronDown, LockKeyhole, RotateCcw, SquareTerminal, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { pasteText } from "@shared/command-values"
import type { Session } from "@shared/types"

import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { isNotFound, STALE_SERVER } from "@/lib/server-version"
import { useTerminal } from "@/lib/terminal"
import { cn } from "@/lib/utils"

type Status = "connecting" | "open" | "exited" | "error"

const THEMES = {
  dark: {
    background: "#0b0d10",
    foreground: "#e6e6e6",
    cursor: "#e6e6e6",
    selectionBackground: "#3a4150",
  },
  light: {
    background: "#fbfbfa",
    foreground: "#1f2328",
    cursor: "#1f2328",
    selectionBackground: "#cfd6e0",
  },
}

/**
 * La terminal de la sesión, al pie de la vista. La shell corre en el server (en la carpeta de la
 * sesión) y sigue viva al cambiar de sesión o recargar: al volver, se ve lo último que mostró.
 */
export function TerminalPanel({ session }: { session: Session }) {
  const open = useTerminal((s) => !!s.open[session.id])
  const setOpen = useTerminal((s) => s.setOpen)
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
    const dark = document.documentElement.classList.contains("dark")
    const t = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: dark ? THEMES.dark : THEMES.light,
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(host.current)
    fit.fit()
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
          if (ev.code === 4403) setError("La terminal se cerró.")
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

  return (
    <section
      data-terminal=""
      className="flex h-[40%] min-h-48 shrink-0 flex-col border-t bg-card"
      aria-label="Terminal"
    >
      <header className="flex items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
        <SquareTerminal className="size-3.5" />
        <span className="font-medium text-foreground">Terminal</span>
        <span className="truncate font-mono" title={session.cwd}>
          {session.cwd}
        </span>
        <span className={cn("ml-1", status === "error" && "text-status-error")}>
          {status === "connecting"
            ? "conectando…"
            : status === "exited"
              ? "la shell terminó"
              : status === "error"
                ? (error ?? "sin conexión")
                : ""}
        </span>
        {secure && (
          <span
            data-terminal-secure=""
            role="status"
            className="flex min-w-0 items-center gap-1 rounded-sm bg-status-attention/15 px-1.5 py-0.5 font-medium text-foreground"
          >
            <LockKeyhole className="size-3.5 shrink-0 text-status-attention" />
            <span className="truncate">
              Escribiendo sin mostrar: pegá o escribí el valor y apretá Enter
            </span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {(status === "exited" || status === "error") && (
            <Button size="xs" variant="ghost" onClick={() => void restart()}>
              <RotateCcw />
              Abrir otra
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setOpen(session.id, false)}
            aria-label="Esconder la terminal (sigue abierta)"
            title="Esconder (Ctrl+`): sigue abierta"
          >
            <ChevronDown />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => {
              void api.closeTerminal(session.id)
              setOpen(session.id, false)
            }}
            aria-label="Cerrar la terminal"
            title="Cerrar: corta la shell y lo que esté corriendo"
          >
            <X />
          </Button>
        </span>
      </header>
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
