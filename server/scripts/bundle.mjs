// Empaqueta el server en una carpeta que corre sola con `node server.mjs`, sin node_modules ni el repo.
// Es lo que lleva adentro la app de escritorio.
//
//   npm run bundle -w server -- --out <carpeta> [--web <web/dist>]
//
// Deja en <carpeta>: server.mjs, compact-hook.mjs, THIRD_PARTY_LICENSES y web/ (si pasás --web).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { build } from "rolldown"

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const { values } = parseArgs({ options: { out: { type: "string" }, web: { type: "string" } } })
if (!values.out) {
  console.error("Uso: npm run bundle -w server -- --out <carpeta> [--web <web/dist>]")
  process.exit(1)
}
// npm corre el script desde server/: las rutas relativas son respecto de donde lo llamaste.
const cwd = process.env.INIT_CWD ?? process.cwd()
const out = path.resolve(cwd, values.out)
const web = values.web ? path.resolve(cwd, values.web) : null
if (web && !fs.existsSync(path.join(web, "index.html"))) {
  console.error(`No encontré ${path.join(web, "index.html")}: corré \`npm run build\` antes.`)
  process.exit(1)
}

const started = Date.now()
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const result = await build({
  input: path.join(serverDir, "src/index.ts"),
  platform: "node",
  // Los nativos opcionales de ws: si no están, ws usa su versión en JS.
  external: [/^node:/, "bufferutil", "utf-8-validate"],
  transform: {
    target: "node24",
    define: { __CONTROL_PLANE_BUNDLE__: "true" },
  },
  logLevel: "warn",
  output: {
    file: path.join(out, "server.mjs"),
    format: "esm",
    codeSplitting: false,
  },
})

fs.copyFileSync(path.join(serverDir, "src/claude/compact-hook.mjs"), path.join(out, "compact-hook.mjs"))
if (web) fs.cpSync(web, path.join(out, "web"), { recursive: true })

const ids = result.output.flatMap((o) => (o.type === "chunk" ? o.moduleIds : []))
const packages = packagesOf(ids)
fs.writeFileSync(path.join(out, "THIRD_PARTY_LICENSES"), licenses(packages))

const size = fs.statSync(path.join(out, "server.mjs")).size
console.log(
  `Listo en ${out}: server.mjs (${(size / 1024 / 1024).toFixed(1)} MB, ${packages.length} paquetes adentro)` +
    `${web ? " + web" : ""} en ${((Date.now() - started) / 1000).toFixed(1)} s`
)

/** Los paquetes de node_modules de los que quedó código en el bundle. */
function packagesOf(moduleIds) {
  const found = new Map()
  for (const id of moduleIds) {
    const file = id.replace(/^\0/, "").split("?")[0]
    const at = file.lastIndexOf(`${path.sep}node_modules${path.sep}`)
    if (at < 0) continue
    const rest = file.slice(at + "/node_modules/".length).split(path.sep)
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]
    const dir = path.join(file.slice(0, at), "node_modules", name)
    if (found.has(dir)) continue
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
      found.set(dir, { dir, name: pkg.name ?? name, version: pkg.version ?? "", license: licenseField(pkg) })
    } catch {
      found.set(dir, { dir, name, version: "", license: "" })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

function licenseField(pkg) {
  if (typeof pkg.license === "string") return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ")
  return ""
}

function licenses(list) {
  const head = [
    "control-plane: licencias de terceros",
    "",
    "server.mjs incluye código de estos paquetes. Van sus avisos de licencia tal como vienen en cada uno.",
    "",
  ]
  const body = list.map((p) => {
    const file = fs.readdirSync(p.dir).find((f) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(f))
    const text = file ? fs.readFileSync(path.join(p.dir, file), "utf8").trim() : `(el paquete no trae archivo de licencia; declara: ${p.license || "sin dato"})`
    return [`${"-".repeat(72)}`, `${p.name}${p.version ? `@${p.version}` : ""}${p.license ? ` · ${p.license}` : ""}`, "", text, ""].join("\n")
  })
  return [...head, ...body].join("\n") + "\n"
}
