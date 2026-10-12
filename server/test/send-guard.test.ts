import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"

import { buildLaunch } from "../src/claude/args.ts"
import { config } from "../src/config.ts"
import type { SessionRecord } from "../src/db.ts"
import { decideSend, SEND_DENIED, type SendGuardDeps } from "../src/send-guard.ts"

let n = 0
function rec(projectId: string, name: string, kind: "worker" | "orchestrator" = "worker"): SessionRecord {
  n++
  return {
    id: `s_${n}`, projectId, kind, name, role: "", claudeSessionId: `c-${n}`, startedOnce: true, mcpToken: `tok-${n}`, model: null,
    effort: null, worktree: false, cwd: "/tmp", status: "idle", taskTitle: null, taskState: "none", lastActivity: null,
    lastActivityAt: null, costUsd: 0, costByModel: {}, tokens: null, context: null, createdAt: 1, archivedAt: null,
  }
}

const orqA = rec("pa", "ORQ-A", "orchestrator")
const backA = rec("pa", "BACKEND")
const webA = rec("pa", "WEB")
const orqB = rec("pb", "ORQ-B", "orchestrator")
const backB = rec("pb", "BACKEND-B")
// Dos sesiones que se llaman igual en dos proyectos.
const dupA = rec("pa", "TESTS")
const dupB = rec("pb", "TESTS")
const all = [orqA, backA, webA, orqB, backB, dupA, dupB]
const PIDS = new Map<number, string>([[1001, backA.id], [1002, webA.id], [2001, orqB.id], [2002, backB.id], [1000, orqA.id]])
const sock = (pid: number) => `uds:/run/user/1000/cc-socks/${pid}.sock`

function deps(extra: Partial<SendGuardDeps> = {}): SendGuardDeps {
  return {
    sessions: () => all,
    pids: () => PIDS,
    agentNames: () => [],
    socketOf: (_s, pid) => `/run/user/1000/cc-socks/${pid}.sock`,
    ...extra,
  }
}

const send = (caller: SessionRecord | null, to: string, extra: Record<string, unknown> = {}, d = deps()) =>
  decideSend(d, caller, { to, recipient: to, message: "hola", ...extra })

const denied = (r: { allow: boolean; reason?: string }) => (r.allow ? null : (r.reason ?? ""))

describe("cerrojo de SendMessage: a quién va el mensaje", () => {
  it("el nombre de una sesión del propio proyecto pasa, sin distinguir mayúsculas", async () => {
    assert.deepEqual(await send(backA, "WEB"), { allow: true })
    assert.deepEqual(await send(backA, "web"), { allow: true })
    assert.deepEqual(await send(backA, "ORQ-A"), { allow: true })
    assert.deepEqual(await send(orqA, "BACKEND"), { allow: true })
    assert.deepEqual(await send(backA, "BACKEND"), { allow: true }, "a sí misma")
  })

  it("una sesión de otro proyecto se deniega, con el texto de un worker o el de una orquestadora", async () => {
    assert.equal(denied(await send(backA, "BACKEND-B")), SEND_DENIED.otherProjectWorker)
    assert.equal(denied(await send(backA, "ORQ-B")), SEND_DENIED.otherProjectWorker)
    assert.equal(denied(await send(orqA, "ORQ-B")), SEND_DENIED.otherProjectOrchestrator)
    assert.equal(denied(await send(orqB, "WEB")), SEND_DENIED.otherProjectOrchestrator)
    assert.match(SEND_DENIED.otherProjectWorker, /^Solo podés hablar con sesiones de tu proyecto\. Si necesitás algo de otro proyecto, pedíselo a tu orquestadora\.$/)
    assert.equal(SEND_DENIED.otherProjectOrchestrator, "Para hablar con otro proyecto usá message_project.")
  })

  it("nombre [ref]: se resuelve por el nombre", async () => {
    assert.deepEqual(await send(backA, "WEB [3fa9c1]", { recipient_kind: "name" }), { allow: true })
    assert.equal(denied(await send(backA, "BACKEND-B [3fa9c1]")), SEND_DENIED.otherProjectWorker)
  })

  it("la dirección uds: se resuelve por el pid del proceso que lanzó el dashboard", async () => {
    assert.deepEqual(await send(backA, sock(1002), { recipient_kind: "session" }), { allow: true })
    assert.deepEqual(await send(orqA, sock(1001), { recipient_kind: "session" }), { allow: true })
    assert.equal(denied(await send(backA, sock(2001), { recipient_kind: "session" })), SEND_DENIED.otherProjectWorker)
    assert.equal(denied(await send(orqA, sock(2002), { recipient_kind: "session" })), SEND_DENIED.otherProjectOrchestrator)
  })

  it("un socket de un pid que no es del dashboard (una sesión tuya de afuera, la nube) se deniega y lo explica", async () => {
    const r = denied(await send(backA, sock(99999), { recipient_kind: "session" }))
    assert.match(r!, /no es una sesión de este dashboard/)
    assert.match(r!, /fuera del dashboard.*la nube/)
    assert.match(r!, /pedíselo a tu orquestadora/)
    assert.match(denied(await send(orqA, sock(99999), { recipient_kind: "session" }))!, /message_project/)
    assert.match(denied(await send(backA, "bridge:session_abc", { recipient_kind: "session" }))!, /no es una sesión de este dashboard/)
    // Una ruta rara que termina igual pero no es el socket de ese proceso.
    assert.match(denied(await send(backA, "uds:/tmp/otro/cc-socks/1002.sock", { recipient_kind: "session" }))!, /no es una sesión de este dashboard/)
    assert.match(denied(await send(backA, "uds:/run/user/1000/cc-socks/abc.sock", { recipient_kind: "session" }))!, /no es una sesión de este dashboard/)
  })

  it("sin registro del socket, vale el lugar por defecto de Claude Code", async () => {
    const d = deps({ socketOf: () => null })
    const prev = process.env.XDG_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = "/run/user/1000"
    try {
      assert.deepEqual(await send(backA, sock(1002), { recipient_kind: "session" }, d), { allow: true })
      assert.match(denied(await send(backA, "uds:/tmp/x/cc-socks/1002.sock", { recipient_kind: "session" }, d))!, /no es una sesión/)
    } finally {
      if (prev === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = prev
    }
  })

  it("un nombre que no es de ninguna sesión del dashboard se deniega", async () => {
    assert.match(denied(await send(backA, "MI-SESION-DE-TERMINAL"))!, /no es una sesión de este dashboard/)
    assert.match(denied(await send(backA, "*"))!, /no es una sesión de este dashboard/)
  })

  it("el nombre repetido en dos proyectos se deniega y pide el nombre exacto", async () => {
    const r = denied(await send(dupA, "TESTS"))
    assert.equal(r, SEND_DENIED.ambiguous("TESTS"))
    assert.match(r!, /list_sessions/)
    assert.equal(denied(await send(backA, "TESTS [abc123]")), SEND_DENIED.ambiguous("TESTS"))
  })

  it("un nombre repetido solo entre sesiones de otros proyectos es de otro proyecto", async () => {
    const d = deps({ sessions: () => [orqA, backA, rec("pb", "DUP"), rec("pc", "DUP")] })
    assert.equal(denied(await send(backA, "DUP", {}, d)), SEND_DENIED.otherProjectWorker)
  })

  it("una sesión de afuera del dashboard con el mismo nombre también es ambiguo; las del dashboard no cuentan", async () => {
    const live = async () => [
      { pid: 1002, name: "WEB", cwd: "/x", kind: "interactive" as const },
      { pid: 777, name: "web", cwd: "/y", kind: "interactive" as const },
    ]
    assert.equal(denied(await send(backA, "WEB", {}, deps({ live }))), SEND_DENIED.ambiguous("WEB"))
    const onlyOurs = async () => [{ pid: 1002, name: "WEB", cwd: "/x", kind: "interactive" as const }]
    assert.deepEqual(await send(backA, "WEB", {}, deps({ live: onlyOurs })), { allow: true })
    const broken = async () => {
      throw new Error("no anda")
    }
    assert.deepEqual(await send(backA, "WEB", {}, deps({ live: broken })), { allow: true }, "el chequeo de afuera es de mejor esfuerzo")
  })

  it("un subagente propio con ese nombre gana (SendMessage lo elige a él), sin [ref]", async () => {
    const d = deps({ agentNames: (id) => (id === backA.id ? ["BACKEND-B", "revisor"] : []) })
    assert.deepEqual(await send(backA, "revisor", {}, d), { allow: true })
    assert.deepEqual(await send(backA, "BACKEND-B", {}, d), { allow: true })
    assert.equal(denied(await send(backA, "BACKEND-B [abc123]", {}, d)), SEND_DENIED.otherProjectWorker, "con [ref] se pide una sesión")
    assert.equal(denied(await send(webA, "BACKEND-B", {}, d)), SEND_DENIED.otherProjectWorker, "los subagentes son de cada sesión")
  })

  it("la conversación principal del propio proceso pasa", async () => {
    assert.deepEqual(await send(backA, "main", { recipient_kind: "main" }), { allow: true })
  })

  it("falla cerrado: sin sesión que llama, sin destino o que se rompe", async () => {
    assert.match(denied(await send(null, "WEB"))!, /No pude identificar tu sesión/)
    assert.equal(denied(await decideSend(deps(), backA, {})), SEND_DENIED.unresolved(""))
    assert.equal(denied(await decideSend(deps(), backA, { to: "  " })), SEND_DENIED.unresolved(""))
    assert.equal(denied(await decideSend(deps(), backA, { to: " [abc] " })), SEND_DENIED.unresolved("[abc]"))
    assert.match(SEND_DENIED.unresolved("X"), /nombre exacto que muestra list_sessions/)
  })
})

describe("cerrojo de SendMessage: el hook en las sesiones", () => {
  const launch = (kind: "worker" | "orchestrator") =>
    buildLaunch(rec("pa", "S", kind), {
      mcpUrl: "http://127.0.0.1:4700/mcp/tok",
      hookUrl: "http://127.0.0.1:4700/hooks/tok",
      protocol: "p",
      orchestratorCanEdit: false,
      model: null,
      effort: null,
    })
  const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]!) as { hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]> }

  it("los argumentos de lanzamiento traen el PreToolUse de SendMessage, y el de compactación sigue", () => {
    for (const kind of ["worker", "orchestrator"] as const) {
      const hooks = settingsOf(launch(kind).args).hooks
      const pre = hooks.PreToolUse!
      assert.equal(pre.length, 1)
      assert.equal(pre[0]!.matcher, "SendMessage")
      assert.match(pre[0]!.hooks[0]!.command, /\/hooks\/tok\/send-message" --deny-on-error$/)
      assert.ok(pre[0]!.hooks[0]!.timeout <= 60)
      assert.match(hooks.PreCompact![0]!.hooks[0]!.command, /\/hooks\/tok\/compact"$/)
      assert.ok(hooks.PostCompact)
    }
  })

  /** Corre el script del hook como lo corre Claude Code: el evento por stdin, la decisión por stdout. */
  const runHook = (url: string, ...flags: string[]) =>
    spawnSync(process.execPath, [config.compactHook, url, ...flags], { input: JSON.stringify({ tool_name: "SendMessage" }), encoding: "utf8", timeout: 20_000 })

  it("el script deniega si el dashboard no contesta (--deny-on-error) y la compactación sigue como siempre", () => {
    const closed = runHook("http://127.0.0.1:1/hooks/x/send-message", "--deny-on-error")
    assert.equal(closed.status, 0)
    const out = JSON.parse(closed.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse")
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny")
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /por seguridad no se envía/)
    const open = runHook("http://127.0.0.1:1/hooks/x/compact")
    assert.deepEqual([open.status, open.stdout], [0, ""])
  })

  it("el script pasa lo que el server responde: la decisión con deny, o nada para dejar pasar; un 500 deniega", async () => {
    let reply: { code: number; body: string } = { code: 200, body: "" }
    const srv = http.createServer((req, res) => {
      req.resume()
      req.on("end", () => res.writeHead(reply.code, { "content-type": "application/json" }).end(reply.body))
    })
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hooks/x/send-message`
    try {
      // spawnSync bloquea el event loop: el script corre en otro proceso, el server tiene que seguir atendiendo.
      const run = (...flags: string[]) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const c = spawn(process.execPath, [config.compactHook, url, ...flags])
          let out = ""
          c.stdout.on("data", (d) => (out += d))
          c.on("close", (code) => resolve({ code, out }))
          c.stdin.end("{}")
        })
      reply = { code: 200, body: "" }
      assert.deepEqual(await run("--deny-on-error"), { code: 0, out: "" })
      const decision = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "NO" } })
      reply = { code: 200, body: decision }
      assert.deepEqual(await run("--deny-on-error"), { code: 0, out: decision })
      reply = { code: 500, body: "" }
      assert.match((await run("--deny-on-error")).out, /"permissionDecision":"deny"/)
      assert.equal((await run()).out, "", "la compactación no se bloquea por un error")
    } finally {
      srv.close()
    }
  })
})
