import { CornerDownRight, MessagesSquare, OctagonAlert } from "lucide-react"
import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { Link } from "wouter"

import type { BatchProjectMessage, Project, ProjectMessage } from "@shared/types"

import { RefText } from "@/components/file-ref"
import { Section } from "@/components/panel-section"
import { TonePill } from "@/components/status"
import { api } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/** El proyecto de la sesión que se está viendo: lo pone el timeline. */
export const ProjectIdContext = createContext<string | undefined>(undefined)

/** Los mensajes del proyecto, enviados y recibidos. `version` los vuelve a pedir (un lote nuevo, un mensaje enviado). */
export function useProjectMessages(projectId: string | undefined, version: unknown = 0, enabled = true) {
  const [list, setList] = useState<ProjectMessage[] | null>(null)
  useEffect(() => {
    if (!projectId || !enabled) return
    let cancelled = false
    api.projectMessages(projectId).then(
      (l) => !cancelled && setList(l),
      () => !cancelled && setList((cur) => cur ?? [])
    )
    return () => {
      cancelled = true
    }
  }, [projectId, version, enabled])
  return list
}

/** El nombre del proyecto en la voz de la UI; si ya no existe, un texto neutro. */
function useProjectRef(idOrName: string | undefined | null): { id: string | null; name: string } {
  const projects = useStore((s) => s.projects)
  return useMemo(() => {
    if (!idOrName) return { id: null, name: "otro proyecto" }
    const all = Object.values(projects) as Project[]
    const p = projects[idOrName] ?? all.find((x) => x.name.toLowerCase() === idOrName.toLowerCase())
    return p ? { id: p.id, name: p.name } : { id: null, name: idOrName }
  }, [projects, idOrName])
}

function ProjectLink({ id, name }: { id: string | null; name: string }) {
  if (!id) return <span className="name">{name}</span>
  return (
    <Link href={`/p/${id}`} className="name text-foreground hover:underline">
      {name}
    </Link>
  )
}

/** "En respuesta a…" con el texto del mensaje, y un salto al chat del otro proyecto donde está. */
function ReplyContext({ replyTo, messages, here }: { replyTo: string; messages: ProjectMessage[] | null; here: string | undefined }) {
  const target = messages?.find((m) => m.id === replyTo)
  const otherSession = target ? (target.fromProjectId === here ? target.toSessionId : target.fromSessionId) : null
  const otherProject = target ? (target.fromProjectId === here ? target.toProjectId : target.fromProjectId) : null
  const mine = target ? target.fromProjectId === here : null
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
      <CornerDownRight className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">
        En respuesta a {mine === null ? "un mensaje anterior" : mine ? "tu mensaje" : "su mensaje"}
        {target && <>: <span className="line-clamp-2 italic wrap-anywhere">«{target.text}»</span></>}
        {otherProject && otherSession && (
          <Link href={`/p/${otherProject}/s/${otherSession}`} className="mt-0.5 block font-medium text-foreground hover:underline">
            Ver en su chat
          </Link>
        )}
      </span>
    </p>
  )
}

/** La llamada a message_project en el chat de quien escribe. */
export function OutgoingProjectMessage({ call }: { call: { use: { input?: unknown }; result: { content?: string; isError?: boolean } | null } }) {
  const projectId = useContext(ProjectIdContext)
  const input = (call.use.input ?? {}) as { project?: string; message?: string; replyTo?: string }
  const dest = useProjectRef(input.project)
  const failedCall = !!call.result?.isError
  const messages = useProjectMessages(projectId, call.result?.content, !!input.replyTo)
  return (
    <div className="surface-card px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <MessagesSquare className={cn("size-4 shrink-0", failedCall ? "text-status-error" : "text-status-pending")} />
        <span className="min-w-0">
          Mensaje a la orquestadora de «<ProjectLink id={dest.id} name={dest.name} />»
        </span>
        {failedCall ? <TonePill tone="error">No se envió</TonePill> : !call.result ? <TonePill tone="working">Enviando</TonePill> : null}
      </div>
      {input.message && (
        <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
          <RefText text={input.message} />
        </p>
      )}
      {input.replyTo && <ReplyContext replyTo={input.replyTo} messages={messages} here={projectId} />}
      {failedCall && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-status-error">
          <OctagonAlert className="mt-0.5 size-3 shrink-0" />
          <span className="wrap-anywhere">{call.result?.content || "No se pudo enviar el mensaje."}</span>
        </p>
      )}
    </div>
  )
}

/**
 * Los mensajes de otras orquestadoras dentro de un lote. Violeta (para mirar, no frena) y con su propia
 * leyenda: no es un resultado de un worker ni una instrucción del usuario.
 */
export function IncomingProjectMessages({ messages: incoming, version }: { messages: BatchProjectMessage[]; version: unknown }) {
  const projectId = useContext(ProjectIdContext)
  const thread = useProjectMessages(projectId, version, incoming.some((m) => m.replyTo))
  return (
    <ul className="mt-2.5 space-y-2.5 border-t pt-2.5">
      {incoming.map((m) => (
        <IncomingMessage key={m.id} m={m} thread={thread} projectId={projectId} />
      ))}
    </ul>
  )
}

function IncomingMessage({ m, thread, projectId }: { m: BatchProjectMessage; thread: ProjectMessage[] | null; projectId: string | undefined }) {
  const from = useProjectRef(m.fromProjectId)
  const name = from.id ? from.name : m.fromProjectName
  return (
    <li className="rounded-xl bg-status-pending/8 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <MessagesSquare className="size-3.5 shrink-0 text-status-pending" />
        <span className="font-medium">
          De la orquestadora de «<ProjectLink id={from.id} name={name} />»
        </span>
        <TonePill tone="pending">Otro proyecto</TonePill>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
        <RefText text={m.text} />
      </p>
      {m.replyTo && <ReplyContext replyTo={m.replyTo} messages={thread} here={projectId} />}
      <p className="mt-1.5 text-2xs text-muted-foreground">Lo escribió otra orquestadora, no vos.</p>
    </li>
  )
}

/** "Otros proyectos" en el panel de la orquestadora: las conversaciones recientes, una fila por proyecto. */
export function OtherProjectsSection({ projectId, version }: { projectId: string; version: unknown }) {
  const messages = useProjectMessages(projectId, version)
  const projects = useStore((s) => s.projects)
  const rows = useMemo(() => {
    const last = new Map<string, ProjectMessage>()
    for (const m of [...(messages ?? [])].sort((a, b) => b.createdAt - a.createdAt)) {
      const other = m.fromProjectId === projectId ? m.toProjectId : m.fromProjectId
      if (!last.has(other)) last.set(other, m)
    }
    return [...last.entries()]
  }, [messages, projectId])
  if (!rows.length) return null
  const nameOf = (otherId: string, m: ProjectMessage) =>
    (projects[otherId] as Project | undefined)?.name ?? (m.fromProjectId === projectId ? m.toProjectName : m.fromProjectName)
  return (
    <Section
      id="other-projects"
      title="Otros proyectos"
      count={rows.length}
      summary={`${nameOf(rows[0]![0], rows[0]![1])} · ${timeAgo(rows[0]![1].createdAt)}`}
    >
      <ul className="divide-y">
        {rows.map(([otherId, m]) => {
          const sent = m.fromProjectId === projectId
          const session = sent ? m.toSessionId : m.fromSessionId
          const name = nameOf(otherId, m)
          const body = (
            <>
              <span className="flex items-baseline gap-2">
                <span className="name min-w-0 flex-1 truncate text-ui">{name}</span>
                <span className="shrink-0 text-2xs text-muted-foreground" title={new Date(m.createdAt).toLocaleString("es-AR")}>
                  {timeAgo(m.createdAt)}
                </span>
              </span>
              <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground wrap-anywhere">
                {sent ? "Vos: " : ""}
                {m.text}
              </span>
            </>
          )
          return (
            <li key={otherId} className="py-2 first:pt-0 last:pb-0">
              {projects[otherId] && session ? (
                <Link href={`/p/${otherId}/s/${session}`} className="block rounded-md hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  {body}
                </Link>
              ) : (
                <div>{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
