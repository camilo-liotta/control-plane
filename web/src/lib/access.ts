import { create } from "zustand"

import { canDo, type Capability } from "@shared/remote-access"
import type { RemoteCapabilities } from "@shared/types"

import { ApiError, api, setUnpairedHandler } from "@/lib/api"

/**
 * Desde dónde se entra y qué se puede hacer: desde esta máquina (todo) o desde otro dispositivo de la
 * tailnet (según su nivel). Es solo ayuda de uso: ocultar un control no protege nada, el server decide.
 */
interface AccessState {
  /** null hasta que se sabe (la app espera antes de conectarse). */
  caps: RemoteCapabilities | null
  /** Desde esta máquina: si el acceso remoto está activo y cuántos dispositivos hay (para el aviso). */
  local: { active: boolean; devices: number } | null
  /** Sube cada vez que el server avisa que cambió el acceso remoto (los diálogos se vuelven a leer). */
  tick: number
  load: () => Promise<void>
  /** El server dijo que este dispositivo no está vinculado: vuelve la pantalla de vinculación. */
  unpair: () => void
  refreshLocal: () => Promise<void>
  changed: () => void
}

const RETRY_MS = 1500

export const useAccess = create<AccessState>((set, get) => ({
  caps: null,
  local: null,
  tick: 0,
  load: async () => {
    for (;;) {
      try {
        const caps = await api.remoteCapabilities()
        const prev = get().caps
        if (!prev || JSON.stringify(prev) !== JSON.stringify(caps))
          set({ caps })
        if (caps.mode === "local") void get().refreshLocal()
        return
      } catch (err) {
        // Un server de otra versión no tiene la ruta: es el de esta máquina, sin acceso remoto.
        if (err instanceof ApiError && err.status === 404) {
          set({ caps: { mode: "local" } })
          return
        }
        // Sin respuesta: el server puede estar arrancando; se reintenta (la pantalla de espera sigue).
        if (get().caps) return
        await new Promise((r) => setTimeout(r, RETRY_MS))
      }
    }
  },
  unpair: () => {
    const { caps } = get()
    // Desde esta máquina un 401 no existe; si llegara, no se toca nada.
    if (!caps || caps.mode === "local" || caps.paired === false) return
    set({ caps: { mode: caps.mode, paired: false } })
  },
  refreshLocal: async () => {
    if (get().caps?.mode !== "local") return
    try {
      const [status, devices] = await Promise.all([
        api.remoteStatus(),
        api.remoteDevices(),
      ])
      set({ local: { active: status.active, devices: devices.length } })
    } catch {
      // el aviso es un extra: si no se pudo leer, queda como estaba
    }
  },
  changed: () => {
    set((s) => ({ tick: s.tick + 1 }))
    void get().refreshLocal()
  },
}))

setUnpairedHandler(() => useAccess.getState().unpair())

/** Si el modo actual permite la capacidad (`manage` es solo de esta máquina). Ver `canDo`. */
export const useCan = (cap: Capability) => useAccess((s) => canDo(s.caps, cap))

/** Desde otro dispositivo de la tailnet (no desde esta máquina ni sin saber todavía). */
export const useIsRemote = () =>
  useAccess((s) => s.caps !== null && s.caps.mode !== "local")
