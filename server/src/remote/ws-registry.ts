import type { WebSocket } from "ws"

/** Cuántos websockets abiertos puede tener un dispositivo a la vez. */
export const MAX_SOCKETS_PER_DEVICE = 4

/** Los websockets remotos de cada dispositivo: revocar a uno o cortar el acceso los cierra al instante. */
export class WsRegistry {
  private byDevice = new Map<string, Set<WebSocket>>()

  /** Lo anota; si el dispositivo ya tiene el máximo, lo cierra y devuelve false. */
  add(deviceId: string, ws: WebSocket): boolean {
    const set = this.byDevice.get(deviceId) ?? new Set<WebSocket>()
    if (set.size >= MAX_SOCKETS_PER_DEVICE) {
      ws.close(1013, "demasiadas conexiones")
      return false
    }
    set.add(ws)
    this.byDevice.set(deviceId, set)
    const drop = () => {
      set.delete(ws)
      if (!set.size && this.byDevice.get(deviceId) === set) this.byDevice.delete(deviceId)
    }
    ws.once("close", drop)
    ws.once("error", drop)
    return true
  }

  count(deviceId: string): number {
    return this.byDevice.get(deviceId)?.size ?? 0
  }

  /** Corta los websockets de un dispositivo (terminate: sin esperar el cierre ordenado). */
  closeDevice(deviceId: string) {
    for (const ws of [...(this.byDevice.get(deviceId) ?? [])]) ws.terminate()
    this.byDevice.delete(deviceId)
  }

  closeAll() {
    for (const set of this.byDevice.values()) for (const ws of [...set]) ws.terminate()
    this.byDevice.clear()
  }
}
