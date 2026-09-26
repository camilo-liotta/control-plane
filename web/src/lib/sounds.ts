import { useSyncExternalStore } from "react"

import type { NoticeEvent } from "@shared/types"

/**
 * Sonidos de la bandeja: uno por tipo de aviso, sintetizados con Web Audio (sin archivos). Son
 * independientes de las notificaciones del sistema y se configuran en este navegador.
 */

export type SoundId = "campana" | "gota" | "sube" | "arpegio" | "alerta" | "suave" | "grave" | "ninguno"

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: "campana", label: "Campana" },
  { id: "gota", label: "Gota" },
  { id: "sube", label: "Dos notas" },
  { id: "arpegio", label: "Arpegio" },
  { id: "alerta", label: "Alerta" },
  { id: "suave", label: "Suave" },
  { id: "grave", label: "Grave" },
  { id: "ninguno", label: "Sin sonido" },
]

export const EVENTS: { id: NoticeEvent; label: string; hint: string }[] = [
  { id: "needs_you", label: "Te necesita", hint: "Una pregunta de Claude o un permiso" },
  { id: "result", label: "Resultado", hint: "Un worker terminó y reportó" },
  { id: "blocked", label: "Bloqueado", hint: "Un worker quedó trabado y pide una decisión" },
  { id: "proposals", label: "Propuestas listas", hint: "La orquestadora terminó de revisar" },
  { id: "compaction", label: "Compactación", hint: "El contexto se llena o espera tu elección" },
  { id: "error", label: "Error", hint: "Algo falló" },
]

export interface SoundSettings {
  enabled: boolean
  volume: number
  /** Solo si no estás mirando el dashboard (otra pestaña, otra app). */
  onlyAway: boolean
  byEvent: Record<NoticeEvent, SoundId>
}

const DEFAULTS: SoundSettings = {
  enabled: true,
  volume: 0.6,
  onlyAway: false,
  byEvent: { needs_you: "sube", result: "campana", blocked: "alerta", proposals: "arpegio", compaction: "suave", error: "grave" },
}

const KEY = "control-plane:sounds"
const listeners = new Set<() => void>()
let current: SoundSettings = read()

function read(): SoundSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SoundSettings> | null
    return raw ? { ...DEFAULTS, ...raw, byEvent: { ...DEFAULTS.byEvent, ...(raw.byEvent ?? {}) } } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

export function setSoundSettings(patch: Partial<Omit<SoundSettings, "byEvent">> & { byEvent?: Partial<Record<NoticeEvent, SoundId>> }) {
  current = { ...current, ...patch, byEvent: { ...current.byEvent, ...(patch.byEvent ?? {}) } }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // sin almacenamiento local: vale solo hasta recargar
  }
  for (const l of listeners) l()
}

export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}

// ---------------------------------------------------------------- audio

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null
  ctx ??= new AudioContext()
  if (ctx.state === "suspended") void ctx.resume().catch(() => {})
  return ctx
}

// El navegador no deja sonar nada hasta que tocás la página: con el primer toque queda habilitado.
if (typeof window !== "undefined") {
  const unlock = () => {
    audio()
    window.removeEventListener("pointerdown", unlock)
    window.removeEventListener("keydown", unlock)
  }
  window.addEventListener("pointerdown", unlock)
  window.addEventListener("keydown", unlock)
}

/** Una nota: frecuencia, cuándo empieza, cuánto dura y con qué forma de onda. */
function tone(c: AudioContext, out: AudioNode, freq: number, at: number, dur: number, type: OscillatorType = "sine", gain = 1, slideTo?: number) {
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, at)
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur)
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(g).connect(out)
  osc.start(at)
  osc.stop(at + dur + 0.05)
}

export function playSound(id: SoundId, volume = current.volume) {
  if (id === "ninguno" || volume <= 0) return
  const c = audio()
  if (!c) return
  const out = c.createGain()
  out.gain.value = 0.35 * volume
  out.connect(c.destination)
  const t = c.currentTime + 0.02
  switch (id) {
    case "campana":
      tone(c, out, 880, t, 1.2, "sine", 0.9)
      tone(c, out, 1760, t, 0.6, "sine", 0.25)
      tone(c, out, 2640, t, 0.3, "sine", 0.1)
      break
    case "gota":
      tone(c, out, 1400, t, 0.18, "sine", 0.9, 500)
      break
    case "sube":
      tone(c, out, 660, t, 0.22, "triangle", 0.9)
      tone(c, out, 990, t + 0.16, 0.35, "triangle", 0.9)
      break
    case "arpegio":
      tone(c, out, 523.25, t, 0.28, "sine", 0.8)
      tone(c, out, 659.25, t + 0.11, 0.28, "sine", 0.8)
      tone(c, out, 783.99, t + 0.22, 0.45, "sine", 0.8)
      break
    case "alerta":
      tone(c, out, 740, t, 0.12, "square", 0.35)
      tone(c, out, 740, t + 0.18, 0.12, "square", 0.35)
      tone(c, out, 740, t + 0.36, 0.2, "square", 0.35)
      break
    case "suave":
      tone(c, out, 440, t, 0.7, "sine", 0.6)
      tone(c, out, 554.37, t + 0.05, 0.7, "sine", 0.35)
      break
    case "grave":
      tone(c, out, 196, t, 0.35, "sawtooth", 0.35, 147)
      tone(c, out, 147, t + 0.3, 0.45, "sawtooth", 0.3)
      break
  }
}

/** El sonido de un aviso de la bandeja, según su tipo y tu configuración. */
export function playNotice(event: NoticeEvent) {
  const s = current
  if (!s.enabled) return
  if (s.onlyAway && !(document.hidden || !document.hasFocus())) return
  playSound(s.byEvent[event])
}
