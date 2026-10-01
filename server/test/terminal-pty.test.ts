import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"

import { descendants, innerScript, shQuote, spawnPty, type Pty } from "../src/terminal/pty.ts"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Cada test con PTY tiene un tope: si algo se traba, falla rápido en vez de colgar el job. Y las
 * PTY que queden abiertas (porque un test falló antes de cerrar la suya) se cierran al final: un
 * hijo vivo deja el proceso de tests esperando para siempre.
 */
const PTY_TEST = { timeout: 30_000 }
const opened = new Set<Pty>()
after(async () => {
  await Promise.all([...opened].map((p) => p.kill()))
})

/** Espera a que `ok` se cumpla, o falla con `what`. */
async function waitUntil(ok: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`no pasó: ${what}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

/** Una shell de login de verdad (bash), con HOME y carpeta temporales y un prompt fijo. */
function open(cols = 100, rows = 30) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-term-"))
  fs.writeFileSync(path.join(home, ".bash_profile"), "PS1='LISTO$ '\nunset PROMPT_COMMAND\n")
  const pty = spawnPty({
    shell: "/bin/bash",
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", LANG: "C.UTF-8" },
    cols,
    rows,
  })
  opened.add(pty)
  let out = ""
  pty.onData((d) => (out += d))
  return {
    pty,
    home,
    get out() {
      return out
    },
    /** Espera a que aparezca `re` en lo que salió después de `from`. */
    async until(re: RegExp, from = 0, ms = 8000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const m = re.exec(out.slice(from))
        if (m) return m
        await new Promise((r) => setTimeout(r, 30))
      }
      throw new Error(`no apareció ${re} en: ${JSON.stringify(out.slice(from))}`)
    },
  }
}

async function run(t: ReturnType<typeof open>, cmd: string, re: RegExp) {
  const from = t.out.length
  t.pty.write(cmd + "\r")
  return t.until(re, from)
}

test("la shell arranca en un PTY con el tamaño pedido y se puede cambiar", PTY_TEST, async () => {
  const t = open(100, 30)
  try {
    await t.until(/LISTO\$ /)
    assert.match((await run(t, "stty size", /(\d+ \d+)\r?\n/))[1]!, /^30 100$/)
    await t.pty.resize(132, 41)
    assert.match((await run(t, "stty size", /(\d+ \d+)\r?\n/))[1]!, /^41 132$/)
    // La shell se entera (SIGWINCH): $COLUMNS se actualiza.
    assert.match((await run(t, "echo cols=$COLUMNS", /cols=(\d+)/))[1]!, /^132$/)
    // Es una terminal de verdad y el TERM llega.
    assert.match((await run(t, "test -t 0 && echo tty-si; echo term=$TERM", /term=([^$\s]+)/))[1]!, /^xterm-256color$/)
  } finally {
    await t.pty.kill()
  }
})

test("Ctrl+C corta el comando en primer plano y los colores pasan tal cual", PTY_TEST, async () => {
  const t = open()
  try {
    await t.until(/LISTO\$ /)
    const from = t.out.length
    t.pty.write("sleep 30\r")
    await new Promise((r) => setTimeout(r, 300))
    t.pty.write("\x03")
    await t.until(/LISTO\$ /, from + 1)
    assert.match((await run(t, "echo rc=$?", /rc=(\d+)/))[1]!, /^130$/)
    await run(t, "printf '\\033[31mROJO\\033[0m\\n'", /\x1b\[31mROJO\x1b\[0m/)
  } finally {
    await t.pty.kill()
  }
})

test("cerrar la terminal mata la shell, lo que corre y los jobs de fondo", PTY_TEST, async () => {
  const t = open()
  const pids: number[] = []
  try {
    await t.until(/LISTO\$ /)
    const bg = Number((await run(t, "sleep 300 & echo bg=$!", /bg=(\d+)/))[1])
    pids.push(bg)
    // Uno en primer plano que ignora SIGHUP: igual tiene que morir.
    const fgFile = path.join(t.home, "fg.pid")
    t.pty.write(`sh -c 'trap "" HUP; echo $$ > ${fgFile}; exec sleep 300'\r`)
    // El archivo existe apenas la shell lo abre, antes de que tenga el pid; y el pid de la shell se
    // conoce recién cuando `ps` la encuentra (en la Mac puede tardar más que el primer prompt).
    const fgPid = () => Number(fs.existsSync(fgFile) ? fs.readFileSync(fgFile, "utf8").trim() : "")
    await waitUntil(() => fgPid() > 0, "el pid del comando en primer plano")
    await waitUntil(() => t.pty.pid > 0, "el pid de la shell")
    const fg = fgPid()
    pids.push(fg)
    const shell = t.pty.pid
    assert.ok(alive(shell), "la shell está viva")
    assert.ok(alive(bg), "el job de fondo está vivo")
    assert.ok(alive(fg), "el comando en primer plano está vivo")

    let exited = false
    t.pty.onExit(() => (exited = true))
    await t.pty.kill()
    assert.ok(exited, "script terminó")
    assert.ok(!alive(shell), "la shell murió")
    assert.ok(!alive(bg), "el job de fondo murió")
    assert.ok(!alive(fg), "el comando en primer plano murió")
  } finally {
    await t.pty.kill()
    // Si falló a mitad de camino, que no queden sleeps de 5 minutos.
    for (const pid of pids) if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL")
  }
})

test("la shell va citada y el tamaño es un número", () => {
  assert.equal(shQuote("it's"), `'it'\\''s'`)
  assert.equal(innerScript("/opt/my shell/zsh", 80, 24), `stty rows 24 cols 80 2>/dev/null; SHELL='/opt/my shell/zsh'; export SHELL; exec "$SHELL" -l`)
  assert.deepEqual(descendants([{ pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 9 }], 1), [2, 3])
})

export type { Pty }
