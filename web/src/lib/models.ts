import type { ModelOption, ProjectSettings, SessionKind } from "@shared/types"

/** Los esfuerzos que conoce el CLI, de menor a mayor. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

const EFFORT_NAMES: Record<string, string> = { low: "bajo", medium: "medio", high: "alto", xhigh: "muy alto", max: "máximo" }

/** "medio", "muy alto"… (o el valor tal cual, si es uno que todavía no conocemos). */
export function effortName(effort: string): string {
  return EFFORT_NAMES[effort] ?? effort
}

/** "esfuerzo medio", para las pastillas. */
export function effortLabel(effort: string): string {
  return `esfuerzo ${effortName(effort)}`
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

/** Los modelos principales del catálogo (los alias: opus, sonnet, haiku, fable), para elegir rápido. */
export function mainModels(models: ModelOption[]): ModelOption[] {
  return models.filter((m) => m.value !== "default" && !m.value.startsWith("claude-"))
}

/** Los esfuerzos que soporta un modelo del catálogo (los cinco si no se sabe; ninguno si no soporta). */
export function effortsFor(models: ModelOption[], model: string | null): string[] {
  const m = model ? findModel(models, model) : models.find((x) => x.value === "default")
  return m ? (m.efforts ?? []) : EFFORTS
}

/** Nombre legible del modelo que está usando una sesión (el CLI informa el id completo). */
export function modelLabel(models: ModelOption[], current: string | null, configured: string | null): string {
  const byCurrent = current ? findModel(models, current) : undefined
  if (byCurrent) return cleanLabel(byCurrent.label)
  const byValue = configured ? models.find((m) => m.value === configured) : undefined
  if (byValue) return cleanLabel(byValue.label)
  if (current) return bareId(current).replace(/^claude-/, "")
  if (configured) return configured
  return "Modelo por defecto"
}

/**
 * Modelo y esfuerzo con los que arranca una sesión sin los suyos: la orquestadora usa los del proyecto
 * y las sesiones, los de sesiones (o los de la orquestadora si no tienen). null = el de tu configuración.
 */
export function projectDefaults(settings: ProjectSettings, kind: SessionKind) {
  if (kind === "orchestrator") return { model: settings.defaultModel, effort: settings.defaultEffort }
  return {
    model: settings.workerModel ?? settings.defaultModel,
    effort: settings.workerEffort ?? settings.defaultEffort,
  }
}

/**
 * Lo gastado por modelo (US$ por id resuelto), con el nombre de cada uno y de mayor a menor. Los ids
 * que son el mismo modelo (con y sin "[1m]" o la fecha) se juntan.
 */
export function costsByModel(models: ModelOption[], byModel: Record<string, number> | { model: string; usd: number }[]) {
  const list = Array.isArray(byModel) ? byModel : Object.entries(byModel).map(([model, usd]) => ({ model, usd }))
  const out = new Map<string, number>()
  for (const { model, usd } of list) {
    if (!(usd > 0)) continue
    const name = modelName(models, model)
    out.set(name, (out.get(name) ?? 0) + usd)
  }
  return [...out].map(([name, usd]) => ({ name, usd })).sort((a, b) => b.usd - a.usd)
}
