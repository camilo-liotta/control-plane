import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useLocation } from "wouter"

import type { Draft, Project, Report, Session, SubagentBrief } from "@shared/types"

import { StatusPill, TonePill } from "@/components/status"
import { STATUS_VIEW } from "@/components/timeline/subagents"
import { useNow } from "@/hooks/use-now"
import { duration, timeAgo, tokens, usd } from "@/lib/format"
import { sessionStatus, type Tone } from "@/lib/status"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

type Kind = "orchestrator" | "worker" | "subagent"

interface GNode extends SimulationNodeDatum {
  id: string
  kind: Kind
  sessionId: string
  toolUseId?: string
  r: number
  /** Posición objetivo: los workers repartidos en círculo, los subagentes por fuera de su worker. */
  tx: number
  ty: number
}

interface GLink extends SimulationLinkDatum<GNode> {
  id: string
  kind: "core" | "sub"
}

const TONE_FILL: Record<Tone, string> = {
  working: "fill-status-working",
  attention: "fill-status-attention",
  done: "fill-status-done",
  error: "fill-status-error",
  idle: "fill-status-idle",
}
const TONE_STROKE: Record<Tone, string> = {
  working: "stroke-status-working",
  attention: "stroke-status-attention",
  done: "stroke-status-done",
  error: "stroke-status-error",
  idle: "stroke-status-idle",
}

const STALE_MS = 24 * 60 * 60 * 1000

interface Props {
  project: Project
  orchestrator: Session | null
  workers: Session[]
  drafts: Draft[]
  reports: Report[]
}

/**
 * Mapa en vivo del proyecto: la orquestadora al centro, los workers alrededor y sus subagentes
 * como un tercer nivel. Colores por estado, animaciones mientras trabajan, tooltip y clic para abrir.
 */
export function ProjectGraph({ project, orchestrator, workers, drafts, reports }: Props) {
  const [, navigate] = useLocation()
  const setUi = useUi((s) => s.set)
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const sim = useRef<Simulation<GNode, GLink> | null>(null)
  const nodesRef = useRef(new Map<string, GNode>())
  const nodeEls = useRef(new Map<string, SVGGElement>())
  const linkEls = useRef(new Map<string, SVGGElement>())
  const [size, setSize] = useState({ w: 800, h: 360 })
  const [hover, setHover] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const now = useNow(5000)

  const sessions = useMemo(() => (orchestrator ? [orchestrator, ...workers] : workers), [orchestrator, workers])
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const subById = useMemo(() => {
    const m = new Map<string, { sub: SubagentBrief; owner: Session }>()
    for (const s of sessions) for (const sub of s.subagents ?? []) m.set(`${s.id}:${sub.toolUseId}`, { sub, owner: s })
    return m
  }, [sessions])
  const queuedBy = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of reports) if (r.state === "queued" || r.state === "in_review") m.set(r.sessionId, (m.get(r.sessionId) ?? 0) + 1)
    return m
  }, [reports])
  const readyFor = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of drafts) if (d.state === "ready" && d.targetSessionId) m.set(d.targetSessionId, (m.get(d.targetSessionId) ?? 0) + 1)
    return m
  }, [drafts])

  // Topología: qué nodos y conexiones hay (las posiciones las maneja la simulación).
  const topology = useMemo(() => {
    const nodes: { id: string; kind: Kind; sessionId: string; toolUseId?: string; r: number }[] = []
    const links: { id: string; source: string; target: string; kind: "core" | "sub" }[] = []
    const center = orchestrator?.id ?? "__center"
    nodes.push({ id: center, kind: "orchestrator", sessionId: orchestrator?.id ?? "", r: 24 })
    for (const w of workers) {
      nodes.push({ id: w.id, kind: "worker", sessionId: w.id, r: 15 })
      links.push({ id: `${center}->${w.id}`, source: center, target: w.id, kind: "core" })
    }
    for (const s of sessions) {
      for (const sub of s.subagents ?? []) {
        const id = `${s.id}:${sub.toolUseId}`
        nodes.push({ id, kind: "subagent", sessionId: s.id, toolUseId: sub.toolUseId, r: 6 })
        links.push({ id: `${s.id}->${id}`, source: s.id, target: id, kind: "sub" })
      }
    }
    return { nodes, links, key: nodes.map((n) => n.id).join("|") }
  }, [orchestrator, workers, sessions])

  // Tamaño del contenedor.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.max(320, Math.round(entry!.contentRect.width))
      setSize((s) => (s.w === w ? s : { w, h: 360 }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cx = size.w / 2
  const cy = size.h / 2
  const ring = Math.max(95, Math.min(size.h * 0.36, size.w * 0.3, 190))

  // Simulación: se rearma cuando cambian los nodos o el tamaño, conservando las posiciones.
  useEffect(() => {
    const prev = nodesRef.current
    // Ángulo de cada worker (arrancando arriba) y de sus subagentes alrededor de ese ángulo.
    const workerIds = topology.nodes.filter((n) => n.kind === "worker").map((n) => n.id)
    const angleOf = new Map(workerIds.map((id, i) => [id, -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, workerIds.length)]))
    const subsOf = new Map<string, string[]>()
    for (const n of topology.nodes) if (n.kind === "subagent") subsOf.set(n.sessionId, [...(subsOf.get(n.sessionId) ?? []), n.id])
    const target = (n: (typeof topology.nodes)[number]) => {
      if (n.kind === "orchestrator") return { tx: cx, ty: cy }
      if (n.kind === "worker") {
        const a = angleOf.get(n.id) ?? 0
        return { tx: cx + Math.cos(a) * ring, ty: cy + Math.sin(a) * ring }
      }
      const siblings = subsOf.get(n.sessionId) ?? [n.id]
      const j = siblings.indexOf(n.id)
      // Subagentes de la orquestadora: en un arco chico cerca del centro.
      const base = angleOf.get(n.sessionId) ?? Math.PI / 2
      const radius = angleOf.has(n.sessionId) ? ring + 46 : 58
      const a = base + (j - (siblings.length - 1) / 2) * (angleOf.has(n.sessionId) ? 0.22 : 0.5)
      return { tx: cx + Math.cos(a) * radius, ty: cy + Math.sin(a) * radius }
    }
    const nodes: GNode[] = topology.nodes.map((n) => {
      const t = target(n)
      const old = prev.get(n.id)
      if (old) return Object.assign(old, n, t)
      // Los nodos nuevos nacen cerca de quien los lanzó.
      const owner = n.kind === "subagent" ? prev.get(n.sessionId) : undefined
      return { ...n, ...t, x: owner?.x ?? t.tx, y: owner?.y ?? t.ty }
    })
    const map = new Map(nodes.map((n) => [n.id, n]))
    nodesRef.current = map
    const center = nodes.find((n) => n.kind === "orchestrator")
    if (center) {
      center.fx = cx
      center.fy = cy
    }
    const links: GLink[] = topology.links.map((l) => ({ ...l }))

    sim.current?.stop()
    const s = forceSimulation<GNode, GLink>(nodes)
      .force(
        "link",
        forceLink<GNode, GLink>(links)
          .id((d) => d.id)
          .distance((l) => (l.kind === "core" ? ring : 30))
          .strength((l) => (l.kind === "core" ? 0.06 : 0.9))
      )
      .force("charge", forceManyBody<GNode>().strength((d) => (d.kind === "subagent" ? -20 : d.kind === "worker" ? -90 : -200)))
      .force("collide", forceCollide<GNode>((d) => d.r + (d.kind === "worker" ? 18 : 4)))
      .force("x", forceX<GNode>((d) => d.tx).strength((d) => (d.kind === "subagent" ? 0.18 : 0.14)))
      .force("y", forceY<GNode>((d) => d.ty).strength((d) => (d.kind === "subagent" ? 0.18 : 0.14)))
      .alpha(prev.size ? 0.5 : 1)
      .on("tick", () => {
        for (const n of nodes) {
          // Que nada se salga del recuadro.
          n.x = Math.max(n.r + 4, Math.min(size.w - n.r - 4, n.x ?? cx))
          n.y = Math.max(n.r + 4, Math.min(size.h - n.r - 16, n.y ?? cy))
          nodeEls.current.get(n.id)?.setAttribute("transform", `translate(${n.x},${n.y})`)
        }
        for (const l of links) {
          const el = linkEls.current.get(l.id)
          const a = l.source as GNode
          const b = l.target as GNode
          if (!el || !a.x || !b.x) continue
          for (const line of el.querySelectorAll("line")) {
            line.setAttribute("x1", String(a.x))
            line.setAttribute("y1", String(a.y))
            line.setAttribute("x2", String(b.x))
            line.setAttribute("y2", String(b.y))
          }
          const marker = el.querySelector("circle")
          if (marker) {
            // Resultado en cola: un punto cerca de la orquestadora, viajando hacia ella.
            marker.setAttribute("cx", String(a.x + (b.x - a.x) * 0.3))
            marker.setAttribute("cy", String(a.y! + (b.y! - a.y!) * 0.3))
          }
        }
      })
    sim.current = s
    return () => {
      s.stop()
    }
  }, [topology.key, size.w, size.h])

  // Al montar nodos nuevos, ubicarlos ya (sin esperar al próximo tick).
  useLayoutEffect(() => {
    for (const [id, el] of nodeEls.current) {
      const n = nodesRef.current.get(id)
      if (n?.x !== undefined) el.setAttribute("transform", `translate(${n.x},${n.y})`)
    }
  })

  // Arrastrar para acomodar; un clic sin arrastrar abre la sesión.
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null)
  const toLocal = (e: React.PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const onDown = (e: React.PointerEvent, id: string) => {
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const p = toLocal(e)
    drag.current = { id, x: p.x, y: p.y, moved: false }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = toLocal(e)
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < 4) return
    d.moved = true
    const n = nodesRef.current.get(d.id)
    if (!n || n.kind === "orchestrator") return
    n.fx = p.x
    n.fy = p.y
    sim.current?.alphaTarget(0.25).restart()
  }
  const onUp = (id: string) => {
    const d = drag.current
    drag.current = null
    const n = nodesRef.current.get(id)
    if (d?.moved) {
      if (n && n.kind !== "orchestrator") {
        n.fx = null
        n.fy = null
      }
      sim.current?.alphaTarget(0)
      setTick((t) => t + 1)
      return
    }
    open(id)
  }

  const open = (id: string) => {
    const n = nodesRef.current.get(id)
    if (!n?.sessionId) return
    navigate(`/p/${project.id}/s/${n.sessionId}`)
    if (n.kind === "subagent" && n.toolUseId) setUi({ subagent: { sessionId: n.sessionId, toolUseId: n.toolUseId } })
  }

  const hoverNode = hover ? nodesRef.current.get(hover) : undefined

  return (
    <div ref={wrap} className="relative w-full select-none" style={{ height: size.h }}>
      <svg ref={svg} width={size.w} height={size.h} className="block overflow-visible" onPointerMove={onMove} role="img" aria-label="Mapa de las sesiones del proyecto">
        <g>
          {topology.links.map((l) => {
            const target = byId.get(l.target)
            const sub = subById.get(l.target)
            const working = l.kind === "core" ? target?.status === "working" : sub?.sub.status === "running"
            const queued = l.kind === "core" ? (queuedBy.get(l.target) ?? 0) : 0
            return (
              <g
                key={l.id}
                ref={(el) => {
                  if (el) linkEls.current.set(l.id, el)
                  else linkEls.current.delete(l.id)
                }}
              >
                <line className={cn("stroke-border", l.kind === "sub" && "stroke-border/80")} strokeWidth={l.kind === "core" ? 1.5 : 1} />
                {working && <line className="link-flow stroke-status-working/70" strokeWidth={l.kind === "core" ? 1.8 : 1.2} />}
                {queued > 0 && <circle r={4.5} className="node-dot fill-status-attention" />}
              </g>
            )
          })}
        </g>
        <g>
          {topology.nodes.map((n) => {
            const session = byId.get(n.sessionId)
            let tone: Tone = "idle"
            let pulse = false
            let stale = false
            let label: string | null = null
            if (n.kind === "subagent") {
              const s = subById.get(n.id)?.sub
              tone = s ? STATUS_VIEW[s.status].tone : "idle"
              pulse = s?.status === "running"
              stale = s ? s.status !== "running" : false
            } else if (session) {
              const st = sessionStatus(session)
              tone = st.tone
              pulse = st.pulse || session.status === "needs_input"
              stale = session.status === "stopped" && (!session.lastActivityAt || now - session.lastActivityAt > STALE_MS)
              label = n.kind === "orchestrator" ? "Orquestadora" : session.name
            } else if (n.kind === "orchestrator") {
              label = "Orquestadora"
            }
            const stopped = session?.status === "stopped" || session?.status === "error"
            const ready = readyFor.get(n.sessionId) ?? 0
            const reviewing = n.kind === "orchestrator" && project.review.active
            return (
              <g
                key={n.id}
                ref={(el) => {
                  if (el) nodeEls.current.set(n.id, el)
                  else nodeEls.current.delete(n.id)
                }}
                className={cn("cursor-pointer outline-none", stale && "opacity-45")}
                tabIndex={0}
                role="button"
                aria-label={label ?? "Subagente"}
                onPointerDown={(e) => onDown(e, n.id)}
                onPointerUp={() => onUp(n.id)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover((h) => (h === n.id ? null : h))}
                onKeyDown={(e) => e.key === "Enter" && open(n.id)}
              >
                {pulse && (
                  <circle
                    r={n.r}
                    className={cn("node-pulse", TONE_FILL[tone], session?.status === "needs_input" && "node-pulse-fast")}
                  />
                )}
                {reviewing && (
                  <circle r={n.r + 7} fill="none" strokeWidth={1.5} strokeDasharray="3 5" className="ring-spin stroke-status-working" />
                )}
                <circle
                  r={n.r}
                  strokeWidth={n.kind === "orchestrator" ? 2.5 : 2}
                  strokeDasharray={stopped && n.kind !== "subagent" ? "3 3" : undefined}
                  className={cn(
                    TONE_STROKE[tone],
                    stopped ? "fill-background" : n.kind === "orchestrator" ? "fill-card" : TONE_FILL[tone],
                    hover === n.id && "stroke-[3px]"
                  )}
                  style={!stopped && n.kind !== "orchestrator" ? { fillOpacity: 0.22 } : undefined}
                />
                {n.kind === "orchestrator" && <circle r={6} className={TONE_FILL[tone]} />}
                {n.kind === "worker" && !stopped && <circle r={4.5} className={TONE_FILL[tone]} />}
                {ready > 0 && (
                  <g transform={`translate(${n.r * 0.75},${-n.r * 0.75})`}>
                    <circle r={5.5} className="fill-status-attention stroke-background" strokeWidth={1.5} />
                  </g>
                )}
                {label && (
                  <text
                    y={n.r + 14}
                    textAnchor="middle"
                    className={cn(
                      "pointer-events-none font-mono text-[10.5px] font-medium",
                      n.kind === "orchestrator" ? "fill-foreground" : "fill-muted-foreground",
                      hover === n.id && "fill-foreground"
                    )}
                  >
                    {label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
      {workers.length === 0 && (
        <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-xs text-muted-foreground">
          Las sesiones worker aparecen acá, alrededor de la orquestadora.
        </p>
      )}
      {hoverNode && hoverNode.x !== undefined && (
        <GraphTooltip
          node={hoverNode}
          session={byId.get(hoverNode.sessionId)}
          sub={subById.get(hoverNode.id)}
          project={project}
          queued={queuedBy.get(hoverNode.sessionId) ?? 0}
          ready={readyFor.get(hoverNode.sessionId) ?? 0}
          width={size.w}
          now={now}
        />
      )}
    </div>
  )
}

function GraphTooltip({
  node,
  session,
  sub,
  project,
  queued,
  ready,
  width,
  now,
}: {
  node: GNode
  session?: Session
  sub?: { sub: SubagentBrief; owner: Session }
  project: Project
  queued: number
  ready: number
  width: number
  now: number
}) {
  const x = node.x ?? 0
  const y = node.y ?? 0
  const left = Math.max(130, Math.min(width - 130, x))
  const below = y < 150
  return (
    <div
      className="pointer-events-none absolute z-10 w-64 rounded-xl border bg-popover p-3 text-xs shadow-lg"
      style={{
        left,
        top: below ? y + node.r + 12 : y - node.r - 12,
        transform: `translate(-50%, ${below ? "0" : "-100%"})`,
      }}
    >
      {node.kind === "subagent" && sub ? (
        <>
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[0.8rem] font-semibold">{sub.sub.name ?? sub.sub.description}</span>
            <TonePill tone={STATUS_VIEW[sub.sub.status].tone} className="ml-auto">
              {STATUS_VIEW[sub.sub.status].label}
            </TonePill>
          </div>
          <p className="mt-1 text-muted-foreground">
            Subagente de <span className="font-mono text-foreground">{sub.owner.name}</span>
            {[sub.sub.subagentType, sub.sub.model].filter(Boolean).length ? ` · ${[sub.sub.subagentType, sub.sub.model].filter(Boolean).join(" · ")}` : ""}
          </p>
          {sub.sub.lastActivity && <p className="mt-1.5 truncate font-mono text-muted-foreground">{sub.sub.lastActivity}</p>}
          <p className="mt-1.5 font-mono text-muted-foreground">
            {duration((sub.sub.endedAt ?? now) - sub.sub.startedAt)}
            {sub.sub.tokens ? ` · ${tokens(sub.sub.tokens)} tokens` : ""}
          </p>
        </>
      ) : session ? (
        <>
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[0.8rem] font-semibold">
              {node.kind === "orchestrator" ? "Orquestadora" : session.name}
            </span>
            <StatusPill session={session} className="ml-auto" />
          </div>
          {node.kind === "orchestrator" ? (
            <p className="mt-1 text-muted-foreground">
              Cola {project.review.queued} · revisando {project.review.inReview}
              {project.review.paused ? " · en pausa" : ""}
            </p>
          ) : (
            session.role && <p className="mt-0.5 truncate text-muted-foreground">{session.role}</p>
          )}
          {node.kind === "worker" && (
            <p className="mt-1.5 line-clamp-2">
              <span className="text-muted-foreground">Tarea: </span>
              {session.taskTitle ?? "sin tarea asignada"}
            </p>
          )}
          {node.kind === "orchestrator" && session.lastText && <p className="mt-1.5 line-clamp-2 text-muted-foreground">{session.lastText}</p>}
          {session.lastActivity && (
            <p className="mt-1.5 truncate font-mono text-muted-foreground">
              {session.lastActivity} · {timeAgo(session.lastActivityAt, now)}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t pt-2 font-mono text-[0.7rem] text-muted-foreground">
            {session.tokens?.total ? <span>{tokens(session.tokens.total)} tokens</span> : null}
            {session.costUsd > 0 && <span>{usd(session.costUsd)}</span>}
            {session.subagentsRunning > 0 && (
              <span className="text-status-working">
                {session.subagentsRunning === 1 ? "1 subagente" : `${session.subagentsRunning} subagentes`}
              </span>
            )}
            {queued > 0 && <span className="text-status-attention">{queued === 1 ? "1 resultado en cola" : `${queued} resultados en cola`}</span>}
            {ready > 0 && <span className="text-status-attention">{ready === 1 ? "1 propuesta lista" : `${ready} propuestas listas`}</span>}
          </div>
          <p className="mt-1.5 text-[0.7rem] text-muted-foreground">Clic para abrir{node.kind !== "orchestrator" ? " · arrastrá para acomodar" : ""}</p>
        </>
      ) : (
        <p className="text-muted-foreground">La orquestadora todavía no arrancó.</p>
      )}
    </div>
  )
}

export function GraphLegend() {
  const items: { tone: Tone; label: string }[] = [
    { tone: "working", label: "Trabajando" },
    { tone: "attention", label: "Te necesita" },
    { tone: "done", label: "Terminó" },
    { tone: "idle", label: "Esperando" },
    { tone: "error", label: "Error" },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground">
      {items.map((i) => (
        <span key={i.tone} className="inline-flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="4" className={cn(TONE_FILL[i.tone], TONE_STROKE[i.tone])} fillOpacity={0.3} strokeWidth={1.5} />
          </svg>
          {i.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden>
          <circle cx="5" cy="5" r="4" fill="none" strokeWidth={1.5} strokeDasharray="2 2" className="stroke-status-idle" />
        </svg>
        Detenida
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-status-attention" />
        Resultado en cola / propuesta lista
      </span>
    </div>
  )
}
