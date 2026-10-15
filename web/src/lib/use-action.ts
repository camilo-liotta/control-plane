import { useCallback, useRef, useState } from "react"

/**
 * Una acción que pega al server desde un botón: mientras está pendiente, `busy` es true (para
 * deshabilitarlo) y otro clic no hace nada, así un doble clic no manda dos pedidos.
 * Cada `key` es independiente (por ejemplo "start" y "stop" en el mismo menú).
 */
export function useAction() {
  const pending = useRef(new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const run = useCallback((key: string, fn: () => Promise<unknown>): Promise<void> => {
    if (pending.current.has(key)) return Promise.resolve()
    pending.current.add(key)
    setBusy(new Set(pending.current))
    return fn()
      .then(() => {}, () => {})
      .finally(() => {
        pending.current.delete(key)
        setBusy(new Set(pending.current))
      })
  }, [])
  return { run, busy: (key?: string) => (key ? busy.has(key) : busy.size > 0) }
}
