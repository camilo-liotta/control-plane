import type { WebSocket } from "ws"

import type { ServerMessage } from "./shared/types.ts"

/** Difunde los cambios a todas las pestañas abiertas del dashboard. */
export class Hub {
  private clients = new Set<WebSocket>()

  add(ws: WebSocket, hello: ServerMessage) {
    this.clients.add(ws)
    ws.on("close", () => this.clients.delete(ws))
    ws.on("error", () => this.clients.delete(ws))
    ws.send(JSON.stringify(hello))
  }

  broadcast(msg: ServerMessage) {
    if (!this.clients.size) return
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  get size() {
    return this.clients.size
  }
}
