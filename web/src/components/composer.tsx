import { ArrowUp, File as FileIcon, Paperclip, RotateCw, Square, TerminalSquare, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { deliver } from "@shared/deliver"
import type { Session, SlashCommand } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { interruptSession } from "@/lib/session-actions"
import { freshFiles, registerDropTarget } from "@/lib/desktop-drop"
import { clipboardImages, formatSize, prepareUpload, shrunkText, VISION_TYPES } from "@/lib/files"
import { inDesktop } from "@/lib/notify"
import { useStore } from "@/lib/store"
import { toneSoft } from "@/lib/status"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

/** El borrador de cada sesión: sobrevive a cambiar de sesión y a recargar la página. */
const DRAFT_KEY = (id: string) => `control-plane:draft:${id}`
const drafts = {
  get(id: string): string {
    try {
      return localStorage.getItem(DRAFT_KEY(id)) ?? ""
    } catch {
      return ""
    }
  },
  set(id: string, value: string) {
    try {
      if (value) localStorage.setItem(DRAFT_KEY(id), value)
      else localStorage.removeItem(DRAFT_KEY(id))
    } catch {
      // sin localStorage: el borrador vive mientras la pestaña esté abierta
    }
  },
}
const commandCache = new Map<string, { at: number; list: SlashCommand[] }>()

interface Pending {
  key: string
  name: string
  mime: string
  size: number
  preview?: string
  status: "uploading" | "ready" | "error"
  id?: string
  error?: string
  /** El archivo original, para reintentar si no se pudo subir. */
  file: File
  /** Si se achicó para subirla, qué se dice. */
  shrunk?: string
}

function useCommands(sessionId: string, active: boolean) {
  const [list, setList] = useState<SlashCommand[]>(() => commandCache.get(sessionId)?.list ?? [])
  useEffect(() => {
    if (!active) return
    const cached = commandCache.get(sessionId)
    if (cached && Date.now() - cached.at < 60_000) {
      setList(cached.list)
      return
    }
    let cancelled = false
    api.commands(sessionId).then(
      (cmds) => {
        commandCache.set(sessionId, { at: Date.now(), list: cmds })
        if (!cancelled) setList(cmds)
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, active])
  return list
}

function rank(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase()
  // Primero los comandos nativos que empiezan igual, después las skills.
  const starts = commands
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)) || a.name.length - b.name.length)
  const contains = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || (q.length > 2 && c.description.toLowerCase().includes(q)))
  )
  return [...starts, ...contains].slice(0, 8)
}

/**
 * Caja para escribirle a una sesión. Si está trabajando, el mensaje se suma al turno en curso.
 * Acepta adjuntos (botón, pegar o arrastrar) y autocompleta los slash commands.
 */
export function Composer({ session, dropTarget }: { session: Session; dropTarget?: React.RefObject<HTMLElement | null> }) {
  const [text, setText] = useState(() => drafts.get(session.id) ?? "")
  const [pending, setPending] = useState<Pending[]>([])
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = session.status === "working" || session.status === "needs_input"
  const stopped = session.status === "stopped" || session.status === "error"

  const query = /^\/([^\s]*)$/.exec(text)?.[1]
  const menuOpen = query !== undefined && dismissed !== text
  const commands = useCommands(session.id, query !== undefined)
  const matches = useMemo(() => (query !== undefined ? rank(commands, query) : []), [commands, query])

  useEffect(() => {
    ref.current?.focus()
  }, [session.id])

  useEffect(() => setHighlight(0), [query])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [text])

  const update = (value: string) => {
    setText(value)
    drafts.set(session.id, value)
  }

  const upload = (key: string, file: File) => {
    let shrunk: string | undefined
    void prepareUpload(file)
      .then(({ name, mime, data, shrunk: s }) => {
        shrunk = s ? shrunkText(s) : undefined
        return api.upload(session.id, { name, mime, data })
      })
      .then(
        (att) => setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "ready", id: att.id, name: att.name, size: att.size, shrunk } : x))),
        (err: Error) => {
          setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "error", error: err.message } : x)))
          toast.error(`No se pudo adjuntar ${file.name || "el archivo"}`, { description: err.message })
        }
      )
  }

  const addFiles = (files: File[]) => {
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const preview = VISION_TYPES.has(file.type) ? URL.createObjectURL(file) : undefined
      setPending((p) => [...p, { key, name: file.name || "pegado", mime: file.type, size: file.size, preview, status: "uploading", file }])
      upload(key, file)
    }
    ref.current?.focus()
  }

  const retry = (key: string) => {
    const item = pending.find((x) => x.key === key)
    if (!item) return
    setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "uploading", error: undefined } : x)))
    upload(key, item.file)
  }

  // Los archivos que la app de escritorio lee cuando se sueltan en la ventana.
  const addRef = useRef(addFiles)
  addRef.current = addFiles
  useEffect(() => registerDropTarget({ add: (files) => addRef.current(files), dragging: setDragging }), [])

  const remove = (key: string) =>
    setPending((p) => {
      const item = p.find((x) => x.key === key)
      if (item?.preview) URL.revokeObjectURL(item.preview)
      return p.filter((x) => x.key !== key)
    })

  // Arrastrar y soltar sobre toda la columna del chat.
  useEffect(() => {
    const el = dropTarget?.current
    if (!el) return
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      addFiles(freshFiles(Array.from(e.dataTransfer?.files ?? []), "page"))
    }
    el.addEventListener("dragenter", enter)
    el.addEventListener("dragover", over)
    el.addEventListener("dragleave", leave)
    el.addEventListener("drop", drop)
    return () => {
      el.removeEventListener("dragenter", enter)
      el.removeEventListener("dragover", over)
      el.removeEventListener("dragleave", leave)
      el.removeEventListener("drop", drop)
    }
  }, [dropTarget, session.id])

  const uploading = pending.some((p) => p.status === "uploading")
  const failed = pending.filter((p) => p.status === "error").length
  const ready = pending.filter((p) => p.status === "ready" && p.id)
  // Un adjunto que no se pudo subir no se descarta en silencio: hay que reintentarlo o quitarlo.
  const canSend = (text.trim().length > 0 || ready.length > 0) && !uploading && !failed && !sending && !(session.external && stopped)

  const send = async () => {
    if (!canSend) return
    // /compact solo abre el panel para elegir qué queda; con instrucciones, va directo a Claude Code.
    if (text.trim() === "/compact" && !pending.length) {
      update("")
      useUi.getState().set({ compactFor: session.id })
      return
    }
    const message = text.trim()
    const attached = pending
    // La caja se limpia al mandar, no cuando vuelve la respuesta: si la sesión tarda en reanudarse,
    // el mensaje no queda ahí como si no hubiera salido.
    update("")
    setPending([])
    setSending(true)
    // Un id por envío: si la respuesta se pierde, el reintento no lo duplica y el eco del WS lo confirma.
    const clientId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const ids = ready.map((p) => p.id!)
    try {
      await deliver({
        send: () => api.send(session.id, message, ids, clientId),
        echoed: () =>
          (useStore.getState().events[session.id] ?? []).some((e) => e.event.kind === "user" && e.event.clientId === clientId),
      })
      for (const p of attached) if (p.preview) URL.revokeObjectURL(p.preview)
    } catch (err) {
      toast.error("No se pudo enviar el mensaje", { description: err instanceof Error ? err.message : String(err) })
      // No salió: vuelve a la caja, salvo que ya hayas empezado a escribir otro.
      if (!drafts.get(session.id)) update(message)
      setPending((current) => (current.length ? current : attached))
    } finally {
      setSending(false)
      ref.current?.focus()
    }
  }

  const accept = (cmd: SlashCommand) => {
    update(`/${cmd.name} `)
    setDismissed(null)
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }

  const interrupt = async () => {
    setStopping(true)
    try {
      await interruptSession(session.id)
    } finally {
      setStopping(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && matches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setHighlight((h) => (h + 1) % matches.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setHighlight((h) => (h - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault()
        accept(matches[highlight] ?? matches[0]!)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setDismissed(text)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const hint = failed
    ? failed === 1
      ? "Un adjunto no se pudo subir: reintentalo o quitalo para enviar."
      : `${failed} adjuntos no se pudieron subir: reintentalos o quitalos para enviar.`
    : stopped
    ? session.external
      ? null
      : "La sesión está detenida: tu mensaje la reanuda."
    : busy
      ? "Está trabajando: tu mensaje se suma al turno en curso."
      : null

  return (
    <div className="bg-background px-4 pt-2 pb-4">
      <div className="relative mx-auto max-w-3xl">
        {session.external && stopped && (
          <div role="note" className={cn("mb-2 flex items-start gap-2 rounded-xl px-3 py-2 text-xs leading-snug", toneSoft.pending, "text-foreground")}>
            <TerminalSquare className="mt-0.5 size-3.5 shrink-0 text-status-pending" />
            <span>
              {session.external.kind === "background" ? (
                <>
                  Esta conversación corre en segundo plano en Claude Code. Detenela con{" "}
                  <code className="font-mono">claude stop {session.external.id ?? ""}</code> para usarla desde acá.
                </>
              ) : (
                <>
                  Esta conversación está abierta en una terminal{session.external.pid ? ` (pid ${session.external.pid})` : ""}. Cerrala con{" "}
                  <code className="font-mono">/exit</code> para usarla desde acá: dos procesos sobre la misma conversación la rompen.
                </>
              )}
            </span>
          </div>
        )}
        {menuOpen && matches.length > 0 && (
          <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl bg-popover shadow-overlay">
            <div className="border-b px-3 py-1.5 text-2xs text-muted-foreground">
              Comandos y skills · <Kbd>↑</Kbd> <Kbd>↓</Kbd> para elegir, <Kbd>Tab</Kbd> para completar
            </div>
            <ul className="max-h-72 overflow-y-auto p-1">
              {matches.map((c, i) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => accept(c)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left",
                      i === highlight && "bg-muted"
                    )}
                  >
                    <span className="shrink-0 font-mono text-ui font-medium">/{c.name}</span>
                    {c.argumentHint && <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.argumentHint}</span>}
                    <span className="min-w-0 truncate text-xs text-muted-foreground" title={c.description}>
                      {c.description}
                    </span>
                    {!c.builtin && <span className="ml-auto shrink-0 text-2xs text-muted-foreground">skill</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div
          className={cn("composer relative bg-card", dragging && "ring-2 ring-status-working-lamp")}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-card/90 text-sm font-medium text-status-working">
              Soltá los archivos para adjuntarlos
            </div>
          )}
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {pending.map((p) => (
                <div
                  key={p.key}
                  className={cn(
                    "flex items-center gap-2 rounded-xl bg-muted/60 text-xs",
                    p.preview ? "py-1 pr-1 pl-1" : "py-1 pr-1 pl-2.5",
                    p.status === "error" && "ring-1 ring-status-error-lamp"
                  )}
                >
                  {p.preview ? (
                    <button
                      type="button"
                      onClick={() => useUi.getState().set({ lightbox: p.id ? { id: p.id, name: p.name } : { name: p.name, src: p.preview } })}
                      className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label={`Ver ${p.name}`}
                    >
                      <img src={p.preview} alt={p.name} className="size-11 rounded-lg object-cover" />
                    </button>
                  ) : (
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex max-w-40 min-w-0 flex-col">
                    <span className="truncate font-medium" title={p.name}>
                      {p.name}
                    </span>
                    <span className={cn("truncate", p.status === "error" ? "text-status-error" : "text-muted-foreground")} title={p.error ?? p.shrunk}>
                      {p.status === "uploading" ? "Subiendo…" : p.status === "error" ? "No se pudo subir" : p.shrunk ? `${formatSize(p.size)} · achicada` : formatSize(p.size)}
                    </span>
                  </span>
                  {p.status === "uploading" && <Spinner className="size-3.5 text-muted-foreground" />}
                  {p.status === "error" && (
                    <Button size="icon-sm" variant="ghost" onClick={() => retry(p.key)} aria-label={`Reintentar ${p.name}`} title="Reintentar">
                      <RotateCw />
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => remove(p.key)}
                    className="text-muted-foreground"
                    aria-label={`Quitar ${p.name}`}
                    title="Quitar"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => update(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files)
              if (files.length) {
                e.preventDefault()
                addFiles(files)
                return
              }
              // En la app de escritorio en Linux (WebKitGTK) el evento no trae las imágenes: se leen aparte.
              if (inDesktop() && !e.clipboardData.types.includes("text/plain")) {
                void clipboardImages().then((images) => images.length && addFiles(images))
              }
            }}
            rows={1}
            placeholder={`Escribile a ${session.name}… (/ para comandos)`}
            aria-label={`Mensaje para ${session.name}`}
            className="block max-h-80 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []))
                e.target.value = ""
              }}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => fileInput.current?.click()}
              aria-label="Adjuntar archivos"
              title="Adjuntar archivos o imágenes (también podés pegarlos o arrastrarlos)"
            >
              <Paperclip />
            </Button>
            <span className={cn("min-w-0 truncate text-xs", failed ? "text-status-error" : "text-muted-foreground")} title={hint ?? undefined}>
              {hint ?? (
                <>
                  <Kbd>Enter</Kbd> envía · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> salto de línea
                </>
              )}
            </span>
            {session.queuedMessages > 0 && (
              <span className="shrink-0 text-2xs font-medium text-status-pending">{session.queuedMessages} en cola</span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {busy && (
                <Button size="sm" variant="outline" onClick={interrupt} disabled={stopping}>
                  {stopping ? <Spinner /> : <Square className="fill-current" />}
                  Interrumpir
                </Button>
              )}
              <Button size="icon-sm" onClick={send} disabled={!canSend} aria-label="Enviar">
                {sending ? <Spinner /> : <ArrowUp />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
