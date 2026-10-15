import { useEffect, useState, useSyncExternalStore } from "react"

import type { ResolvedRef } from "@shared/file-refs"

import { api } from "@/lib/api"

/** Dónde se buscan las rutas de un texto: el proyecto y, si hay, la sesión que lo escribió. */
export interface RefScope {
  projectId: string
  sessionId?: string
}

// Lo ya resuelto, por proyecto + sesión + ruta: el archivo, o null si no existe. Las que no existen se
// vuelven a preguntar pasado un rato (la sesión puede crear el archivo después de nombrarlo).
const MISS_TTL = 60_000
const cache = new Map<string, { value: ResolvedRef | null; at: number }>()
const listeners = new Set<() => void>()
const queue = new Map<string, { scope: RefScope; inputs: Set<string> }>()
const inFlight = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
let version = 0

const scopeKey = (s: RefScope) => `${s.projectId}|${s.sessionId ?? ""}`
const refKey = (s: RefScope, input: string) => `${scopeKey(s)}|${input}`

function notify() {
  version++
  for (const l of listeners) l()
}

/** Manda lo pendiente en un pedido por proyecto + sesión (en tandas de 200, el tope del server). */
async function flush() {
  timer = null
  const batches = [...queue.values()]
  queue.clear()
  await Promise.all(
    batches.map(async ({ scope, inputs }) => {
      const all = [...inputs]
      for (let i = 0; i < all.length; i += 200) {
        const chunk = all.slice(i, i + 200)
        try {
          const { ok } = await api.resolvePaths(scope.projectId, chunk, scope.sessionId)
          const byInput = new Map(ok.map((r) => [r.input, r]))
          for (const input of chunk) cache.set(refKey(scope, input), { value: byInput.get(input) ?? null, at: Date.now() })
        } catch {
          // Sin server o con error: quedan sin link y se reintentan más tarde.
          for (const input of chunk) cache.set(refKey(scope, input), { value: null, at: Date.now() })
        } finally {
          for (const input of chunk) inFlight.delete(refKey(scope, input))
        }
      }
    })
  )
  notify()
}

function request(scope: RefScope, input: string) {
  const key = refKey(scope, input)
  const hit = cache.get(key)
  if (inFlight.has(key) || (hit && (hit.value || Date.now() - hit.at < MISS_TTL))) return
  inFlight.add(key)
  const sk = scopeKey(scope)
  let batch = queue.get(sk)
  if (!batch) queue.set(sk, (batch = { scope, inputs: new Set() }))
  batch.inputs.add(input)
  timer ??= setTimeout(() => void flush(), 40)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

// Un solo observador para todas las referencias: se resuelven cuando entran en vista.
const watchers = new WeakMap<Element, () => void>()
let observer: IntersectionObserver | null = null
function observe(el: Element, onVisible: () => void) {
  if (typeof IntersectionObserver === "undefined") return onVisible()
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        watchers.get(e.target)?.()
        watchers.delete(e.target)
        observer!.unobserve(e.target)
      }
    },
    { rootMargin: "200px" }
  )
  watchers.set(el, onVisible)
  observer.observe(el)
  return () => {
    watchers.delete(el)
    observer?.unobserve(el)
  }
}

/**
 * Lo que el server sabe de `input` en `scope`: el archivo resuelto, null si no existe o undefined
 * mientras no se sabe. Pregunta recién cuando `el` entra en vista, y junta los pedidos en lote.
 */
export function useResolvedRef(scope: RefScope | null, input: string, el: Element | null): ResolvedRef | null | undefined {
  const [visible, setVisible] = useState(false)
  const projectId = scope?.projectId
  const sessionId = scope?.sessionId
  useEffect(() => {
    if (!projectId || !el || visible) return
    return observe(el, () => setVisible(true))
  }, [projectId, el, visible])
  useEffect(() => {
    if (projectId && visible) request({ projectId, sessionId }, input)
  }, [projectId, sessionId, input, visible])
  useSyncExternalStore(subscribe, () => version)
  if (!scope) return null
  return cache.get(refKey(scope, input))?.value
}
