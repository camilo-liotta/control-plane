import { Bot, Plus, Trash2 } from "lucide-react"

import type { SubagentSpec } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

const MODELS = [
  { value: "__inherit", label: "El del worker" },
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
]

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-muted px-1.5 py-px font-mono text-[0.65rem] text-muted-foreground">{children}</span>
}

/** Subagentes que la orquestadora le pide al worker, en modo lectura. */
export function SubagentSpecList({ specs }: { specs: SubagentSpec[] }) {
  if (!specs.length) return null
  return (
    <div className="mt-3 rounded-lg border bg-muted/30 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Bot className="size-3.5" />
        {specs.length === 1 ? "Pide 1 subagente" : `Pide ${specs.length} subagentes`}
      </div>
      <ul className="space-y-2">
        {specs.map((s) => (
          <li key={s.name} className="text-[0.82rem]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono font-semibold">{s.name}</span>
              {s.role && <span className="text-muted-foreground">· {s.role}</span>}
              {s.model && <Badge>{s.model}</Badge>}
              {s.background && <Badge>en paralelo</Badge>}
              {s.readOnly && <Badge>solo lectura</Badge>}
            </div>
            <p className="mt-0.5 leading-snug text-foreground/85">{s.task}</p>
            {s.rules.length > 0 && (
              <ul className="mt-0.5 list-disc pl-4 text-xs text-muted-foreground">
                {s.rules.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

const empty = (i: number): SubagentSpec => ({
  name: `subagente-${i}`,
  role: "",
  task: "",
  rules: [],
  model: null,
  background: true,
  readOnly: false,
})

/** Edición de los subagentes pedidos: nombre, rol, tarea, reglas, modelo y modo. */
export function SubagentSpecEditor({ specs, onChange }: { specs: SubagentSpec[]; onChange: (s: SubagentSpec[]) => void }) {
  const set = (i: number, patch: Partial<SubagentSpec>) => onChange(specs.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  return (
    <div className="space-y-2">
      {specs.map((s, i) => (
        <div key={i} className="space-y-2 rounded-lg border bg-muted/20 p-2.5">
          <div className="flex items-center gap-2">
            <Bot className="size-4 shrink-0 text-muted-foreground" />
            <Input
              value={s.name}
              onChange={(e) => set(i, { name: e.target.value })}
              placeholder="nombre"
              className="h-7 w-40 font-mono text-xs"
            />
            <Input value={s.role} onChange={(e) => set(i, { role: e.target.value })} placeholder="Rol (quién es)" className="h-7 text-xs" />
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              onClick={() => onChange(specs.filter((_, j) => j !== i))}
              aria-label={`Quitar ${s.name}`}
            >
              <Trash2 />
            </Button>
          </div>
          <Textarea
            value={s.task}
            onChange={(e) => set(i, { task: e.target.value })}
            placeholder="Tarea: qué tiene que hacer"
            className="min-h-14 text-xs"
          />
          <Textarea
            value={s.rules.join("\n")}
            onChange={(e) => set(i, { rules: e.target.value.split("\n") })}
            placeholder="Reglas o cláusulas, una por línea"
            className="min-h-10 text-xs"
          />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Select value={s.model ?? "__inherit"} onValueChange={(v) => set(i, { model: v === "__inherit" ? null : v })}>
              <SelectTrigger size="sm" className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1.5">
              <Switch checked={s.background} onCheckedChange={(v) => set(i, { background: v })} size="sm" />
              En paralelo
            </label>
            <label className="flex items-center gap-1.5">
              <Switch checked={s.readOnly} onCheckedChange={(v) => set(i, { readOnly: v })} size="sm" />
              Solo lectura
            </label>
          </div>
        </div>
      ))}
      <Button size="xs" variant="outline" onClick={() => onChange([...specs, empty(specs.length + 1)])}>
        <Plus />
        Agregar subagente
      </Button>
    </div>
  )
}

/** Limpia lo editado antes de mandarlo: reglas vacías fuera. */
export function cleanSpecs(specs: SubagentSpec[]): SubagentSpec[] {
  return specs.map((s) => ({ ...s, rules: s.rules.map((r) => r.trim()).filter(Boolean) })).filter((s) => s.task.trim())
}
