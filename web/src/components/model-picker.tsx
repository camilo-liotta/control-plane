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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { api } from "@/lib/api"
import { modelLabel } from "@/lib/files"
import { useModels, useStore } from "@/lib/store"

const DEFAULT = "__default"
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

/** Modelo y esfuerzo de la sesión: se cambian en vivo, sin reiniciarla. */
export function ModelPicker({ session }: { session: Session }) {
  const models = useModels()
  const projectModel = useStore((s) => s.projects[session.projectId]?.settings.defaultModel ?? null)
  const label = modelLabel(models, session.currentModel, session.model ?? projectModel)
  const selected = models.find((m) => m.value === session.model)
  const efforts = (selected ?? models.find((m) => m.resolved === session.currentModel))?.efforts ?? EFFORTS
  const running = session.status !== "stopped" && session.status !== "error"

  const change = async (patch: { model?: string | null; effort?: string | null }, ok: string) => {
    try {
      await api.updateSession(session.id, patch)
      toast.success(ok, { description: running ? "Aplica desde el próximo turno." : "Aplica cuando la reanudes." })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" title="Cambiar modelo y esfuerzo">
          <Cpu />
          <span className="hidden max-w-32 truncate md:inline">{label}</span>
          {session.effort && <span className="hidden font-mono text-[0.7rem] lg:inline">· {session.effort}</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-64">
        <DropdownMenuLabel>Modelo</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={session.model ?? DEFAULT}
          onValueChange={(v) => {
            const model = v === DEFAULT ? null : v
            const name = model ? (models.find((m) => m.value === model)?.label ?? model) : "el de tu configuración"
            void change({ model }, `Modelo: ${name}`)
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
                void change({ effort }, effort ? `Esfuerzo: ${effort}` : "Esfuerzo por defecto")
              }}
            >
              <DropdownMenuRadioItem value={DEFAULT}>El de tu configuración</DropdownMenuRadioItem>
              {efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e} className="font-mono">
                  {e}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
          <span className="font-mono text-xs">{running ? `${running} trabajando` : "subagentes"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <SubagentList sessionId={session.id} events={events} limit={15} />
      </PopoverContent>
    </Popover>
  )
}
