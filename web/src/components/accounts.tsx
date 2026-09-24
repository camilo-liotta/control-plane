import { Check, ChevronsUpDown, FolderCog, RefreshCw, Settings2, Trash2, Users } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { Account, AccountAuth } from "@shared/types"

import { Button } from "@/components/ui/button"
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { shortPath } from "@/lib/format"
import { useAccounts, useCurrentAccount } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

function Initial({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border bg-background font-condensed text-[0.8rem] font-semibold uppercase",
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <Initial name={current.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{current.name}</span>
            <span className={cn("block truncate text-[0.7rem] text-muted-foreground", current.auth && !current.auth.loggedIn && "text-status-error")}>
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
            <Initial name={a.name} className="size-6 text-[0.72rem]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{a.name}</span>
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
      setEditing(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api.removeAccount(account.id)
      toast.success(`Cuenta ${account.name} quitada`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-start gap-2.5">
        <Initial name={account.name} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre" className="h-8" />
              <Input
                value={bin}
                onChange={(e) => setBin(e.target.value)}
                placeholder="Comando (opcional, por defecto claude)"
                className="h-8 font-mono text-xs"
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="font-medium">{account.name}</span>
                {account.isDefault && <span className="text-[0.7rem] text-muted-foreground">la de siempre</span>}
              </div>
              <p className="truncate font-mono text-[0.72rem] text-muted-foreground" title={account.configDir}>
                {shortPath(account.configDir)}
                {account.bin ? ` · ${account.bin}` : ""}
              </p>
              <p className={cn("text-xs", account.auth?.loggedIn ? "text-muted-foreground" : "text-status-error")}>
                {authLine(account.auth)}
                {account.auth?.organization ? ` · ${account.auth.organization}` : ""}
              </p>
              {account.auth && !account.auth.loggedIn && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Para loguearla, corré en una terminal <code className="font-mono break-all">{loginCommand(account)}</code> y usá /login.
                </p>
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
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={remove}
                  disabled={busy || account.projects > 0}
                  title={account.projects > 0 ? "Tiene proyectos: archivalos antes" : "Quitar la cuenta"}
                  aria-label="Quitar la cuenta"
                >
                  <Trash2 />
                </Button>
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
  const [dir, setDir] = useState("")
  const [name, setName] = useState("")
  const [bin, setBin] = useState("")
  const [adding, setAdding] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!open) return
    setDetected(null)
    api.detectAccounts().then(setDetected, () => setDetected([]))
  }, [open, accounts.length])

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
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await api.accounts(true)
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
        <ul className="space-y-2">
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

        <div className="rounded-xl border bg-muted/30 p-4">
          <h3 className="text-sm font-medium">Agregar una cuenta</h3>
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
                  className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                >
                  <FolderCog className="size-4 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block font-mono break-all">{shortPath(d.configDir)}</span>
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setUi({ accountsDialog: false })}>
            Cerrar
          </Button>
          <Button onClick={add} disabled={!dir.trim() || adding}>
            {adding && <Spinner />}
            Agregar cuenta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
