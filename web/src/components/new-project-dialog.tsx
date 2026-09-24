import { FolderGit2, FolderOpen } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { authLine } from "@/components/accounts"
import { api, type DirSuggestion } from "@/lib/api"
import { basename, shortPath } from "@/lib/format"
import { useAccounts, useCurrentAccount } from "@/lib/store"
import { useUi } from "@/lib/ui"
import { cn } from "@/lib/utils"

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [, navigate] = useLocation()
  const [path, setPath] = useState("~/projects/")
  const [name, setName] = useState("")
  const [nameTouched, setNameTouched] = useState(false)
  const [suggest, setSuggest] = useState<DirSuggestion | null>(null)
  const [creating, setCreating] = useState(false)
  const accounts = useAccounts()
  const current = useCurrentAccount()
  const selectAccount = useUi((s) => s.selectAccount)
  const [accountId, setAccountId] = useState<string | null>(null)
  const account = accounts.find((a) => a.id === (accountId ?? current?.id)) ?? current

  useEffect(() => {
    if (open) setAccountId(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      api.suggestDirs(path).then(setSuggest, () => setSuggest(null))
    }, 120)
    return () => clearTimeout(t)
  }, [path, open])

  useEffect(() => {
    if (!nameTouched && suggest?.exists) setName(basename(suggest.path))
  }, [suggest, nameTouched])

  const create = async () => {
    setCreating(true)
    try {
      const project = await api.createProject({ repoPath: path, name: name.trim() || undefined, accountId: account?.id })
      if (account && account.id !== current?.id) selectAccount(account.id)
      toast.success(`Proyecto ${project.name} creado`, { description: "La orquestadora ya está arrancando." })
      onOpenChange(false)
      navigate(`/p/${project.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuevo proyecto</DialogTitle>
          <DialogDescription>
            Elegí la carpeta del repo. Se crea la orquestadora del proyecto y después sumás las sesiones que necesites.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="repo-path">Carpeta del repo</FieldLabel>
            <Input
              id="repo-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="font-mono text-sm"
              spellCheck={false}
              autoFocus
            />
            {suggest && (
              <FieldDescription className={cn(suggest.exists && !suggest.isGitRepo && "text-status-attention")}>
                {!suggest.exists
                  ? "La carpeta no existe todavía."
                  : suggest.isGitRepo
                    ? "Repositorio git encontrado."
                    : "Esta carpeta no es un repositorio git: funciona igual, pero los workers no van a poder usar worktrees."}
              </FieldDescription>
            )}
            {suggest && suggest.dirs.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-lg border p-1">
                {suggest.dirs.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    onClick={() => setPath(d.path + "/")}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    {d.isGitRepo ? (
                      <FolderGit2 className="size-4 text-status-done" />
                    ) : (
                      <FolderOpen className="size-4 text-muted-foreground" />
                    )}
                    <span className="truncate font-mono text-[0.8rem]">{shortPath(d.path)}</span>
                  </button>
                ))}
              </div>
            )}
          </Field>
          {accounts.length > 1 && account && (
            <Field>
              <FieldLabel>Cuenta de Claude Code</FieldLabel>
              <Select value={account.id} onValueChange={setAccountId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} · {authLine(a.auth)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Las sesiones del proyecto van a correr con esta cuenta.</FieldDescription>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="project-name">Nombre</FieldLabel>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameTouched(true)
              }}
              placeholder="mi-proyecto"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={create} disabled={!suggest?.exists || creating}>
            {creating && <Spinner />}
            Crear proyecto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
