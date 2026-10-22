import { Copy, Link2, RefreshCw, ShieldOff, Unplug, UsersRound } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import {
  auditKindLabel,
  auditOutcomeLabel,
  CONTROL_CONFIRM_COPY,
  describeAudit,
  ENABLE_CONFIRM_PARAGRAPHS,
  ENABLE_CONFIRM_TITLE,
  TIER_OPTIONS,
  tierLabel,
  tierNeedsConfirm,
  type Tier,
} from "@shared/remote-access"
import type {
  RemoteAuditView,
  RemoteConfigView,
  RemoteDevice,
  RemoteStatus,
} from "@shared/types"

import { Button } from "@/components/ui/button"
import { ConfirmAction } from "@/components/ui/confirm-action"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAccess } from "@/lib/access"
import { api } from "@/lib/api"
import { failed, reason } from "@/lib/errors"
import { clock, timeAgo } from "@/lib/format"
import { useUi } from "@/lib/ui"
import { useAction } from "@/lib/use-action"

/** Un renglón con un interruptor: el título, lo que hace y el interruptor a la derecha. */
function SwitchRow({
  id,
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string
  title: string
  hint: React.ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <label htmlFor={id} className="min-w-0 text-sm">
        {title}
        <span className="block text-2xs text-muted-foreground">{hint}</span>
      </label>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="mt-0.5"
      />
    </div>
  )
}

/** El selector de nivel (Ver / Ver y responder / Control). Subir a Control pasa por una confirmación antes de llegar acá. */
function TierSelect({
  id,
  label,
  value,
  disabled,
  onChange,
  className,
}: {
  id?: string
  label: string
  value: Tier
  disabled?: boolean
  onChange: (tier: Tier) => void
  className?: string
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(v) => onChange(v as Tier)}
    >
      <SelectTrigger id={id} aria-label={label} size="sm" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TIER_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** La auditoría (sin contenido): qué pasó, desde qué dispositivo y con qué resultado. Solo se ve desde esta máquina. */
function AuditTab({ tick, devices }: { tick: number; devices: RemoteDevice[] }) {
  const [view, setView] = useState<RemoteAuditView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const names = new Map(devices.map((d) => [d.id, d.name]))
  const load = useCallback(async () => {
    setError(null)
    try {
      setView(await api.remoteAudit(200))
    } catch (err) {
      setError(reason(err))
    }
  }, [])
  useEffect(() => void load(), [load, tick])

  if (error) return <p className="text-destructive">No se pudo leer la auditoría: {error}</p>
  if (!view)
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner className="size-4" /> Leyendo la auditoría…
      </p>
    )
  return (
    <div className="grid gap-2">
      <p className="text-2xs text-muted-foreground">
        Se guardan 30 días o los últimos 10.000 hechos. Nunca incluye mensajes, textos de borradores, comandos, cookies ni enlaces: de un permiso queda la
        herramienta y una huella del pedido. Lecturas desde que arrancó el server: {view.counters.reads}.
      </p>
      {view.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Todavía no hay actividad remota.</p>
      ) : (
        <ul className="max-h-[50svh] divide-y overflow-y-auto">
          {view.rows.map((r) => (
            <li key={r.id} className="grid gap-0.5 py-1.5 text-xs">
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium">{auditKindLabel(r.kind)}</span>
                <span className={r.outcome === "ok" ? "text-muted-foreground" : "text-destructive"}>
                  {auditOutcomeLabel(r.outcome)}
                  {r.status ? ` (${r.status})` : ""}
                </span>
                <span className="ml-auto text-2xs text-muted-foreground" title={new Date(r.at).toLocaleString("es-AR")}>
                  {timeAgo(r.at)}
                </span>
              </span>
              {(describeAudit(r) || r.reason) && (
                <span className="min-w-0 font-mono text-2xs break-all text-muted-foreground">
                  {describeAudit(r)}
                  {r.reason ? ` · ${r.reason}` : ""}
                </span>
              )}
              {r.deviceId && <span className="text-2xs text-muted-foreground">{names.get(r.deviceId) ?? "Dispositivo revocado"}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const copyText = (text: string, done: string) =>
  void navigator.clipboard.writeText(text).then(
    () => toast.success(done),
    () => toast.error("No se pudo copiar")
  )

/**
 * "Acceso remoto": el estado de Tailscale, el interruptor, los dispositivos vinculados y el corte de emergencia.
 * Solo se abre desde esta máquina (en un dispositivo remoto no existe). El nivel (Ver / Ver y responder / Control) vale para todos los
 * dispositivos y cada uno puede tener el suyo: gana el menor. Subir a Control pide una confirmación aparte.
 */
export function RemoteDialog() {
  const open = useUi((s) => s.remoteDialog)
  const setUi = useUi((s) => s.set)
  const tick = useAccess((s) => s.tick)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [config, setConfig] = useState<RemoteConfigView | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmEnable, setConfirmEnable] = useState(false)
  const [tab, setTab] = useState<"access" | "audit">("access")
  // Subir a Control (el techo o un dispositivo) pasa por un AlertDialog; hasta que se confirma no se manda nada.
  const [controlFor, setControlFor] = useState<
    { kind: "config" } | { kind: "device"; device: RemoteDevice } | null
  >(null)
  const [pairName, setPairName] = useState("")
  const [pairing, setPairing] = useState<{
    url: string
    expiresAt: number
  } | null>(null)
  const action = useAction()

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const [s, c, d] = await Promise.all([
        api.remoteStatus(),
        api.remoteConfig(),
        api.remoteDevices(),
      ])
      setStatus(s)
      setConfig(c)
      setDevices(d)
    } catch (err) {
      setError(reason(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
    else setPairing(null)
  }, [open, load, tick])

  const enable = async () => {
    const s = await api.remoteEnable()
    setStatus(s)
    toast.success("Acceso remoto activado")
    useAccess.getState().changed()
  }
  const disable = () =>
    action.run("disable", async () => {
      try {
        await api.remoteDisable()
        setPairing(null)
        toast.success("Acceso remoto apagado")
        await load()
        useAccess.getState().changed()
      } catch (err) {
        failed("apagar el acceso remoto")(err)
      }
    })
  const kill = () =>
    action.run("kill", async () => {
      try {
        await api.remoteKill()
        setPairing(null)
        toast.success("Acceso remoto cortado")
        await load()
        useAccess.getState().changed()
      } catch (err) {
        failed("cortar el acceso remoto")(err)
      }
    })
  const revoke = async (d: RemoteDevice) => {
    await api.revokeRemoteDevice(d.id)
    toast.success(`Acceso revocado: ${d.name}`)
    await load()
    useAccess.getState().changed()
  }
  const createPairing = () =>
    action.run("pair", async () => {
      try {
        setPairing(await api.createPairing(pairName.trim() || undefined))
        setPairName("")
      } catch (err) {
        failed("crear el enlace de vinculación")(err)
      }
    })
  const changeTier = (next: Tier) => {
    if (tierNeedsConfirm(next)) return setControlFor({ kind: "config" })
    void action.run("tier", async () => {
      try {
        setConfig(await api.setRemoteConfig({ tier: next }))
        useAccess.getState().changed()
      } catch (err) {
        failed("cambiar el nivel de acceso")(err)
      }
    })
  }
  const changeDeviceTier = (d: RemoteDevice, next: Tier) => {
    if (tierNeedsConfirm(next)) return setControlFor({ kind: "device", device: d })
    void action.run(`tier-${d.id}`, async () => {
      try {
        await api.setRemoteDeviceTier(d.id, next)
        await load()
        useAccess.getState().changed()
      } catch (err) {
        failed("cambiar el nivel del dispositivo")(err)
      }
    })
  }
  const confirmControl = async () => {
    const target = controlFor
    if (!target) return
    if (target.kind === "config") setConfig(await api.setRemoteConfig({ tier: "control", confirm: "control" }))
    else {
      await api.setRemoteDeviceTier(target.device.id, "control", "control")
      await load()
    }
    useAccess.getState().changed()
  }
  const revokeAll = async () => {
    const r = await api.revokeAllRemoteDevices()
    toast.success(r.revoked === 1 ? "Acceso revocado a 1 dispositivo" : `Acceso revocado a ${r.revoked} dispositivos`)
    await load()
    useAccess.getState().changed()
  }
  const setDangerous = (v: boolean) =>
    action.run("dangerous", async () => {
      try {
        setConfig(await api.setRemoteConfig({ requireLocalForDangerous: v }))
      } catch (err) {
        failed("guardar el ajuste")(err)
      }
    })

  const ready = status?.state === "ready"
  const enabled = status?.enabled ?? false

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => setUi({ remoteDialog: v })}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Acceso remoto</DialogTitle>
            <DialogDescription>
              Entrar al dashboard desde otro dispositivo de tu tailnet de
              Tailscale. Está apagado por defecto: el panel solo escucha en esta
              máquina.
            </DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={(v) => setTab(v as "access" | "audit")}>
            <TabsList>
              <TabsTrigger value="access">Acceso</TabsTrigger>
              <TabsTrigger value="audit">Auditoría</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="grid gap-4 text-sm" aria-live="polite">
            {tab === "audit" ? (
              <AuditTab tick={tick} devices={devices} />
            ) : busy && !status ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-4" /> Mirando el estado de Tailscale…
              </p>
            ) : error ? (
              <p className="text-destructive">
                No se pudo leer el estado: {error}
              </p>
            ) : status ? (
              <>
                {!ready ? (
                  <p>{status.message}</p>
                ) : (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Tailnet</dt>
                    <dd className="min-w-0 truncate">
                      {status.tailnet ?? "—"}
                    </dd>
                    <dt className="text-muted-foreground">Nombre</dt>
                    <dd className="min-w-0 truncate font-mono text-xs">
                      {status.host}
                    </dd>
                    <dt className="text-muted-foreground">Direcciones</dt>
                    <dd className="min-w-0 font-mono text-xs break-all">
                      {status.ips.join(", ") || "—"}
                    </dd>
                    <dt className="text-muted-foreground">Acceso remoto</dt>
                    <dd>
                      {status.active
                        ? "Activo"
                        : enabled
                          ? "Prendido, sin conexión"
                          : "Apagado"}
                    </dd>
                    {status.url && (
                      <>
                        <dt className="text-muted-foreground">Dirección</dt>
                        <dd className="min-w-0 font-mono text-xs break-all">
                          {status.url}
                        </dd>
                      </>
                    )}
                  </dl>
                )}

                {enabled && status.problem && (
                  <p role="alert" className="text-destructive">
                    El acceso está prendido pero sin conexión.{" "}
                    {status.problem.message}
                  </p>
                )}

                <div className="grid gap-3 border-t pt-4">
                  <SwitchRow
                    id="remote-enabled"
                    title="Permitir acceso desde tu tailnet"
                    hint="Solo dispositivos vinculados, solo dentro de tu tailnet. Nunca a internet ni a la red local."
                    checked={enabled}
                    disabled={action.busy("disable") || (!enabled && !ready)}
                    onChange={(v) =>
                      v ? setConfirmEnable(true) : void disable()
                    }
                  />
                  <div className="flex items-start justify-between gap-3">
                    <label htmlFor="remote-tier" className="min-w-0">
                      Nivel de acceso
                      <span className="block text-2xs text-muted-foreground">
                        {TIER_OPTIONS.find((o) => o.value === (config?.tier ?? "read"))?.hint}{" "}
                        Cada dispositivo puede tener un nivel menor; gana el menor.
                      </span>
                    </label>
                    <TierSelect
                      id="remote-tier"
                      label="Nivel de acceso"
                      value={config?.tier ?? "read"}
                      disabled={!config || action.busy("tier")}
                      onChange={changeTier}
                      className="shrink-0"
                    />
                  </div>
                  <SwitchRow
                    id="remote-dangerous"
                    title="Pedir confirmación en esta máquina para comandos (Bash)"
                    hint="Aprobar Bash y PowerShell va a requerir estar en esta máquina. Solo cuenta cuando un dispositivo puede aprobar permisos."
                    checked={config?.requireLocalForDangerous ?? true}
                    disabled={!config || action.busy("dangerous")}
                    onChange={(v) => void setDangerous(v)}
                  />
                </div>

                <div className="grid gap-2 border-t pt-4">
                  <p className="eyebrow">Dispositivos vinculados</p>
                  {devices.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Cuando vincules un dispositivo, aparece acá.
                    </p>
                  ) : (
                    <ul className="divide-y">
                      {devices.map((d) => (
                        <li key={d.id} className="flex items-center gap-3 py-2">
                          <span className="min-w-0 flex-1">
                            <span className="name block truncate">
                              {d.name}
                            </span>
                            <span className="block truncate text-2xs text-muted-foreground">
                              {tierLabel(d.tier)} ·{" "}
                              {d.lastSeenAt
                                ? `visto ${timeAgo(d.lastSeenAt)}`
                                : "sin conexiones todavía"}
                              {d.tsLogin ? ` · ${d.tsLogin}` : ""}
                            </span>
                          </span>
                          <TierSelect
                            label={`Nivel de ${d.name}`}
                            value={d.tier}
                            disabled={action.busy(`tier-${d.id}`)}
                            onChange={(t) => changeDeviceTier(d, t)}
                            className="shrink-0"
                          />
                          <ConfirmAction
                            title={`¿Revocar el acceso de ${d.name}?`}
                            description={
                              <p>
                                El dispositivo deja de entrar al instante y se
                                cierran sus conexiones abiertas. Para volver a
                                entrar, hace falta vincularlo de nuevo.
                              </p>
                            }
                            confirmLabel="Revocar acceso"
                            onConfirm={() => revoke(d)}
                          >
                            <Button type="button" size="sm" variant="outline">
                              <Unplug className="size-3.5" /> Revocar…
                            </Button>
                          </ConfirmAction>
                        </li>
                      ))}
                    </ul>
                  )}

                  {devices.length > 1 && (
                    <ConfirmAction
                      title="¿Revocar el acceso de todos los dispositivos?"
                      description={
                        <p>
                          Todos dejan de entrar al instante y se cierran sus
                          conexiones abiertas. Para volver a entrar, hace falta
                          vincularlos de nuevo.
                        </p>
                      }
                      confirmLabel="Revocar todos"
                      onConfirm={revokeAll}
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="justify-self-start"
                      >
                        <UsersRound className="size-3.5" /> Revocar todos…
                      </Button>
                    </ConfirmAction>
                  )}

                  <p className="eyebrow mt-2">Vincular un dispositivo</p>
                  {pairing ? (
                    <div className="grid gap-1.5">
                      <div className="flex gap-2">
                        <Input
                          readOnly
                          value={pairing.url}
                          className="h-8 font-mono text-xs"
                          aria-label="Enlace de vinculación"
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <Button
                          type="button"
                          size="sm"
                          onClick={() =>
                            copyText(pairing.url, "Enlace copiado")
                          }
                        >
                          <Copy className="size-3.5" /> Copiar enlace
                        </Button>
                      </div>
                      <p className="text-2xs text-muted-foreground">
                        Abrilo en el dispositivo, dentro de tu tailnet. Vale una
                        sola vez y vence a las {clock(pairing.expiresAt)}.
                      </p>
                    </div>
                  ) : (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void createPairing()
                      }}
                    >
                      <Input
                        value={pairName}
                        onChange={(e) => setPairName(e.target.value)}
                        maxLength={60}
                        placeholder="Nombre del dispositivo (opcional)"
                        className="h-8 text-xs"
                        aria-label="Nombre del dispositivo"
                        disabled={!status.active}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        disabled={!status.active || action.busy("pair")}
                      >
                        {action.busy("pair") ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          <Link2 className="size-3.5" />
                        )}{" "}
                        Crear enlace
                      </Button>
                    </form>
                  )}
                  {!status.active && (
                    <p className="text-2xs text-muted-foreground">
                      Para vincular un dispositivo, el acceso remoto tiene que
                      estar activo.
                    </p>
                  )}
                </div>

                <div className="grid gap-2 border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="justify-self-start"
                    onClick={() => void kill()}
                    disabled={!enabled || action.busy("kill")}
                  >
                    <ShieldOff className="size-3.5" /> Cortar acceso ahora
                  </Button>
                  <p className="text-2xs leading-snug text-muted-foreground">
                    Corta todas las conexiones remotas al instante, sin esperar
                    a Tailscale. Los dispositivos quedan vinculados. Al salir de
                    la app de escritorio, si elegís «Dejarlo corriendo», el
                    acceso remoto sigue activo mientras el server siga
                    corriendo.
                  </p>
                </div>
              </>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load()}
              disabled={busy}
            >
              <RefreshCw className="size-3.5" /> Actualizar
            </Button>
            <Button
              type="button"
              onClick={() => setUi({ remoteDialog: false })}
            >
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmAction
        open={controlFor !== null}
        onOpenChange={(v) => !v && setControlFor(null)}
        title={
          controlFor?.kind === "device"
            ? `¿Dar nivel Control a ${controlFor.device.name}?`
            : "¿Permitir el nivel Control?"
        }
        description={<p>{CONTROL_CONFIRM_COPY}</p>}
        confirmLabel="Permitir Control"
        failMessage="No se pudo subir el nivel a Control"
        onConfirm={confirmControl}
      />

      <ConfirmAction
        open={confirmEnable}
        onOpenChange={setConfirmEnable}
        title={ENABLE_CONFIRM_TITLE}
        description={
          <>
            {ENABLE_CONFIRM_PARAGRAPHS.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </>
        }
        confirmLabel="Permitir acceso"
        destructive={false}
        failMessage="No se pudo activar el acceso remoto"
        onConfirm={enable}
      />
    </>
  )
}
