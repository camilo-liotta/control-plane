import { useEffect } from "react"
import { create } from "zustand"

import type { EditorSettings } from "@shared/types"

import { useCan } from "@/lib/access"
import { api } from "@/lib/api"

export const EDITOR_NAMES: Record<EditorSettings["kind"], string> = {
  code: "VS Code",
  cursor: "Cursor",
  custom: "tu editor",
}

interface EditorState {
  settings: EditorSettings | null
  load: () => Promise<void>
  save: (patch: Partial<EditorSettings>) => Promise<EditorSettings>
}

/** El editor con el que se abren los cambios de una sesión (lo guarda el server, que es quien lo lanza). */
export const useEditorStore = create<EditorState>((set) => ({
  settings: null,
  load: async () => {
    try {
      set({ settings: await api.editor() })
    } catch {}
  },
  save: async (patch) => {
    const settings = await api.saveEditor(patch)
    set({ settings })
    return settings
  },
}))

export function useEditor(): EditorSettings | null {
  const settings = useEditorStore((s) => s.settings)
  const load = useEditorStore((s) => s.load)
  // El editor es de esta máquina: desde otro dispositivo no se pide (el server lo niega).
  const manage = useCan("manage")
  useEffect(() => {
    if (manage && !settings) void load()
  }, [manage, settings, load])
  return settings
}
