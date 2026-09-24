const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto", style: "short" })

export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return ""
  const diff = Math.round((ts - now) / 1000)
  const abs = Math.abs(diff)
  if (abs < 45) return "recién"
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute")
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour")
  return rtf.format(Math.round(diff / 86_400), "day")
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
}

export function duration(ms: number): string {
  if (!ms || ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

export function usd(value: number): string {
  if (!value) return "US$ 0"
  return `US$ ${value.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 3 : 2 })}`
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Acorta rutas absolutas dentro del repo para que se lean mejor. */
export function shortPath(p: string, root?: string): string {
  if (root && p.startsWith(root)) return p.slice(root.length).replace(/^[\\/]/, "") || basename(p)
  const home = /^\/(home|Users)\/[^/]+/.exec(p)
  return home ? "~" + p.slice(home[0].length) : p
}

export function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}
