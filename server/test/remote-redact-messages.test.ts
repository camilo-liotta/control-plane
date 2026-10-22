import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { redactMessage } from "../src/remote/redact.ts"
import type { ServerMessage } from "../src/shared/types.ts"
import { emptySnapshot } from "./remote-harness.ts"

const REPO = "/home/example-user/code/proyecto-fixture"
const m = (x: Record<string, unknown>) => x as unknown as ServerMessage

/** Cada tipo conocido que SÍ llega a un cliente remoto, con su forma mínima. */
const PASSED: Record<string, Record<string, unknown>> = {
  hello: { type: "hello", snapshot: emptySnapshot() },
  project: { type: "project", project: { id: "p1", repoPath: REPO } },
  project_removed: { type: "project_removed", id: "p1" },
  session: { type: "session", session: { id: "s1", cwd: REPO } },
  event: { type: "event", event: { id: 1 } },
  event_update: { type: "event_update", event: { id: 1 } },
  partial: { type: "partial", sessionId: "s1", messageId: "m", index: 0, block: "text", delta: "x" },
  partial_clear: { type: "partial_clear", sessionId: "s1" },
  draft: { type: "draft", draft: { id: "d1" } },
  report: { type: "report", report: { id: "r1" } },
  usage: { type: "usage", accountId: "a1", usage: {} },
  account: { type: "account", account: { id: "a1", configDir: "/home/example-user/.claude", bin: "/x", auth: {} } },
  account_removed: { type: "account_removed", id: "a1" },
  meta: { type: "meta", meta: { version: "0", claudeVersion: null, models: [], account: { email: "a@b.c" }, homeDir: "/home/example-user" } },
  compaction: { type: "compaction", state: { id: "c" } },
  turn: { type: "turn", sessionId: "s1", turn: null },
  remote: { type: "remote" },
  task: { type: "task", task: { id: "t1" } },
  environment: { type: "environment", environment: { id: "e1", notes: "secreto", credentials: [] } },
  environment_removed: { type: "environment_removed", id: "e1", projectId: "p1" },
  apps: { type: "apps", projectId: "p1", apps: [] },
}

/** Los que no llegan nunca (de la app de escritorio o de la gestión local). */
const DROPPED = ["desktop", "desktop_summary", "toast", "clis_changed"]

describe("F3: redactMessage es una lista de permitidos", () => {
  for (const [type, msg] of Object.entries(PASSED)) {
    it(`${type}: llega, sin rutas absolutas ni secretos`, () => {
      const out = redactMessage(m(msg))
      assert.notEqual(out, null)
      assert.equal(out!.type, type)
      const text = JSON.stringify(out)
      assert.ok(!text.includes("example-user"), text)
      assert.ok(!text.includes("secreto"), text)
    })
  }

  for (const type of DROPPED) {
    it(`${type}: no llega`, () => assert.equal(redactMessage(m({ type })), null))
  }

  it("un tipo desconocido (por ejemplo uno futuro con rutas) se descarta", () => {
    assert.equal(redactMessage(m({ type: "future_thing", cwd: REPO })), null)
    assert.equal(redactMessage(m({})), null)
  })
})
