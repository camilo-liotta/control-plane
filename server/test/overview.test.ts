import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { findRepos, githubOf, parseWorktrees } from "../src/overview.ts"

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
})
