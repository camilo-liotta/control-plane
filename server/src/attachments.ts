import fs from "node:fs"
import path from "node:path"

import { config } from "./config.ts"
import type { AttachmentRecord, Db } from "./db.ts"
import type { AttachmentRef } from "./shared/types.ts"
import { now, shortId } from "./util.ts"

/** Tipos de imagen que Claude puede ver directamente en un mensaje. */
export const VISION_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
}

function safeName(name: string) {
  const base = path.basename(name).normalize("NFC").replace(/[^\p{L}\p{N}._ -]/gu, "_").trim()
  return base.slice(-120) || "archivo"
}

export const toRef = (a: AttachmentRecord): AttachmentRef => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })

/** Guarda los archivos que adjuntás (o las imágenes que devuelven las herramientas) en ~/.control-plane. */
export class AttachmentStore {
  private db: Db
  readonly root: string

  constructor(db: Db) {
    this.db = db
    this.root = path.join(config.home, "attachments")
  }

  save(sessionId: string, input: { name: string; mime: string; data: Buffer; source: "user" | "tool" }): AttachmentRecord {
    if (input.data.length > MAX_ATTACHMENT_BYTES) throw new Error("El archivo supera los 30 MB")
    const id = shortId("a_")
    let name = safeName(input.name)
    if (!path.extname(name) && EXT[input.mime]) name += EXT[input.mime]
    const dir = path.join(this.root, sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${id}-${name}`)
    fs.writeFileSync(file, input.data)
    const rec: AttachmentRecord = {
      id,
      sessionId,
      name,
      mime: input.mime || "application/octet-stream",
      size: input.data.length,
      path: file,
      source: input.source,
      createdAt: now(),
    }
    this.db.insertAttachment(rec)
    return rec
  }

  get(id: string) {
    return this.db.getAttachment(id)
  }

  /** Borra los archivos de una sesión eliminada. */
  removeSession(sessionId: string) {
    fs.rmSync(path.join(this.root, sessionId), { recursive: true, force: true })
  }
}
