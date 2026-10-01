import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { Editor, editorCommand, folderCommand } from "../src/editor.ts"
import { PathResolver, resolveRef } from "../src/file-refs.ts"
import { codeRef, parseRef, textRefs } from "../src/shared/file-refs.ts"

const found = (text: string) => textRefs(text).map((r) => r.input)

describe("detector de rutas", () => {
  it("separa la línea y la columna", () => {
    assert.deepEqual(parseRef("web/src/lib/api.ts:120"), { path: "web/src/lib/api.ts", line: 120 })
    assert.deepEqual(parseRef("a/b.ts:3:7"), { path: "a/b.ts", line: 3, col: 7 })
    assert.deepEqual(parseRef("a/b.ts"), { path: "a/b.ts" })
    assert.deepEqual(parseRef("a/b.ts:0"), { path: "a/b.ts" })
  })

  it("en código inline: rutas, nombres con extensión y carpetas con / al final", () => {
    for (const ok of [
      "server/src/sessions.ts",
      "web/src/lib/api.ts:120",
      "desktop/src-tauri/src/update.rs",
      "a/b.tsx:3:7",
      "./scripts/deploy.sh",
      "../otro/README.md",
      "~/projects/control-plane/package.json",
      "/home/u/projects/x/server",
      "package.json",
      ".github/workflows/ci.yml",
      "desktop/Makefile",
      "web/src/",
      "node_modules/@types/node/index.d.ts",
    ])
      assert.ok(codeRef(ok), `debería ser ruta: ${ok}`)
  })

  it("en código inline: no son rutas los comandos, URLs, versiones ni carpetas sin /", () => {
    for (const bad of [
      "npm run dev",
      "gcloud secrets add-iam-policy-binding x --member=serviceAccount:a@b.com",
      "https://github.com/camilo-liotta/control-plane/blob/main/x.ts",
      "v0.4.2",
      "1.2.3",
      "a/b",
      "server/src",
      "--member=serviceAccount:x",
      "{{RUTA: carpeta}}/x.ts",
      "/tmp",
      "~/",
      "./",
      "a//b.ts",
      "x/../../etc/passwd",
      "/api/sessions/:id/open-file",
      "C:\\Users\\x.ts",
      "Ctrl+Z",
    ])
      assert.equal(codeRef(bad), null, `no debería ser ruta: ${bad}`)
  })

  it("en texto suelto: solo lo que claramente es un archivo", () => {
    assert.deepEqual(found("Toqué server/src/sessions.ts y web/src/lib/api.ts:120."), ["server/src/sessions.ts", "web/src/lib/api.ts:120"])
    assert.deepEqual(found("Corré ./scripts/deploy.sh, o mirá ~/notas/plan.md: ahí está."), ["./scripts/deploy.sh", "~/notas/plan.md"])
    assert.deepEqual(found("(ver desktop/src-tauri/src/update.rs:12:3)"), ["desktop/src-tauri/src/update.rs:12:3"])
    assert.deepEqual(found("En /home/u/projects/x/server/src/a.ts falla"), ["/home/u/projects/x/server/src/a.ts"])
  })

  it("en texto suelto: nada de URLs, versiones, a/b sin extensión, nombres sueltos ni comandos", () => {
    assert.deepEqual(
      found(
        "Ver https://github.com/x/y/blob/main/server/src/a.ts y www.x.com/a.ts. Sale la v0.4.2 (antes 1.2.3). " +
          "Probá y/o mirá a/b o TCP/IP, 2026/09/30, Node.js y package.json. Corré npm run dev. 1/2 de las veces. " +
          "La ruta /api/sessions/:id/open-file y mailto:a@b.com/x.md."
      ),
      []
    )
  })

  it("devuelve la posición exacta en el texto", () => {
    const text = "mirá ¿./a/b.ts? ya"
    const [r] = textRefs(text)
    assert.equal(text.slice(r!.start, r!.end), "./a/b.ts")
  })
})

describe("resolución de rutas", () => {
  let tmp: string
  let project: string
  let wt: string
  let outside: string

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-refs-")))
    project = path.join(tmp, "home", "proj")
    outside = path.join(tmp, "home", "afuera")
    fs.mkdirSync(path.join(project, "server", "src"), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(project, "server", "src", "sessions.ts"), "x\n")
    fs.writeFileSync(path.join(project, "package.json"), "{}\n")
    fs.writeFileSync(path.join(outside, "secreto.txt"), "no\n")
    fs.symlinkSync(path.join(outside, "secreto.txt"), path.join(project, "server", "link.txt"))
    fs.symlinkSync(path.join(project, "package.json"), path.join(project, "server", "adentro.json"))
    // Un worktree del proyecto, afuera de su carpeta, con un archivo que solo está ahí.
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", project, ...args], {
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
        stdio: "ignore",
      })
    git("init", "-q", "-b", "main")
    git("add", ".")
    git("commit", "-q", "-m", "base")
    wt = path.join(tmp, "home", "proj--wt")
    git("worktree", "add", "-q", "-b", "feat/x", wt)
    fs.writeFileSync(path.join(wt, "solo-en-wt.md"), "hola\n")
  })
  after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const home = () => path.join(tmp, "home")

  it("adentro: relativa, con línea, carpeta, absoluta y ~/", () => {
    const f = resolveRef("server/src/sessions.ts:12:3", [project], home())!
    assert.equal(f.rel, path.join("server", "src", "sessions.ts"))
    assert.equal(f.kind, "file")
    assert.deepEqual([f.line, f.col], [12, 3])
    assert.equal(resolveRef("server/", [project], home())!.kind, "dir")
    assert.equal(resolveRef(path.join(project, "package.json"), [project], home())!.rel, "package.json")
    assert.equal(resolveRef("~/proj/package.json", [project], home())!.rel, "package.json")
    assert.equal(resolveRef("./server/../package.json", [project], home()), null, "los .. en el medio no valen")
  })

  it("afuera: absoluta, ~/, .. y symlinks que salen", () => {
    assert.equal(resolveRef(path.join(outside, "secreto.txt"), [project], home()), null)
    assert.equal(resolveRef("~/afuera/secreto.txt", [project], home()), null, "~/ que existe pero fuera del proyecto")
    assert.equal(resolveRef("~/../home/afuera/secreto.txt", [project], home()), null)
    assert.equal(resolveRef("../afuera/secreto.txt", [project], home()), null)
    assert.equal(resolveRef("../../afuera/secreto.txt", [path.join(project, "server")], home()), null)
    assert.equal(resolveRef("server/link.txt", [project], home()), null, "symlink que apunta afuera")
    assert.equal(resolveRef("server/adentro.json", [project], home())!.rel, "package.json", "symlink que queda adentro")
  })

  it("inexistente o que no parece ruta: nada", () => {
    assert.equal(resolveRef("server/src/no-existe.ts", [project], home()), null)
    assert.equal(resolveRef("npm run dev", [project], home()), null)
  })

  it("en lote: primero la sesión, después el proyecto y sus worktrees", async () => {
    const r = new PathResolver({ home: home() })
    const out = await r.resolve(["server/src/sessions.ts", "solo-en-wt.md", "no/existe.ts", "server/src/sessions.ts"], { projectRoot: project })
    assert.deepEqual(
      out.map((f) => [f.input, f.root]),
      [
        ["server/src/sessions.ts", project],
        ["solo-en-wt.md", wt],
      ]
    )
    // Con la sesión en el worktree, la ruta se busca primero ahí.
    const inWt = await r.resolve(["package.json"], { projectRoot: project, sessionCwd: wt })
    assert.equal(inWt[0]!.root, wt)
    await assert.rejects(r.one("../afuera/secreto.txt", { projectRoot: project }), /No encontré/)
  })
})

describe("abrir en el editor en una línea", () => {
  it("VS Code y Cursor: -g archivo:línea:col en la ventana de la carpeta", () => {
    assert.deepEqual(editorCommand({ kind: "code", command: "" }, { dir: "/p", file: "/p/a.ts", base: null, line: 12, col: 3 }), {
      bin: "code",
      args: ["/p", "-g", "/p/a.ts:12:3"],
    })
    assert.deepEqual(editorCommand({ kind: "cursor", command: "" }, { dir: "/p", file: "/p/a.ts", base: null, line: 12 }).args, ["/p", "-g", "/p/a.ts:12"])
    assert.deepEqual(editorCommand({ kind: "code", command: "" }, { dir: "/p", file: "/p/a.ts", base: null }).args, ["/p", "-g", "/p/a.ts"])
  })

  it("comando propio: {line} es la línea, o 1", () => {
    const s = { kind: "custom" as const, command: "subl {file}:{line}" }
    assert.deepEqual(editorCommand(s, { dir: "/p", file: "/p/a.ts", base: null, line: 40 }), { bin: "subl", args: ["/p/a.ts:40"] })
    assert.deepEqual(editorCommand(s, { dir: "/p", file: "/p/a.ts", base: null }).args, ["/p/a.ts:1"])
    assert.deepEqual(editorCommand({ kind: "custom", command: "vim +{line}" }, { dir: "/p", file: "/p/a.ts", base: null, line: 7 }).args, ["+7", "/p/a.ts"])
    assert.deepEqual(folderCommand({ kind: "custom", command: "idea --line {line} {dir}" }, "/p").args, ["--line", "1", "/p"])
  })

  it("con un editor falso: abre el archivo resuelto en su línea", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-editor-"))
    try {
      const calls: { bin: string; args: string[]; cwd: string }[] = []
      const editor = new Editor({ home, launch: async (bin, args, cwd) => void calls.push({ bin, args, cwd }) })
      await editor.openAt("/p", "/p/server/src/a.ts", 120, 4)
      editor.save({ kind: "custom", command: "my-ed --goto {file}:{line} --root {dir}" })
      await editor.openAt("/p", "/p/server/src/a.ts", 9)
      assert.deepEqual(calls, [
        { bin: "code", args: ["/p", "-g", "/p/server/src/a.ts:120:4"], cwd: "/p" },
        { bin: "my-ed", args: ["--goto", "/p/server/src/a.ts:9", "--root", "/p"], cwd: "/p" },
      ])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
