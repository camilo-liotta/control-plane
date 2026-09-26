import { Download, ExternalLink, File, FileCode, FileSpreadsheet, FileText } from "lucide-react"

import type { AttachmentRef } from "@shared/types"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { attachmentUrl } from "@/lib/api"
import { formatSize, VISION_TYPES } from "@/lib/files"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

export const isImage = (a: { mime: string }) => VISION_TYPES.has(a.mime) || a.mime === "image/svg+xml"

function fileIcon(a: AttachmentRef) {
  if (/pdf|text|markdown/.test(a.mime) || /\.(md|txt|pdf)$/i.test(a.name)) return FileText
  if (/csv|sheet|excel/.test(a.mime) || /\.(csv|xlsx?)$/i.test(a.name)) return FileSpreadsheet
  if (/json|javascript|typescript|xml|yaml|sql/.test(a.mime) || /\.(ts|tsx|js|py|sql|json|ya?ml)$/i.test(a.name)) return FileCode
  return File
}

export function ImageThumb({ att, className }: { att: AttachmentRef; className?: string }) {
  const setUi = useUi((s) => s.set)
  return (
    <button
      type="button"
      onClick={() => setUi({ lightbox: { id: att.id, name: att.name } })}
      className={cn(
        "group/thumb relative overflow-hidden rounded-lg border bg-muted/40 transition hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
        className
      )}
      title={att.name}
    >
      <img src={attachmentUrl(att.id)} alt={att.name} loading="lazy" className="size-full object-cover" />
    </button>
  )
}

export function FileChip({ att, className }: { att: AttachmentRef; className?: string }) {
  const Icon = fileIcon(att)
  return (
    <a
      href={attachmentUrl(att.id)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted",
        className
      )}
      title={`Abrir ${att.name}`}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{att.name}</span>
      <span className="shrink-0 text-muted-foreground">{formatSize(att.size)}</span>
    </a>
  )
}

/** Adjuntos de un mensaje: imágenes en miniatura y archivos como fichas. */
export function AttachmentList({ items, align = "end" }: { items: AttachmentRef[]; align?: "start" | "end" }) {
  const images = items.filter(isImage)
  const files = items.filter((a) => !isImage(a))
  return (
    <div className={cn("flex max-w-[85%] flex-col gap-1.5", align === "end" ? "items-end" : "items-start")}>
      {images.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", align === "end" && "justify-end")}>
          {images.map((a) => (
            <ImageThumb key={a.id} att={a} className={images.length === 1 ? "max-h-64 max-w-80" : "size-24"} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", align === "end" && "justify-end")}>
          {files.map((a) => (
            <FileChip key={a.id} att={a} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Imagen en grande. */
export function Lightbox() {
  const lightbox = useUi((s) => s.lightbox)
  const setUi = useUi((s) => s.set)
  return (
    <Dialog open={Boolean(lightbox)} onOpenChange={(v) => !v && setUi({ lightbox: null })}>
      <DialogContent className="max-h-[92svh] gap-3 sm:max-w-5xl">
        {lightbox && (
          <>
            <div className="flex items-center gap-2 pr-8">
              <DialogTitle className="truncate text-sm">{lightbox.name}</DialogTitle>
              <DialogDescription className="sr-only">Imagen adjunta</DialogDescription>
              {lightbox.id && (
                <div className="ml-auto flex gap-1">
                  <Button asChild size="sm" variant="ghost">
                    <a href={attachmentUrl(lightbox.id)} target="_blank" rel="noreferrer">
                      <ExternalLink />
                      Abrir
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <a href={attachmentUrl(lightbox.id, true)}>
                      <Download />
                      Descargar
                    </a>
                  </Button>
                </div>
              )}
            </div>
            <div className="flex min-h-0 items-center justify-center overflow-auto rounded-lg bg-muted/40">
              <img
                src={lightbox.src ?? (lightbox.id ? attachmentUrl(lightbox.id) : undefined)}
                alt={lightbox.name}
                className="max-h-[78svh] w-auto object-contain"
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
