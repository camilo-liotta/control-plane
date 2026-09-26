import type { WebSocket } from "ws"

import type { DesktopSummary, ServerMessage } from "./shared/types.ts"

/** "web": las pestañas del dashboard. "desktop": la app de escritorio (bandeja y notificaciones). */
export type ClientKind = "web" | "desktop"

/** Cambios que mueven el resumen de la bandeja. */
const SUMMARY_TRIGGERS = new Set<ServerMessage["type"]>(["session", "draft", "project"])
/** Lo único que le llega a la app de escritorio de lo que se difunde. */
const DESKTOP_TYPES = new Set<ServerMessage["type"]>(["toast"])
const SUMMARY_DEBOUNCE_MS = 300

/** Difunde los cambios a todas las pestañas abiertas del dashboard y a la app de escritorio. */
export class Hub {
  private clients = new Map<WebSocket, ClientKind>()
  private summarize: (() => DesktopSummary) | null = null
  private summaryTimer: NodeJS.Timeout | null = null
  private desktopConnected = false

  /** Cómo se calcula el resumen de la bandeja (se define después de armar las sesiones). */
  setSummary(fn: () => DesktopSummary) {
    this.summarize = fn
  }

  add(ws: WebSocket, hello: () => ServerMessage, kind: ClientKind = "web") {
    this.clients.set(ws, kind)
    const drop = () => {
      if (this.clients.delete(ws)) this.syncDesktop()
    }
    ws.on("close", drop)
    ws.on("error", drop)
    if (kind === "desktop") {
      const summary = this.summaryMessage()
      if (summary) ws.send(summary)
    } else {
      ws.send(JSON.stringify(hello()))
      ws.send(JSON.stringify({ type: "desktop", connected: this.desktopConnected } satisfies ServerMessage))
    }
    this.syncDesktop()
  }

  broadcast(msg: ServerMessage) {
    if (SUMMARY_TRIGGERS.has(msg.type)) this.scheduleSummary()
    if (!this.clients.size) return
    const data = JSON.stringify(msg)
    const toDesktop = DESKTOP_TYPES.has(msg.type)
    for (const [ws, kind] of this.clients) {
      if (kind === "desktop" && !toDesktop) continue
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  get size() {
    return this.clients.size
  }

  dispose() {
    if (this.summaryTimer) clearTimeout(this.summaryTimer)
    this.summaryTimer = null
  }

  private send(kind: ClientKind, data: string) {
    for (const [ws, k] of this.clients) {
      if (k === kind && ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  private summaryMessage(): string | null {
    if (!this.summarize) return null
    try {
      return JSON.stringify({ type: "desktop_summary", summary: this.summarize() } satisfies ServerMessage)
    } catch {
      // la base se está cerrando: el próximo cambio lo vuelve a intentar
      return null
    }
  }

  /**
   * Junta los cambios de ~300 ms en un solo resumen. No se reinicia con cada cambio (una sesión
   * trabajando cambia seguido) y se calcula al vencer, así incluye el último.
   */
  private scheduleSummary() {
    if (this.summaryTimer || !this.desktopConnected) return
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null
      const data = this.summaryMessage()
      if (data) this.send("desktop", data)
    }, SUMMARY_DEBOUNCE_MS)
    this.summaryTimer.unref()
  }

  /** Avisa a la web cuando se conecta la primera app de escritorio o se va la última. */
  private syncDesktop() {
    const connected = [...this.clients.values()].includes("desktop")
    if (connected === this.desktopConnected) return
    this.desktopConnected = connected
    this.send("web", JSON.stringify({ type: "desktop", connected } satisfies ServerMessage))
  }
}
