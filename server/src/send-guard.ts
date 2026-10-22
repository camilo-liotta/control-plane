import path from "node:path"
import os from "node:os"

import type { SessionRecord } from "./db.ts"
import type { LiveSession } from "./claude/local.ts"

/**
 * El cerrojo de SendMessage: una sesión del dashboard solo le escribe a sesiones de su propio proyecto.
 * Entre proyectos, solo las orquestadoras, y por message_project. Lo consulta el hook PreToolUse de
 * cada sesión (ver claude/args.ts) y, si acá se deniega, la herramienta no corre, tampoco con
 * --dangerously-skip-permissions. Ante la duda, deniega.
 */

/**
 * `rewriteTo`: el nombre exacto con que corre el proceso destino, cuando no es lo que escribió quien manda (el nombre
 * corto, otras mayúsculas, un [ref]): el hook devuelve el SendMessage con ese destino (updatedInput) y llega a la
 * sesión de su proyecto aunque el nombre corto exista también en otro proyecto (ver names.ts).
 */
export type SendDecision = { allow: true; rewriteTo?: string } | { allow: false; reason: string }

export interface SendGuardDeps {
  /** Las sesiones del dashboard (sin archivar). */
  sessions(): SessionRecord[]
  /** Quién es el dueño de cada pid de Claude Code que lanzó el dashboard. */
  pids(): Map<number, string>
  /** Los nombres de los subagentes que la sesión lanzó (SendMessage también les llega a ellos). */
  agentNames(sessionId: string): string[]
  /** Las sesiones vivas de la cuenta de la sesión, también las de afuera del dashboard (lo mejor que se pueda). */
  live?(session: SessionRecord): Promise<LiveSession[]>
  /** El socket de mensajería que Claude Code registró para ese pid, si se puede leer. */
  socketOf?(session: SessionRecord, pid: number): string | null
}

export const SEND_DENIED = {
  otherProjectWorker: "Solo podés hablar con sesiones de tu proyecto. Si necesitás algo de otro proyecto, pedíselo a tu orquestadora.",
  otherProjectOrchestrator: "Para hablar con otro proyecto usá message_project.",
  notDashboard: (to: string, worker: boolean) =>
    `«${to}» no es una sesión de este dashboard (puede ser una sesión de Claude Code tuya fuera del dashboard, una de la nube o de otra máquina). Las sesiones del dashboard solo hablan con las de su proyecto.${worker ? " Si necesitás algo de afuera, pedíselo a tu orquestadora." : " Entre proyectos, usá message_project."}`,
  ambiguous: (name: string) =>
    `Hay más de una sesión llamada «${name}» (fuera del dashboard, o con un [ref] que no puedo comprobar) y no puedo saber a cuál iría tu mensaje, así que no se envía. Escribile a una sesión de tu proyecto con el nombre que muestra list_sessions, sin [ref]; si no alcanza, pedile al usuario que renombre una de las dos.`,
  unresolved: (to: string) =>
    `No pude saber a quién va «${to}», y por seguridad no se envía. Reintentá con el nombre exacto que muestra list_sessions (las sesiones de tu proyecto).`,
  agentClash: (name: string) =>
    `Tu subagente «${name}» se llama igual que una sesión que no es de tu proyecto: si Claude Code no lo registró con ese nombre, el mensaje iría a esa sesión, así que no se envía. Lanzá el subagente con otro nombre.`,
  noCaller: "No pude identificar tu sesión en el dashboard, y por seguridad no se envía el mensaje.",
}

const deny = (reason: string): SendDecision => ({ allow: false, reason })
const ALLOW: SendDecision = { allow: true }

/** Dónde pone Claude Code el socket de un pid, si el registro no lo dice. */
function defaultSocket(pid: number): string {
  const dir = process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}`
  return path.join(dir, "cc-socks", `${pid}.sock`)
}

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Decide si `caller` puede mandar este SendMessage (`input` es el tool_input que ve el hook). */
export async function decideSend(deps: SendGuardDeps, caller: SessionRecord | null, input: Record<string, unknown>): Promise<SendDecision> {
  if (!caller) return deny(SEND_DENIED.noCaller)
  const worker = caller.kind !== "orchestrator"
  const raw = input.recipient ?? input.to
  const to = typeof raw === "string" ? raw.trim() : ""
  if (!to) return deny(SEND_DENIED.unresolved(String(raw ?? "").trim()))
  const kind = typeof input.recipient_kind === "string" ? input.recipient_kind : null

  const crossProject = deny(worker ? SEND_DENIED.otherProjectWorker : SEND_DENIED.otherProjectOrchestrator)
  const sameProject = (target: SessionRecord) => target.id === caller.id || target.projectId === caller.projectId

  // La conversación principal del propio proceso (desde un subagente).
  if (kind === "main" || (kind === null && to.toLowerCase() === "main")) return ALLOW

  // Una dirección de socket: la que trae el "from" de un mensaje recibido. El número es el pid de Claude Code.
  const uds = /^uds:(.+)$/.exec(to)
  if (uds || kind === "session") {
    const m = uds ? /(?:^|\/)cc-socks\/(\d+)\.sock$/.exec(uds[1]!) : null
    const pid = m ? Number(m[1]) : null
    const owner = pid !== null ? deps.pids().get(pid) : undefined
    const target = owner ? deps.sessions().find((s) => s.id === owner) : undefined
    if (!uds || !target || pid === null) return deny(SEND_DENIED.notDashboard(to, worker))
    // Que la ruta sea el socket de ESE proceso y no otro con el mismo número en otra carpeta.
    const registered = deps.socketOf?.(target, pid) ?? null
    if (uds[1] !== (registered ?? defaultSocket(pid))) return deny(SEND_DENIED.notDashboard(to, worker))
    return sameProject(target) ? ALLOW : crossProject
  }

  // Un nombre, con o sin [ref].
  const withRef = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(to)
  const base = (withRef ? withRef[1]! : to).trim()
  if (!base) return deny(SEND_DENIED.unresolved(to))
  const all = deps.sessions()
  const matches = (s: SessionRecord) => eq(s.name, base) || eq(s.processName, base)

  // Si el nombre también es el de un subagente propio, SendMessage elige al subagente. Solo con el nombre
  // exacto: con otras mayúsculas puede no ser el subagente y sí una sesión de otro proyecto.
  // Pero lo que se ve es el Agent que se pidió, no el subagente que Claude Code registró: si no llegó a lanzarse (un
  // subagent_type que no existe), le cambió el nombre (uno repetido) o se lo rechazó, SendMessage busca entre las
  // sesiones. Así que el nombre de un subagente no puede ser el de una sesión o un proceso de otro proyecto.
  if (!withRef && deps.agentNames(caller.id).some((n) => n.trim() === base)) {
    if (all.some((s) => matches(s) && !sameProject(s))) return deny(SEND_DENIED.agentClash(base))
    if (deps.live) {
      const pids = deps.pids()
      for (const l of (await deps.live(caller).catch(() => [])).filter((l) => l.name && eq(l.name, base))) {
        const owner = l.pid ? pids.get(l.pid) : undefined
        const t = owner ? all.find((s) => s.id === owner) : undefined
        if (!t || !sameProject(t)) return deny(SEND_DENIED.agentClash(base))
      }
    }
    return ALLOW
  }

  // Los nombres son únicos por proyecto, no en toda la máquina: el corto se resuelve primero dentro del proyecto de quien
  // manda. Lo que resuelve SendMessage es el nombre del proceso (`processName`, calificado con el proyecto si otro
  // proyecto repite el nombre), y ese es único entre las sesiones del dashboard.
  const own = all.filter((s) => matches(s) && sameProject(s))
  if (!own.length) return all.some(matches) ? crossProject : deny(SEND_DENIED.notDashboard(to, worker))
  if (own.length > 1) return deny(SEND_DENIED.ambiguous(base))
  const target = own[0]!
  const final = target.processName

  // Una sesión tuya de afuera del dashboard (o un proceso cuyo nombre no se actualizó) con el nombre con que se va a
  // enviar podría ser la elegida: no se puede saber; un proceso del dashboard con ese nombre tiene que ser del proyecto.
  if (deps.live) {
    const pids = deps.pids()
    for (const l of (await deps.live(caller).catch(() => [])).filter((l) => l.name && eq(l.name, final))) {
      const owner = l.pid ? pids.get(l.pid) : undefined
      const t = owner ? all.find((s) => s.id === owner) : undefined
      if (!t) return deny(SEND_DENIED.ambiguous(base))
      if (!sameProject(t)) return crossProject
    }
  }
  // Tal cual lo escribió, si ya es el nombre exacto (sin espacios de más: Claude Code recibe lo crudo); si no, el destino
  // se cambia por el del proceso.
  return raw === final ? ALLOW : { allow: true, rewriteTo: final }
}

/** El tool_input con el destino cambiado (lo que el hook devuelve como updatedInput). */
export function withRecipient(input: Record<string, unknown>, to: string): Record<string, unknown> {
  const out = { ...input }
  const has = (k: string) => typeof out[k] === "string"
  if (has("recipient")) out.recipient = to
  if (has("to") || !has("recipient")) out.to = to
  return out
}
