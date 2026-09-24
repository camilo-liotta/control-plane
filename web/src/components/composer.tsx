import { ArrowUp, Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { Session } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

const drafts = new Map<string, string>()

/** Caja para escribirle a una sesión. Si está trabajando, el mensaje se suma al turno en curso. */
export function Composer({ session }: { session: Session }) {
  const [text, setText] = useState(() => drafts.get(session.id) ?? "")
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const busy = session.status === "working" || session.status === "needs_input"
  const stopped = session.status === "stopped" || session.status === "error"

  useEffect(() => {
    setText(drafts.get(session.id) ?? "")
    ref.current?.focus()
  }, [session.id])

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

  const send = async () => {
    const value = text.trim()
    if (!value || sending) return
    setSending(true)
    try {
      await api.send(session.id, value)
      update("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
      ref.current?.focus()
    }
  }

  const interrupt = async () => {
    setStopping(true)
    try {
      await api.interrupt(session.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setStopping(false)
    }
  }

  const hint = stopped
    ? "La sesión está detenida: tu mensaje la reanuda."
    : busy
      ? "Está trabajando: tu mensaje se suma al turno en curso."
      : null

  return (
    <div className="border-t bg-background/95 px-4 pt-3 pb-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            "rounded-2xl border bg-card shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20"
          )}
        >
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => update(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            rows={1}
            placeholder={`Escribile a ${session.name}…`}
            className="block max-h-80 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[0.92rem] leading-relaxed outline-none placeholder:text-muted-foreground/70"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <span className="truncate pl-1.5 text-xs text-muted-foreground">
              {hint ?? (
                <>
                  <Kbd>Enter</Kbd> envía · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> salto de línea
                </>
              )}
            </span>
            {session.queuedMessages > 0 && (
              <span className="shrink-0 font-mono text-[0.7rem] text-status-working">
                {session.queuedMessages} en cola
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {busy && (
                <Button size="sm" variant="outline" onClick={interrupt} disabled={stopping}>
                  {stopping ? <Spinner /> : <Square className="fill-current" />}
                  Interrumpir
                </Button>
              )}
              <Button size="icon-sm" onClick={send} disabled={!text.trim() || sending} aria-label="Enviar">
                {sending ? <Spinner /> : <ArrowUp />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
