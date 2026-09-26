import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { childEnv } from "./claude/env.ts"
import { config } from "./config.ts"
import type { AccountRecord, Db } from "./db.ts"
import type { Account, AccountAuth, UsageInfo } from "./shared/types.ts"
import { errorMessage, now, shortId } from "./util.ts"

const run = promisify(execFile)

const expandHome = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p)

/**
 * Cuentas de Claude Code. Cada una es un directorio de configuración (lo que usa CLAUDE_CONFIG_DIR):
 * ahí viven su login, sus settings, sus transcripts y el registro de sesiones vivas.
 */
export class Accounts {
  private db: Db
  private auth = new Map<string, { at: number; value: AccountAuth }>()
  readonly defaultDir = path.resolve(expandHome(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")))

  constructor(db: Db) {
    this.db = db
  }

  dir(a: AccountRecord): string {
    return a.configDir ? path.resolve(expandHome(a.configDir)) : this.defaultDir
  }

  isDefault(a: AccountRecord): boolean {
    return this.dir(a) === this.defaultDir
  }

  /**
   * Variables para lanzar Claude Code con esta cuenta. La de siempre no define nada:
   * en macOS, poner CLAUDE_CONFIG_DIR apuntando a ~/.claude cambia dónde busca el login en el llavero.
   */
  env(a: AccountRecord): Record<string, string> {
    return this.isDefault(a) ? {} : { CLAUDE_CONFIG_DIR: this.dir(a) }
  }

  bin(a: AccountRecord): string {
    return a.bin?.trim() || config.claudeBin
  }

  settingsFile(a: AccountRecord): string {
    return path.join(this.dir(a), "settings.json")
  }

  /** Config global (la que /config guarda para IDE y copiado): ~/.claude.json, o adentro del directorio con CLAUDE_CONFIG_DIR. */
  globalConfigFile(a: AccountRecord): string {
    if (this.isDefault(a) && !process.env.CLAUDE_CONFIG_DIR) return path.join(os.homedir(), ".claude.json")
    return path.join(this.dir(a), ".claude.json")
  }

  list(): AccountRecord[] {
    return this.db.listAccounts()
  }

  get(id: string): AccountRecord | null {
    return this.db.getAccount(id)
  }

  defaultAccount(): AccountRecord {
    const list = this.list()
    return list.find((a) => this.isDefault(a)) ?? list[0]!
  }

  forProject(projectId: string): AccountRecord {
    const p = this.db.getProject(projectId)
    return (p?.accountId ? this.get(p.accountId) : null) ?? this.defaultAccount()
  }

  /** La primera vez crea la cuenta de siempre y le asigna los proyectos que ya existían. */
  async ensureDefault() {
    if (!this.list().some((a) => this.isDefault(a))) {
      const rec: AccountRecord = { id: shortId("acc_"), name: "Principal", configDir: null, bin: null, createdAt: now() }
      this.db.insertAccount(rec)
      const auth = await this.authStatus(rec, true)
      const name = auth.organization || auth.email?.split("@")[0]
      if (name) this.db.updateAccount(rec.id, { name })
    }
    this.db.assignOrphanProjects(this.defaultAccount().id)
  }

  create(input: { name: string; configDir: string; bin?: string | null }): AccountRecord {
    const dir = path.resolve(expandHome(input.configDir.trim()))
    if (!input.configDir.trim()) throw new Error("Falta el directorio de configuración")
    if (this.list().some((a) => this.dir(a) === dir)) throw new Error("Ya hay una cuenta con ese directorio")
    const rec: AccountRecord = {
      id: shortId("acc_"),
      name: input.name.trim() || path.basename(dir).replace(/^\.claude-?/, "") || "Cuenta",
      configDir: dir === this.defaultDir ? null : dir,
      bin: input.bin?.trim() || null,
      createdAt: now(),
    }
    this.db.insertAccount(rec)
    return rec
  }

  update(id: string, patch: { name?: string; bin?: string | null }) {
    const a = this.get(id)
    if (!a) throw new Error("La cuenta no existe")
    this.db.updateAccount(id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() || a.name } : {}),
      ...(patch.bin !== undefined ? { bin: patch.bin?.trim() || null } : {}),
    })
    if (patch.bin !== undefined) this.auth.delete(id)
  }

  remove(id: string) {
    const a = this.get(id)
    if (!a) throw new Error("La cuenta no existe")
    if (this.isDefault(a)) throw new Error("La cuenta de siempre no se puede quitar")
    if (this.db.countProjectsByAccount(id)) throw new Error("La cuenta tiene proyectos activos: archivalos antes de quitarla")
    this.db.deleteAccount(id)
    this.auth.delete(id)
  }

  /** Con qué cuenta está logueado ese directorio (claude auth status). Se cachea un minuto. */
  async authStatus(a: AccountRecord, force = false): Promise<AccountAuth> {
    const cached = this.auth.get(a.id)
    if (cached && !force && now() - cached.at < 60_000) return cached.value
    let value: AccountAuth
    try {
      const { stdout } = await run(this.bin(a), ["auth", "status"], {
        env: childEnv(this.env(a)),
        timeout: 20_000,
      })
      const s = JSON.parse(stdout) as {
        loggedIn?: boolean
        email?: string
        orgName?: string
        subscriptionType?: string
        authMethod?: string
      }
      value = {
        loggedIn: Boolean(s.loggedIn),
        email: s.email,
        organization: s.orgName,
        subscription: s.subscriptionType,
        method: s.authMethod,
      }
    } catch (err) {
      value = { loggedIn: false, error: errorMessage(err).split("\n")[0] }
    }
    this.auth.set(a.id, { at: now(), value })
    return value
  }

  /** Lo que informa una sesión al arrancar (más fresco que auth status). */
  rememberAuth(accountId: string, info: { email?: string; organization?: string; subscription?: string }) {
    const prev = this.auth.get(accountId)?.value
    this.auth.set(accountId, { at: now(), value: { ...prev, loggedIn: true, ...info } })
  }

  cachedAuth(id: string): AccountAuth | null {
    return this.auth.get(id)?.value ?? null
  }

  /** Directorios ~/.claude-* con pinta de configuración de Claude Code que todavía no son cuentas. */
  detect(): { configDir: string; name: string }[] {
    const home = os.homedir()
    const known = new Set(this.list().map((a) => this.dir(a)))
    let entries: string[] = []
    try {
      entries = fs.readdirSync(home)
    } catch {
      return []
    }
    return entries
      .filter((n) => /^\.claude(-[\w.-]+)?$/.test(n))
      .map((n) => path.join(home, n))
      .filter((dir) => {
        try {
          if (!fs.statSync(dir).isDirectory() || known.has(dir)) return false
          return ["settings.json", ".claude.json", "projects", ".credentials.json"].some((f) => fs.existsSync(path.join(dir, f)))
        } catch {
          return false
        }
      })
      .map((dir) => {
        const suffix = path.basename(dir).replace(/^\.claude-?/, "")
        return { configDir: dir, name: suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1) : "Claude" }
      })
  }

  view(a: AccountRecord, usage: UsageInfo | null): Account {
    return {
      id: a.id,
      name: a.name,
      configDir: this.dir(a),
      isDefault: this.isDefault(a),
      bin: a.bin,
      auth: this.cachedAuth(a.id),
      usage,
      projects: this.db.countProjectsByAccount(a.id),
    }
  }
}
