// La versión de control-plane, en un solo lugar: el package.json de la raíz manda.
//
//   npm run version:set 0.2.0     la pone en todos los lugares que la repiten
//   npm run version:check         falla si alguno quedó distinto
//   node scripts/version.mjs --check --tag v0.2.0   además, que coincida con el tag (lo usa el release)
//
// La repiten (Node y cargo necesitan el número escrito): los cuatro package.json, package-lock.json,
// Cargo.toml y Cargo.lock. tauri.conf.json la lee de desktop/package.json y server/src/config.ts de
// server/package.json: el chequeo también mira que sigan así.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const WORKSPACES = ["server", "web", "desktop"]
const CARGO_TOML = "desktop/src-tauri/Cargo.toml"
const CARGO_LOCK = "desktop/src-tauri/Cargo.lock"
const CRATE = "control-plane-desktop"

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8")
const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text)
const readJson = (rel) => JSON.parse(read(rel))
const writeJson = (rel, data) => write(rel, JSON.stringify(data, null, 2) + "\n")

// La línea `version = "…"` de la sección [package] de Cargo.toml.
const CARGO_TOML_RE = /(\[package\][^[]*?\nversion = ")([^"]*)(")/
// La entrada del crate de la app en Cargo.lock.
const CARGO_LOCK_RE = new RegExp(`(\\[\\[package\\]\\]\\nname = "${CRATE}"\\nversion = ")([^"]*)(")`)

/** Dónde está escrita la versión y qué dice cada lugar. */
function found() {
  const out = []
  out.push(["package.json", readJson("package.json").version])
  for (const ws of WORKSPACES) out.push([`${ws}/package.json`, readJson(`${ws}/package.json`).version])
  const lock = readJson("package-lock.json")
  out.push(["package-lock.json", lock.version])
  out.push(['package-lock.json packages[""]', lock.packages?.[""]?.version])
  for (const ws of WORKSPACES) out.push([`package-lock.json packages["${ws}"]`, lock.packages?.[ws]?.version])
  out.push([CARGO_TOML, read(CARGO_TOML).match(CARGO_TOML_RE)?.[2]])
  out.push([CARGO_LOCK, read(CARGO_LOCK).match(CARGO_LOCK_RE)?.[2]])
  return out
}

/** Lo que tiene que seguir leyendo la versión de otro lado en lugar de repetirla. */
function derived() {
  const problems = []
  const tauri = readJson("desktop/src-tauri/tauri.conf.json").version
  if (tauri !== "../package.json") {
    problems.push(`desktop/src-tauri/tauri.conf.json: "version" tiene que ser "../package.json" (dice ${JSON.stringify(tauri)})`)
  }
  const configTs = read("server/src/config.ts")
  if (!/^import pkg from "\.\.\/package\.json" with \{ type: "json" \}$/m.test(configTs) || !/^export const version: string = pkg\.version$/m.test(configTs)) {
    problems.push("server/src/config.ts: la versión tiene que salir de server/package.json (import pkg … / export const version = pkg.version)")
  }
  return problems
}

function set(version) {
  if (!SEMVER.test(version)) fail(`"${version}" no es una versión válida (X.Y.Z, por ejemplo 0.2.0).`)
  for (const rel of ["package.json", ...WORKSPACES.map((ws) => `${ws}/package.json`)]) {
    const pkg = readJson(rel)
    pkg.version = version
    writeJson(rel, pkg)
  }
  const lock = readJson("package-lock.json")
  lock.version = version
  for (const key of ["", ...WORKSPACES]) {
    if (!lock.packages?.[key]) fail(`package-lock.json no tiene packages["${key}"]: corré npm install antes.`)
    lock.packages[key].version = version
  }
  writeJson("package-lock.json", lock)
  for (const [rel, re] of [
    [CARGO_TOML, CARGO_TOML_RE],
    [CARGO_LOCK, CARGO_LOCK_RE],
  ]) {
    const text = read(rel)
    if (!re.test(text)) fail(`No encontré la versión en ${rel}.`)
    write(rel, text.replace(re, `$1${version}$3`))
  }
}

function check(tag) {
  const want = readJson("package.json").version
  const problems = found()
    .filter(([, v]) => v !== want)
    .map(([where, v]) => `${where}: dice ${v ?? "(nada)"} y la de package.json es ${want}`)
  problems.push(...derived())
  if (tag !== undefined && tag.replace(/^v/, "") !== want) {
    problems.push(`el tag ${tag} no coincide con la versión del repo (${want}): corré npm run version:set ${tag.replace(/^v/, "")} y commiteá`)
  }
  if (problems.length) {
    console.error(`✗ La versión quedó despareja:\n${problems.map((p) => `  - ${p}`).join("\n")}`)
    console.error("  Arreglalo con: npm run version:set X.Y.Z")
    process.exit(1)
  }
  console.log(`✓ Versión ${want} en todos lados${tag !== undefined ? ` (coincide con ${tag})` : ""}.`)
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const args = process.argv.slice(2)
if (args[0] === "--check") {
  const i = args.indexOf("--tag")
  check(i >= 0 ? (args[i + 1] ?? fail("Falta el tag después de --tag.")) : undefined)
} else if (args.length === 1 && !args[0].startsWith("-")) {
  set(args[0])
  check()
  console.log("Ahora: commit, tag v" + args[0] + " y push del tag (ver CONTRIBUTING.md).")
} else {
  fail("Uso: npm run version:set X.Y.Z  ·  npm run version:check")
}
