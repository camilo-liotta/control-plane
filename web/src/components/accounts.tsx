import { Check, ChevronsUpDown, Copy, FolderCog, LogIn, RefreshCw, Settings2, Trash2, Users } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import type { Account, AccountAuth } from "@shared/types"

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { LoadError } from "@/components/ui/load-error"
import { Spinner } from "@/components/ui/spinner"
import { copy } from "@/components/tools/cli-login"
import { api } from "@/lib/api"
import { toneSoft } from "@/lib/status"
import { shortPath } from "@/lib/format"
import { useAccounts, useCurrentAccount } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

function Initial({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-xs font-semibold uppercase shadow-raised",
        className
      )}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  )
}

export function authLine(auth: AccountAuth | null): string {
  if (!auth) return "Verificando…"
  if (!auth.loggedIn) return "Sin login"
  return [auth.email, auth.subscription].filter(Boolean).join(" · ") || "Logueada"
}

/** Comando para loguear una cuenta desde una terminal. */
function loginCommand(a: { configDir: string; isDefault: boolean }) {
  return a.isDefault ? "claude" : `CLAUDE_CONFIG_DIR=${shortPath(a.configDir)} claude`
}

/** Selector de cuenta de Claude Code, como el de organizaciones. Filtra los proyectos por cuenta. */
export function AccountSwitcher() {
  const accounts = useAccounts()
  const current = useCurrentAccount()
  const ui = useUi()
  if (!current) return null
  const needsLogin = Boolean(current.auth && !current.auth.loggedIn)
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label={`Cuenta: ${current.name}. Cambiar de cuenta`}
        >
          <Initial name={current.name} />
          <span className="min-w-0 flex-1">
            <span className="name block truncate text-ui" title={current.name}>{current.name}</span>
            <span className={cn("block truncate text-2xs text-muted-foreground", needsLogin && "text-status-attention")}>
              {authLine(current.auth)}
            </span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-64">
        <DropdownMenuLabel className="eyebrow">Cuentas de Claude Code</DropdownMenuLabel>
        {accounts.map((a) => (
          <DropdownMenuItem key={a.id} onClick={() => ui.selectAccount(a.id)} className="gap-2.5">
            <Initial name={a.name} className="size-6 text-2xs" />
            <span className="min-w-0 flex-1">
              <span className="name block truncate">{a.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {authLine(a.auth)} · {a.projects === 1 ? "1 proyecto" : `${a.projects} proyectos`}
              </span>
            </span>
            {a.id === current.id && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => ui.set({ settingsForAccount: current.id })}>
          <Settings2 />
          Configuración de Claude Code
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => ui.set({ accountsDialog: true })}>
          <Users />
          Administrar cuentas…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {/* Sin login, las sesiones de esta cuenta no arrancan: te espera y frena, por eso va en ámbar. */}
    {needsLogin && (
      <button
        type="button"
        onClick={() => ui.set({ accountsDialog: true })}
        className={cn(
          "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium outline-hidden transition-colors hover:brightness-95 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          toneSoft.attention
        )}
      >
        <LogIn className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Loguear la cuenta</span>
      </button>
    )}
    </>
  )
}

function AccountRow({ account }: { account: Account }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(account.name)
  const [bin, setBin] = useState(account.bin ?? "")
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api.updateAccount(account.id, { name, bin: bin.trim() || null })
      toast.success("Cuenta guardada")
      setEditing(false)
    } catch (err) {
      toast.error("No se pudo guardar la cuenta", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  // Si falla, ConfirmAction muestra el error y queda abierto.
  const remove = async () => {
    await api.removeAccount(account.id)
    toast.success(`Cuenta ${account.name} quitada`)
  }

  return (
    <li className="px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <Initial name={account.name} className="bg-muted shadow-none" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre" aria-label="Nombre de la cuenta" className="h-8" />
              <Input
                value={bin}
                onChange={(e) => setBin(e.target.value)}
                placeholder="Comando (opcional, por defecto claude)"
                aria-label="Comando de la cuenta"
                className="h-8 font-mono text-xs"
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="name truncate" title={account.name}>{account.name}</span>
                {account.isDefault && <span className="text-2xs text-muted-foreground">la de siempre</span>}
              </div>
              <p className="truncate font-mono text-2xs text-muted-foreground" title={account.configDir}>
                {shortPath(account.configDir)}
                {account.bin ? ` · ${account.bin}` : ""}
              </p>
              <p className={cn("text-xs", account.auth && !account.auth.loggedIn ? "text-status-attention" : "text-muted-foreground")}>
                {authLine(account.auth)}
                {account.auth?.organization ? ` · ${account.auth.organization}` : ""}
              </p>
              {account.auth && !account.auth.loggedIn && (
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                  <li>
                    En una terminal, corré{" "}
                    <code className="rounded-md bg-muted px-1 py-0.5 font-mono break-words text-foreground">{loginCommand(account)}</code>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="ml-1 align-middle"
                      aria-label="Copiar el comando"
                      title="Copiar el comando"
                      onClick={() => copy(loginCommand(account))}
                    >
                      <Copy />
                    </Button>
                  </li>
                  <li>
                    Adentro, escribí <code className="font-mono">/login</code> y seguí los pasos en el navegador.
                  </li>
                  <li>Volvé acá y tocá "Volver a verificar los logins".</li>
                </ol>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <Button size="xs" onClick={save} disabled={busy}>
                {busy && <Spinner />}
                Guardar
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
            </>
          ) : (
            <>
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                Editar
              </Button>
              {!account.isDefault && (
                <ConfirmAction
                  title={`¿Quitar la cuenta ${account.name}?`}
                  description={
                    <p>
                      Deja de aparecer en el dashboard. No se borran su directorio (<code className="font-mono">{shortPath(account.configDir)}</code>), su login
                      ni sus conversaciones: la podés volver a agregar cuando quieras.
                    </p>
                  }
                  confirmLabel="Quitar"
                  onConfirm={remove}
                >
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={busy || account.projects > 0}
                    title={account.projects > 0 ? "Tiene proyectos: archivalos antes" : "Quitar la cuenta"}
                    aria-label={`Quitar la cuenta ${account.name}`}
                  >
                    <Trash2 />
                  </Button>
                </ConfirmAction>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  )
}

/** Administrar cuentas: cada una es un directorio de configuración de Claude Code con su propio login. */
export function AccountsDialog() {
  const open = useUi((s) => s.accountsDialog)
  const setUi = useUi((s) => s.set)
  const selectAccount = useUi((s) => s.selectAccount)
  const accounts = useAccounts()
  const [detected, setDetected] = useState<{ configDir: string; name: string; auth: AccountAuth }[] | null>(null)
  const [detectError, setDetectError] = useState<unknown>(null)
  const [dir, setDir] = useState("")
  const [name, setName] = useState("")
  const [bin, setBin] = useState("")
  const [adding, setAdding] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const detect = useCallback(() => {
    setDetected(null)
    setDetectError(null)
    return api.detectAccounts().then(setDetected, setDetectError)
  }, [])
  useEffect(() => {
    if (open) void detect()
  }, [open, accounts.length, detect])

  const add = async () => {
    setAdding(true)
    try {
      const a = await api.createAccount({ name, configDir: dir, bin: bin.trim() || null })
      toast.success(`Cuenta ${a.name} agregada`, { description: authLine(a.auth) })
      setDir("")
      setName("")
      setBin("")
      selectAccount(a.id)
    } catch (err) {
      toast.error("No se pudo agregar la cuenta", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setAdding(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await api.accounts(true)
    } catch (err) {
      toast.error("No se pudieron verificar los logins", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => setUi({ accountsDialog: v })}>
      <DialogContent className="max-h-[90svh] overflow-x-hidden overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Cuentas de Claude Code</DialogTitle>
          <DialogDescription>
            Cada cuenta es un directorio de configuración (el que usa <code className="font-mono">CLAUDE_CONFIG_DIR</code>) con su login, sus
            settings y sus conversaciones. Cada proyecto pertenece a una cuenta y sus sesiones corren con ella.
          </DialogDescription>
        </DialogHeader>
        <ul className="surface-card divide-y overflow-hidden">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
        </ul>
        <div className="flex justify-end">
          <Button size="xs" variant="ghost" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Spinner /> : <RefreshCw />}
            Volver a verificar los logins
          </Button>
        </div>

        <form
          id="add-account"
          onSubmit={(e) => {
            e.preventDefault()
            if (dir.trim() && !adding) void add()
          }}
        >
          <FieldSeparator>Agregar una cuenta</FieldSeparator>
          {Boolean(detectError) && <LoadError what="las cuentas detectadas" error={detectError} onRetry={detect} compact className="mt-2" />}
          {detected && detected.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {detected.map((d) => (
                <button
                  key={d.configDir}
                  type="button"
                  onClick={() => {
                    setDir(d.configDir)
                    setName(d.auth.organization || d.name)
                  }}
                  className="surface-card flex max-w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FolderCog className="size-4 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block font-mono break-words">{shortPath(d.configDir)}</span>
                    <span className="block text-muted-foreground">{authLine(d.auth)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <FieldGroup className="mt-3">
            <Field>
              <FieldLabel htmlFor="acc-dir">Directorio de configuración</FieldLabel>
              <Input id="acc-dir" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/.claude-personal" className="font-mono text-sm" />
              <FieldDescription>
                El mismo que usa tu comando para esa cuenta. Por ejemplo, si <code className="font-mono">claude-personal</code> es{" "}
                <code className="font-mono">CLAUDE_CONFIG_DIR=~/.claude-personal claude</code>, acá va <code className="font-mono">~/.claude-personal</code>.
              </FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="acc-name">Nombre</FieldLabel>
                <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Personal" />
              </Field>
              <Field>
                <FieldLabel htmlFor="acc-bin">Comando (opcional)</FieldLabel>
                <Input id="acc-bin" value={bin} onChange={(e) => setBin(e.target.value)} placeholder="claude" className="font-mono text-sm" />
              </Field>
            </div>
          </FieldGroup>
        </form>
        <DialogFooter sticky>
          <Button variant="outline" onClick={() => setUi({ accountsDialog: false })}>
            Cerrar
          </Button>
          <Button type="submit" form="add-account" disabled={!dir.trim() || adding}>
            {adding && <Spinner />}
            Agregar cuenta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
