#!/usr/bin/env node
// El banco de UX: un server sembrado con datos inventados, un proxy por área y un navegador headless
// para capturar. Todo vive en ~/.cache/cp-ux (o CP_UX_HOME). Ver scripts/ux/README.md.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
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

/**
 * El PATH del server: todo lo del sistema (la terminal y los scripts de /etc/profile.d lo usan) menos
 * los CLIs del catálogo de Herramientas → CLIs, así no aparecen los reales ni sus logins.
 */
function prepareBin() {
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.mkdirSync(BIN, { recursive: true })
  const catalog = fs.readFileSync(path.join(REPO, "server/src/clis.ts"), "utf8")
  const hidden = new Set([...catalog.matchAll(/bins:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])))
  hidden.add("claude")
  // La vista previa esconde además lo que abriría algo en el escritorio de verdad (el editor, el navegador).
  for (const b of (process.env.CP_UX_HIDE ?? "").split(",").filter(Boolean)) hidden.add(b)
  for (const dir of ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"]) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      const target = path.join(BIN, n)
      if (hidden.has(n) || fs.existsSync(target)) continue
      try { fs.symlinkSync(path.join(dir, n), target) } catch {}
    }
  }
  fs.rmSync(path.join(BIN, "node"), { force: true })
  fs.symlinkSync(process.execPath, path.join(BIN, "node"))
}

async function server() {
  if (readPid("server") || (await portBusy(SERVER_PORT))) throw new Error(`Ya hay algo en el :${SERVER_PORT} (node scripts/ux/ux.mjs status)`)
  const from = path.resolve(opt("from", REPO))
  const dist = path.join(from, "web", "dist")
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error(`Falta ${dist}: compilalo antes (env -u NODE_ENV npm run build -w web)`)
  if (has("reset")) for (const d of [SRV, FAKE_HOME, REPOS]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(FAKE_HOME, ".claude"), { recursive: true })
  // La terminal del sembrado sale en las capturas: un prompt inventado, sin tu usuario ni tu máquina.
  fs.writeFileSync(path.join(FAKE_HOME, ".bashrc"), "PS1='demo@banco:\\w\\$ '\n")
  fs.writeFileSync(path.join(FAKE_HOME, ".profile"), ". ~/.bashrc\n")
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

/**
 * La vista previa para el usuario: la web y el server de origin/main, con datos inventados, en el
 * :4729 (o --port). Todo aparte del banco y del dashboard de verdad:
 * - el código es un checkout propio de origin/main en ~/.cache/cp-ux/preview/src (no compila el
 *   web/dist de este checkout, que puede ser el que sirve el dashboard del :4700);
 * - los datos, el HOME, el PATH y el Claude falso viven en ~/.cache/cp-ux/preview (nunca
 *   ~/.control-plane ni ~/.claude), con su propio server sembrado: lo que se toque ahí no cambia el
 *   sembrado del :4720 que usan las capturas.
 * `preview stop` lo apaga (por pid). `preview --keep` no vuelve a sembrar si ya hay datos.
 */
async function preview() {
  const home = path.join(os.homedir(), ".cache", "cp-ux", "preview")
  const port = Number(opt("port", 4729))
  const sub = (argv, extra = {}) =>
    execFileSync(process.execPath, [path.join(REPO, "scripts/ux/ux.mjs"), ...argv], {
      stdio: "inherit",
      env: { ...process.env, CP_UX_HOME: home, CP_UX_PORT: String(port), CP_UX_HIDE: "code,cursor,codium,xdg-open,gio,open,gnome-open,kde-open", ...extra },
    })
  const src = path.join(home, "src")
  if (args[0] === "stop") {
    if (!fs.existsSync(src)) return console.log("La vista previa no está levantada")
    sub(["stop", "server"])
    for (let i = 0; i < 40 && (await portBusy(port)); i++) await new Promise((r) => setTimeout(r, 250))
    return console.log((await portBusy(port)) ? `El :${port} sigue ocupado: mirá con ss -ltnp qué lo usa` : "Vista previa apagada")
  }
  if (await portBusy(port)) throw new Error(`El :${port} está ocupado. Si es la vista previa, apagala antes: node scripts/ux/ux.mjs preview stop`)
  if ([4700, SERVER_PORT].includes(port)) throw new Error(`El :${port} no se usa para la vista previa`)

  // El código: origin/main en un checkout aparte, al día.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const env = { ...process.env }
  delete env.NODE_ENV // con NODE_ENV=production, npm no instala las devDependencies (vite, tsc)
  const git = (...a) => execFileSync("git", a, { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] }).toString().trim()
  console.log("Trayendo origin/main…")
  git("fetch", "-q", "origin", "main")
  if (!fs.existsSync(path.join(src, ".git"))) {
    fs.mkdirSync(home, { recursive: true })
    git("worktree", "add", "-q", "--detach", src, "origin/main")
  } else execFileSync("git", ["checkout", "-q", "--detach", "origin/main"], { cwd: src, stdio: "inherit" })
  console.log(`Código: ${execFileSync("git", ["log", "--oneline", "-1"], { cwd: src }).toString().trim()}`)
  const lock = fs.readFileSync(path.join(src, "package-lock.json"), "utf8")
  const stamp = path.join(home, "lock.json")
  if (!fs.existsSync(path.join(src, "node_modules")) || !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== lock) {
    console.log("Instalando dependencias (la primera vez tarda un poco)…")
    execFileSync(npm, ["ci", "--no-audit", "--no-fund"], { cwd: src, env, stdio: ["ignore", "ignore", "inherit"] })
    fs.writeFileSync(stamp, lock)
  }
  console.log("Compilando la web…")
  execFileSync(npm, ["run", "build", "-w", "web"], { cwd: src, env, stdio: ["ignore", "ignore", "inherit"] })

  // El server, con datos inventados y de cero (salvo --keep).
  const seeded = fs.existsSync(path.join(home, "srv", "control-plane.db"))
  sub(["server", "--from", src, ...(has("keep") && seeded ? [] : ["--reset"])])
  if (!(has("keep") && seeded)) {
    console.log("Sembrando los datos de ejemplo (≈ 30 s)…")
    sub(["seed"])
  }
  console.log(`\nVista previa: http://127.0.0.1:${port}`)
  console.log("Para apagarla: node scripts/ux/ux.mjs preview stop")
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
  preview,
}[cmd]
if (!run) {
  console.log("Uso: node scripts/ux/ux.mjs <server [--from <checkout>] [--reset] | seed | proxy <puerto> [dist] | browser | shots … | webkit … | status | stop [nombre|all] | preview [stop] [--port 4729] [--keep]>")
  process.exit(cmd ? 1 : 0)
}
try {
  await run()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
