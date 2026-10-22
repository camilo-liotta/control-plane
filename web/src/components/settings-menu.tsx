import { ChevronRight, Globe, Settings, Settings2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import type { EditorKind } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useEditor, useEditorStore } from "@/lib/editor"
import { useProjects } from "@/lib/store"
import { useUi } from "@/lib/ui"

/** Ajustes del dashboard que no son de un proyecto: por ahora, con qué editor se abren los cambios. */
export function SettingsMenu() {
  const settings = useEditor()
  const save = useEditorStore((s) => s.save)
  const [command, setCommand] = useState("")
  useEffect(() => setCommand(settings?.command ?? ""), [settings?.command])
  const [open, setOpen] = useState(false)
  const [location] = useLocation()
  const projects = useProjects()
  const setUi = useUi((s) => s.set)
  // Dentro de un proyecto (/p/:id…), sus ajustes quedan a un clic; afuera, hay que elegir cuál.
  const current = projects.find((p) => location === `/p/${p.id}` || location.startsWith(`/p/${p.id}/`))
  const openProject = (id: string) => {
    setOpen(false)
    setUi({ settingsFor: id })
  }

  const apply = async (patch: { kind?: EditorKind; command?: string }) => {
    try {
      await save(patch)
      if (patch.command !== undefined) toast.success("Comando del editor guardado")
    } catch (err) {
      toast.error("No se pudo guardar el editor", { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        <div className="border-b pb-3">
          <p className="eyebrow">Ajustes del dashboard</p>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">Valen para todos los proyectos y se guardan en esta máquina.</p>
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
        <div className="space-y-1.5 border-t pt-3">
          <p className="eyebrow">Acceso remoto</p>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setUi({ remoteDialog: true })
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">Acceso remoto</span>
              <span className="block text-2xs text-muted-foreground">Estado de Tailscale y dispositivos</span>
            </span>
          </button>
        </div>
        <div className="space-y-1.5 border-t pt-3">
          <p className="eyebrow">Ajustes del proyecto</p>
          {current ? (
            <button
              type="button"
              onClick={() => openProject(current.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Settings2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">Ajustes de {current.name}</span>
                <span className="block text-2xs text-muted-foreground">Modelos, orquestación y más</span>
              </span>
            </button>
          ) : projects.length === 0 ? (
            <p className="text-xs text-muted-foreground">Cuando tengas un proyecto, sus ajustes (con los modelos) están acá.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Elegí un proyecto para ver sus ajustes, como los modelos.</p>
              <ul className="-mx-1 max-h-40 overflow-y-auto">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => openProject(p.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
