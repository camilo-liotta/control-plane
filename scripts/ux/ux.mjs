#!/usr/bin/env node
// El banco de UX: un server sembrado con datos inventados, un proxy por área y un navegador headless
// para capturar. Todo vive en ~/.cache/cp-ux (o CP_UX_HOME). Ver scripts/ux/README.md.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

import { BIN, CACHE, CDP_PORT, FAKE_CLAUDE, FAKE_HOME, LOGS, PIDS, REPO, REPOS, SERVER_PORT, SRV } from "./paths.mjs"

const [cmd, ...args] = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
const has = (name) => args.includes(`--${name}`)
for (const d of [CACHE, PIDS, LOGS]) fs.mkdirSync(d, { recursive: true })

const pidFile = (name) => path.join(PIDS, `${name}.pid`)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const readPid = (name) => { try { const p = Number(fs.readFileSync(pidFile(name), "utf8")); return alive(p) ? p : null } catch { return null } }
const portBusy = (port) => new Promise((r) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true) }); s.on("error", () => r(false)) })

/** Lanza un proceso suelto, con su log y su pid en ~/.cache/cp-ux. */
function launch(name, file, argv, { env = process.env, cwd } = {}) {
  const out = fs.openSync(path.join(LOGS, `${name}.log`), "a")
  const child = spawn(file, argv, { cwd, env, detached: true, stdio: ["ignore", out, out] })
  child.unref()
  fs.writeFileSync(pidFile(name), String(child.pid))
  console.log(`${name}: pid ${child.pid} (log en ${path.join(LOGS, name + ".log")})`)
  return child.pid
}

/** El PATH del server: solo lo que necesita, así Herramientas → CLIs no muestra los CLIs (ni los logins) reales. */
function prepareBin() {
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.mkdirSync(BIN, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(BIN, "node"))
  for (const b of ["git", "python3", "bash", "sh", "env", "ls", "cat", "grep", "sed", "head", "tail", "uname", "id", "dirname", "basename", "readlink", "mkdir", "rm", "sleep", "tput", "stty"]) {
    const found = ["/usr/bin", "/bin", "/usr/local/bin"].map((d) => path.join(d, b)).find((f) => fs.existsSync(f))
    if (found) fs.symlinkSync(found, path.join(BIN, b))
  }
}

async function server() {
  if (readPid("server") || (await portBusy(SERVER_PORT))) throw new Error(`Ya hay algo en el :${SERVER_PORT} (node scripts/ux/ux.mjs status)`)
  const from = path.resolve(opt("from", REPO))
  const dist = path.join(from, "web", "dist")
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error(`Falta ${dist}: compilalo antes (env -u NODE_ENV npm run build -w web)`)
  if (has("reset")) for (const d of [SRV, FAKE_HOME, REPOS]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(FAKE_HOME, ".claude"), { recursive: true })
  prepareBin()
  execFileSync(process.execPath, [path.join(REPO, "scripts/ux/fake-claude.mjs")], { stdio: "inherit" })
  const env = {
    HOME: FAKE_HOME,
    PATH: BIN,
    SHELL: "/bin/bash",
    LANG: process.env.LANG ?? "es_AR.UTF-8",
    TERM: "xterm-256color",
    CONTROL_PLANE_PORT: String(SERVER_PORT),
    CONTROL_PLANE_HOME: SRV,
    CONTROL_PLANE_WEB_DIST: dist,
    CLAUDE_BIN: FAKE_CLAUDE,
    CLAUDE_CONFIG_DIR: path.join(FAKE_HOME, ".claude"),
    FAKE_LONG_MS: "86400000",
  }
  launch("server", process.execPath, [path.join(from, "server/src/index.ts")], { env, cwd: path.join(from, "server") })
  for (let i = 0; i < 40 && !(await portBusy(SERVER_PORT)); i++) await new Promise((r) => setTimeout(r, 250))
  console.log(`Server sembrado: http://127.0.0.1:${SERVER_PORT} (código de ${from})`)
}

async function proxy() {
  const port = Number(args[0])
  const dist = path.resolve(args[1] ?? path.join(REPO, "web/dist"))
  if (!port) throw new Error("Uso: ux.mjs proxy <puerto> [web/dist]")
  if (await portBusy(port)) throw new Error(`El :${port} ya está ocupado`)
  launch(`proxy-${port}`, process.execPath, [path.join(REPO, "scripts/ux/proxy.mjs"), String(port), dist])
  for (let i = 0; i < 20 && !(await portBusy(port)); i++) await new Promise((r) => setTimeout(r, 150))
  console.log(`http://127.0.0.1:${port}`)
}

/** Edge o Chromium headless, con un perfil propio en ~/.cache/cp-ux/browser (se borra al pararlo). */
async function browser() {
  if (readPid("browser")) return console.log("El navegador ya está corriendo")
  const bin = [process.env.CP_UX_BROWSER, "/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((b) => b && fs.existsSync(b))
  if (!bin) throw new Error("No encontré Edge ni Chromium: pasalo con CP_UX_BROWSER=/ruta/al/binario")
  const profile = path.join(CACHE, "browser")
  fs.rmSync(profile, { recursive: true, force: true })
  launch("browser", bin, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run", "--font-render-hinting=none", "about:blank"])
  for (let i = 0; i < 40 && !(await portBusy(CDP_PORT)); i++) await new Promise((r) => setTimeout(r, 250))
}

function stop(which = "all") {
  const names = fs.readdirSync(PIDS).map((f) => f.replace(/\.pid$/, "")).filter((n) => which === "all" || n === which)
  for (const n of names) {
    const pid = readPid(n)
    if (pid) {
      process.kill(pid, "SIGTERM")
      console.log(`${n}: SIGTERM a ${pid}`)
    }
    fs.rmSync(pidFile(n), { force: true })
    if (n === "browser") setTimeout(() => fs.rmSync(path.join(CACHE, "browser"), { recursive: true, force: true }), 1500)
  }
  if (!names.length) console.log("No hay nada corriendo con ese nombre")
}

function status() {
  for (const f of fs.readdirSync(PIDS)) {
    const n = f.replace(/\.pid$/, "")
    const pid = readPid(n)
    console.log(`${n.padEnd(12)} ${pid ? `pid ${pid}` : "parado"}`)
  }
  console.log(`datos: ${CACHE}`)
}

const run = {
  server,
  seed: () => import("./seed.mjs"),
  proxy,
  browser,
  shots: () => import("./shots.mjs"),
  webkit: () => execFileSync("bash", [path.join(REPO, "scripts/ux/webkit/run.sh"), ...args], { stdio: "inherit" }),
  stop: () => stop(args[0]),
  status,
}[cmd]
if (!run) {
  console.log("Uso: node scripts/ux/ux.mjs <server [--from <checkout>] [--reset] | seed | proxy <puerto> [dist] | browser | shots … | webkit … | status | stop [nombre|all]>")
  process.exit(cmd ? 1 : 0)
}
try {
  await run()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
