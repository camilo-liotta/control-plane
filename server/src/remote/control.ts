import type { RemoteConfig } from "../db.ts"
import { httpsPortError, type Tailscale, type TailscaleState } from "../tailscale.ts"
import type { RemoteListener } from "./listener.ts"

const SHUTDOWN_BUDGET_MS = 5_000

/** Lo que control necesita de la base (una fila de ajustes). */
export interface ConfigStore {
  getRemoteConfig(): RemoteConfig
  updateRemoteConfig(patch: Partial<Omit<RemoteConfig, "updatedAt">>): RemoteConfig
}

export interface ControlDeps {
  db: ConfigStore
  tailscale: Pick<Tailscale, "status" | "serveEntry" | "serveOn" | "serveOff">
  listener: Pick<RemoteListener, "start" | "stop" | "stopNow" | "running">
  /** El puerto de loopback donde escucha el listener remoto. */
  localPort: number
  /** El puerto principal del server (serve nunca puede usarlo). */
  mainPort: number
  now?: () => number
  /** Corta los websockets remotos (al apagar, cortar o cerrar el server). */
  onCut?: () => void
  /** Avisa que cambió el estado (la web se entera por el hub). */
  onChange?: () => void
  shutdownBudgetMs?: number
}

export type EnableResult = { ok: true } | { ok: false; state: TailscaleState }

export interface DisableResult {
  /** Si se sacó una entrada de serve. */
  removed: boolean
  reason: "removed" | "no_ownership" | "foreign" | "stale" | "error"
  message?: string
}

const fail = (message: string): EnableResult => ({ ok: false, state: { kind: "error", message } })

/**
 * Prende y apaga el acceso remoto. El orden importa:
 *  - al prender: estado listo, abrir el listener, leer la entrada de serve, guardar que la vamos a crear nosotros, crearla, verificar, guardar "prendido".
 *  - al apagar o cortar: primero se guarda enabled=0 y se cierra el listener y los websockets (todo sincrónico); recién después se le habla a Tailscale.
 * Solo se saca de serve lo que creamos nosotros y sigue apuntando a lo nuestro.
 */
export class RemoteControl {
  private d: ControlDeps
  private chain: Promise<unknown> = Promise.resolve()
  /** Sube con cada corte: lo que se estaba prendiendo se da cuenta y se deshace. */
  private epoch = 0
  private lastProblem: TailscaleState | null = null

  constructor(d: ControlDeps) {
    this.d = d
  }

  config(): RemoteConfig {
    return this.d.db.getRemoteConfig()
  }

  /** Cambia un ajuste que no toca a Tailscale (el techo de nivel, la confirmación local de comandos). */
  setConfig(patch: Partial<Pick<RemoteConfig, "tier" | "requireLocalForDangerous">>): RemoteConfig {
    const next = this.d.db.updateRemoteConfig(patch)
    this.changed()
    return next
  }

  /** Avisa que cambió algo del acceso remoto (dispositivos, por ejemplo): la web vuelve a pedir su estado. */
  notify() {
    this.changed()
  }

  /** Por qué está prendido pero sin exposición (Tailscale no listo, puerto ocupado…). */
  problem(): TailscaleState | null {
    return this.lastProblem
  }

  /** Prendido y con el listener abierto. */
  get active(): boolean {
    return this.config().enabled && this.d.listener.running
  }

  private get now() {
    return this.d.now ? this.d.now() : Date.now()
  }

  private changed() {
    try {
      this.d.onChange?.()
    } catch {
      // un aviso que falla no cambia nada
    }
  }

  /** Una cosa a la vez: prender, apagar y reconciliar no se pisan. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  // ------------------------------------------------------------------ prender

  enable(o: { httpsPort?: number } = {}): Promise<EnableResult> {
    return this.queue(() => this.enableNow(o.httpsPort ?? this.config().httpsPort))
  }

  private async enableNow(httpsPort: number): Promise<EnableResult> {
    const portError = httpsPortError(httpsPort, this.d.mainPort)
    if (portError) return fail(portError)
    const epoch = this.epoch
    const target = `http://127.0.0.1:${this.d.localPort}`
    const cancelled = () => epoch !== this.epoch
    let bound = false
    let created = false

    const undo = async (state: TailscaleState): Promise<EnableResult> => {
      if (bound) this.d.listener.stopNow()
      if (created) {
        // La propiedad se conserva hasta saber que la entrada ya no está (o que dejó de ser nuestra).
        const clear = () => this.d.db.updateRemoteConfig({ serveOwned: false, serveTarget: null, serveCreatedAt: null })
        const entry = await this.safe(() => this.d.tailscale.serveEntry(httpsPort))
        if (entry?.ok && entry.target !== target) {
          // No hay nada nuestro (ya no está) o ahora es de otro: no se toca.
          clear()
        } else {
          // Nuestra, o ilegible: antes de crearla no había entrada en ese puerto, así que se intenta sacar con el serve off de siempre.
          const off = await this.safe(() => this.d.tailscale.serveOff(httpsPort))
          if (off?.ok) {
            clear()
          } else {
            const again = await this.safe(() => this.d.tailscale.serveEntry(httpsPort))
            if (again?.ok && again.target !== target) {
              clear()
            } else {
              // No se pudo sacar ni probar que no está: la propiedad queda anotada y el próximo arranque reintenta.
              state = { kind: "error", message: "No se pudo sacar el acceso remoto de Tailscale: se reintenta al volver a arrancar." }
            }
          }
        }
      }
      this.lastProblem = state
      this.changed()
      return { ok: false, state }
    }

    try {
      const status = await this.d.tailscale.status()
      if (cancelled()) return this.cancelledResult()
      if (status.kind !== "ready") {
        this.lastProblem = status
        this.changed()
        return { ok: false, state: status }
      }

      if (!this.d.listener.running) {
        try {
          await this.d.listener.start(this.d.localPort)
          bound = true
        } catch {
          return this.problemResult({ kind: "port_in_use", message: `No se pudo abrir el puerto local ${this.d.localPort}: ya lo usa otra cosa.` })
        }
      }
      if (cancelled()) return await undo(this.cancelledState())

      const entry = await this.d.tailscale.serveEntry(httpsPort)
      if (cancelled()) return await undo(this.cancelledState())
      if (!entry.ok) return await undo(entry.state)

      const cfg = this.config()
      const ours = entry.target === target && cfg.serveOwned && cfg.serveTarget === target
      if (entry.target !== null && !ours) {
        return await undo({ kind: "port_in_use", message: `No se pudo usar el puerto ${httpsPort}: Tailscale ya lo usa para otra cosa.` })
      }

      if (!ours) {
        // Se anota ANTES de crearla: si el server se cae a mitad de camino, al volver se sabe que la entrada es nuestra.
        this.d.db.updateRemoteConfig({ serveOwned: true, serveTarget: target, serveCreatedAt: this.now, httpsPort, localPort: this.d.localPort })
        created = true
        const on = await this.d.tailscale.serveOn(httpsPort, target)
        if (cancelled()) return await undo(this.cancelledState())
        if (!on.ok) return await undo(on.state)
        const check = await this.d.tailscale.serveEntry(httpsPort)
        if (cancelled()) return await undo(this.cancelledState())
        if (!check.ok || check.target !== target) {
          return await undo({ kind: "error", message: "No se pudo confirmar que Tailscale publicó el acceso remoto." })
        }
      }

      this.d.db.updateRemoteConfig({ enabled: true, origin: `https://${status.host}:${httpsPort}` })
      this.lastProblem = null
      this.changed()
      return { ok: true }
    } catch (err) {
      return await undo({ kind: "error", message: `No se pudo prender el acceso remoto${err instanceof Error && err.message ? `: ${err.message.slice(0, 200)}` : "."}` })
    }
  }

  private cancelledState(): TailscaleState {
    return { kind: "error", message: "No se pudo prender el acceso remoto: se cortó mientras se estaba prendiendo." }
  }

  private cancelledResult(): EnableResult {
    return { ok: false, state: this.cancelledState() }
  }

  private problemResult(state: TailscaleState): EnableResult {
    this.lastProblem = state
    this.changed()
    return { ok: false, state }
  }

  /** Una llamada a Tailscale que nunca lanza: lo que falla queda como "no se pudo". */
  private async safe<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn()
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------ apagar y cortar

  /** El corte, sincrónico: no depende de Tailscale ni espera a nadie. */
  private cut() {
    this.epoch++
    this.d.db.updateRemoteConfig({ enabled: false })
    this.d.listener.stopNow()
    try {
      this.d.onCut?.()
    } catch {
      // los websockets ya perdieron su socket igual
    }
    this.lastProblem = null
    this.changed()
  }

  /** Apaga: corta el acceso ya y después saca la entrada de serve si es nuestra. */
  async disable(): Promise<DisableResult> {
    this.cut()
    return this.queue(() => this.removeOwned())
  }

  /** El botón de corte: igual que apagar, pero quien llama no espera al CLI (`done` es lo que sigue, a lo mejor nunca termina). */
  kill(): { done: Promise<DisableResult> } {
    this.cut()
    return { done: this.queue(() => this.removeOwned()).catch((err) => ({ removed: false, reason: "error" as const, message: String(err) })) }
  }

  /** Saca la entrada de serve solo si la creamos y sigue siendo nuestra. Un ajeno nunca se toca. */
  private async removeOwned(): Promise<DisableResult> {
    const cfg = this.config()
    if (!cfg.serveOwned) return { removed: false, reason: "no_ownership" }
    const clear = () => this.d.db.updateRemoteConfig({ serveOwned: false, serveTarget: null, serveCreatedAt: null })
    const entry = await this.safe(() => this.d.tailscale.serveEntry(cfg.httpsPort))
    if (!entry) return { removed: false, reason: "error", message: "No se pudo hablar con Tailscale para sacar el acceso remoto." }
    if (!entry.ok) return { removed: false, reason: "error", message: entry.state.message }
    if (entry.target === null) {
      clear()
      return { removed: false, reason: "stale" }
    }
    if (entry.target !== cfg.serveTarget) {
      clear()
      return { removed: false, reason: "foreign", message: "Tailscale usa ese puerto para otra cosa: no se tocó." }
    }
    const off = await this.safe(() => this.d.tailscale.serveOff(cfg.httpsPort))
    if (!off?.ok) return { removed: false, reason: "error", message: off ? off.state.message : "No se pudo hablar con Tailscale para sacar el acceso remoto." }
    clear()
    this.changed()
    return { removed: true, reason: "removed" }
  }

  // ------------------------------------------------------------------ ciclo de vida

  /** Después de que el server escucha: retoma lo prendido, o limpia lo que quedó de antes. Nunca lanza. */
  reconcile(): Promise<void> {
    return this.queue(async () => {
      try {
        const cfg = this.config()
        if (cfg.enabled) {
          await this.enableNow(cfg.httpsPort)
        } else if (cfg.serveOwned) {
          await this.removeOwned()
        }
      } catch {
        // un problema con Tailscale no tumba el arranque
      }
    })
  }

  /** Al cerrar el server: cierra el listener y saca la entrada, con un plazo. `enabled` queda como está. */
  async shutdown(): Promise<void> {
    this.epoch++
    try {
      await this.d.listener.stop()
    } catch {
      // ya estaba cerrado
    }
    try {
      this.d.onCut?.()
    } catch {
      // nada que cortar
    }
    const budget = this.d.shutdownBudgetMs ?? SHUTDOWN_BUDGET_MS
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budget)
      timer.unref()
    })
    try {
      await Promise.race([this.removeOwned().then(() => undefined, () => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
