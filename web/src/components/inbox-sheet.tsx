import { Inbox } from "lucide-react"
import { Link } from "wouter"

import { DraftCard } from "@/components/draft-card"
import { ReportCard } from "@/components/report-card"
import { SessionLamp } from "@/components/status"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className="eyebrow">{title}</h3>
        <span className="font-mono text-xs text-muted-foreground">{count}</span>
      </div>
      {children}
    </section>
  )
}

/** Todo lo que espera algo de vos, de todos los proyectos. */
export function InboxSheet() {
  const open = useUi((s) => s.inbox)
  const setUi = useUi((s) => s.set)
  const sessions = useStore((s) => s.sessions)
  const drafts = useStore((s) => s.drafts)
  const reports = useStore((s) => s.reports)
  const projects = useStore((s) => s.projects)

  const needs = Object.values(sessions).filter((s) => s.status === "needs_input")
  const ready = Object.values(drafts).filter((d) => d.state === "ready").sort((a, b) => a.createdAt - b.createdAt)
  const staged = Object.values(drafts).filter((d) => d.state === "staged")
  const queue = Object.values(reports)
    .filter((r) => r.state === "queued" || r.state === "in_review")
    .sort((a, b) => a.createdAt - b.createdAt)
  const empty = !needs.length && !ready.length && !staged.length && !queue.length
  const close = () => setUi({ inbox: false })

  return (
    <Sheet open={open} onOpenChange={(v) => setUi({ inbox: v })}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Bandeja</SheetTitle>
          <SheetDescription>Lo que espera una decisión tuya, en todos los proyectos.</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {empty && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>Nada pendiente</EmptyTitle>
                <EmptyDescription>
                  Cuando una sesión te necesite o la orquestadora proponga algo, aparece acá.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <Group title="Te necesitan" count={needs.length}>
            <div className="space-y-1.5">
              {needs.map((s) => (
                <Link
                  key={s.id}
                  href={`/p/${s.projectId}/s/${s.id}`}
                  onClick={close}
                  className="flex items-center gap-2.5 rounded-lg border border-status-attention/40 bg-status-attention/5 px-3 py-2 hover:bg-status-attention/10"
                >
                  <SessionLamp session={s} />
                  <span className="font-mono text-sm font-medium">{s.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {projects[s.projectId]?.name} · {s.pending?.kind === "permission" ? "pide una aprobación" : "tiene una pregunta"}
                  </span>
                </Link>
              ))}
            </div>
          </Group>
          <Group title="Propuestas listas para enviar" count={ready.length}>
            {ready.map((d) => (
              <div key={d.id} className="space-y-1">
                <p className="text-xs text-muted-foreground">{projects[d.projectId]?.name}</p>
                <DraftCard draft={d} compact />
              </div>
            ))}
          </Group>
          <Group title="En preparación" count={staged.length}>
            <p className="text-xs text-muted-foreground">
              La orquestadora las está revisando junto con la cola: se liberan cuando termine.
            </p>
            {staged.map((d) => (
              <DraftCard key={d.id} draft={d} compact />
            ))}
          </Group>
          <Group title="Cola de resultados" count={queue.length}>
            {queue.map((r) => (
              <div key={r.id} className="space-y-1">
                <p className="text-xs text-muted-foreground">{projects[r.projectId]?.name}</p>
                <ReportCard report={r} />
              </div>
            ))}
          </Group>
        </div>
      </SheetContent>
    </Sheet>
  )
}
