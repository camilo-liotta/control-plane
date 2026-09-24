import { diffLines } from "diff"
import { useMemo, useState } from "react"

import { cn } from "@/lib/utils"

interface Line {
  kind: "add" | "del" | "same"
  text: string
}

/** Sin esto, "hola" contra "hola\nchau" marca "hola" como cambiada por el salto final. */
const eol = (t: string) => (t && !t.endsWith("\n") ? t + "\n" : t)

function toLines(oldText: string, newText: string): Line[] {
  const out: Line[] = []
  for (const part of diffLines(eol(oldText), eol(newText))) {
    const lines = part.value.replace(/\n$/, "").split("\n")
    const kind: Line["kind"] = part.added ? "add" : part.removed ? "del" : "same"
    for (const text of lines) out.push({ kind, text })
  }
  return out
}

/** Recorta el contexto sin cambios a 3 líneas alrededor de cada cambio. */
function collapse(lines: Line[], context = 3): (Line | { kind: "gap"; count: number })[] {
  const keep = new Set<number>()
  lines.forEach((l, i) => {
    if (l.kind === "same") return
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j)
  })
  const out: (Line | { kind: "gap"; count: number })[] = []
  let gap = 0
  lines.forEach((l, i) => {
    if (keep.has(i) || l.kind !== "same") {
      if (gap) out.push({ kind: "gap", count: gap })
      gap = 0
      out.push(l)
    } else gap++
  })
  if (gap) out.push({ kind: "gap", count: gap })
  return out
}

export function diffStats(oldText: string, newText: string) {
  let add = 0
  let del = 0
  for (const part of diffLines(eol(oldText), eol(newText))) {
    const n = part.value.replace(/\n$/, "").split("\n").length
    if (part.added) add += n
    else if (part.removed) del += n
  }
  return { add, del }
}

export function DiffView({ oldText, newText, maxLines = 80 }: { oldText: string; newText: string; maxLines?: number }) {
  const [all, setAll] = useState(false)
  const rows = useMemo(() => collapse(toLines(oldText, newText)), [oldText, newText])
  const visible = all ? rows : rows.slice(0, maxLines)
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40 font-mono text-[0.75rem] leading-[1.55]">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {visible.map((row, i) =>
              row.kind === "gap" ? (
                <tr key={i} className="text-muted-foreground/70">
                  <td className="w-5 select-none" />
                  <td className="px-2 py-0.5 text-[0.7rem]">··· {row.count} líneas sin cambios</td>
                </tr>
              ) : (
                <tr
                  key={i}
                  className={cn(
                    row.kind === "add" && "bg-diff-add/12",
                    row.kind === "del" && "bg-diff-del/12"
                  )}
                >
                  <td
                    className={cn(
                      "w-5 pl-2 select-none",
                      row.kind === "add" && "text-diff-add",
                      row.kind === "del" && "text-diff-del",
                      row.kind === "same" && "text-muted-foreground/50"
                    )}
                  >
                    {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
                  </td>
                  <td className="pr-3 whitespace-pre">{row.text || " "}</td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
      {rows.length > maxLines && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="w-full border-t bg-background/60 py-1 text-[0.7rem] font-medium text-muted-foreground hover:text-foreground"
        >
          {all ? "Mostrar menos" : `Mostrar ${rows.length - maxLines} líneas más`}
        </button>
      )}
    </div>
  )
}
