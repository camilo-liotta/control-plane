import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { childEnv } from "./claude/env.ts"
import type { Db, SessionRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import type { SessionManager, TurnEndInfo } from "./sessions.ts"
import type { CompactionDraft, CompactionSection, CompactionState, ContextUsage, TimelineEvent } from "./shared/types.ts"
import { errorMessage, now, oneLine } from "./util.ts"

const run = promisify(execFile)

/** Secciones del resumen que arma Claude Code al compactar (las mismas, en castellano). */
export const DRAFT_SECTIONS = [
  "Pedido e intención",
  "Conceptos técnicos",
  "Archivos y código",
  "Errores y arreglos",
  "Resolución de problemas",
  "Mensajes del usuario",
  "Tareas pendientes",
  "Trabajo en curso",
  "Próximo paso",
]

export const DRAFT_QUESTION = [
  "Vamos a compactar esta conversación y el usuario quiere elegir, punto por punto, qué se conserva.",
  "Escribí el resumen que harías al compactar, pero como una lista de puntos independientes: cada punto tiene que poder conservarse o descartarse solo, y ser concreto (rutas, nombres, valores, decisiones, errores y cómo se arreglaron).",
  "Un punto es un solo dato, decisión, archivo, error o tarea: nunca juntes varios en el mismo punto.",
  "Incluí todo lo que incluiría un resumen de compactación completo, pero no lo que viene de tus instrucciones de sistema (tu rol, el protocolo de trabajo, las otras sesiones): eso no se pierde al compactar.",
  `Agrupalos en estas secciones y omití las vacías: ${DRAFT_SECTIONS.map((s) => `"${s}"`).join(", ")}.`,
  "Escribí los puntos en el idioma de la conversación. No uses herramientas.",
  'Respondé SOLO con JSON válido, sin texto antes ni después ni bloques de código, con esta forma: {"sections":[{"title":"...","points":["..."]}]}',
].join(" ")

/** Lo que manda la web al compactar: cada punto con su texto (quizás editado) y si se conserva. */
export interface CompactionSelection {
  sections: { title: string; points: { text: string; keep: boolean }[] }[]
  extra?: string
}

const MAX_POINTS = 400

/** Lee el borrador que devolvió Claude (tolera bloques de código y texto alrededor). */
export function parseDraft(raw: string): CompactionSection[] {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("Claude no devolvió el borrador en el formato pedido")
  let data: unknown
  try {
    data = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new Error("Claude no devolvió el borrador en el formato pedido")
  }
  const sections = (data as { sections?: unknown }).sections
  if (!Array.isArray(sections)) throw new Error("El borrador no tiene secciones")
  let n = 0
  const out: CompactionSection[] = []
  for (const s of sections as { title?: unknown; points?: unknown }[]) {
    const title = oneLine(String(s?.title ?? ""), 80) || "Otros"
    const points = (Array.isArray(s?.points) ? s.points : [])
      .map((p) => String(p ?? "").trim().slice(0, 2000))
      .filter(Boolean)
      .slice(0, Math.max(0, MAX_POINTS - n))
      .map((text) => ({ id: `p${++n}`, text }))
    if (points.length) out.push({ title, points })
  }
  if (!n) throw new Error("El borrador vino vacío")
  return out
}

/** Un punto como ítem de lista: si tiene varias líneas, siguen indentadas dentro del mismo ítem. */
const bullet = (text: string) => text.trim().slice(0, 4000).replace(/\n+/g, "\n  ")

/**
 * Instrucciones para la compactación de Claude Code. El resumen lo escribiste vos (elegiste y
 * editaste los puntos): se le pide que lo copie tal cual, que es lo que mejor cumple cualquier
 * modelo, y que lo descartado no aparezca en ningún lado (tampoco citando mensajes).
 */
export function compactInstructions(sel: CompactionSelection): { text: string; kept: number; dropped: number } {
  // Sin borrador (por ejemplo, con el contexto tan lleno que no se pudo armar): tus instrucciones van
  // como las de /compact, y Claude Code arma su resumen de siempre siguiéndolas.
  if (!sel.sections.length) return { text: sel.extra?.trim() ?? "", kept: 0, dropped: 0 }
  const keptSections: { title: string; points: string[] }[] = []
  const dropped: string[] = []
  for (const s of sel.sections) {
    const keep = s.points.filter((p) => p.keep && p.text.trim()).map((p) => bullet(p.text))
    dropped.push(...s.points.filter((p) => !p.keep && p.text.trim()).map((p) => bullet(p.text)))
    if (keep.length) keptSections.push({ title: s.title.trim() || "Otros", points: keep })
  }
  const kept = keptSections.reduce((n, s) => n + s.points.length, 0)
  const extra = sel.extra?.trim()
  const curated = keptSections.map((s) => [`## ${s.title}`, ...s.points.map((p) => `- ${p}`)].join("\n")).join("\n\n")
  const lines = [
    "[control-plane] The user already wrote the summary for this compaction: they reviewed a draft point by point and chose what survives. These instructions replace the standard summary structure.",
  ]
  if (kept) {
    lines.push(
      "",
      "Inside <summary>, copy the text between <curated_summary> tags exactly as written, verbatim. Do not add the standard sections (Primary Request and Intent, Key Technical Concepts, Files and Code Sections, Errors and fixes, Problem Solving, All user messages, Pending Tasks, Current Work, Optional Next Step) and do not quote or list the user's messages.",
      'If the conversation continued after the review, you may append one final section "## Después de la revisión" with only what happened after it.',
      "",
      "<curated_summary>",
      curated,
      "</curated_summary>"
    )
  } else {
    lines.push("", "The user kept no points from the draft: write a brief summary that follows their instructions below.")
  }
  if (dropped.length) {
    lines.push(
      "",
      'The user removed these facts on purpose: they must not appear anywhere in the summary (not in the analysis, not in "Después de la revisión", not in any quoted message), and do not mention that they were removed:',
      ...dropped.map((p) => `- ${p}`)
    )
  }
  if (extra) lines.push("", "Additional instructions from the user:", extra)
  return { text: lines.join("\n"), kept, dropped: dropped.length }
}

interface Applied {
  text: string
  kept: number
  dropped: number
}

/** Cuánto tiempo vale una selección guardada después de una compactación fallida. */
const RETRY_MS = 30 * 60_000

interface Waiter {
  since: number
  deadline: number
  timer: NodeJS.Timeout
  resolvers: Set<(text: string) => void>
}

interface Entry {
  draft: CompactionDraft | null
  drafting: Promise<void> | null
  error: string | null
  waiting: Waiter | null
  /** Se mandó la compactación con tu selección: kept/dropped para la tarjeta del chat. */
  applying: Applied | null
  /** Tu selección de una compactación que falló: se usa sola en el próximo intento. */
  retry: (Applied & { at: number }) | null
  /** Ya avisamos que el contexto se está llenando (se reinicia al compactar). */
  warned: boolean
  /** Un mensaje no entró por el contexto lleno: se reenvía después de la próxima compactación. */
  resend: boolean
  /** Ya compactó: el reenvío sale cuando termina ese turno (el de /compact). */
  resendOnTurnEnd: boolean
  /** Mandamos /compact para poder reenviar: si el turno termina sin compactar, hay que avisar. */
  compactingForResend: boolean
}

export interface CompactionDeps {
  db: Db
  hub: Hub
  sessions: SessionManager
  /** Binario, entorno y modelo con que corre la sesión (para leer la conversación en una copia aparte). */
  launchFor: (session: SessionRecord) => { bin: string; env: Record<string, string>; model: string | null }
}

/** Si el borrador se armó con bastante menos contexto que el actual, conviene rehacerlo. */
const STALE_TOKENS = 0.1
/** Avisamos cuando el contexto llega a esta fracción de donde compacta solo. */
const WARN_AT = 0.85

/**
 * La compactación moldeable: arma un borrador del resumen punto por punto (preguntándole a la propia
 * sesión, sin tocar la conversación), deja elegir qué sobrevive y se lo pasa a la compactación de
 * Claude Code como instrucciones. Con el modo "esperarme", el hook PreCompact frena la compactación
 * automática hasta que elegís (o se vence el tiempo).
 */
export class Compaction {
  private entries = new Map<string, Entry>()
  private deps: CompactionDeps

  constructor(deps: CompactionDeps) {
    this.deps = deps
    deps.sessions.on("context", (id, usage) => this.onContext(id, usage))
    deps.sessions.on("compacted", (id, eventId) => this.onCompacted(id, eventId))
    deps.sessions.on("compactFailed", (id) => this.onFailed(id))
    deps.sessions.on("turnEnd", (rec, info) => {
      const e = this.entries.get(rec.id)
      // Si el turno terminó y la compactación no llegó a pasar (falló o se canceló), no queda "aplicando".
      if (e?.applying && !e.waiting) {
        e.applying = null
        this.broadcast(rec.id)
      }
      if (e?.resendOnTurnEnd) {
        e.resendOnTurnEnd = false
        e.compactingForResend = false
        e.resend = false
        this.deps.sessions.setHold(rec.id, null)
        this.broadcast(rec.id)
        void this.deps.sessions.resendUnsent(rec.id).catch((err: unknown) => this.notice(rec.id, "warn", `No pude reenviar el mensaje: ${errorMessage(err)}`))
      } else if (e?.compactingForResend && info.local) {
        // El /compact terminó sin compactar (por ejemplo, "No messages to compact"): el mensaje sigue sin salir.
        e.compactingForResend = false
        this.notice(rec.id, "warn", "No se pudo compactar, así que el mensaje no salió. Probá de nuevo, o empezá la sesión de cero.")
        this.broadcast(rec.id)
      } else if (info.contextFull) this.onContextFull(rec, info)
      else if (e?.resend && info.ok && !info.local) {
        // Siguió por otro lado (mandaste otra cosa y entró): el mensaje viejo ya no se reenvía.
        e.resend = false
        this.deps.sessions.setHold(rec.id, null)
        this.broadcast(rec.id)
      }
    })
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id)
    if (!e) {
      e = {
        draft: null,
        drafting: null,
        error: null,
        waiting: null,
        applying: null,
        retry: null,
        warned: false,
        resend: false,
        resendOnTurnEnd: false,
        compactingForResend: false,
      }
      this.entries.set(id, e)
    }
    return e
  }

  view(id: string): CompactionState {
    const e = this.entries.get(id)
    return {
      sessionId: id,
      draft: e?.draft ?? null,
      drafting: Boolean(e?.drafting),
      error: e?.error ?? null,
      waiting: e?.waiting ? { since: e.waiting.since, deadline: e.waiting.deadline } : null,
      applying: Boolean(e?.applying),
      resendPending: Boolean(e?.resend || e?.resendOnTurnEnd),
    }
  }

  list(): CompactionState[] {
    return [...this.entries.keys()].map((id) => this.view(id)).filter((s) => s.draft || s.drafting || s.error || s.waiting || s.applying || s.resendPending)
  }

  private broadcast(id: string) {
    this.deps.hub.broadcast({ type: "compaction", state: this.view(id) })
  }

  private session(id: string): SessionRecord {
    const rec = this.deps.db.getSession(id)
    if (!rec || rec.archivedAt) throw new Error("La sesión no existe")
    return rec
  }

  // ------------------------------------------------------------- borrador

  /**
   * Arma el borrador. Lo normal es preguntarle a la sesión (side_question: usa su contexto y su
   * caché, y no queda en la conversación). Mientras compacta no responde, así que en ese caso se lee
   * la conversación en una copia aparte que no se guarda.
   */
  draft(id: string): Promise<void> {
    const rec = this.session(id)
    const e = this.entry(id)
    if (e.drafting) return e.drafting
    e.error = null
    const tokens = this.deps.sessions.contextOf(id)?.tokens ?? null
    e.drafting = (async () => {
      try {
        const raw = e.waiting ? await this.askFork(rec) : await this.askSession(id)
        e.draft = { sections: parseDraft(raw), createdAt: now(), contextTokens: tokens }
      } catch (err) {
        const msg = errorMessage(err)
        e.error = /prompt is too long/i.test(msg)
          ? "El contexto está tan lleno que Claude no puede armar el borrador. Compactá sin revisar, o escribí abajo qué tiene que conservar el resumen."
          : msg
      } finally {
        e.drafting = null
        this.broadcast(id)
      }
    })()
    this.broadcast(id)
    return e.drafting
  }

  private async askSession(id: string): Promise<string> {
    const r = await this.deps.sessions.control(id, "side_question", { question: DRAFT_QUESTION }, 300_000)
    const text = typeof r.response === "string" ? r.response : ""
    if (!text || r.synthetic === true) throw new Error("La sesión no pudo armar el borrador. Probá de nuevo en un momento.")
    return text
  }

  private async askFork(rec: SessionRecord): Promise<string> {
    const { bin, env, model } = this.deps.launchFor(rec)
    const args = [
      "-p",
      DRAFT_QUESTION,
      "--resume",
      rec.claudeSessionId,
      "--fork-session",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--settings",
      JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
      ...(model ? ["--model", model] : []),
    ]
    const { stdout } = await run(bin, args, { cwd: rec.cwd, env: childEnv(env), timeout: 300_000, maxBuffer: 32 * 1024 * 1024 })
    const out = JSON.parse(stdout) as { result?: string; is_error?: boolean }
    if (out.is_error || !out.result) throw new Error(oneLine(out.result || "No se pudo leer la conversación para armar el borrador", 300))
    return out.result
  }

  discard(id: string) {
    const e = this.entries.get(id)
    if (!e || e.waiting) return
    e.draft = null
    e.error = null
    this.broadcast(id)
  }

  // ------------------------------------------------------------- compactar

  /** Compacta con tu selección: si la sesión estaba esperando, sigue; si no, le manda /compact. */
  async apply(id: string, sel: CompactionSelection) {
    this.session(id)
    const e = this.entry(id)
    const { text, kept, dropped } = compactInstructions(sel)
    if (!kept && !sel.extra?.trim()) throw new Error("Conservá al menos un punto (o escribí instrucciones)")
    e.applying = { text, kept, dropped }
    if (e.waiting) {
      this.finishWait(id, text)
      return
    }
    await this.pinResend(id)
    try {
      await this.deps.sessions.send(id, `/compact ${text}`, {
        origin: "control",
        event: { kind: "notice", level: "info", text: sel.sections.length ? compactNotice(kept, dropped) : "Compactando con tus instrucciones." },
      })
    } catch (err) {
      e.applying = null
      this.broadcast(id)
      throw err
    }
    this.broadcast(id)
  }

  /** Compacta sin revisar (como /compact). Si estaba esperando, deja que Claude decida. */
  async direct(id: string) {
    this.session(id)
    const e = this.entry(id)
    if (e.waiting) {
      this.finishWait(id, "")
      return
    }
    await this.pinResend(id)
    await this.deps.sessions.send(id, "/compact", { origin: "user" })
  }

  /** Si el último mensaje no entró, que salga después de esta compactación (también tras reiniciar el server). */
  private async pinResend(id: string) {
    const e = this.entry(id)
    if (e.resend || (await this.deps.sessions.holdUnsent(id))) {
      e.resend = true
      e.compactingForResend = true
    }
  }

  private finishWait(id: string, text: string, reason: "chosen" | "timeout" | "closed" = "chosen") {
    const e = this.entries.get(id)
    const w = e?.waiting
    if (!e || !w) return
    clearTimeout(w.timer)
    e.waiting = null
    for (const resolve of w.resolvers) resolve(text)
    this.deps.sessions.setHold(id, null)
    if (reason === "timeout") {
      this.deps.sessions.addEvent(id, {
        kind: "notice",
        level: "info",
        text: "No elegiste a tiempo qué conservar: Claude compactó el contexto como siempre.",
      })
    }
    this.broadcast(id)
  }

  // ------------------------------------------------------------- hooks

  /**
   * Hook de Claude Code (PreCompact / PostCompact). Devuelve el texto que el hook imprime:
   * para PreCompact, Claude Code lo suma a las instrucciones del resumen.
   */
  hook(token: string, input: Record<string, unknown>, onClose: (cb: () => void) => void): Promise<string> {
    const rec = this.deps.db.getSessionByToken(token)
    if (!rec || input.hook_event_name !== "PreCompact") return Promise.resolve("")
    // Las compactaciones pedidas a mano ya traen sus instrucciones (/compact …).
    if (input.trigger !== "auto") return Promise.resolve("")
    // Si tu selección no llegó a aplicarse (la compactación falló), se usa en este intento.
    const e = this.entries.get(rec.id)
    if (e?.retry && now() - e.retry.at < RETRY_MS) {
      e.applying = { text: e.retry.text, kept: e.retry.kept, dropped: e.retry.dropped }
      this.deps.sessions.addEvent(rec.id, {
        kind: "notice",
        level: "info",
        text: `Se compacta con la selección que elegiste antes: ${selectionSummary(e.retry.kept, e.retry.dropped)}.`,
      })
      this.broadcast(rec.id)
      return Promise.resolve(e.retry.text)
    }
    const project = this.deps.db.getProject(rec.projectId)
    if (!project || project.settings.compactMode !== "ask") return Promise.resolve("")
    return this.waitForChoice(rec, project.settings.compactWaitMin, onClose)
  }

  private waitForChoice(rec: SessionRecord, minutes: number, onClose: (cb: () => void) => void): Promise<string> {
    const e = this.entry(rec.id)
    const ms = Math.min(45, Math.max(1, minutes)) * 60_000
    const promise = new Promise<string>((resolve) => {
      if (!e.waiting) {
        const since = now()
        e.waiting = {
          since,
          deadline: since + ms,
          timer: setTimeout(() => this.finishWait(rec.id, "", "timeout"), ms),
          resolvers: new Set(),
        }
        this.deps.sessions.setHold(rec.id, "Por compactar: elegí qué conservar")
        this.deps.hub.broadcast({
          type: "toast",
          event: "compaction",
          level: "warn",
          title: `${rec.name} va a compactar el contexto`,
          body: `Elegí qué conservar. Si no, compacta como siempre en ${Math.round(ms / 60_000)} min.`,
          projectId: rec.projectId,
          sessionId: rec.id,
          open: "compaction",
        })
        const d = e.draft
        const ctx = this.deps.sessions.contextOf(rec.id)
        const stale = !d || (ctx && d.contextTokens !== null && ctx.tokens - d.contextTokens > ctx.max * STALE_TOKENS)
        if (stale && !e.drafting) void this.draft(rec.id)
        this.broadcast(rec.id)
      }
      const w = e.waiting!
      w.resolvers.add(resolve)
      // Si Claude Code cortó el hook (sesión detenida, precálculo descartado), esa espera se libera.
      onClose(() => {
        if (!w.resolvers.delete(resolve)) return
        resolve("")
        if (w.resolvers.size === 0 && e.waiting === w) this.finishWait(rec.id, "", "closed")
      })
    })
    return promise
  }

  // ------------------------------------------------------------- eventos

  /** El contexto se está llenando: te avisa (y en modo "esperarme" prepara el borrador). */
  private onContext(id: string, usage: ContextUsage) {
    const rec = this.deps.db.getSession(id)
    const project = rec ? this.deps.db.getProject(rec.projectId) : null
    if (!rec || !project || project.settings.compactMode === "auto" || !usage.autoCompact) return
    const limit = Math.min(usage.threshold ?? usage.max, usage.max)
    const e = this.entry(id)
    if (e.warned || usage.tokens < limit * WARN_AT) return
    e.warned = true
    const pct = Math.round((usage.tokens / usage.max) * 100)
    this.deps.hub.broadcast({
      type: "toast",
      event: "compaction",
      level: "info",
      title: `${rec.name} va por el ${pct}% del contexto`,
      body: "Pronto va a compactar. Si querés, elegí ahora qué conservar.",
      projectId: rec.projectId,
      sessionId: rec.id,
      open: "compaction",
    })
    if (project.settings.compactMode === "ask" && !e.draft && !e.drafting) void this.draft(id)
  }

  private onCompacted(id: string, eventId: number) {
    const e = this.entries.get(id)
    if (!e) return
    const stored = this.deps.db.getEvent(eventId)
    if (stored && stored.event.kind === "compact" && e.applying && (e.applying.kept || e.applying.dropped)) {
      stored.event = { ...stored.event, kept: e.applying.kept, dropped: e.applying.dropped } as TimelineEvent
      this.deps.db.updateEvent(stored)
      this.deps.hub.broadcast({ type: "event_update", event: stored })
    }
    this.entries.set(id, {
      draft: null,
      drafting: e.drafting,
      error: null,
      waiting: e.waiting,
      applying: null,
      retry: null,
      warned: false,
      resend: false,
      resendOnTurnEnd: e.resend || e.resendOnTurnEnd,
      compactingForResend: e.compactingForResend,
    })
    this.broadcast(id)
  }

  /** La compactación falló: si era con tu selección, queda guardada para el próximo intento. */
  private onFailed(id: string) {
    const e = this.entries.get(id)
    if (!e?.applying) return
    e.retry = { ...e.applying, at: now() }
    e.applying = null
    this.deps.sessions.addEvent(id, {
      kind: "notice",
      level: "info",
      text: "Tu selección quedó guardada: se usa sola la próxima vez que Claude compacte esta sesión.",
    })
    this.broadcast(id)
  }

  // ------------------------------------------------------------- contexto lleno

  /**
   * Claude Code no mandó el mensaje porque la conversación ya no entra ("Prompt is too long") y no
   * compactó solo (le pasa sin terminal). Hacemos lo que hubiera hecho: compactar con /compact, que
   * sí puede con una conversación pasada del límite, y reenviar. En modo "esperarme" elegís vos cómo.
   */
  private onContextFull(rec: SessionRecord, info: TurnEndInfo) {
    const project = this.deps.db.getProject(rec.projectId)
    const ctx = this.deps.sessions.contextOf(rec.id)
    const pct = ctx ? ` (${Math.round((ctx.tokens / ctx.max) * 100)}%)` : ""
    const e = this.entry(rec.id)
    if (info.retried) {
      e.resend = false
      this.notice(rec.id, "warn", "Tampoco entró después de compactar: puede que el mensaje solo sea demasiado largo. Probá mandarlo en partes.")
      this.broadcast(rec.id)
      return
    }
    e.resend = true
    if (project?.settings.compactMode === "ask") {
      this.notice(rec.id, "warn", `El contexto está lleno${pct} y el mensaje no salió. Elegí qué conservar al compactar (o compactá directo) y lo reenvío solo.`)
      this.deps.sessions.setHold(rec.id, "Contexto lleno: compactá para seguir")
      this.deps.hub.broadcast({
        type: "toast",
        event: "compaction",
        level: "warn",
        title: `${rec.name} tiene el contexto lleno`,
        body: "El mensaje no salió. Compactá y se reenvía solo.",
        projectId: rec.projectId,
        sessionId: rec.id,
        open: "compaction",
      })
      this.broadcast(rec.id)
      return
    }
    this.notice(rec.id, "info", `El contexto se llenó${pct} y Claude Code no compactó solo: compacto la conversación y reenvío el mensaje.`)
    void this.compactAndResend(rec.id).catch((err: unknown) => this.notice(rec.id, "warn", `No pude compactar: ${errorMessage(err)}`))
  }

  /** Compacta como /compact y, cuando termina, reenvía lo que no había entrado. */
  async compactAndResend(id: string) {
    this.session(id)
    if (!(await this.deps.sessions.holdUnsent(id))) throw new Error("No hay un mensaje sin enviar")
    const e = this.entry(id)
    e.resend = true
    e.compactingForResend = true
    this.broadcast(id)
    try {
      await this.deps.sessions.send(id, "/compact", { origin: "control", event: { kind: "notice", level: "info", text: "Compactando para que entre el mensaje…" } })
    } catch (err) {
      e.compactingForResend = false
      this.broadcast(id)
      throw err
    }
  }

  private notice(id: string, level: "info" | "warn", text: string) {
    this.deps.sessions.addEvent(id, { kind: "notice", level, text })
  }

  /** Al apagar el server: nadie queda esperando (las sesiones compactan como siempre). */
  dispose() {
    for (const id of this.entries.keys()) this.finishWait(id, "", "closed")
  }
}

function selectionSummary(kept: number, dropped: number) {
  const k = kept === 1 ? "1 punto se conserva" : `${kept} puntos se conservan`
  const d = dropped ? (dropped === 1 ? ", 1 se descarta" : `, ${dropped} se descartan`) : ""
  return k + d
}

export function compactNotice(kept: number, dropped: number) {
  return `Compactando con tu selección: ${selectionSummary(kept, dropped)}.`
}
