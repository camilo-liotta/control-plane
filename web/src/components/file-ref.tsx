import { createContext, useContext, useMemo, useState } from "react"

import { textRefs } from "@shared/file-refs"

import { api } from "@/lib/api"
import { EDITOR_NAMES, useEditor, useEditorStore } from "@/lib/editor"
import { useResolvedRef, type RefScope } from "@/lib/file-refs"
import { failed } from "@/lib/errors"

const ScopeContext = createContext<RefScope | null>(null)

/**
 * Las rutas a archivos que aparecen adentro (en el markdown o en un <RefText>) se buscan en este
 * proyecto y, si hay, en la carpeta de esta sesión. Sin esto, no se linkea nada.
 */
export function FileRefScope({ projectId, sessionId, children }: RefScope & { children: React.ReactNode }) {
  const value = useMemo(() => ({ projectId, sessionId }), [projectId, sessionId])
  useEditor() // para el nombre del editor en el tooltip, una vez por bloque
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export const useRefScope = () => useContext(ScopeContext)

/**
 * Una ruta que, si existe en el proyecto, se abre en el editor al hacer clic. Mientras no se sabe (o si
 * no existe) se ve igual que el texto de alrededor.
 */
export function FileRefLink({ input, children }: { input: string; children: React.ReactNode }) {
  const scope = useRefScope()
  const [el, setEl] = useState<HTMLSpanElement | null>(null)
  const ref = useResolvedRef(scope, input, el)
  const kind = useEditorStore((s) => s.settings?.kind)
  if (!scope || !ref) return <span ref={setEl}>{children}</span>
  return (
    <a
      href="#"
      className="file-ref"
      title={`Abrir en ${kind ? EDITOR_NAMES[kind] : "VS Code"}`}
      onClick={(e) => {
        e.preventDefault()
        api.openPath(scope.projectId, input, scope.sessionId).catch(failed("abrir el archivo"))
      }}
    >
      {children}
    </a>
  )
}

/** Texto plano (sin markdown) con las rutas a archivos linkeadas. */
export function RefText({ text }: { text: string }) {
  const scope = useRefScope()
  const refs = useMemo(() => (scope ? textRefs(text) : []), [scope, text])
  if (!refs.length) return <>{text}</>
  const out: React.ReactNode[] = []
  let pos = 0
  for (const r of refs) {
    if (r.start > pos) out.push(text.slice(pos, r.start))
    out.push(
      <FileRefLink key={r.start} input={r.input}>
        {r.input}
      </FileRefLink>
    )
    pos = r.end
  }
  if (pos < text.length) out.push(text.slice(pos))
  return <>{out}</>
}
