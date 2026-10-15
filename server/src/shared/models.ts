import type { ModelOption, ProjectSettings, SessionKind } from "./types.ts"

/** Los esfuerzos que conoce el CLI, de menor a mayor. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

/** Los alias de los modelos principales: valen aunque el catálogo todavía no haya llegado. */
export const MODEL_ALIASES = ["haiku", "sonnet", "opus", "fable"]

const EFFORT_NAMES: Record<string, string> = { low: "bajo", medium: "medio", high: "alto", xhigh: "muy alto", max: "máximo" }

/** "medio", "muy alto"… (o el valor tal cual, si es uno que todavía no conocemos). */
export function effortName(effort: string): string {
  return EFFORT_NAMES[effort] ?? effort
}

/** El id sin "[1m]" ni la fecha del final: claude-haiku-4-5-20251001[1m] → claude-haiku-4-5. */
const bareId = (id: string) => id.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "")

const cleanLabel = (label: string) => label.replace(/ \(.*\)$/, "")

/** El modelo del catálogo por su valor (sonnet, opus…) o por su id resuelto (claude-sonnet-5-5[1m]). */
export function findModel(models: ModelOption[], valueOrId: string | null): ModelOption | undefined {
  if (!valueOrId) return undefined
  const bare = bareId(valueOrId)
  return (
    models.find((m) => m.value === valueOrId && m.value !== "default") ??
    models.find((m) => m.value !== "default" && m.resolved && bareId(m.resolved) === bare) ??
    models.find((m) => m.value !== "default" && bareId(m.value) === bare)
  )
}

/** "Sonnet 5.5" para un valor del catálogo o un id resuelto; si no está, el id sin "claude-". */
export function modelName(models: ModelOption[], valueOrId: string): string {
  const m = findModel(models, valueOrId)
  return m ? cleanLabel(m.label) : bareId(valueOrId).replace(/^claude-/, "")
}

/** "Sonnet 5.5 · esfuerzo medio", "esfuerzo alto" o "Opus 5.5". */
export function choiceLabel(models: ModelOption[], model: string | null, effort: string | null): string {
  return [model ? modelName(models, model) : null, effort ? `esfuerzo ${effortName(effort)}` : null].filter(Boolean).join(" · ")
}

/** Los modelos que se pueden pedir, en una línea, para los errores. */
function optionsLine(models: ModelOption[]): string {
  const list = models.filter((m) => m.value !== "default")
  if (!list.length) return MODEL_ALIASES.join(", ")
  return list.map((m) => `${m.value} (${cleanLabel(m.label)}${m.efforts?.length ? `: ${m.efforts.join(", ")}` : ", sin esfuerzo"})`).join("; ")
}

/**
 * Valida el modelo y el esfuerzo que pide una propuesta contra el catálogo de Claude Code. Devuelve el
 * modelo como lo conoce el catálogo (el alias o el valor) y el esfuerzo. `base` es el modelo con que
 * sigue la sesión si la propuesta no cambia el modelo: contra él se valida el esfuerzo.
 * Sin catálogo (todavía no arrancó ninguna sesión) valen los alias y los esfuerzos conocidos.
 */
export function checkModelChoice(
  models: ModelOption[],
  model: string | null | undefined,
  effort: string | null | undefined,
  base: string | null
): { model: string | null; effort: string | null } {
  const wanted = model?.trim() || null
  const level = effort?.trim().toLowerCase() || null
  let option: ModelOption | undefined
  let value: string | null = null
  if (wanted) {
    if (wanted === "default") throw new Error(`"default" no es un modelo para una propuesta. Modelos: ${optionsLine(models)}.`)
    option = findModel(models, wanted)
    if (option) value = option.value
    else if (!models.length && MODEL_ALIASES.includes(wanted)) value = wanted
    else throw new Error(`No existe el modelo "${wanted}". Modelos: ${optionsLine(models)}.`)
  }
  if (level) {
    if (!EFFORTS.includes(level)) throw new Error(`El esfuerzo "${level}" no existe. Esfuerzos: ${EFFORTS.join(", ")}.`)
    const target = option ?? (value ? undefined : base ? findModel(models, base) : models.find((m) => m.value === "default"))
    if (target?.efforts && !target.efforts.includes(level)) {
      throw new Error(
        target.efforts.length
          ? `${cleanLabel(target.label)} no tiene esfuerzo "${level}". Esfuerzos: ${target.efforts.join(", ")}.`
          : `${cleanLabel(target.label)} no tiene niveles de esfuerzo: sacá effort o elegí otro modelo. Modelos: ${optionsLine(models)}.`
      )
    }
  }
  return { model: value, effort: level }
}

/** Con qué modelo y esfuerzo corre una sesión: los suyos o, si no tiene, los de los workers (solo workers) o los del proyecto. */
export function sessionChoice(
  settings: Pick<ProjectSettings, "defaultModel" | "defaultEffort" | "workerModel" | "workerEffort"> | undefined,
  s: { kind: SessionKind; model: string | null; effort: string | null }
): { model: string | null; effort: string | null } {
  const worker = s.kind === "worker"
  return {
    model: s.model ?? (worker ? settings?.workerModel : null) ?? settings?.defaultModel ?? null,
    effort: s.effort ?? (worker ? settings?.workerEffort : null) ?? settings?.defaultEffort ?? null,
  }
}
