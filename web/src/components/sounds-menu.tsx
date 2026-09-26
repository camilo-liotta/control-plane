import { Play, Volume2, VolumeX } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EVENTS, playSound, setSoundSettings, SOUNDS, useSoundSettings, type SoundId } from "@/lib/sounds"
import { cn } from "@/lib/utils"

/** Sonidos de la bandeja: uno por tipo de aviso, aparte de las notificaciones del sistema. */
export function SoundsMenu() {
  const s = useSoundSettings()
  const label = s.enabled ? "Sonidos de la bandeja: activados" : "Sonidos de la bandeja: apagados"
  const Icon = s.enabled ? Volume2 : VolumeX
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn("rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground", s.enabled && "text-foreground")}
              aria-label={label}
            >
              <Icon className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start" className="w-96 gap-3 p-3.5">
        <div>
          <p className="text-sm font-medium">Sonidos de la bandeja</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            Un sonido distinto según qué pasó. Van aparte de los avisos del sistema y se guardan en este navegador.
          </p>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>{s.enabled ? "Activados" : "Apagados"}</span>
          <Switch checked={s.enabled} onCheckedChange={(v) => setSoundSettings({ enabled: v })} aria-label="Sonidos de la bandeja" />
        </label>
        <div className={cn("space-y-3", !s.enabled && "pointer-events-none opacity-50")}>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-16 shrink-0 text-muted-foreground">Volumen</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(s.volume * 100)}
              onChange={(e) => setSoundSettings({ volume: Number(e.target.value) / 100 })}
              onPointerUp={() => playSound(s.byEvent.result)}
              className="w-full accent-[var(--claude)]"
              aria-label="Volumen"
            />
            <span className="w-8 text-right font-mono text-xs">{Math.round(s.volume * 100)}</span>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Solo si no estoy mirando el dashboard</span>
            <Switch checked={s.onlyAway} onCheckedChange={(v) => setSoundSettings({ onlyAway: v })} aria-label="Solo si no estoy mirando" />
          </label>
          <ul className="divide-y rounded-lg border">
            {EVENTS.map((e) => (
              <li key={e.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{e.label}</span>
                  <span className="block truncate text-[0.7rem] text-muted-foreground">{e.hint}</span>
                </span>
                <Select value={s.byEvent[e.id]} onValueChange={(v) => (setSoundSettings({ byEvent: { [e.id]: v as SoundId } }), playSound(v as SoundId))}>
                  <SelectTrigger size="sm" className="w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOUNDS.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  onClick={() => playSound(s.byEvent[e.id])}
                  disabled={s.byEvent[e.id] === "ninguno"}
                  aria-label={`Escuchar el sonido de ${e.label}`}
                >
                  <Play className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}
