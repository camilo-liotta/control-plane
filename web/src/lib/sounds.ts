import { useSyncExternalStore } from "react"

import type { NoticeEvent } from "@shared/types"

/**
 * Sonidos de la bandeja: uno por tipo de aviso, sintetizados con Web Audio (sin archivos). Son
 * independientes de las notificaciones del sistema y se configuran en este navegador.
 */

export type SoundId = "llamada" | "toc" | "espera" | "duda" | "apagado" | "descenso" | "acorde" | "brillo" | "burbuja" | "arpegio" | "suave" | "ninguno"

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: "llamada", label: "Llamada" },
  { id: "toc", label: "Toc toc" },
  { id: "espera", label: "Espera" },
  { id: "duda", label: "Duda" },
  { id: "apagado", label: "Apagado" },
  { id: "descenso", label: "Descenso" },
  { id: "acorde", label: "Acorde" },
  { id: "brillo", label: "Brillo" },
  { id: "burbuja", label: "Burbuja" },
  { id: "arpegio", label: "Arpegio" },
  { id: "suave", label: "Suave" },
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
  byEvent: { needs_you: "llamada", result: "acorde", blocked: "espera", proposals: "arpegio", compaction: "suave", error: "apagado" },
}

const KEY = "control-plane:sounds"
const listeners = new Set<() => void>()
let current: SoundSettings = read()

function read(): SoundSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SoundSettings> | null
    if (!raw) return DEFAULTS
    // Un sonido que ya no existe (de una versión anterior) vuelve al de por defecto.
    const known = new Set(SOUNDS.map((x) => x.id))
    const byEvent = { ...DEFAULTS.byEvent }
    for (const [event, id] of Object.entries(raw.byEvent ?? {})) if (known.has(id as SoundId)) byEvent[event as NoticeEvent] = id as SoundId
    return { ...DEFAULTS, ...raw, byEvent }
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
function tone(c: AudioContext, out: AudioNode, freq: number, at: number, dur: number, type: OscillatorType = "sine", gain = 1, slideTo?: number, attack = 0.012) {
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, at)
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur)
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(gain, at + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(g).connect(out)
  osc.start(at)
  osc.stop(at + dur + 0.05)
}

/** Madera suave (tipo marimba): la fundamental y un parcial agudo que se apaga rápido. */
function wood(c: AudioContext, out: AudioNode, freq: number, at: number, dur: number, gain = 0.8) {
  tone(c, out, freq, at, dur, "sine", gain, undefined, 0.006)
  tone(c, out, freq * 4, at, dur * 0.25, "sine", gain * 0.12, undefined, 0.004)
}

type Synth = (c: AudioContext, out: AudioNode, t: number) => void

/** Cada sonido y, si corresponde, el filtro que le redondea los agudos. */
const SYNTHS: Record<Exclude<SoundId, "ninguno">, { cutoff?: number; play: Synth }> = {
  llamada: { cutoff: 3200, play: (c, o, t) => (tone(c, o, 587.33, t, 0.5, "sine", 0.7, undefined, 0.03), tone(c, o, 783.99, t + 0.15, 0.7, "sine", 0.7, undefined, 0.03)) },
  toc: { cutoff: 3200, play: (c, o, t) => (wood(c, o, 659.25, t, 0.45), wood(c, o, 880, t + 0.14, 0.6)) },
  espera: { cutoff: 3200, play: (c, o, t) => (tone(c, o, 523.25, t, 1.1, "sine", 0.55, undefined, 0.08), tone(c, o, 622.25, t + 0.02, 1.1, "sine", 0.3, undefined, 0.08)) },
  duda: { cutoff: 3200, play: (c, o, t) => (wood(c, o, 783.99, t, 0.45, 0.75), wood(c, o, 659.25, t + 0.18, 0.7, 0.75)) },
  apagado: { cutoff: 3200, play: (c, o, t) => (tone(c, o, 293.66, t, 0.9, "sine", 0.7, 261.63, 0.04), tone(c, o, 587.33, t, 0.5, "sine", 0.15, 523.25, 0.04)) },
  descenso: {
    cutoff: 3200,
    play: (c, o, t) => (
      tone(c, o, 659.25, t, 0.4, "sine", 0.6, undefined, 0.02),
      tone(c, o, 523.25, t + 0.16, 0.4, "sine", 0.6, undefined, 0.02),
      tone(c, o, 440, t + 0.32, 0.7, "sine", 0.6, undefined, 0.02)
    ),
  },
  acorde: {
    cutoff: 3000,
    play: (c, o, t) => (
      tone(c, o, 392, t, 0.9, "sine", 0.45, undefined, 0.04),
      tone(c, o, 493.88, t + 0.01, 0.9, "sine", 0.4, undefined, 0.04),
      tone(c, o, 587.33, t + 0.02, 0.9, "sine", 0.35, undefined, 0.04)
    ),
  },
  brillo: { cutoff: 3000, play: (c, o, t) => (tone(c, o, 783.99, t, 1.0, "sine", 0.75, undefined, 0.02), tone(c, o, 1567.98, t, 0.5, "sine", 0.12, undefined, 0.02)) },
  burbuja: { cutoff: 3000, play: (c, o, t) => tone(c, o, 520, t, 0.5, "sine", 0.7, 780, 0.02) },
  arpegio: { play: (c, o, t) => (tone(c, o, 523.25, t, 0.28, "sine", 0.8), tone(c, o, 659.25, t + 0.11, 0.28, "sine", 0.8), tone(c, o, 783.99, t + 0.22, 0.45, "sine", 0.8)) },
  suave: { play: (c, o, t) => (tone(c, o, 440, t, 0.7, "sine", 0.6), tone(c, o, 554.37, t + 0.05, 0.7, "sine", 0.35)) },
}

export function playSound(id: SoundId, volume = current.volume) {
  if (id === "ninguno" || volume <= 0) return
  const synth = SYNTHS[id]
  const c = audio()
  if (!c || !synth) return
  const out = c.createGain()
  out.gain.value = 0.35 * volume
  if (synth.cutoff) {
    const lp = c.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = synth.cutoff
    out.connect(lp).connect(c.destination)
  } else out.connect(c.destination)
  synth.play(c, out, c.currentTime + 0.02)
}

/** El sonido de un aviso de la bandeja, según su tipo y tu configuración. */
export function playNotice(event: NoticeEvent) {
  const s = current
  if (!s.enabled) return
  if (s.onlyAway && !(document.hidden || !document.hasFocus())) return
  playSound(s.byEvent[event])
}
