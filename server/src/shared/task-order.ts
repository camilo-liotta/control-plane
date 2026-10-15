// El orden de las tareas para vos y sus etiquetas: lo mismo en el tablero del proyecto, en la
// Bandeja y en lo que ven las sesiones con list_user_tasks.

import type { UserTask } from "./types.ts"

/**
 * Las abiertas, en el orden en que conviene hacerlas:
 * 1. las que frenan a una sesión (que no se escondan al final aunque no tengan prioridad);
 * 2. por prioridad (1 va primero); las que no tienen, después;
 * 3. por fecha límite, y las más viejas primero (se pidieron antes).
 */
export function compareTasks(a: UserTask, b: UserTask): number {
  if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
  if (a.priority !== b.priority) return (a.priority ?? Infinity) - (b.priority ?? Infinity)
  if (a.due !== b.due) return (a.due ?? Infinity) - (b.due ?? Infinity)
  return a.createdAt - b.createdAt
}

/**
 * Las ordena y deja juntas las de una misma etiqueta (que se vea que van juntas): el grupo queda
 * donde está su primera tarea, y adentro, en su orden. Solo cuentan las etiquetas de un grupo de
 * verdad (dos o más abiertas).
 */
export function orderTasks(open: UserTask[]): UserTask[] {
  const sorted = [...open].sort(compareTasks)
  const groups = tagGroups(sorted)
  const out: UserTask[] = []
  const placed = new Set<string>()
  for (const t of sorted) {
    if (placed.has(t.id)) continue
    const tag = groupTag(t, groups)
    const members = tag ? sorted.filter((x) => groupTag(x, groups) === tag) : [t]
    for (const m of members) if (!placed.has(m.id)) (placed.add(m.id), out.push(m))
  }
  return out
}

/** Una etiqueta: corta, en minúsculas y con guiones (Postmark Dominios → postmark-dominios). */
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "")
}

export function normalizeTags(raw: string[]): string[] {
  return [...new Set(raw.map(normalizeTag).filter(Boolean))].slice(0, 4)
}

export interface TagGroup {
  tag: string
  /** Todas las que la tienen (abiertas, hechas y descartadas hace poco). */
  total: number
  /** Las que siguen abiertas. */
  open: number
  done: number
}

/**
 * Las etiquetas que relacionan tareas: las que siguen en dos o más abiertas. Una que quedó en una
 * sola abierta (las otras ya se hicieron) no es un grupo y no se muestra. Las descartadas no
 * cuentan en el total ("1 de 3" es de las que hay que hacer).
 */
export function tagGroups(tasks: UserTask[]): Map<string, TagGroup> {
  const all = new Map<string, TagGroup>()
  for (const t of tasks) {
    if (t.status === "dismissed") continue
    for (const tag of t.tags) {
      const g = all.get(tag) ?? { tag, total: 0, open: 0, done: 0 }
      g.total++
      if (t.status === "open") g.open++
      else g.done++
      all.set(tag, g)
    }
  }
  for (const [tag, g] of all) if (g.open < 2) all.delete(tag)
  return all
}

/** La etiqueta de grupo de una tarea (si tiene varias, la primera que sea un grupo). */
export function groupTag(t: UserTask, groups: Map<string, TagGroup>): string | null {
  return t.tags.find((x) => groups.has(x)) ?? null
}
