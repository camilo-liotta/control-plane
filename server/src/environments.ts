import type { CredentialRecord, Db, EnvironmentRecord, SessionRecord } from "./db.ts"
import type { Hub } from "./hub.ts"
import type { SessionManager } from "./sessions.ts"
import type { Credential, Environment } from "./shared/types.ts"
import { now, oneLine, shortId } from "./util.ts"

/**
 * Entornos del proyecto (locales o de staging) con sus credenciales de prueba, para que las sesiones
 * que levantan un entorno y crean usuarios dejen las credenciales en el dashboard y no en el chat.
 *
 * El secreto (contraseña o token) solo sale de acá por dos caminos: list_environments (la sesión lo
 * necesita para usarlo) y GET /api/credentials/:id/secret (la web, al mostrarlo o copiarlo). Ni el
 * snapshot, ni los avisos, ni el chat, ni el resumen de la app de escritorio lo llevan.
 */

export interface EnvironmentInput {
  name: string
  url?: string | null
  appId?: string | null
  notes?: string | null
}

export interface CredentialInput {
  name?: string
  username?: string | null
  secret?: string | null
  loginUrl?: string | null
  notes?: string | null
}

type By = SessionRecord | "user"

const text = (v: string | null | undefined, max: number) => (v === undefined ? undefined : v === null || !v.trim() ? null : v.trim().slice(0, max))
const label = (v: string, what: string) => {
  const s = oneLine(v, 80).trim()
  if (!s) throw new Error(`${what} necesita un nombre`)
  return s
}

function view(c: CredentialRecord): Credential {
  const { secret, ...rest } = c
  return { ...rest, hasSecret: Boolean(secret) }
}

export class Environments {
  private deps: { db: Db; hub: Hub; sessions?: Pick<SessionManager, "addEvent"> }

  constructor(deps: { db: Db; hub: Hub; sessions?: Pick<SessionManager, "addEvent"> }) {
    this.deps = deps
  }

  private full(e: EnvironmentRecord): Environment {
    return { ...e, credentials: this.deps.db.listCredentials(e.id).map(view) }
  }

  /** Los entornos con sus credenciales, sin los secretos (lo que ve la web). */
  list(projectId?: string): Environment[] {
    const live = new Set(this.deps.db.listProjects().map((p) => p.id))
    return this.deps.db
      .listEnvironments(projectId)
      .filter((e) => live.has(e.projectId))
      .map((e) => this.full(e))
  }

  private broadcast(id: string): Environment {
    const e = this.deps.db.getEnvironment(id)!
    const env = this.full(e)
    this.deps.hub.broadcast({ type: "environment", environment: env })
    return env
  }

  private project(projectId: string) {
    const p = this.deps.db.getProject(projectId)
    if (!p || p.archivedAt) throw new Error("El proyecto no existe")
    return p
  }

  private owned(by: By, projectId: string, what: string) {
    if (by !== "user" && by.projectId !== projectId) throw new Error(`${what} es de otro proyecto`)
  }

  private note(by: By, textLine: string) {
    if (by !== "user") this.deps.sessions?.addEvent(by.id, { kind: "notice", level: "info", text: textLine })
  }

  /** Crea el entorno o, si ya hay uno con ese nombre, lo actualiza. */
  setEnvironment(projectId: string, input: EnvironmentInput, by: By): { environment: Environment; created: boolean } {
    this.project(projectId)
    const name = label(input.name, "El entorno")
    const existing = this.deps.db.findEnvironment(projectId, name)
    if (existing) {
      this.deps.db.updateEnvironment(existing.id, { url: text(input.url, 500), appId: text(input.appId, 80), notes: text(input.notes, 1000), updatedAt: now() })
      return { environment: this.broadcast(existing.id), created: false }
    }
    const e: EnvironmentRecord = {
      id: shortId("e_"),
      projectId,
      name,
      url: text(input.url, 500) ?? null,
      appId: text(input.appId, 80) ?? null,
      notes: text(input.notes, 1000) ?? null,
      createdBy: by === "user" ? null : by.id,
      createdAt: now(),
      updatedAt: now(),
    }
    this.deps.db.insertEnvironment(e)
    this.note(by, `Creó el entorno "${name}".`)
    return { environment: this.broadcast(e.id), created: true }
  }

  /** Cambios de la web: también el nombre (que no choque con otro). */
  updateEnvironment(id: string, patch: Partial<EnvironmentInput>, by: By): Environment {
    const e = this.environment(id, by)
    const name = patch.name !== undefined ? label(patch.name, "El entorno") : undefined
    if (name && name.toLowerCase() !== e.name.toLowerCase() && this.deps.db.findEnvironment(e.projectId, name)) throw new Error(`Ya hay un entorno "${name}"`)
    this.deps.db.updateEnvironment(id, { name, url: text(patch.url, 500), appId: text(patch.appId, 80), notes: text(patch.notes, 1000), updatedAt: now() })
    return this.broadcast(id)
  }

  removeEnvironment(id: string, by: By) {
    const e = this.environment(id, by)
    this.deps.db.deleteEnvironment(id)
    this.deps.hub.broadcast({ type: "environment_removed", id, projectId: e.projectId })
  }

  private environment(id: string, by: By): EnvironmentRecord {
    const e = this.deps.db.getEnvironment(id)
    if (!e) throw new Error(`No existe el entorno ${id}`)
    this.owned(by, e.projectId, `El entorno ${id}`)
    return e
  }

  /** El entorno por nombre o id; las sesiones lo crean al dejar la primera credencial. */
  private resolveEnvironment(projectId: string, ref: string, by: By, create: boolean): EnvironmentRecord {
    const byId = this.deps.db.getEnvironment(ref)
    if (byId) {
      this.owned(by, byId.projectId, `El entorno ${ref}`)
      return byId
    }
    const found = this.deps.db.findEnvironment(projectId, ref.trim())
    if (found) return found
    if (!create) throw new Error(`No hay un entorno "${ref}" en el proyecto`)
    return this.deps.db.getEnvironment(this.setEnvironment(projectId, { name: ref }, by).environment.id)!
  }

  /** Agrega una credencial al entorno o, si ya hay una con ese nombre, la actualiza (no se duplica). */
  addCredential(projectId: string, environment: string, input: CredentialInput & { name: string }, by: By): { environment: Environment; credential: Credential; created: boolean } {
    this.project(projectId)
    const env = this.resolveEnvironment(projectId, environment, by, true)
    const name = label(input.name, "La credencial")
    const existing = this.deps.db.findCredential(env.id, name)
    if (existing) {
      // Mismo nombre: se actualiza la que estaba, sin renombrarla.
      this.patchCredential(existing, { ...input, name: undefined })
      this.note(by, `Actualizó la credencial "${existing.name}" del entorno "${env.name}".`)
      return { environment: this.broadcast(env.id), credential: view(this.deps.db.getCredential(existing.id)!), created: false }
    }
    const c: CredentialRecord = {
      id: shortId("k_"),
      environmentId: env.id,
      name,
      username: text(input.username, 300) ?? null,
      secret: input.secret?.length ? input.secret.slice(0, 4000) : null,
      loginUrl: text(input.loginUrl, 500) ?? null,
      notes: text(input.notes, 1000) ?? null,
      createdBy: by === "user" ? null : by.id,
      createdAt: now(),
      updatedAt: now(),
    }
    this.deps.db.insertCredential(c)
    this.note(by, `Dejó la credencial "${name}" en el entorno "${env.name}".`)
    if (by !== "user")
      this.deps.hub.broadcast({
        type: "toast",
        level: "info",
        title: `${by.name} dejó una credencial`,
        body: `${name} · ${env.name}`,
        projectId,
        sessionId: by.id,
        open: "environments",
      })
    return { environment: this.broadcast(env.id), credential: view(c), created: true }
  }

  private patchCredential(c: CredentialRecord, patch: CredentialInput) {
    const name = patch.name !== undefined ? label(patch.name, "La credencial") : undefined
    if (name && name.toLowerCase() !== c.name.toLowerCase() && this.deps.db.findCredential(c.environmentId, name)) throw new Error(`Ya hay una credencial "${name}" en ese entorno`)
    this.deps.db.updateCredential(c.id, {
      name,
      username: text(patch.username, 300),
      // Un secreto vacío lo borra; sin el campo, queda el que estaba.
      secret: patch.secret === undefined ? undefined : patch.secret?.length ? patch.secret.slice(0, 4000) : null,
      loginUrl: text(patch.loginUrl, 500),
      notes: text(patch.notes, 1000),
      updatedAt: now(),
    })
  }

  /** La credencial por id, o por entorno y nombre. */
  private credential(projectId: string, ref: { id?: string; environment?: string; name?: string }, by: By): { c: CredentialRecord; env: EnvironmentRecord } {
    if (ref.id) {
      const c = this.deps.db.getCredential(ref.id)
      if (!c) throw new Error(`No existe la credencial ${ref.id}`)
      const env = this.environment(c.environmentId, by)
      return { c, env }
    }
    if (!ref.environment || !ref.name) throw new Error("Decí cuál: el id, o el entorno y el nombre de la credencial")
    const env = this.resolveEnvironment(projectId, ref.environment, by, false)
    const c = this.deps.db.findCredential(env.id, ref.name.trim())
    if (!c) throw new Error(`No hay una credencial "${ref.name}" en el entorno "${env.name}"`)
    return { c, env }
  }

  updateCredential(projectId: string, ref: { id?: string; environment?: string; name?: string }, patch: CredentialInput, by: By): Credential {
    const { c, env } = this.credential(projectId, ref, by)
    this.patchCredential(c, patch)
    this.note(by, `Actualizó la credencial "${c.name}" del entorno "${env.name}".`)
    this.broadcast(env.id)
    return view(this.deps.db.getCredential(c.id)!)
  }

  removeCredential(projectId: string, ref: { id?: string; environment?: string; name?: string }, by: By) {
    const { c, env } = this.credential(projectId, ref, by)
    this.deps.db.deleteCredential(c.id)
    this.note(by, `Borró la credencial "${c.name}" del entorno "${env.name}".`)
    this.broadcast(env.id)
    return { name: c.name, environment: env.name }
  }

  /** El secreto de una credencial: solo para la web, al mostrarlo o copiarlo. */
  secret(id: string): string | null {
    const c = this.deps.db.getCredential(id)
    if (!c) throw new Error(`No existe la credencial ${id}`)
    return c.secret
  }

  /** Lo que ven las sesiones con list_environments: con los secretos, porque los necesitan para usarlos. */
  summary(projectId: string): string {
    const list = this.deps.db.listEnvironments(projectId)
    if (!list.length) return "No hay entornos cargados en este proyecto. Creá uno con set_environment o dejá una credencial con add_credential."
    const name = (id: string | null) => (id ? (this.deps.db.getSession(id)?.name ?? "?") : "el usuario")
    return list
      .map((e) => {
        const creds = this.deps.db.listCredentials(e.id)
        const head = [`## ${e.name} [${e.id}]`, e.url ? `URL: ${e.url}` : null, e.appId ? `app: ${e.appId}` : null, e.notes ? `notas: ${e.notes}` : null].filter(Boolean).join("\n")
        const rows = creds.length
          ? creds
              .map((c) =>
                [
                  `- ${c.name} [${c.id}]`,
                  c.username ? `usuario: ${c.username}` : null,
                  c.secret ? `secreto: ${c.secret}` : "sin secreto",
                  c.loginUrl ? `login: ${c.loginUrl}` : null,
                  c.notes ? `notas: ${c.notes}` : null,
                  `la dejó ${name(c.createdBy)}`,
                ]
                  .filter(Boolean)
                  .join(" | ")
              )
              .join("\n")
          : "(sin credenciales)"
        return `${head}\n${rows}`
      })
      .join("\n\n")
  }
}
