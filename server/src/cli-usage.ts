import fs from "node:fs"
import path from "node:path"

/**
 * Qué programas usan tus sesiones: se lee de los transcripts de Claude Code (los comandos que corrió
 * la herramienta Bash y los "command not found" de sus resultados). Se lee de a poco: cada archivo
 * desde donde quedó la vez anterior.
 */

/** Lo básico de cualquier shell: no son "CLIs" que valga la pena mostrar. */
const BASIC = new Set(
  (
    "cd ls cat echo printf grep egrep fgrep sed awk head tail wc sort uniq cut tr xargs find mkdir rmdir rm cp mv touch chmod chown ln " +
    "pwd env export source test true false sleep date which command type timeout tee diff file stat du df ps kill pkill pgrep curl wget " +
    "tar gzip gunzip unzip zip git node npm npx python python3 pip pip3 bash sh zsh set unset read for while if then else elif do done " +
    "fi case esac exit return local basename dirname realpath readlink seq bc less more man history open xdg-open clear time nohup exec " +
    "sudo eval trap wait jobs bg fg alias unalias printenv id whoami uname hostname tree mktemp nl rev base64 md5sum sha256sum shasum " +
    "od hexdump strings column paste join comm split fold expand fmt sleep yes watch lsof ss netstat ping dig nslookup host ssh scp rsync " +
    "claude ssh-keygen perl cmp shred xxd nproc dpkg lsb_release free findmnt strip apt apt-get snap brew systemctl journalctl service " +
    "make cmake gcc g++ cc tsx tsc vite node24 until break continue function select in declare typeset let shift getopts [ [[ { } ( ) ! : ."
  ).split(/\s+/)
)

export interface ProgramUse {
  name: string
  count: number
  lastAt: number
  projects: Set<string>
}

export interface UsageSnapshot {
  used: Map<string, ProgramUse>
  missing: Map<string, ProgramUse>
}

/** Los programas de un comando de shell: el primero de cada tramo (&&, ||, ;, |, saltos de línea). */
export function programsIn(command: string): string[] {
  const out: string[] = []
  // El cuerpo de un heredoc y lo que va entre comillas (un python -c "…") no son comandos.
  const bare = command
    .replace(/\\\r?\n/g, " ")
    .replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, " ")
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
  // Las funciones que define el propio comando (run() { … }) no son programas.
  const own = new Set([...bare.matchAll(/(?:^|[\s;{(])(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/g)].map((m) => m[1]!))
  for (const raw of bare.replace(/\$\(|`/g, "\n").split(/&&|\|\||;|\||\n/)) {
    const words = raw.trim().replace(/^[({!\s]+/, "").split(/\s+/)
    let i = 0
    // VAR=valor, sudo/env/time/nohup/exec/command, timeout 30: lo que viene después es el programa.
    while (i < words.length) {
      const w = words[i]!
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || ["sudo", "env", "time", "nohup", "exec", "command", "builtin"].includes(w)) i++
      else if (w === "timeout" && /^\d/.test(words[i + 1] ?? "")) i += 2
      else break
    }
    let w = (words[i] ?? "").replace(/^["']|["']$/g, "")
    if (!w || w.startsWith("-") || w.startsWith("$")) continue
    if (w.includes("/")) {
      if (!w.startsWith("/")) continue // ./script, rutas relativas: son del repo, no CLIs
      w = path.basename(w)
    }
    if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(w) && !BASIC.has(w) && !own.has(w)) out.push(w)
  }
  return out
}

const NOT_FOUND = /(?:^|[\n:]\s*)([A-Za-z0-9][A-Za-z0-9._+-]*): (?:command )?not found/g

export class CliUsage {
  private offsets = new Map<string, number>()
  private used = new Map<string, ProgramUse>()
  private missing = new Map<string, ProgramUse>()
  private scanning: Promise<void> | null = null
  lastScan = 0

  private readonly opts: { dirs: () => { dir: string; label: string }[]; maxAgeDays?: number }

  constructor(opts: { dirs: () => { dir: string; label: string }[]; maxAgeDays?: number }) {
    this.opts = opts
  }

  get busy() {
    return this.scanning !== null
  }

  snapshot(): UsageSnapshot {
    return { used: this.used, missing: this.missing }
  }

  /** Lee lo nuevo de los transcripts. Si ya está leyendo, espera esa misma lectura. */
  scan(): Promise<void> {
    this.scanning ??= this.run().finally(() => {
      this.scanning = null
      this.lastScan = Date.now()
    })
    return this.scanning
  }

  private async run() {
    const since = Date.now() - (this.opts.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000
    for (const { dir, label } of this.opts.dirs()) {
      let files: string[]
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      } catch {
        continue
      }
      for (const f of files) {
        const file = path.join(dir, f)
        let stat: fs.Stats
        try {
          stat = fs.statSync(file)
        } catch {
          continue
        }
        if (stat.mtimeMs < since) continue
        await this.readFrom(file, stat.size, label)
      }
    }
  }

  private async readFrom(file: string, size: number, label: string) {
    let offset = this.offsets.get(file) ?? 0
    if (offset > size) offset = 0 // el archivo se reescribió
    if (offset === size) return
    const fd = await fs.promises.open(file, "r")
    try {
      const CHUNK = 1024 * 1024
      let carry = ""
      let pos = offset
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos))
        const { bytesRead } = await fd.read(buf, 0, buf.length, pos)
        if (!bytesRead) break
        pos += bytesRead
        const text = carry + buf.subarray(0, bytesRead).toString("utf8")
        const lines = text.split("\n")
        carry = lines.pop() ?? ""
        for (const line of lines) this.line(line, label)
        offset = pos - Buffer.byteLength(carry)
      }
      this.offsets.set(file, offset)
    } finally {
      await fd.close()
    }
  }

  private line(line: string, label: string) {
    const bash = line.includes('"name":"Bash"')
    const notFound = line.includes("not found")
    if (!bash && !notFound) return
    let obj: { timestamp?: string; message?: { content?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }
    const at = obj.timestamp ? Date.parse(obj.timestamp) || 0 : 0
    const content = Array.isArray(obj.message?.content) ? (obj.message!.content as Record<string, unknown>[]) : []
    for (const b of content) {
      if (b.type === "tool_use" && b.name === "Bash") {
        const cmd = (b.input as { command?: unknown } | undefined)?.command
        if (typeof cmd === "string") for (const p of programsIn(cmd)) bump(this.used, p, at, label)
      } else if (b.type === "tool_result" && notFound) {
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("\n") : ""
        for (const m of text.matchAll(NOT_FOUND)) if (!BASIC.has(m[1]!)) bump(this.missing, m[1]!, at, label)
      }
    }
  }
}

function bump(map: Map<string, ProgramUse>, name: string, at: number, label: string) {
  let u = map.get(name)
  if (!u) {
    u = { name, count: 0, lastAt: 0, projects: new Set() }
    map.set(name, u)
  }
  u.count++
  if (at > u.lastAt) u.lastAt = at
  u.projects.add(label)
}
