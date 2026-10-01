import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { Db, defaultSettings, type SessionRecord } from "../src/db.ts"
import type { Hub } from "../src/hub.ts"
import type { SendOptions, SessionManager } from "../src/sessions.ts"
import type { ServerMessage, TimelineEvent } from "../src/shared/types.ts"
import { CATALOG, Clis, type CliSpec } from "../src/clis.ts"
import { compareTasks, normalizeTags, orderTasks, tagGroups } from "../src/shared/task-order.ts"
import type { UserTask } from "../src/shared/types.ts"
import { CLI_DONE_NOTE, detectCli, sameTask, UserTasks } from "../src/user-tasks.ts"

function session(name: string): SessionRecord {
  return {
    id: `s_${name.toLowerCase()}`, projectId: "p1", kind: "worker", name, role: "", claudeSessionId: `c-${name}`, startedOnce: true,
    mcpToken: `tok-${name}`, model: null, effort: null, worktree: false, cwd: "/tmp", status: "idle", taskTitle: null, taskState: "none",
    lastActivity: null, lastActivityAt: null, costUsd: 0, tokens: null, context: null, createdAt: 1, archivedAt: null,
  }
}

describe("tareas para vos", () => {
  let dir: string
  let db: Db
  let tasks: UserTasks
  const messages: ServerMessage[] = []
  const events: { id: string; event: TimelineEvent }[] = []
  const sent: { id: string; text: string; opts: SendOptions }[] = []
  const alfa = session("ALFA")
  const beta = session("BETA")

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tasks-"))
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    db.insertSession(alfa)
    db.insertSession(beta)
    const hub = { broadcast: (m: ServerMessage) => messages.push(m) } as unknown as Hub
    const sessions = {
      addEvent: (id: string, event: TimelineEvent) => events.push({ id, event }),
      send: async (id: string, text: string, opts: SendOptions) => void sent.push({ id, text, opts }),
    } as unknown as SessionManager
    tasks = new UserTasks({ db, hub, sessions })
  })
  after(() => {
    tasks.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("reconoce dos pedidos del mismo trabajo", () => {
    assert.equal(sameTask("Reautenticar gcloud", "reautenticar GCloud (tu usuario)"), true)
    assert.equal(sameTask("Loguear vercel", "Loguear gcloud"), false)
  })

  it("una sesión crea una tarea: queda en el tablero, avisa y se ve en su chat", () => {
    const { task, existing } = tasks.create("p1", { title: "Reautenticar gcloud", steps: ["Herramientas → CLIs", "Reautenticar en Google Cloud CLI"], blocking: false }, alfa)
    assert.equal(existing, false)
    assert.equal(task.createdBy, alfa.id)
    // El aviso lleva al tablero, a "Tareas para vos" (la sesión viaja igual, para agrupar los avisos).
    const toast = messages.find((m) => m.type === "toast" && m.event === "task")
    assert.ok(toast && toast.type === "toast")
    assert.deepEqual([toast.projectId, toast.sessionId, toast.open], ["p1", alfa.id, "tasks"])
    assert.ok(events.some((e) => e.id === alfa.id && e.event.kind === "notice" && e.event.text.includes("Creó una tarea")))
    assert.throws(() => tasks.create("p1", { title: "Algo", steps: [] }, alfa), /pasos/)
  })

  it("si otra sesión pide lo mismo, se suma a la que ya estaba", () => {
    const { task, existing } = tasks.create("p1", { title: "reautenticar gcloud ya", steps: ["x"], blocking: true }, beta)
    assert.equal(existing, true)
    assert.deepEqual(task.alsoBy, [beta.id])
    assert.equal(task.blocking, true, "ahora frena a alguien")
    assert.equal(tasks.list("p1").filter((t) => t.status === "open").length, 1)
  })

  it("cuando la marcás hecha, les avisa a las sesiones que la pidieron", async () => {
    const [t] = tasks.list("p1")
    tasks.update(t!.id, { status: "done", note: "listo, con la cuenta de siempre" }, "user")
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(sent.map((s) => s.id).sort(), [alfa.id, beta.id])
    assert.match(sent[0]!.text, /ya hizo la tarea "Reautenticar gcloud".*Nota: listo/)
    assert.equal(tasks.list("p1")[0]!.closedBy, "user")
  })

  it("una sesión la cierra si ya no hace falta, sin mandarle nada a nadie", () => {
    sent.length = 0
    const { task } = tasks.create("p1", { title: "Pedir acceso a la base de Emissa", steps: ["Escribirle a soporte"] }, alfa)
    tasks.update(task.id, { status: "dismissed", note: "ya tengo acceso con dwh_reader" }, beta)
    assert.equal(sent.length, 0)
    assert.equal(db.getTask(task.id)!.closedBy, beta.id)
    assert.ok(events.some((e) => e.id === beta.id && e.event.kind === "notice" && e.event.text.includes("Descartó")))
    assert.throws(() => tasks.update(task.id, { status: "done" }, { ...beta, projectId: "otro" }), /otro proyecto/)
  })

  it("las que tienen fecha avisan un rato antes, una sola vez", () => {
    const { task } = tasks.create("p1", { title: "Correr el workflow de fin de mes", steps: ["`gh workflow run extractor.yml`"], due: Date.now() + 5 * 60_000 }, null)
    assert.deepEqual(db.dueTasks(Date.now() + 15 * 60_000).map((t) => t.id), [task.id])
    ;(tasks as unknown as { remind(): void }).remind()
    const toast = messages.findLast((m) => m.type === "toast" && m.title === "Una tarea tuya vence en un rato")
    assert.ok(toast && toast.type === "toast")
    assert.deepEqual([toast.projectId, toast.open], ["p1", "tasks"])
    assert.equal(db.dueTasks(Date.now() + 15 * 60_000).length, 0)
  })

  it("las sesiones ven las abiertas con sus pasos y las cerradas", () => {
    const text = tasks.summary("p1")
    assert.match(text, /Abiertas:[\s\S]*Correr el workflow[\s\S]*1\. `gh workflow run/)
    assert.match(text, /Cerradas[\s\S]*Reautenticar gcloud · hecha por el usuario/)
  })
})

describe("cli, prioridad y etiquetas", () => {
  let dir: string
  let db: Db
  let clis: Clis
  let tasks: UserTasks
  const messages: ServerMessage[] = []
  const sent: { id: string; text: string }[] = []
  const alfa = session("ALFA")
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(check(), `no llegó a tiempo: ${what}`)
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tasks-cli-"))
    db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    db.insertSession(alfa)
    // Un CLI falso, como en clis.test.ts: el login pregunta y sale bien solo si le contestás "Y".
    const bin = path.join(dir, "falsocli")
    fs.writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "falsocli 1.2.3"; exit 0; fi
if [ "$1" = "status" ]; then if [ -f "${dir}/logueado" ]; then echo "ok"; exit 0; fi; echo "token expired"; exit 1; fi
echo "Open https://ejemplo.com/device to continue"
echo "Continue? (Y/n)"
read respuesta
[ "$respuesta" = "Y" ] && touch "${dir}/logueado" && exit 0
echo "login cancelado por el usuario"
exit 3
`,
      { mode: 0o755 }
    )
    const spec: CliSpec = {
      id: "falsocli",
      name: "Falso CLI",
      description: "",
      category: "Pruebas",
      bins: ["falsocli"],
      docs: "https://ejemplo.com",
      install: {},
      auth: [
        {
          label: null,
          login: ["login"],
          check: async (_bin, run) => {
            const r = await run(["status"])
            return r.code === 0 ? { state: "ok", account: "vos@ejemplo.com" } : { state: "expired" }
          },
        },
      ],
    }
    process.env.PATH = `${dir}:${process.env.PATH}`
    clis = new Clis({ catalog: [spec] })
    const hub = { broadcast: (m: ServerMessage) => messages.push(m) } as unknown as Hub
    const sessions = {
      addEvent: () => {},
      send: async (id: string, text: string) => void sent.push({ id, text }),
    } as unknown as SessionManager
    tasks = new UserTasks({ db, hub, sessions, clis })
  })
  after(() => {
    tasks.dispose()
    clis.dispose()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("la tarea guarda cli, priority y tags (las etiquetas, normalizadas)", () => {
    const { task } = tasks.create("p1", { title: "Loguear el falso", steps: ["Tocá el botón"], cli: { id: "falsocli" }, priority: 2, tags: ["Postmark Dominios", "postmark-dominios", "  "] }, alfa)
    const saved = db.getTask(task.id)!
    assert.deepEqual(saved.cli, { id: "falsocli", credential: 0 })
    assert.equal(saved.priority, 2)
    assert.deepEqual(saved.tags, ["postmark-dominios"])
    tasks.update(task.id, { priority: null, tags: ["otra_cosa"] }, alfa)
    assert.equal(db.getTask(task.id)!.priority, null)
    assert.deepEqual(db.getTask(task.id)!.tags, ["otra-cosa"])
    tasks.update(task.id, { priority: 0 }, alfa)
    assert.equal(db.getTask(task.id)!.priority, 1, "la prioridad arranca en 1")
    assert.throws(() => tasks.create("p1", { title: "Loguear otro", steps: ["x"], cli: { id: "no-existe" } }, alfa), /catálogo/)
    assert.throws(() => tasks.create("p1", { title: "Loguear otro", steps: ["x"], cli: { id: "falsocli", credential: 3 } }, alfa), /credencial/)
    tasks.update(task.id, { status: "dismissed" }, alfa)
  })

  it("si el login desde la tarea sale bien, se cierra sola y le avisa a la sesión", async () => {
    sent.length = 0
    const { task } = tasks.create("p1", { title: "Reautenticar el falso", steps: ["Tocá Reautenticar"], cli: { id: "falsocli" } }, alfa)
    const job = tasks.loginFromTask(task.id)
    await until(() => clis.job(job.id).output.includes("(Y/n)"), "la pregunta del login")
    clis.answer(job.id, "Y")
    await until(() => db.getTask(task.id)!.status === "done", "que se cierre")
    const done = db.getTask(task.id)!
    assert.equal(done.note, CLI_DONE_NOTE)
    assert.equal(done.closedBy, "user")
    await until(() => sent.length > 0, "el aviso a la sesión")
    assert.equal(sent[0]!.id, alfa.id)
    assert.match(sent[0]!.text, /ya hizo la tarea "Reautenticar el falso".*Reautenticado desde la tarea/)
    assert.throws(() => tasks.loginFromTask(task.id), /cerrada/)
  })

  it("si el login falla, queda abierta con el motivo y no le avisa a nadie", async () => {
    fs.rmSync(path.join(dir, "logueado"), { force: true })
    sent.length = 0
    const { task } = tasks.create("p1", { title: "Volver a loguear el falso", steps: ["Tocá Reautenticar"], cli: { id: "falsocli" } }, alfa)
    const job = tasks.loginFromTask(task.id)
    await until(() => clis.job(job.id).output.includes("(Y/n)"), "la pregunta del login")
    clis.answer(job.id, "n")
    await until(() => Boolean(db.getTask(task.id)!.note), "el motivo")
    const t = db.getTask(task.id)!
    assert.equal(t.status, "open")
    assert.match(t.note!, /No se pudo reautenticar: el login terminó con error \(código 3\): login cancelado por el usuario/)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(sent.length, 0)
    assert.throws(() => tasks.loginFromTask((tasks.create("p1", { title: "Mandar el mail a soporte", steps: ["x"] }, alfa)).task.id), /no es de loguear/)
  })

  it("las que ya existían sin cli lo toman del título o de los pasos", () => {
    const id = "t_vieja"
    db.insertTask({
      id, projectId: "p1", title: "Reautenticar falsocli", steps: ["Herramientas → CLIs"], why: null, blocking: false, due: null, createdBy: alfa.id, alsoBy: [],
      status: "open", note: null, closedBy: null, createdAt: 1, updatedAt: 1, closedAt: null, cli: null, priority: null, tags: [],
    })
    assert.deepEqual(tasks.get(id)!.cli, { id: "falsocli", credential: 0 })
    assert.equal(db.getTask(id)!.cli, null, "no se guarda: es solo de respaldo")
  })
})

describe("el detector de CLI", () => {
  const det = (title: string, steps: string[] = ["x"]) => detectCli({ title, steps }, CATALOG)
  it("reconoce los pedidos de login de un CLI del catálogo", () => {
    assert.deepEqual(det("Reautenticar gcloud"), { id: "gcloud", credential: 0 })
    assert.deepEqual(det("Loguear gh con la cuenta de la empresa"), { id: "gh", credential: 0 })
    assert.deepEqual(det("Iniciar sesión en Vercel"), { id: "vercel", credential: 0 })
    assert.deepEqual(det("Re-autenticar Google Cloud (ADC)"), { id: "gcloud", credential: 1 })
    assert.deepEqual(det("Login de wrangler"), { id: "wrangler", credential: 0 })
    assert.deepEqual(det("Arreglar el deploy", ["Corré `gcloud auth application-default login`"]), { id: "gcloud", credential: 1 })
    assert.deepEqual(det("Hace falta tu cuenta", ["Corré `gh auth login --web --hostname github.com --git-protocol https`"]), { id: "gh", credential: 0 })
  })
  it("no se confunde con lo que no es loguear ese CLI", () => {
    assert.equal(det("Revisar los logs de gcloud"), null)
    assert.equal(det("Instalar gh"), null)
    assert.equal(det("Loguearte en la consola de AWS para aprobar la factura"), null)
    assert.equal(det("Login en la web de Vercel"), null)
    assert.equal(det("Crear un token de GitHub"), null)
    assert.equal(det("Reautenticar la VPN"), null)
    assert.equal(det("Loguear el bot de Slack"), null)
    assert.equal(det("Loguear en ghost"), null, "gh tiene que ser una palabra entera")
    assert.equal(det("Pasar el login a jq"), null, "jq no tiene login")
  })
})

describe("orden y etiquetas", () => {
  let n = 0
  const t = (p: Partial<UserTask>): UserTask => ({
    id: `t${++n}`, projectId: "p1", title: `tarea ${n}`, steps: ["x"], why: null, blocking: false, due: null, createdBy: null, alsoBy: [],
    status: "open", note: null, closedBy: null, createdAt: n, updatedAt: n, closedAt: null, cli: null, priority: null, tags: [], ...p,
  })

  it("por prioridad (1 primero), las sin prioridad al final por fecha, y las que frenan arriba igual", () => {
    const sinVieja = t({ title: "sin prioridad, vieja" })
    const dos = t({ title: "dos", priority: 2 })
    const sinNueva = t({ title: "sin prioridad, nueva" })
    const uno = t({ title: "uno", priority: 1 })
    const frena = t({ title: "frena, sin prioridad", blocking: true })
    const frenaDos = t({ title: "frena, prioridad 2", blocking: true, priority: 2 })
    const sorted = [sinVieja, dos, sinNueva, uno, frena, frenaDos].sort(compareTasks).map((x) => x.title)
    assert.deepEqual(sorted, ["frena, prioridad 2", "frena, sin prioridad", "uno", "dos", "sin prioridad, vieja", "sin prioridad, nueva"])
  })

  it("cuenta por etiqueta, y una que quedó en una sola abierta no es un grupo", () => {
    const tasks = [
      t({ tags: ["postmark-dominios"], status: "done" }),
      t({ tags: ["postmark-dominios"] }),
      t({ tags: ["postmark-dominios"] }),
      t({ tags: ["postmark-dominios"], status: "dismissed" }),
      t({ tags: ["sola"] }),
      t({ tags: ["sola"], status: "done" }),
    ]
    const g = tagGroups(tasks)
    assert.deepEqual(g.get("postmark-dominios"), { tag: "postmark-dominios", total: 3, open: 2, done: 1 })
    assert.equal(g.has("sola"), false)
    assert.deepEqual(normalizeTags(["Postmark  Dominios!", "ÁREA_Ñandú", "x".repeat(40)]), ["postmark-dominios", "area-nandu", "x".repeat(32)])
  })

  it("las de un mismo grupo quedan juntas, donde está la primera", () => {
    const a = t({ title: "A dominio 1", priority: 1, tags: ["dominio"] })
    const b = t({ title: "B otra", priority: 2 })
    const c = t({ title: "C dominio 2", priority: 3, tags: ["dominio"] })
    const d = t({ title: "D sin prioridad" })
    assert.deepEqual(orderTasks([d, c, b, a]).map((x) => x.title), ["A dominio 1", "C dominio 2", "B otra", "D sin prioridad"])
  })
})

describe("reabrir una tarea", () => {
  it("deja atrás la nota con que se había cerrado", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-tasks-reopen-"))
    const db = new Db(path.join(dir, "t.db"))
    db.insertProject({ id: "p1", name: "P", repoPath: dir, settings: defaultSettings, accountId: null, createdAt: 1, archivedAt: null })
    const tasks = new UserTasks({ db, hub: { broadcast: () => {} } as unknown as Hub, sessions: { addEvent: () => {}, send: async () => {} } as unknown as SessionManager })
    try {
      const { task } = tasks.create("p1", { title: "Algo", steps: ["x"] }, null)
      tasks.update(task.id, { status: "done", note: "listo" }, "user")
      assert.equal(tasks.update(task.id, { status: "open" }, "user").note, null)
    } finally {
      tasks.dispose()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
