import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { execFileSync } from "node:child_process"

import { findRepos, githubOf, parseWorktrees, readRepos } from "../src/overview.ts"

describe("resumen del proyecto", () => {
  it("reconoce remotos de GitHub por ssh y por https", () => {
    assert.deepEqual(githubOf("git@github.com:acme/warehouse.git"), { owner: "acme", repo: "warehouse" })
    assert.deepEqual(githubOf("https://github.com/acme/app"), { owner: "acme", repo: "app" })
    assert.deepEqual(githubOf("https://token@github.com/acme/app.git"), { owner: "acme", repo: "app" })
    assert.equal(githubOf("https://gitlab.com/acme/app.git"), null)
    assert.equal(githubOf(null), null)
  })

  it("lee los worktrees con su rama", () => {
    const out = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r--x\nHEAD def\nbranch refs/heads/feat/x\n\nworktree /r--d\nHEAD 123\ndetached\n"
    assert.deepEqual(parseWorktrees(out), [
      { path: "/r", branch: "main" },
      { path: "/r--x", branch: "feat/x" },
      { path: "/r--d", branch: null },
    ])
  })

  it("encuentra la raíz y los repos anidados, sin entrar en node_modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cp-repos-"))
    for (const d of [".git", "apps/web/.git", "libs/.git", "node_modules/pkg/.git", "a/b/c/.git"]) fs.mkdirSync(path.join(root, d), { recursive: true })
    const found = findRepos(root).map((p) => path.relative(root, p) || ".")
    assert.deepEqual(found.sort(), [".", "apps/web", "libs"])
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("lee los worktrees del repo aunque estén afuera o en una carpeta oculta, agrupados con su repo", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-wt-")))
    const root = path.join(base, "app")
    fs.mkdirSync(root)
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdio: "pipe" })
    git("init", "-q", "-b", "main")
    fs.writeFileSync(path.join(root, "a.txt"), "a\n")
    git("add", ".")
    git("commit", "-q", "-m", "base")
    git("worktree", "add", "-q", "-b", "feat/afuera", path.join(base, "app--afuera"))
    git("worktree", "add", "-q", "-b", "feat/oculto", path.join(root, ".claude/worktrees/oculto"))
    fs.writeFileSync(path.join(base, "app--afuera", "b.txt"), "b\n")

    const repos = await readRepos(root)
    const by = Object.fromEntries(repos.map((r) => [r.branch, r]))
    assert.deepEqual(Object.keys(by).sort(), ["feat/afuera", "feat/oculto", "main"])
    assert.equal(new Set(repos.map((r) => r.group)).size, 1, "los tres son del mismo repo")
    assert.equal(by["main"]!.worktree, false)
    assert.equal(by["feat/afuera"]!.worktree, true)
    assert.equal(by["feat/afuera"]!.name, "app--afuera")
    assert.equal(by["feat/afuera"]!.changes, 1)
    assert.equal(by["feat/oculto"]!.name, ".claude/worktrees/oculto")
    fs.rmSync(base, { recursive: true, force: true })
  })
})
