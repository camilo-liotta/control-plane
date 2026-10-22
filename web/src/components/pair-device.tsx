import { Link2 } from "lucide-react"
import { useState } from "react"

import { parsePairHash } from "@shared/remote-access"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useAccess } from "@/lib/access"
import { api } from "@/lib/api"
import { reason } from "@/lib/errors"

/**
 * La pantalla de un dispositivo que todavía no está vinculado (solo desde la tailnet): canjea el enlace
 * `#pair=TOKEN` que se crea en la máquina del server. El enlace vale una vez y vence a los 5 minutos.
 * No canjea solo al abrir: hace falta tocar "Vincular", así que un adelanto de enlace no lo gasta.
 */
export function PairDevice() {
  const [token] = useState(() => parsePairHash(window.location.hash))
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.pairDevice(token, name.trim() || undefined)
      // El token ya no sirve: se saca de la barra de direcciones y se vuelve a leer el acceso.
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      )
      await useAccess.getState().load()
    } catch (err) {
      setError(reason(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex h-svh items-center justify-center bg-sidebar p-4">
      <form
        onSubmit={submit}
        className="surface-card grid w-full max-w-sm gap-4 p-6"
      >
        <div className="grid gap-1.5">
          <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Link2 className="size-4" />
          </span>
          <h1 className="page-title text-base">Vincular este dispositivo</h1>
          <p className="text-sm text-muted-foreground">
            {token
              ? "Este dispositivo va a poder entrar al dashboard de control-plane que corre en otra máquina de tu tailnet."
              : "Este dispositivo no está vinculado. En la máquina del server, abrí Ajustes → Acceso remoto → Vincular un dispositivo y abrí acá el enlace que se crea."}
          </p>
        </div>
        {token && (
          <>
            <Field>
              <FieldLabel htmlFor="pair-name">
                Nombre del dispositivo (opcional)
              </FieldLabel>
              <Input
                id="pair-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                autoComplete="off"
                placeholder="Por ejemplo, el celular"
              />
              <FieldDescription>
                Así se ve en la lista de dispositivos del server.
              </FieldDescription>
            </Field>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />}
              Vincular
            </Button>
          </>
        )}
      </form>
    </main>
  )
}
