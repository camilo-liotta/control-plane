import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { AttachmentStore } from "../src/attachments.ts"
import { childEnv, SERVER_ONLY_ENV } from "../src/claude/env.ts"
import { Db, defaultSettings } from "../src/db.ts"
import { Hub } from "../src/hub.ts"
import { SessionManager } from "../src/sessions.ts"
import { writeFakeClaude } from "./fake-claude.ts"

// Lo que pone la app de escritorio (o `npm start`) para el server, más lo que puede venir de tu shell.
const SERVER_ENV = {
  CONTROL_PLANE_LAUNCH_ID: "lanzado-por-la-app",
  CONTROL_PLANE_COMPACT_HOOK: "/instalado/app/compact-hook.mjs",
  CONTROL_PLANE_WEB_DIST: "/instalado/app/web",
  NODE_ENV: "production",
  CONTROL_PLANE_PORT: "4700",
  CONTROL_PLANE_HOME: "/datos/de/siempre",
  CONTROL_PLANE_HOST: "127.0.0.1",
}

describe("el entorno de lo que lanza el server", () => {
  it("saca las variables del server y deja las que pueden venir de tu shell", () => {
    const env = childEnv({ NO_COLOR: "1" }, { ...SERVER_ENV, PATH: "/usr/bin" })
    for (const k of SERVER_ONLY_ENV) assert.equal(env[k], undefined, k)
    assert.equal(env.CONTROL_PLANE_PORT, "4700")
    assert.equal(env.CONTROL_PLANE_HOME, "/datos/de/siempre")
    assert.equal(env.CONTROL_PLANE_HOST, "127.0.0.1")
    assert.equal(env.PATH, "/usr/bin")
    assert.equal(env.NO_COLOR, "1")
  })

  describe("una sesión", () => {
    let dir: string
    let db: Db
    let sessions: SessionManager
    const saved: Record<string, string | undefined> = {}

    before(() => {
      for (const [k, v] of Object.entries(SERVER_ENV)) {
        saved[k] = process.env[k]
        process.env[k] = v
      }
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-env-"))
      const fake = writeFakeClaude(dir)
      // El claude falso, pero antes deja su entorno en un archivo.
      const bin = path.join(dir, "claude-env.sh")
      fs.writeFileSync(bin, `#!/bin/sh\nenv > "${dir}/env-$$.txt"\nexec "${fake}" "$@"\n`, { mode: 0o755 })
      db = new Db(path.join(dir, "t.db"))
      db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
      sessions = new SessionManager({
        db,
        hub: new Hub(),
        attachments: new AttachmentStore(db),
        mcpUrlFor: () => "http://127.0.0.1/mcp",
        hookUrlFor: () => "http://127.0.0.1/hooks",
        launchFor: () => ({ protocol: "", orchestratorCanEdit: false, model: null, effort: null, env: { CLAUDE_CONFIG_DIR: dir }, bin, accountId: "acc" }),
        accountIdFor: () => "acc",
        meta: { version: "test", claudeVersion: null, models: [], account: null, homeDir: dir },
      })
    })

    after(async () => {
      for (const s of db.listSessions()) await sessions.stop(s.id).catch(() => {})
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })

    it("no recibe las variables internas del server, y sí el puerto", async () => {
      const rec = sessions.create({ projectId: "p1", kind: "worker", name: "GAMMA", role: "", cwd: dir, claudeSessionId: "c-env" })
      await sessions.send(rec.id, "hola", { origin: "user" })
      let file: string | undefined
      for (let i = 0; i < 100 && !file; i++) {
        file = fs.readdirSync(dir).find((f) => f.startsWith("env-"))
        if (!file) await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(file, "la sesión arrancó")
      const env = Object.fromEntries(
        fs
          .readFileSync(path.join(dir, file), "utf8")
          .split("\n")
          .filter((l) => l.includes("="))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
      )
      for (const k of SERVER_ONLY_ENV) assert.equal(env[k], undefined, k)
      assert.equal(env.CONTROL_PLANE_PORT, "4700")
      assert.equal(env.CONTROL_PLANE_HOME, "/datos/de/siempre")
      assert.equal(env.CLAUDE_CONFIG_DIR, dir)
    })
  })
})
