import type { ServerMessage } from "@shared/types"

import { useAccess } from "./access"
import { useStore } from "./store"

/** Conexión en vivo con el server; se reconecta sola si se corta. */
export function connect() {
  let attempt = 0
  let socket: WebSocket | null = null
  let stopped = false

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws"
    socket = new WebSocket(`${proto}://${location.host}/ws`)
    socket.onopen = () => {
      attempt = 0
      useStore.getState().setConnected(true)
    }
    socket.onmessage = (ev) => {
      try {
        useStore.getState().apply(JSON.parse(String(ev.data)) as ServerMessage)
      } catch (err) {
        console.error("Mensaje inválido del server", err)
      }
    }
    socket.onclose = () => {
      useStore.getState().setConnected(false)
      if (stopped) return
      // Desde otro dispositivo, un corte puede ser que lo revocaron: se vuelve a mirar si sigue vinculado.
      if (useAccess.getState().caps?.mode !== "local") void useAccess.getState().load()
      const delay = Math.min(10_000, 500 * 2 ** attempt++)
      setTimeout(open, delay)
    }
  }

  open()
  return () => {
    stopped = true
    socket?.close()
  }
}
