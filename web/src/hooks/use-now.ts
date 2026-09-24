import { useEffect, useState } from "react"

/** Fecha actual que se refresca sola (para "hace 2 min" y cuentas regresivas). */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
