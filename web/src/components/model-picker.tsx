import { Bot, ChevronDown, Cpu } from "lucide-react"
import { toast } from "sonner"

import type { Session, StoredEvent } from "@shared/types"

import { SubagentList } from "@/components/timeline/subagents"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { api } from "@/lib/api"
import { modelLabel } from "@/lib/files"
import { useModels, useStore } from "@/lib/store"

const DEFAULT = "__default"
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

/** El nombre del modelo que usa la sesión, para el botón y el menú. */
export function useModelLabel(session: Session) {
  const models = useModels()
  const projectModel = useStore((s) => s.projects[session.projectId]?.settings.defaultModel ?? null)
  return modelLabel(models, session.currentModel, session.model ?? projectModel)
}

/** Modelo y esfuerzo de la sesión: se cambian en vivo, sin reiniciarla. */
export function ModelPicker({ session }: { session: Session }) {
  const label = useModelLabel(session)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" className="gap-1.5" title="Cambiar modelo y esfuerzo" aria-label={`Modelo: ${label}. Cambiar modelo y esfuerzo`}>
          <Cpu className="text-muted-foreground" />
          <span className="hidden max-w-32 truncate xl:inline">{label}</span>
          {session.effort && <span className="hidden text-xs text-muted-foreground 2xl:inline">· {session.effort}</span>}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-64">
        <ModelChoices session={session} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Las opciones de modelo y esfuerzo, para un menú (el del botón o el ⋯ en pantallas chicas). */
export function ModelChoices({ session }: { session: Session }) {
  const models = useModels()
  const selected = models.find((m) => m.value === session.model)
  const efforts = (selected ?? models.find((m) => m.resolved === session.currentModel))?.efforts ?? EFFORTS
  const running = session.status !== "stopped" && session.status !== "error"

  const change = async (patch: { model?: string | null; effort?: string | null }, ok: string) => {
    try {
      await api.updateSession(session.id, patch)
      toast.success(ok, { description: running ? "Aplica desde el próximo turno." : "Aplica cuando la reanudes." })
    } catch (err) {
      toast.error("No se pudo cambiar", { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <>
        <DropdownMenuLabel>Modelo</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={session.model ?? DEFAULT}
          onValueChange={(v) => {
            const model = v === DEFAULT ? null : v
            const name = model ? (models.find((m) => m.value === model)?.label ?? model) : "el de tu configuración"
            void change({ model }, model ? `Modelo cambiado a ${name}` : "Modelo cambiado al de tu configuración")
          }}
        >
          <DropdownMenuRadioItem value={DEFAULT}>El de tu configuración</DropdownMenuRadioItem>
          {models
            .filter((m) => m.value !== "default")
            .map((m) => (
              <DropdownMenuRadioItem key={m.value} value={m.value} className="flex-col items-start gap-0">
                <span>{m.label}</span>
                {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
              </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Esfuerzo</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={session.effort ?? DEFAULT}
              onValueChange={(v) => {
                const effort = v === DEFAULT ? null : v
                void change({ effort }, effort ? `Esfuerzo cambiado a ${effort}` : "Esfuerzo cambiado al de tu configuración")
              }}
            >
              <DropdownMenuRadioItem value={DEFAULT}>El de tu configuración</DropdownMenuRadioItem>
              {efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e}>
                  {e}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
    </>
  )
}

/** Indicador de subagentes trabajando, con la lista a un clic. */
export function SubagentsChip({ session, events }: { session: Session; events: StoredEvent[] }) {
  const any = events.some((e) => e.event.kind === "subagent")
  if (!any) return null
  const running = session.subagentsRunning
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className={running ? "text-status-working" : "text-muted-foreground"} title="Subagentes de esta sesión">
          <Bot />
          <span className="text-xs">{running ? `${running} trabajando` : "Subagentes"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <SubagentList sessionId={session.id} events={events} limit={15} />
      </PopoverContent>
    </Popover>
  )
}

/** "Modelo: X" con sus opciones, como submenú del ⋯ (en pantallas chicas). */
export function ModelSubmenu({ session }: { session: Session }) {
  const label = useModelLabel(session)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Cpu />
        <span className="min-w-0 truncate" title={label}>
          {label.startsWith("Modelo") ? label : `Modelo: ${label}`}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-auto min-w-64">
        <ModelChoices session={session} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
