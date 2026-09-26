import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { CliUsage } from "./cli-usage.ts"
import type { CliAuthState, CliCredential, CliInfo, CliJob, CliView, UsedProgram } from "./shared/types.ts"
import { now, oneLine, shortId } from "./util.ts"

/**
 * CLIs de la máquina: un catálogo (el "marketplace") con cómo detectar cada uno, cómo saber si está
 * logueado y con qué comando se instala o se loguea. Son de tu usuario del sistema, no de una cuenta de
 * Claude Code: los ven todos los proyectos. El dashboard corre los comandos del catálogo (nunca texto
 * libre) y el login lo hacés vos en el navegador.
 */

interface Run {
  code: number | null
  out: string
}

type Check = (bin: string, run: (args: string[], timeoutMs?: number) => Promise<Run>) => Promise<{ state: CliAuthState; account?: string | null; detail?: string | null }>

interface CredentialSpec {
  /** Qué credencial es, si el CLI tiene más de una (gcloud: tu usuario y las de aplicación). */
  label: string | null
  check: Check
  /** Argumentos del login (abre el navegador o muestra un link y un código). */
  login?: string[]
  /** Si el login pide pegar un token o una contraseña, no se hace desde acá: se muestra para la terminal. */
  terminalLogin?: string
}

export interface CliSpec {
  id: string
  name: string
  description: string
  category: string
  bins: string[]
  version?: string[]
  docs: string
  install: { mac?: string; linux?: string; npm?: string }
  auth?: CredentialSpec[]
}

const pick = (out: string, re: RegExp) => re.exec(out)?.[1] ?? null
const firstLine = (out: string) => oneLine(out.trim().split("\n").find((l) => l.trim()) ?? "", 160)

/** Estado por código de salida: 0 es logueado; si no, se busca si es "vencido" o "sin login". */
function byExit(opts: { args: string[]; account?: (out: string) => string | null; expired?: RegExp; timeoutMs?: number }): Check {
  return async (_bin, run) => {
    const r = await run(opts.args, opts.timeoutMs)
    if (r.code === 0) return { state: "ok", account: opts.account?.(r.out) ?? null }
    if (r.code === null) return { state: "unknown", detail: "no contestó a tiempo" }
    if (opts.expired?.test(r.out)) return { state: "expired", detail: firstLine(r.out) }
    return { state: "logged_out" }
  }
}

export const CATALOG: CliSpec[] = [
  {
    id: "gh",
    name: "GitHub CLI",
    description: "Repos, PRs, issues y Actions de GitHub.",
    category: "Código",
    bins: ["gh"],
    docs: "https://cli.github.com",
    install: { mac: "brew install gh", linux: "sudo apt install gh" },
    auth: [
      {
        label: null,
        login: ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"],
        check: byExit({
          args: ["auth", "status", "--hostname", "github.com"],
          account: (o) => pick(o, /Logged in to github\.com account (\S+)/),
          expired: /token .*invalid|expired|re-authenticate/i,
        }),
      },
    ],
  },
  {
    id: "gcloud",
    name: "Google Cloud CLI",
    description: "Google Cloud: proyectos, BigQuery (bq), Cloud Run, IAM.",
    category: "Nube",
    bins: ["gcloud"],
    docs: "https://cloud.google.com/sdk/docs/install",
    install: { mac: "brew install --cask google-cloud-sdk", linux: "sudo snap install google-cloud-cli --classic" },
    auth: [
      {
        label: "Tu usuario",
        login: ["auth", "login"],
        check: async (_bin, run) => {
          const list = await run(["auth", "list", "--format=json"])
          let account: string | null = null
          try {
            account = (JSON.parse(list.out) as { account: string; status: string }[]).find((a) => a.status === "ACTIVE")?.account ?? null
          } catch {
            // salida inesperada
          }
          if (!account) return { state: "logged_out" }
          // Pedir un token es la única forma de saber si sigue vigente (no se muestra ni se guarda).
          const tok = await run(["auth", "print-access-token", "--quiet"], 20_000)
          if (tok.code === 0) return { state: "ok", account }
          if (tok.code === null) return { state: "unknown", account, detail: "no contestó a tiempo" }
          return { state: "expired", account, detail: /reauthentication/i.test(tok.out) ? "Pide volver a iniciar sesión" : firstLine(tok.out) }
        },
      },
      {
        label: "Credenciales de aplicación (ADC)",
        login: ["auth", "application-default", "login"],
        check: async (_bin, run) => {
          const tok = await run(["auth", "application-default", "print-access-token"], 20_000)
          if (tok.code === 0) return { state: "ok" }
          if (tok.code === null) return { state: "unknown", detail: "no contestó a tiempo" }
          if (/not found|could not find/i.test(tok.out)) return { state: "logged_out", detail: "Las usan las librerías (Python, dbt, Terraform)" }
          return { state: "expired", detail: firstLine(tok.out) }
        },
      },
    ],
  },
  {
    id: "aws",
    name: "AWS CLI",
    description: "Amazon Web Services.",
    category: "Nube",
    bins: ["aws"],
    docs: "https://docs.aws.amazon.com/cli/",
    install: { mac: "brew install awscli", linux: "sudo snap install aws-cli --classic" },
    auth: [
      {
        label: null,
        login: ["sso", "login"],
        check: byExit({
          args: ["sts", "get-caller-identity", "--output", "json"],
          account: (o) => pick(o, /"Arn":\s*"([^"]+)"/),
          expired: /expired|ExpiredToken|refresh/i,
          timeoutMs: 20_000,
        }),
      },
    ],
  },
  {
    id: "az",
    name: "Azure CLI",
    description: "Microsoft Azure.",
    category: "Nube",
    bins: ["az"],
    docs: "https://learn.microsoft.com/cli/azure/install-azure-cli",
    install: { mac: "brew install azure-cli", linux: "curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash" },
    auth: [
      {
        label: null,
        login: ["login"],
        check: byExit({ args: ["account", "show", "--output", "json"], account: (o) => pick(o, /"name":\s*"([^"@]+@[^"]+)"/), expired: /expired|AADSTS|refresh token/i, timeoutMs: 20_000 }),
      },
    ],
  },
  {
    id: "wrangler",
    name: "Wrangler",
    description: "Cloudflare Workers, Pages, R2, D1 y KV.",
    category: "Deploy",
    bins: ["wrangler"],
    docs: "https://developers.cloudflare.com/workers/wrangler/",
    install: { npm: "wrangler" },
    auth: [
      {
        label: null,
        login: ["login"],
        check: async (_bin, run) => {
          const r = await run(["whoami"], 20_000)
          if (r.code === null) return { state: "unknown", detail: "no contestó a tiempo" }
          if (/not authenticated|not logged in/i.test(r.out)) return { state: "logged_out" }
          if (/expired|refresh/i.test(r.out) && r.code !== 0) return { state: "expired", detail: firstLine(r.out) }
          return r.code === 0 ? { state: "ok", account: pick(r.out, /email ([^\s!]+@[^\s!]+)/i) } : { state: "logged_out" }
        },
      },
    ],
  },
  {
    id: "vercel",
    name: "Vercel CLI",
    description: "Deploys y proyectos de Vercel.",
    category: "Deploy",
    bins: ["vercel"],
    docs: "https://vercel.com/docs/cli",
    install: { npm: "vercel" },
    auth: [
      {
        label: null,
        login: ["login"],
        check: byExit({ args: ["whoami"], account: (o) => o.trim().split("\n").filter((l) => l.trim() && !/Vercel CLI/.test(l)).pop()?.trim() ?? null, expired: /token.*(invalid|expired)/i, timeoutMs: 20_000 }),
      },
    ],
  },
  {
    id: "netlify",
    name: "Netlify CLI",
    description: "Sitios y funciones de Netlify.",
    category: "Deploy",
    bins: ["netlify"],
    docs: "https://docs.netlify.com/cli/get-started/",
    install: { npm: "netlify-cli" },
    auth: [
      {
        label: null,
        login: ["login"],
        check: async (_bin, run) => {
          const r = await run(["status"], 20_000)
          if (r.code === null) return { state: "unknown", detail: "no contestó a tiempo" }
          if (/not logged in/i.test(r.out)) return { state: "logged_out" }
          return r.code === 0 ? { state: "ok", account: pick(r.out, /Email:\s*(\S+)/) } : { state: "logged_out" }
        },
      },
    ],
  },
  {
    id: "fly",
    name: "Fly.io CLI",
    description: "Apps y máquinas de Fly.io.",
    category: "Deploy",
    bins: ["fly", "flyctl"],
    docs: "https://fly.io/docs/flyctl/",
    install: { mac: "brew install flyctl", linux: "curl -L https://fly.io/install.sh | sh" },
    auth: [{ label: null, login: ["auth", "login"], check: byExit({ args: ["auth", "whoami"], account: (o) => firstLine(o) || null, expired: /expired|invalid token/i, timeoutMs: 20_000 }) }],
  },
  {
    id: "railway",
    name: "Railway CLI",
    description: "Proyectos y deploys de Railway.",
    category: "Deploy",
    bins: ["railway"],
    docs: "https://docs.railway.com/guides/cli",
    install: { npm: "@railway/cli" },
    auth: [{ label: null, login: ["login"], check: byExit({ args: ["whoami"], account: (o) => pick(o, /Logged in as\s+(.+?)\s*👋?$/m), expired: /expired/i, timeoutMs: 20_000 }) }],
  },
  {
    id: "neonctl",
    name: "Neon CLI",
    description: "Proyectos, branches y bases de Neon (Postgres).",
    category: "Datos",
    bins: ["neonctl", "neon"],
    docs: "https://neon.com/docs/reference/neon-cli",
    install: { npm: "neonctl" },
    auth: [{ label: null, login: ["auth"], check: byExit({ args: ["me", "--output", "json"], account: (o) => pick(o, /"email":\s*"([^"]+)"/), expired: /expired|401/i, timeoutMs: 20_000 }) }],
  },
  {
    id: "supabase",
    name: "Supabase CLI",
    description: "Proyectos, migraciones y funciones de Supabase.",
    category: "Datos",
    bins: ["supabase"],
    docs: "https://supabase.com/docs/guides/cli",
    install: { mac: "brew install supabase/tap/supabase" },
    auth: [{ label: null, login: ["login"], check: byExit({ args: ["projects", "list", "--output", "json"], expired: /expired|401/i, timeoutMs: 20_000 }) }],
  },
  {
    id: "doppler",
    name: "Doppler",
    description: "Secretos y variables de entorno por proyecto y ambiente.",
    category: "Servicios",
    bins: ["doppler"],
    docs: "https://docs.doppler.com/docs/install-cli",
    install: { mac: "brew install dopplerhq/cli/doppler", linux: "curl -Ls https://cli.doppler.com/install.sh | sudo sh" },
    auth: [
      {
        label: null,
        login: ["login"],
        check: byExit({
          args: ["me", "--json"],
          account: (o) => pick(o, /"workplace":\s*\{[^}]*"name":\s*"([^"]+)"/) ?? pick(o, /"name":\s*"([^"]+)"/),
          expired: /expired|invalid token|unauthorized/i,
          timeoutMs: 20_000,
        }),
      },
    ],
  },
  {
    id: "op",
    name: "1Password CLI",
    description: "Secretos y credenciales de 1Password.",
    category: "Servicios",
    bins: ["op"],
    docs: "https://developer.1password.com/docs/cli/get-started/",
    install: { mac: "brew install --cask 1password-cli" },
    auth: [{ label: null, terminalLogin: "op signin", check: byExit({ args: ["whoami"], account: (o) => pick(o, /Email:\s*(\S+)/), expired: /expired|session/i }) }],
  },
  {
    id: "cloudflared",
    name: "cloudflared",
    description: "Túneles de Cloudflare hacia servicios locales.",
    category: "Infraestructura",
    bins: ["cloudflared"],
    docs: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    install: { mac: "brew install cloudflared" },
    auth: [
      {
        label: null,
        login: ["tunnel", "login"],
        check: async (_bin, run) => {
          const r = await run(["tunnel", "list"], 20_000)
          if (r.code === 0) return { state: "ok" }
          if (r.code === null) return { state: "unknown", detail: "no contestó a tiempo" }
          if (/origin certificate|cert\.pem|login/i.test(r.out)) return { state: "logged_out" }
          return { state: "expired", detail: firstLine(r.out) }
        },
      },
    ],
  },
  {
    id: "ngrok",
    name: "ngrok",
    description: "Exponer un puerto local con una URL pública.",
    category: "Infraestructura",
    bins: ["ngrok"],
    docs: "https://ngrok.com/download",
    install: { mac: "brew install ngrok", linux: "sudo snap install ngrok" },
    auth: [{ label: null, terminalLogin: "ngrok config add-authtoken <token>", check: byExit({ args: ["config", "check"] }) }],
  },
  {
    id: "doctl",
    name: "DigitalOcean CLI",
    description: "Droplets, bases y apps de DigitalOcean.",
    category: "Nube",
    bins: ["doctl"],
    docs: "https://docs.digitalocean.com/reference/doctl/how-to/install/",
    install: { mac: "brew install doctl", linux: "sudo snap install doctl" },
    auth: [{ label: null, terminalLogin: "doctl auth init", check: byExit({ args: ["account", "get"], account: (o) => pick(o, /(\S+@\S+)/), expired: /unauthorized|401/i, timeoutMs: 20_000 }) }],
  },
  {
    id: "pulumi",
    name: "Pulumi",
    description: "Infraestructura como código en TypeScript o Python.",
    category: "Infraestructura",
    bins: ["pulumi"],
    docs: "https://www.pulumi.com/docs/iac/download-install/",
    install: { mac: "brew install pulumi/tap/pulumi", linux: "curl -fsSL https://get.pulumi.com | sh" },
    auth: [{ label: null, login: ["login"], check: byExit({ args: ["whoami"], account: (o) => firstLine(o) || null, expired: /expired|unauthorized/i, timeoutMs: 20_000 }) }],
  },
  {
    id: "firebase",
    name: "Firebase CLI",
    description: "Hosting, funciones y reglas de Firebase.",
    category: "Deploy",
    bins: ["firebase"],
    docs: "https://firebase.google.com/docs/cli",
    install: { npm: "firebase-tools" },
    auth: [
      {
        label: null,
        login: ["login", "--reauth"],
        check: async (_bin, run) => {
          const r = await run(["login:list"], 20_000)
          if (r.code === null) return { state: "unknown", detail: "no contestó a tiempo" }
          const account = pick(r.out, /Logged in as (\S+)/)
          if (account) return { state: "ok", account }
          return /No authorized accounts/i.test(r.out) ? { state: "logged_out" } : { state: "expired", detail: firstLine(r.out) }
        },
      },
    ],
  },
  {
    id: "heroku",
    name: "Heroku CLI",
    description: "Apps y add-ons de Heroku.",
    category: "Deploy",
    bins: ["heroku"],
    docs: "https://devcenter.heroku.com/articles/heroku-cli",
    install: { mac: "brew tap heroku/brew && brew install heroku", linux: "sudo snap install heroku --classic" },
    auth: [{ label: null, login: ["login"], check: byExit({ args: ["auth:whoami"], account: (o) => firstLine(o) || null, expired: /expired|invalid credentials/i, timeoutMs: 20_000 }) }],
  },
  {
    id: "helm",
    name: "Helm",
    description: "Paquetes (charts) para Kubernetes.",
    category: "Infraestructura",
    bins: ["helm"],
    version: ["version", "--short"],
    docs: "https://helm.sh/docs/intro/install/",
    install: { mac: "brew install helm", linux: "sudo snap install helm --classic" },
  },
  {
    id: "mongosh",
    name: "mongosh",
    description: "Cliente de MongoDB.",
    category: "Datos",
    bins: ["mongosh"],
    docs: "https://www.mongodb.com/docs/mongodb-shell/install/",
    install: { mac: "brew install mongosh" },
  },
  {
    id: "mysql",
    name: "mysql",
    description: "Cliente de MySQL y MariaDB.",
    category: "Datos",
    bins: ["mysql"],
    docs: "https://dev.mysql.com/doc/refman/8.4/en/mysql.html",
    install: { mac: "brew install mysql-client", linux: "sudo apt install mysql-client" },
  },
  {
    id: "redis-cli",
    name: "redis-cli",
    description: "Cliente de Redis.",
    category: "Datos",
    bins: ["redis-cli"],
    docs: "https://redis.io/docs/latest/develop/tools/cli/",
    install: { mac: "brew install redis", linux: "sudo apt install redis-tools" },
  },
  {
    id: "psql",
    name: "psql",
    description: "Cliente de PostgreSQL.",
    category: "Datos",
    bins: ["psql"],
    docs: "https://www.postgresql.org/docs/current/app-psql.html",
    install: { mac: "brew install libpq", linux: "sudo apt install postgresql-client" },
  },
  {
    id: "dbt",
    name: "dbt",
    description: "Modelos SQL y transformaciones del warehouse.",
    category: "Datos",
    bins: ["dbt"],
    docs: "https://docs.getdbt.com/docs/core/installation-overview",
    install: { mac: "uv tool install dbt-core --with dbt-postgres", linux: "uv tool install dbt-core --with dbt-postgres" },
  },
  {
    id: "docker",
    name: "Docker",
    description: "Contenedores e imágenes.",
    category: "Infraestructura",
    bins: ["docker"],
    docs: "https://docs.docker.com/get-docker/",
    install: { mac: "brew install --cask docker", linux: "sudo apt install docker.io" },
  },
  {
    id: "kubectl",
    name: "kubectl",
    description: "Clusters de Kubernetes.",
    category: "Infraestructura",
    bins: ["kubectl"],
    version: ["version", "--client"],
    docs: "https://kubernetes.io/docs/tasks/tools/",
    install: { mac: "brew install kubectl", linux: "sudo snap install kubectl --classic" },
  },
  {
    id: "terraform",
    name: "Terraform",
    description: "Infraestructura como código.",
    category: "Infraestructura",
    bins: ["terraform"],
    docs: "https://developer.hashicorp.com/terraform/install",
    install: { mac: "brew install hashicorp/tap/terraform", linux: "sudo snap install terraform --classic" },
  },
  {
    id: "stripe",
    name: "Stripe CLI",
    description: "Pagos de Stripe: webhooks locales y la API.",
    category: "Servicios",
    bins: ["stripe"],
    docs: "https://docs.stripe.com/stripe-cli",
    install: { mac: "brew install stripe/stripe-cli/stripe" },
  },
  {
    id: "sentry-cli",
    name: "Sentry CLI",
    description: "Releases, source maps e issues de Sentry.",
    category: "Servicios",
    bins: ["sentry-cli"],
    docs: "https://docs.sentry.io/cli/",
    install: { npm: "@sentry/cli" },
  },
  {
    id: "uv",
    name: "uv",
    description: "Python: entornos, paquetes y herramientas.",
    category: "Lenguajes",
    bins: ["uv"],
    docs: "https://docs.astral.sh/uv/",
    install: { mac: "brew install uv", linux: "curl -LsSf https://astral.sh/uv/install.sh | sh" },
  },
  {
    id: "pnpm",
    name: "pnpm",
    description: "Paquetes de Node.",
    category: "Lenguajes",
    bins: ["pnpm"],
    docs: "https://pnpm.io/installation",
    install: { npm: "pnpm" },
  },
  {
    id: "bun",
    name: "Bun",
    description: "Runtime y paquetes de JavaScript.",
    category: "Lenguajes",
    bins: ["bun"],
    docs: "https://bun.sh",
    install: { mac: "brew install oven-sh/bun/bun", linux: "curl -fsSL https://bun.sh/install | bash" },
  },
  {
    id: "jq",
    name: "jq",
    description: "Filtrar y transformar JSON en la terminal.",
    category: "Utilidades",
    bins: ["jq"],
    docs: "https://jqlang.org",
    install: { mac: "brew install jq", linux: "sudo apt install jq" },
  },
  {
    id: "rg",
    name: "ripgrep",
    description: "Búsqueda rápida en archivos.",
    category: "Utilidades",
    bins: ["rg"],
    docs: "https://github.com/BurntSushi/ripgrep",
    install: { mac: "brew install ripgrep", linux: "sudo apt install ripgrep" },
  },
]

/** Tokens que un CLI pueda imprimir: nunca llegan a la UI. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]{10,}/g, "$1•••")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "ya29.•••")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g, "eyJ•••")
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_•••")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1•••")
}

/** El comando de instalación para esta máquina, y si el dashboard lo puede correr (sin sudo). */
export function installFor(spec: CliSpec, platform: NodeJS.Platform = process.platform): { command: string; runnable: boolean } | null {
  const command = spec.install.npm ? `npm install -g ${spec.install.npm}` : platform === "darwin" ? spec.install.mac : spec.install.linux
  if (!command) return null
  return { command, runnable: !/\bsudo\b/.test(command) }
}

/** Busca un ejecutable en el PATH (sin shell). */
export function which(bin: string, envPath = process.env.PATH ?? ""): string | null {
  const extra = [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/snap/bin"]
  for (const dir of [...envPath.split(path.delimiter), ...extra]) {
    if (!dir) continue
    const file = path.join(dir, bin)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {
      // no está acá
    }
  }
  return null
}

/** Links y códigos de un login (el de dispositivo de gh, las URLs de gcloud) para mostrarlos a mano. */
export function loginHints(output: string): { urls: string[]; code: string | null } {
  const urls = [...new Set(output.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])].slice(0, 4)
  const code = pick(output, /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i) ?? pick(output, /\bcode[:\s]+([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/i)
  return { urls, code }
}

function runCommand(file: string, args: string[], timeoutMs = 10_000): Promise<Run> {
  return new Promise((resolve) => {
    let out = ""
    let done = false
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", CI: "1" } })
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out })
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(null)
    }, timeoutMs)
    child.stdout.on("data", (d) => (out = (out + String(d)).slice(-20_000)))
    child.stderr.on("data", (d) => (out = (out + String(d)).slice(-20_000)))
    child.on("error", () => finish(-1))
    child.on("exit", (code) => finish(code))
  })
}

const STATUS_TTL = 60_000
const JOB_MAX_MS = 15 * 60_000

interface JobRuntime {
  job: CliJob
  child: ChildProcess | null
}

export class Clis {
  private cache: { at: number; list: CliInfo[] } | null = null
  private scanning: Promise<CliInfo[]> | null = null
  private jobs = new Map<string, JobRuntime>()

  private readonly opts: { onChange?: () => void; platform?: NodeJS.Platform; catalog?: CliSpec[]; usage?: CliUsage }

  constructor(opts: { onChange?: () => void; platform?: NodeJS.Platform; catalog?: CliSpec[]; usage?: CliUsage } = {}) {
    this.opts = opts
  }

  private get catalog() {
    return this.opts.catalog ?? CATALOG
  }

  private get platform() {
    return this.opts.platform ?? process.platform
  }

  async view(refresh = false): Promise<CliView> {
    const list = await this.scan(refresh)
    const usage = this.opts.usage
    // Lo que usaron las sesiones se lee aparte (la primera vez tarda): al terminar, avisa y la vista se relee.
    if (usage && !usage.busy && (refresh || Date.now() - usage.lastScan > 5 * 60_000)) void usage.scan().then(() => this.opts.onChange?.())
    const snap = usage?.snapshot()
    const known = new Set(this.catalog.flatMap((c) => c.bins))
    const clis = list.map((c) => {
      const spec = this.catalog.find((s) => s.id === c.id)!
      const uses = spec.bins.map((b) => snap?.used.get(b)).filter((u) => u !== undefined)
      const count = uses.reduce((n, u) => n + u.count, 0)
      return {
        ...c,
        usage: count ? { count, lastAt: Math.max(...uses.map((u) => u.lastAt)) } : null,
        wanted: c.installed ? 0 : spec.bins.reduce((n, b) => n + (snap?.missing.get(b)?.count ?? 0), 0),
      }
    })
    const used: UsedProgram[] = []
    for (const u of snap?.used.values() ?? []) {
      if (known.has(u.name) || u.count < 2) continue
      const file = which(u.name)
      if (file) used.push({ name: u.name, path: file, count: u.count, lastAt: u.lastAt, projects: [...u.projects].sort() })
    }
    used.sort((a, b) => b.count - a.count)
    return {
      platform: this.platform,
      at: this.cache?.at ?? now(),
      clis,
      jobs: [...this.jobs.values()].map((j) => j.job).slice(-20),
      used: used.slice(0, 40),
      usageScanning: usage?.busy ?? false,
    }
  }

  /** Lo que ven las sesiones con list_clis: solo lo instalado, con su estado. */
  async summary(): Promise<string> {
    const list = (await this.scan(false)).filter((c) => c.installed)
    if (!list.length) return "No hay CLIs del catálogo instalados en esta máquina."
    const state: Record<CliAuthState, string> = { ok: "logueado", expired: "VENCIDO", logged_out: "sin login", unknown: "no se sabe" }
    return list
      .map((c) => {
        const creds = c.credentials.map((k) => `${k.label ? `${k.label}: ` : ""}${state[k.state]}${k.account ? ` (${k.account})` : ""}`).join("; ")
        return `- ${c.id}${c.version ? ` ${c.version}` : ""}${creds ? ` · ${creds}` : ""}`
      })
      .join("\n")
  }

  private scan(refresh: boolean): Promise<CliInfo[]> {
    if (!refresh && this.cache && now() - this.cache.at < STATUS_TTL) return Promise.resolve(this.cache.list)
    if (this.scanning) return this.scanning
    this.scanning = Promise.all(this.catalog.map((spec) => this.inspect(spec)))
      .then((list) => {
        this.cache = { at: now(), list }
        return list
      })
      .finally(() => {
        this.scanning = null
      })
    return this.scanning
  }

  private async inspect(spec: CliSpec): Promise<CliInfo> {
    const file = spec.bins.map((b) => which(b)).find(Boolean) ?? null
    const install = installFor(spec, this.platform)
    const base: CliInfo = {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      docs: spec.docs,
      installed: Boolean(file),
      path: file,
      version: null,
      install,
      credentials: [],
      usage: null,
      wanted: 0,
    }
    if (!file) {
      base.credentials = (spec.auth ?? []).map((a, i) => ({ index: i, label: a.label, state: "logged_out", account: null, detail: null, terminalLogin: a.login ? null : (a.terminalLogin ?? null) }))
      return base
    }
    const v = await runCommand(file, spec.version ?? ["--version"], 8000)
    base.version = v.code === 0 ? (pick(v.out, /(\d+\.\d+(?:\.\d+)?)/) ?? null) : null
    base.credentials = await Promise.all(
      (spec.auth ?? []).map(async (a, i): Promise<CliCredential> => {
        try {
          const r = await a.check(file, (args, t) => runCommand(file, args, t))
          return { index: i, label: a.label, state: r.state, account: r.account ?? null, detail: r.detail ? scrubSecrets(r.detail) : null, terminalLogin: a.login ? null : (a.terminalLogin ?? null) }
        } catch {
          return { index: i, label: a.label, state: "unknown", account: null, detail: null, terminalLogin: a.login ? null : (a.terminalLogin ?? null) }
        }
      })
    )
    return base
  }

  private spec(id: string): CliSpec {
    const spec = this.catalog.find((c) => c.id === id)
    if (!spec) throw new Error("Ese CLI no está en el catálogo")
    return spec
  }

  /** Login o reautenticación: corre el comando del catálogo y deja ver lo que imprime (links, códigos). */
  login(id: string, credential = 0): CliJob {
    const spec = this.spec(id)
    const auth = spec.auth?.[credential]
    if (!auth?.login) throw new Error(auth?.terminalLogin ? `El login de ${spec.name} pide una credencial: corré ${auth.terminalLogin} en una terminal` : `${spec.name} no tiene login desde acá`)
    const file = spec.bins.map((b) => which(b)).find(Boolean)
    if (!file) throw new Error(`${spec.name} no está instalado`)
    const label = auth.label ? `${spec.name} · ${auth.label}` : spec.name
    return this.start(spec.id, "login", label, file, auth.login)
  }

  /** Instala con el comando del catálogo, si no necesita sudo (si lo necesita, la UI te lo da para copiar). */
  install(id: string): CliJob {
    const spec = this.spec(id)
    const inst = installFor(spec, this.platform)
    if (!inst) throw new Error(`No tengo cómo instalar ${spec.name} en esta máquina: mirá ${spec.docs}`)
    if (!inst.runnable) throw new Error("Esa instalación pide sudo: copiá el comando y corrélo en una terminal")
    return this.start(spec.id, "install", spec.name, "/bin/sh", ["-c", inst.command])
  }

  private start(cliId: string, kind: "login" | "install", label: string, file: string, args: string[]): CliJob {
    const running = [...this.jobs.values()].find((j) => j.job.cliId === cliId && j.job.status === "running")
    if (running) return running.job
    const job: CliJob = {
      id: shortId("job_"),
      cliId,
      kind,
      label,
      command: [path.basename(file) === "sh" ? "" : path.basename(file), ...args].filter(Boolean).join(" ").replace(/^-c /, ""),
      status: "running",
      exitCode: null,
      output: "",
      urls: [],
      code: null,
      startedAt: now(),
      endedAt: null,
    }
    const rt: JobRuntime = { job, child: null }
    this.jobs.set(job.id, rt)
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } })
    rt.child = child
    const append = (d: Buffer | string) => {
      job.output = scrubSecrets((job.output + String(d)).slice(-16_000))
      Object.assign(job, loginHints(job.output))
      this.opts.onChange?.()
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    const timer = setTimeout(() => child.kill("SIGTERM"), JOB_MAX_MS)
    timer.unref?.()
    const end = (code: number | null, error?: string) => {
      clearTimeout(timer)
      if (job.status !== "running") return
      job.status = code === 0 ? "done" : "failed"
      job.exitCode = code
      job.endedAt = now()
      if (error) job.output += `\n${error}`
      rt.child = null
      // Después de un login o una instalación el estado cambió: la próxima vista lo vuelve a consultar.
      this.cache = null
      this.opts.onChange?.()
    }
    child.on("error", (err) => end(-1, err.message))
    child.on("exit", (code) => end(code))
    return job
  }

  job(id: string): CliJob {
    const rt = this.jobs.get(id)
    if (!rt) throw new Error("No existe ese proceso")
    return rt.job
  }

  /** Algunos logins preguntan algo (Y/n, elegir una opción): la respuesta va a su entrada. */
  answer(id: string, text: string) {
    const rt = this.jobs.get(id)
    if (!rt?.child?.stdin || rt.job.status !== "running") throw new Error("Ese proceso ya terminó")
    rt.child.stdin.write(`${text}\n`)
  }

  cancel(id: string) {
    const rt = this.jobs.get(id)
    if (rt?.child && rt.job.status === "running") rt.child.kill("SIGTERM")
  }

  dispose() {
    for (const rt of this.jobs.values()) rt.child?.kill("SIGTERM")
  }
}
