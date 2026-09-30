import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { MAX_FILES, parseNumstat, sessionChanges } from "../src/changes.ts"
import { Editor, editorCommand, folderCommand, projectFolder, resolveInside, splitCommand } from "../src/editor.ts"
import { repoOf } from "../src/config.ts"

const sh = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString()
const write = (dir: string, rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content)
}

describe("cambios de git de una sesión", () => {
  let root: string
  let repo: string

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-changes-"))
    repo = path.join(root, "repo")
    fs.mkdirSync(repo)
    sh(repo, "init", "-q", "-b", "main")
    write(repo, "src/app.ts", "a\nb\nc\n")
    write(repo, "README.md", "hola\n")
    write(repo, "borrar.txt", "x\n")
    sh(repo, "add", ".")
    sh(repo, "commit", "-q", "-m", "base")
  })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  it("en la principal: solo lo que no se commiteó, con staged, sin stagear, nuevos y binarios", async () => {
    write(repo, "src/app.ts", "a\nB\nc\nd\n") // sin stagear: +2 −1
    write(repo, "README.md", "hola\nchau\n")
    sh(repo, "add", "README.md") // staged: +1
    write(repo, "notas/nuevo.md", "uno\ndos\ntres") // nuevo, sin \n final: 3 líneas
    write(repo, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    fs.rmSync(path.join(repo, "borrar.txt"))
    const c = await sessionChanges(repo)
    assert.equal(c.branch, "main")
    assert.equal(c.committed, null, "en la principal no hay grupo de rama")
    const by = Object.fromEntries(c.uncommitted.files.map((f) => [f.path, f]))
    assert.deepEqual([by["src/app.ts"]!.added, by["src/app.ts"]!.deleted], [2, 1])
    assert.deepEqual([by["README.md"]!.added, by["README.md"]!.deleted], [1, 0])
    assert.equal(by["notas/nuevo.md"]!.untracked, true)
    assert.equal(by["notas/nuevo.md"]!.added, 3)
    assert.equal(by["logo.png"]!.binary, true)
    assert.equal(by["logo.png"]!.added, null)
    assert.equal(by["borrar.txt"]!.removed, true)
    assert.equal(c.uncommitted.added, 2 + 1 + 3 + 0)
    assert.equal(c.uncommitted.deleted, 1 + 1)
  })

  it("en una rama: lo commiteado desde el merge-base con la principal, aparte de lo sin commitear", async () => {
    sh(repo, "add", "-A")
    sh(repo, "commit", "-q", "-m", "todo en main")
    sh(repo, "checkout", "-q", "-b", "feat/x")
    write(repo, "src/feature.ts", "1\n2\n")
    sh(repo, "add", ".")
    sh(repo, "commit", "-q", "-m", "feature")
    write(repo, "src/app.ts", "a\nB\nc\nd\ne\n")
    sh(repo, "add", "src/app.ts")
    sh(repo, "commit", "-q", "-m", "otra")
    // La principal avanza después de separarse: no tiene que aparecer en la rama.
    sh(repo, "checkout", "-q", "main")
    write(repo, "solo-main.txt", "m\n")
    sh(repo, "add", ".")
    sh(repo, "commit", "-q", "-m", "main sigue")
    sh(repo, "checkout", "-q", "feat/x")
    write(repo, "README.md", "cambiado\n")

    const c = await sessionChanges(repo)
    assert.equal(c.branch, "feat/x")
    assert.ok(c.committed)
    assert.equal(c.committed.base, "main")
    assert.equal(c.committed.commits, 2)
    assert.deepEqual(c.committed.files.map((f) => f.path), ["src/app.ts", "src/feature.ts"])
    assert.equal(c.committed.added, 3)
    assert.deepEqual(c.uncommitted.files.map((f) => f.path), ["README.md"])
  })

  it("con muchos archivos, un tope y cuántos quedan", async () => {
    for (let i = 0; i < MAX_FILES + 5; i++) write(repo, `muchos/f${String(i).padStart(3, "0")}.txt`, "x\n")
    const c = await sessionChanges(repo)
    assert.equal(c.uncommitted.files.length, MAX_FILES)
    assert.equal(c.uncommitted.more, 6, "205 nuevos + README.md, menos los 200 que entran")
    assert.equal(c.uncommitted.added, MAX_FILES + 5 + 1, "el total cuenta también los que no entran")
    fs.rmSync(path.join(repo, "muchos"), { recursive: true })
  })

  it("errores claros si la carpeta no es un repo o no existe", async () => {
    const plain = fs.mkdtempSync(path.join(root, "plain-"))
    await assert.rejects(sessionChanges(plain), /no es un repo git/)
    await assert.rejects(sessionChanges(path.join(root, "nada")), /ya no existe/)
  })

  it("lee el numstat con binarios y rutas con tabs", () => {
    assert.deepEqual(
      parseNumstat("3\t1\ta.ts\0-\t-\timg.png\0"),
      [
        { path: "a.ts", added: 3, deleted: 1, binary: false, untracked: false, removed: false },
        { path: "img.png", added: null, deleted: null, binary: true, untracked: false, removed: false },
      ]
    )
  })
})

describe("abrir un cambio en el editor", () => {
  let root: string
  let repo: string
  let home: string
  const calls: { bin: string; args: string[]; cwd: string }[] = []
  let editor: Editor

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-editor-"))
    repo = path.join(root, "repo")
    home = path.join(root, "home")
    fs.mkdirSync(repo)
    sh(repo, "init", "-q", "-b", "main")
    write(repo, "src/app.ts", "viejo\n")
    sh(repo, "add", ".")
    sh(repo, "commit", "-q", "-m", "base")
    editor = new Editor({ home, launch: async (bin, args, cwd) => void calls.push({ bin, args, cwd }) })
  })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  it("un archivo modificado se abre como diff contra HEAD, en la ventana del repo", async () => {
    write(repo, "src/app.ts", "nuevo\n")
    const r = await editor.open(repo, "src/app.ts", "uncommitted")
    assert.equal(r.diff, true)
    const { bin, args } = calls.at(-1)!
    assert.equal(bin, "code")
    assert.equal(args[0], repo)
    assert.equal(args[1], "--diff")
    assert.ok(args[2]!.startsWith(path.join(home, "diff-base")), "el temporal va bajo CONTROL_PLANE_HOME")
    assert.equal(path.basename(args[2]!), "app (HEAD).ts")
    assert.equal(fs.readFileSync(args[2]!, "utf8"), "viejo\n")
    assert.equal(args[3], path.join(fs.realpathSync(repo), "src/app.ts"))
  })

  it("un archivo nuevo se abre directo", async () => {
    write(repo, "nuevo.md", "hola\n")
    const r = await editor.open(repo, "nuevo.md", "uncommitted")
    assert.equal(r.diff, false)
    assert.deepEqual(calls.at(-1)!.args, [repo, "-g", path.join(fs.realpathSync(repo), "nuevo.md")])
  })

  it("no deja salir de la carpeta de la sesión", async () => {
    await assert.rejects(editor.open(repo, "../fuera.txt", "uncommitted"), /Ruta inválida/)
    await assert.rejects(editor.open(repo, "/etc/passwd", "uncommitted"), /Ruta inválida/)
    fs.writeFileSync(path.join(root, "secreto.txt"), "x")
    fs.symlinkSync(path.join(root, "secreto.txt"), path.join(repo, "link.txt"))
    await assert.rejects(editor.open(repo, "link.txt", "uncommitted"), /fuera de la carpeta/)
    fs.symlinkSync(root, path.join(repo, "afuera"))
    assert.throws(() => resolveInside(repo, "afuera/secreto.txt"), /fuera de la carpeta/)
  })

  it("el editor se configura: Cursor, o un comando propio con {file}, {base} y {dir}", async () => {
    assert.deepEqual(editor.settings(), { kind: "code", command: "" })
    editor.save({ kind: "cursor" })
    await editor.open(repo, "src/app.ts", "uncommitted")
    assert.equal(calls.at(-1)!.bin, "cursor")
    editor.save({ kind: "custom", command: `meld "{base}" {file}` })
    await editor.open(repo, "src/app.ts", "uncommitted")
    const last = calls.at(-1)!
    assert.equal(last.bin, "meld")
    assert.equal(last.args.length, 2)
    assert.match(last.args[0]!, /app \(HEAD\)\.ts$/)
    // Sin {file}, va al final; sin base (archivo nuevo), se saca el argumento con {base}.
    assert.deepEqual(editorCommand({ kind: "custom", command: "subl -w" }, { dir: "/r", file: "/r/a", base: null }), { bin: "subl", args: ["-w", "/r/a"] })
    assert.deepEqual(editorCommand({ kind: "custom", command: "x --left={base} {file}" }, { dir: "/r", file: "/r/a", base: null }), { bin: "x", args: ["/r/a"] })
    assert.throws(() => editor.save({ kind: "custom", command: "  " }), /comando/)
    assert.deepEqual(splitCommand(`"/Applications/My Editor" -a 'b c' d`), ["/Applications/My Editor", "-a", "b c", "d"])
  })

  it("si el comando no existe, lo dice", async () => {
    const real = new Editor({ home })
    real.save({ kind: "custom", command: "no-existe-este-editor-cp {file}" })
    await assert.rejects(real.open(repo, "src/app.ts", "uncommitted"), /No encontré `no-existe-este-editor-cp`. Elegí tu editor en Ajustes/)
  })

  it("el editor de verdad se lanza desacoplado y le llegan los argumentos", async () => {
    const log = path.join(root, "args.log")
    const fake = path.join(root, "fake-editor.sh")
    // Se escribe aparte y se renombra: ejecutar un archivo recién escrito puede dar "Text file busy".
    fs.writeFileSync(fake + ".tmp", `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}.tmp" && mv "${log}.tmp" "${log}"\n`, { mode: 0o755 })
    fs.renameSync(fake + ".tmp", fake)
    const real = new Editor({ home })
    real.save({ kind: "custom", command: `${fake} {dir} {file}` })
    await real.open(repo, "src/app.ts", "uncommitted")
    for (let i = 0; i < 50 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [repo, path.join(fs.realpathSync(repo), "src/app.ts")])
  })
})

describe("el entorno del editor", () => {
  it("no hereda NODE_ENV ni las CONTROL_PLANE_* internas del server", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-editor-env-"))
    const repo = path.join(root, "repo")
    fs.mkdirSync(repo)
    sh(repo, "init", "-q", "-b", "main")
    write(repo, "a.txt", "x\n")
    const log = path.join(root, "env.log")
    const fake = path.join(root, "env-editor.sh")
    fs.writeFileSync(fake + ".tmp", `#!/bin/sh\nenv > "${log}.tmp" && mv "${log}.tmp" "${log}"\n`, { mode: 0o755 })
    fs.renameSync(fake + ".tmp", fake)
    const vars = { NODE_ENV: "production", CONTROL_PLANE_LAUNCH_ID: "l1", CONTROL_PLANE_WEB_DIST: "/w", CONTROL_PLANE_COMPACT_HOOK: "/h", CP_TEST_KEEP: "si" }
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
    Object.assign(process.env, vars)
    try {
      const editor = new Editor({ home: path.join(root, "home") })
      editor.save({ kind: "custom", command: `${fake} {file}` })
      await editor.open(repo, "a.txt", "uncommitted")
      for (let i = 0; i < 50 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 20))
      const env = fs.readFileSync(log, "utf8")
      for (const k of ["NODE_ENV", "CONTROL_PLANE_LAUNCH_ID", "CONTROL_PLANE_WEB_DIST", "CONTROL_PLANE_COMPACT_HOOK"]) assert.doesNotMatch(env, new RegExp(`^${k}=`, "m"), k)
      assert.match(env, /^CP_TEST_KEEP=si$/m, "el resto del entorno sí llega")
    } finally {
      for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("abrir el proyecto en el editor", () => {
  it("VS Code y Cursor reciben la carpeta; un comando propio, en {dir} o {file} (o al final)", () => {
    assert.deepEqual(folderCommand({ kind: "code", command: "" }, "/r"), { bin: "code", args: ["/r"] })
    assert.deepEqual(folderCommand({ kind: "cursor", command: "" }, "/r"), { bin: "cursor", args: ["/r"] })
    assert.deepEqual(folderCommand({ kind: "custom", command: "zed --new {dir}" }, "/r"), { bin: "zed", args: ["--new", "/r"] })
    assert.deepEqual(folderCommand({ kind: "custom", command: "meld {base} {file}" }, "/r"), { bin: "meld", args: ["/r"] })
    assert.deepEqual(folderCommand({ kind: "custom", command: "subl -n" }, "/r"), { bin: "subl", args: ["-n", "/r"] })
  })

  it("solo abre la carpeta del proyecto o uno de sus worktrees, con el entorno limpio", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-open-")))
    const root = path.join(base, "app")
    fs.mkdirSync(root)
    sh(root, "init", "-q", "-b", "main")
    write(root, "a.txt", "a\n")
    sh(root, "add", ".")
    sh(root, "commit", "-q", "-m", "base")
    sh(root, "worktree", "add", "-q", "-b", "feat/x", path.join(base, "app--x"))
    fs.mkdirSync(path.join(base, "otra"))

    assert.equal(await projectFolder(root), root)
    assert.equal(await projectFolder(root, path.join(base, "app--x")), path.join(base, "app--x"), "un worktree del repo, aunque esté afuera")
    assert.equal(await projectFolder(root, path.join(base, "app--x", "..", "app")), root)
    await assert.rejects(projectFolder(root, path.join(base, "otra")), /no es del proyecto/)
    await assert.rejects(projectFolder(root, "/etc"), /no es del proyecto/)
    await assert.rejects(projectFolder(path.join(base, "no-existe")), /ya no existe/)

    // Un editor falso que guarda sus argumentos y su entorno.
    const log = path.join(base, "open.log")
    const fake = path.join(base, "fake-code.sh")
    fs.writeFileSync(fake + ".tmp", `#!/bin/sh\n{ printf 'ARG=%s\\n' "$@"; env; } > "${log}.tmp" && mv "${log}.tmp" "${log}"\n`, { mode: 0o755 })
    fs.renameSync(fake + ".tmp", fake)
    const saved = { NODE_ENV: process.env.NODE_ENV, CONTROL_PLANE_LAUNCH_ID: process.env.CONTROL_PLANE_LAUNCH_ID }
    Object.assign(process.env, { NODE_ENV: "production", CONTROL_PLANE_LAUNCH_ID: "l1" })
    try {
      const editor = new Editor({ home: path.join(base, "home") })
      editor.save({ kind: "custom", command: `${fake} {dir}` })
      await editor.openFolder(await projectFolder(root, path.join(base, "app--x")))
      for (let i = 0; i < 50 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 20))
      const out = fs.readFileSync(log, "utf8")
      assert.match(out, new RegExp(`^ARG=${path.join(base, "app--x")}$`, "m"))
      assert.doesNotMatch(out, /^NODE_ENV=/m)
      assert.doesNotMatch(out, /^CONTROL_PLANE_LAUNCH_ID=/m)
    } finally {
      for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v))
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("la URL del repo", () => {
  it("sale del campo repository del package.json", () => {
    assert.equal(repoOf({ type: "git", url: "git+https://github.com/acme/app.git" }), "https://github.com/acme/app")
    assert.equal(repoOf("github:acme/app"), "https://github.com/acme/app")
    assert.equal(repoOf("https://example.com/x"), "https://example.com/x")
    assert.equal(repoOf(undefined), null)
    assert.equal(repoOf({ url: "git@github.com:acme/app.git" }), null)
  })
})
