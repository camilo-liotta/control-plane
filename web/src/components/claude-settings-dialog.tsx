import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { ClaudeSetting, ClaudeSettingValue } from "@shared/types"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { shortPath } from "@/lib/format"
import { useStore } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

function Row({ item, onChange }: { item: ClaudeSetting; onChange: (v: ClaudeSettingValue) => void }) {
  const changed = item.isSet && item.value !== item.defaultValue
  return (
    <div className="flex items-start gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{item.label}</span>
          {changed && <span className="size-1.5 rounded-full bg-status-working" title="Cambiado respecto del valor por defecto" />}
          {item.terminalOnly && (
            <span className="rounded-full bg-muted px-1.5 py-px text-[0.65rem] text-muted-foreground">en la terminal</span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{item.description}</p>
      </div>
      <div className="shrink-0 pt-0.5">
        {item.type === "boolean" ? (
          <Switch checked={item.value === true} onCheckedChange={(v) => onChange(v)} aria-label={item.label} />
        ) : (
          <Select value={String(item.value ?? "")} onValueChange={(v) => onChange(v)}>
            <SelectTrigger size="sm" className="w-52 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(item.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  )
}

/** Las opciones del /config de Claude Code, por cuenta. Se guardan donde las guarda el propio CLI. */
export function ClaudeSettingsDialog() {
  const accountId = useUi((s) => s.settingsForAccount)
  const setUi = useUi((s) => s.set)
  const account = useStore((s) => (accountId ? s.accounts[accountId] : undefined))
  const [data, setData] = useState<{ files: { user: string; global: string }; items: ClaudeSetting[] } | null>(null)

  useEffect(() => {
    if (!accountId) return
    setData(null)
    api.claudeSettings(accountId).then(setData, (err: Error) => toast.error(err.message))
  }, [accountId])

  const groups = useMemo(() => {
    const map = new Map<string, ClaudeSetting[]>()
    for (const item of data?.items ?? []) map.set(item.group, [...(map.get(item.group) ?? []), item])
    return [...map.entries()]
  }, [data])

  const change = async (item: ClaudeSetting, value: ClaudeSettingValue) => {
    if (!accountId) return
    const prev = data
    setData((d) => (d ? { ...d, items: d.items.map((i) => (i.key === item.key ? { ...i, value, isSet: true } : i)) } : d))
    try {
      const updated = await api.setClaudeSetting(accountId, item.key, value)
      setData((d) => (d ? { ...d, items: d.items.map((i) => (i.key === item.key ? updated : i)) } : d))
      toast.success(`${item.label}: guardado`, {
        description: item.file === "global" ? "Se aplica la próxima vez que abras Claude Code." : "Las sesiones abiertas lo toman al instante.",
      })
    } catch (err) {
      setData(prev)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open={Boolean(accountId)} onOpenChange={(v) => !v && setUi({ settingsForAccount: null })}>
      <DialogContent className="max-h-[90svh] gap-2 overflow-x-hidden overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configuración de Claude Code{account ? ` · ${account.name}` : ""}</DialogTitle>
          <DialogDescription>
            Las opciones del menú <code className="font-mono">/config</code>. Se guardan en{" "}
            <code className="font-mono break-all">{data ? shortPath(data.files.user) : "settings.json"}</code>
            {data ? (
              <>
                {" "}
                (las de IDE, en <code className="font-mono break-all">{shortPath(data.files.global)}</code>)
              </>
            ) : null}
            , igual que desde la terminal.
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <div className="space-y-3 py-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          groups.map(([group, items]) => (
            <section key={group} className="pt-3">
              <h3 className="eyebrow">{group}</h3>
              <div className={cn("divide-y")}>
                {items.map((item) => (
                  <Row key={item.key} item={item} onChange={(v) => void change(item, v)} />
                ))}
              </div>
            </section>
          ))
        )}
      </DialogContent>
    </Dialog>
  )
}
