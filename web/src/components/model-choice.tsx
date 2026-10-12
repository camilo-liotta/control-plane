import { ChevronDown, Cpu } from "lucide-react"

import type { ModelOption, Session } from "@shared/types"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { effortLabel, effortName, effortsFor, findModel, mainModels, modelLabel, modelName, projectDefaults } from "@/lib/models"
import { useModels, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const KEEP = "__keep"

function defaultName(models: ModelOption[]): string | null {
  const d = models.find((m) => m.value === "default")
  return d?.resolved ? modelName(models, d.resolved) : null
}

/**
 * El nombre del modelo que usa hoy una sesión ("Opus 5.5"), o con el que arrancaría una sesión nueva
 * del proyecto si no se pasa `session`.
 */
export function useSessionModelName(projectId: string, session?: Session | null): string {
  const models = useModels()
  const settings = useStore((s) => s.projects[projectId]?.settings)
  const fromProject = settings ? projectDefaults(settings, session?.kind ?? "worker").model : null
  const configured = session?.model ?? fromProject
  const current = session?.currentModel ?? null
  if (!current && !configured) return defaultName(models) ?? "el modelo por defecto"
  return modelLabel(models, current, configured)
}

/**
 * "Sonnet 5.5 · esfuerzo medio", o "Sigue con Opus 5.5" si no cambia el modelo (en una sesión nueva,
 * "Opus 5.5, el del proyecto").
 */
export function modelSummary(models: ModelOption[], model: string | null, effort: string | null, fallback: string, newSession = false): string {
  const name = model ? modelName(models, model) : newSession ? `${fallback}, el del proyecto` : `Sigue con ${fallback}`
  return effort ? `${name} · ${effortLabel(effort)}` : name
}

/**
 * La pastilla del modelo y el esfuerzo de una propuesta o de un paso. Con `onChange` se puede cambiar
 * antes de aprobar: los modelos principales del catálogo y los esfuerzos que soporta el elegido.
 */
export function ModelPill({
  model,
  effort,
  fallback,
  newSession = false,
  fallbackModel = null,
  onChange,
  disabled = false,
  className,
}: {
  model: string | null
  effort: string | null
  /** Con qué modelo sigue la sesión si `model` es null ("Opus 5.5"). */
  fallback: string
  /** Es para una sesión que todavía no existe: sin modelo, arranca con el del proyecto. */
  newSession?: boolean
  /** El id o valor del modelo con que sigue la sesión, para ofrecer sus esfuerzos si no se elige otro. */
  fallbackModel?: string | null
  onChange?: (next: { model: string | null; effort: string | null }) => void
  disabled?: boolean
  className?: string
}) {
  const models = useModels()
  const text = modelSummary(models, model, effort, fallback, newSession)
  const pill = "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"

  if (!onChange) {
    return (
      <span className={cn(pill, className)} title={`Modelo: ${text}`}>
        <Cpu className="size-3 shrink-0" />
        <span className="truncate">{text}</span>
      </span>
    )
  }

  const main = mainModels(models)
  // Si la orquestadora pidió un id que no es de los principales, que se vea igual entre las opciones.
  const extra = model && !main.some((m) => m.value === model) ? (findModel(models, model) ?? { value: model, label: model }) : null
  const options = extra ? [...main, extra] : main
  const efforts = effortsFor(models, model ?? fallbackModel)

  const pickModel = (v: string) => {
    const next = v === KEEP ? null : v
    // Si el esfuerzo elegido no lo soporta el modelo nuevo, vuelve al de la sesión.
    const keepEffort = effort && effortsFor(models, next ?? fallbackModel).includes(effort) ? effort : null
    onChange({ model: next, effort: keepEffort })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          pill,
          "transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60",
          className
        )}
        aria-label={`Modelo: ${text}. Cambiar modelo y esfuerzo`}
        title="Cambiar modelo y esfuerzo"
      >
        <Cpu className="size-3 shrink-0" />
        <span className="truncate">{text}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-56">
        <DropdownMenuLabel>Modelo</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={model ?? KEEP} onValueChange={pickModel}>
          <DropdownMenuRadioItem value={KEEP}>{newSession ? `El del proyecto (${fallback})` : `Seguir con ${fallback}`}</DropdownMenuRadioItem>
          {options.map((m) => (
            <DropdownMenuRadioItem key={m.value} value={m.value}>
              {modelName(models, m.value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Esfuerzo</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={effort ?? KEEP} onValueChange={(v) => onChange({ model, effort: v === KEEP ? null : v })}>
              <DropdownMenuRadioItem value={KEEP}>{newSession ? "El del proyecto" : "El que tenga la sesión"}</DropdownMenuRadioItem>
              {efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {effortName(e).replace(/^./, (c) => c.toUpperCase())}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
