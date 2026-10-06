import { Settings } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { EditorKind } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useEditor, useEditorStore } from "@/lib/editor"

/** Ajustes del dashboard que no son de un proyecto: por ahora, con qué editor se abren los cambios. */
export function SettingsMenu() {
  const settings = useEditor()
  const save = useEditorStore((s) => s.save)
  const [command, setCommand] = useState("")
  useEffect(() => setCommand(settings?.command ?? ""), [settings?.command])

  const apply = async (patch: { kind?: EditorKind; command?: string }) => {
    try {
      await save(patch)
      if (patch.command !== undefined) toast.success("Comando del editor guardado")
    } catch (err) {
      toast.error("No se pudo guardar el editor", { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" className="rounded-md p-1.5 text-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring" aria-label="Ajustes">
              <Settings className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Ajustes</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start" className="w-96 max-w-[calc(100vw-1.5rem)] gap-3 p-3.5">
        <div>
          <p className="text-sm font-medium">Ajustes</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">Valen para todo el dashboard y se guardan en esta máquina.</p>
        </div>
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              Editor
              <span className="block text-2xs text-muted-foreground">Para "Cambios", "Abrir en el editor" y las rutas a archivos</span>
            </span>
            <Select
              value={settings?.kind ?? "code"}
              onValueChange={(v) => {
                // El comando propio se guarda recién cuando lo escribís.
                if (v !== "custom" || command.trim()) void apply({ kind: v as EditorKind, command })
                else useEditorStore.setState({ settings: { kind: "custom", command: "" } })
              }}
            >
              <SelectTrigger size="sm" className="w-36 text-xs sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="code">VS Code</SelectItem>
                <SelectItem value="cursor">Cursor</SelectItem>
                <SelectItem value="custom">Un comando propio</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {settings?.kind === "custom" && (
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                void apply({ kind: "custom", command })
              }}
            >
              <div className="flex gap-2">
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="meld {base} {file}"
                  className="h-8 font-mono text-xs"
                  aria-label="Comando del editor"
                />
                <Button type="submit" size="sm" disabled={!command.trim()}>
                  Guardar
                </Button>
              </div>
              <p className="text-2xs leading-snug text-muted-foreground">
                Se corre sin shell. <code>{"{file}"}</code> es el archivo, <code>{"{base}"}</code> la versión anterior (para el diff) y{" "}
                <code>{"{dir}"}</code> la carpeta de la sesión y <code>{"{line}"}</code> la línea (al abrir una ruta que nombra una sesión; si
                no tiene, 1). Sin <code>{"{file}"}</code>, el archivo va al final. Al abrir un
                proyecto entero, la carpeta va en <code>{"{dir}"}</code> (o en <code>{"{file}"}</code>, si es lo único que tiene).
              </p>
            </form>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
