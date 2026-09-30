import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { Terminals, type TerminalServerMessage } from "../src/terminal/manager.ts"
import { hiddenInput, parseSttyMode, type Pty, type TermMode } from "../src/terminal/pty.ts"

// `stty -F /dev/pts/N -a` de GNU coreutils, con `read -s` esperando (-echo, icanon).
const GNU_HIDDEN = `speed 38400 baud; rows 30; columns 100; line = 0;
intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>;
eol2 = <undef>; swtch = <undef>; start = ^Q; stop = ^S; susp = ^Z; rprnt = ^R;
werase = ^W; lnext = ^V; discard = ^O; min = 1; time = 0;
-parenb -parodd -cmspar cs8 -hupcl -cstopb cread -clocal -crtscts
-ignbrk -brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl -ixoff
-tandem ixon -ixany -imaxbel -iutf8
opost -olcuc -ocrnl onlcr -onocr -onlret -ofdel nl0 cr0 tab0 bs0 vt0 ff0
isig icanon iexten -echo echoe echok -echonl -noflsh -tostop -echoprt echoctl
echoke -flusho -extproc
`
// La shell en su prompt: readline apaga el eco y también el modo canónico.
const GNU_READLINE = GNU_HIDDEN.replace("isig icanon iexten -echo", "isig -icanon iexten -echo")
const GNU_NORMAL = GNU_HIDDEN.replace("-echo echoe", "echo echoe")
// sudo-rs: de a una tecla, sin eco, pero con el Enter a la vista.
const GNU_SUDO_RS = GNU_READLINE.replace("-echonl", "echonl")

// `stty -f /dev/ttys003 -a` de la Mac (BSD).
const BSD_HIDDEN = `speed 9600 baud; 30 rows; 100 columns;
lflags: icanon isig iexten -echo echoe -echok echoke -echonl echoctl
	-echoprt -altwerase -noflsh -tostop -flusho pendin -nokerninfo
	-extproc
iflags: -istrip icrnl -inlcr -igncr ixon -ixoff ixany imaxbel iutf8
	-ignbrk brkint -inpck -ignpar -parmrk
oflags: opost onlcr -oxtabs -onocr -onlret
cflags: cread cs8 -parenb -parodd hupcl -clocal -cstopb -crtscts -dsrflow
	-dtrflow -mdmbuf
cchars: discard = ^O; dsusp = ^Y; eof = ^D; eol = <undef>;
	eol2 = <undef>; erase = ^?; intr = ^C; kill = ^U; lnext = ^V;
	min = 1; quit = ^\\; reprint = ^R; start = ^Q; status = ^T;
	stop = ^S; susp = ^Z; time = 0; werase = ^W;
`
const BSD_NORMAL = BSD_HIDDEN.replace("iexten -echo echoe", "iexten echo echoe")
const BSD_ZLE = BSD_HIDDEN.replace("lflags: icanon", "lflags: -icanon")

test("lee echo e icanon de stty -a, en Linux y en la Mac", () => {
  assert.deepEqual(parseSttyMode(GNU_HIDDEN), { echo: false, icanon: true, echonl: false })
  assert.deepEqual(parseSttyMode(GNU_NORMAL), { echo: true, icanon: true, echonl: false })
  assert.deepEqual(parseSttyMode(GNU_READLINE), { echo: false, icanon: false, echonl: false })
  assert.deepEqual(parseSttyMode(GNU_SUDO_RS), { echo: false, icanon: false, echonl: true })
  assert.deepEqual(parseSttyMode(BSD_HIDDEN), { echo: false, icanon: true, echonl: false })
  assert.deepEqual(parseSttyMode(BSD_NORMAL), { echo: true, icanon: true, echonl: false })
  assert.deepEqual(parseSttyMode(BSD_ZLE), { echo: false, icanon: false, echonl: false })
  // echoe, echok, -echonl… no son echo.
  assert.equal(parseSttyMode("icanon echoe echok -echonl"), null)
  assert.equal(parseSttyMode(""), null)
  assert.equal(parseSttyMode("stty: /dev/pts/9: No such file or directory"), null)
})

test("entrada oculta: sin eco y por líneas (o con el Enter a la vista); el prompt de la shell no cuenta", () => {
  assert.equal(hiddenInput(parseSttyMode(GNU_HIDDEN)), true)
  assert.equal(hiddenInput(parseSttyMode(GNU_SUDO_RS)), true)
  assert.equal(hiddenInput(parseSttyMode(BSD_HIDDEN)), true)
  assert.equal(hiddenInput(parseSttyMode(GNU_READLINE)), false)
  assert.equal(hiddenInput(parseSttyMode(BSD_ZLE)), false)
  assert.equal(hiddenInput(parseSttyMode(GNU_NORMAL)), false)
  assert.equal(hiddenInput(null), false)
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Un PTY de mentira: la salida y el modo los manejamos desde el test. */
function fakePty() {
  const data: ((d: string) => void)[] = []
  const state = { mode: { echo: true, icanon: true, echonl: false } as TermMode | null, calls: 0, written: "" }
  const pty: Pty = {
    pid: 1,
    write: (d) => void (state.written += d),
    resize: async () => {},
    mode: async () => (state.calls++, state.mode),
    kill: async () => {},
    onData: (cb) => void data.push(cb),
    onExit: () => {},
  }
  return { pty, state, emit: (d: string) => data.forEach((cb) => cb(d)) }
}

test("el estado se manda solo cuando cambia, y sin actividad o sin nadie mirando no se consulta", async () => {
  const f = fakePty()
  const terminals = new Terminals({ sessionAlive: () => true, spawn: () => f.pty, probeQuietMs: 10, probeEnterMs: [10, 40] })
  try {
    const { token } = terminals.open("s", os.tmpdir())
    // Sin nadie conectado, la salida no dispara consultas.
    f.emit("hola\r\n")
    await wait(60)
    assert.equal(f.state.calls, 0)

    const got: TerminalServerMessage[] = []
    const link = terminals.attach("s", token, { send: (m) => got.push(m) })!
    await wait(40)
    const secure = () => got.filter((m) => m.t === "secure")
    // Al conectarse se consulta una vez; con eco, no hay nada que avisar.
    assert.equal(f.state.calls, 1)
    assert.deepEqual(secure(), [])

    // Sin actividad, no se consulta.
    await wait(100)
    assert.equal(f.state.calls, 1)

    // Aparece "Password:" y el programa apaga el eco: se avisa una vez.
    f.state.mode = { echo: false, icanon: true, echonl: false }
    f.emit("Password: ")
    await wait(40)
    assert.deepEqual(secure(), [{ t: "secure", on: true }])
    // Tipear sin Enter no consulta; el Enter sí (dos veces), pero el estado no cambió: nada nuevo.
    const before = f.state.calls
    link.receive({ t: "i", d: "abc" })
    await wait(30)
    assert.equal(f.state.calls, before)
    link.receive({ t: "i", d: "\r" })
    await wait(80)
    assert.equal(f.state.calls, before + 2)
    assert.equal(secure().length, 1)

    // Una pestaña que llega con el candado puesto lo recibe al conectarse.
    const late: TerminalServerMessage[] = []
    const link2 = terminals.attach("s", token, { send: (m) => late.push(m) })!
    assert.deepEqual(late.filter((m) => m.t === "secure"), [{ t: "secure", on: true }])
    link2.detach()

    // Vuelve el eco: se avisa que se fue.
    f.state.mode = { echo: true, icanon: true, echonl: false }
    f.emit("\r\n$ ")
    await wait(40)
    assert.deepEqual(secure(), [{ t: "secure", on: true }, { t: "secure", on: false }])

    // Si stty falla, sin candado (y sin repetir el aviso).
    f.state.mode = null
    f.emit("x")
    await wait(40)
    assert.equal(secure().length, 2)

    // Una ráfaga de salida es una sola consulta, al quedarse quieta.
    const burst = f.state.calls
    for (let i = 0; i < 20; i++) f.emit("línea\r\n")
    await wait(40)
    assert.equal(f.state.calls, burst + 1)
    link.detach()
  } finally {
    await terminals.closeAll()
  }
})

/** Una shell de verdad, con una pestaña de mentira conectada. */
async function realTerminal() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-term-secure-"))
  fs.writeFileSync(path.join(home, ".bash_profile"), "PS1='LISTO$ '\nunset PROMPT_COMMAND\n")
  const terminals = new Terminals({
    shell: "/bin/bash",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" },
    sessionAlive: () => true,
  })
  const { token } = terminals.open("s", home)
  const got: TerminalServerMessage[] = []
  const link = terminals.attach("s", token, { send: (m) => got.push(m) })!
  const out = () => got.flatMap((m) => (m.t === "o" ? [m.d] : [])).join("")
  const secure = () => got.flatMap((m) => (m.t === "secure" ? [m.on] : []))
  const until = async (ok: () => boolean, what: string, ms = 8000) => {
    const end = Date.now() + ms
    while (!ok()) {
      if (Date.now() > end) throw new Error(`no pasó: ${what}. Salida: ${JSON.stringify(out())}`)
      await wait(30)
    }
  }
  await until(() => out().includes("LISTO$ "), "el prompt")
  return { terminals, link, out, secure, until, home }
}

test("de punta a punta: read -s pone el candado, Enter lo saca, y el secreto no queda en ningún lado", async () => {
  const t = await realTerminal()
  try {
    // Con la shell en su prompt (readline sin eco ni modo canónico), no hay candado.
    await wait(400)
    assert.deepEqual(t.secure(), [])

    t.link.receive({ t: "i", d: "read -rs T && echo largo=${#T}\r" })
    await t.until(() => t.secure().at(-1) === true, "el candado")

    // Lo pegado (así llega un Ctrl+Shift+V: como entrada) no hace eco.
    const secret = "s3cr3t-NO-DEBE-VERSE"
    t.link.receive({ t: "i", d: secret })
    await wait(300)
    t.link.receive({ t: "i", d: "\r" })
    await t.until(() => /largo=20/.test(t.out()), "que read reciba el secreto")
    await t.until(() => t.secure().at(-1) === false, "que se vaya el candado")
    assert.deepEqual(t.secure(), [true, false])

    // Ni en la salida ni en lo que se reenvía al reconectar.
    assert.ok(!t.out().includes(secret))
    const again: TerminalServerMessage[] = []
    const { token } = t.terminals.open("s", t.home)
    t.terminals.attach("s", token, { send: (m) => again.push(m) })!.detach()
    const replay = again.flatMap((m) => (m.t === "o" ? [m.d] : [])).join("")
    assert.match(replay, /largo=20/)
    assert.ok(!replay.includes(secret))
  } finally {
    await t.terminals.closeAll()
  }
})

/** Por qué no se puede probar sudo acá: no está, o no pide contraseña (los runners del CI). */
function noSudoPrompt() {
  if (!fs.existsSync("/usr/bin/sudo")) return "sin sudo"
  const r = spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 5000 })
  return r.status === 0 ? "sudo no pide contraseña" : false
}

test("sudo pidiendo contraseña pone el candado, y cortarlo con Ctrl+C lo saca", { skip: noSudoPrompt() }, async () => {
  const t = await realTerminal()
  try {
    t.link.receive({ t: "i", d: "sudo -k; sudo true\r" })
    await t.until(() => t.secure().at(-1) === true, "el candado de sudo")
    t.link.receive({ t: "i", d: "\x03" })
    // Ctrl+C no es Enter: lo que lo saca es la salida (el prompt que vuelve).
    await t.until(() => t.secure().at(-1) === false, "que se vaya el candado")
    assert.deepEqual(t.secure(), [true, false])
  } finally {
    await t.terminals.closeAll()
  }
})
