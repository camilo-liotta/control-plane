import type { EngramState } from "./types.ts"

export const ENGRAM_ABOUT =
  "Engram es una memoria persistente para las sesiones de Claude Code: guarda decisiones, bugs y contexto entre sesiones y compactaciones, y todo queda en tu máquina (~/.engram/engram.db)."

export const ENGRAM_LABEL: Record<EngramState, string> = {
  ready: "Engram listo",
  "no-binary": "Engram: falta el programa",
  partial: "Engram a medio instalar",
  missing: "Sin Engram",
}

export const canInstallEngram = (state: EngramState) => state !== "ready"

/** Resumen de Engram entre cuentas: cuántas lo tienen listo. */
export function summarizeEngram(states: EngramState[]) {
  const ready = states.filter((s) => s === "ready").length
  return { ready, total: states.length, allReady: states.length > 0 && ready === states.length }
}
