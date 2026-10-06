// Dispara, en el sembrado, eventos que mandan avisos: una pregunta, un resultado y una tarea que frena.
// Uso: CP_UX_HOME=… node poke.mjs <puerto> <pregunta|resultado|tarea> <SESIÓN>
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
const [port, what, who] = process.argv.slice(2)
const B = `http://127.0.0.1:${port}`
const db = new DatabaseSync(path.join(process.env.CP_UX_HOME, "srv", "control-plane.db"), { readOnly: true })
const row = db.prepare("SELECT id, mcp_token AS t FROM sessions WHERE name = ?").get(who)
const mcp = (tool, args) =>
  fetch(`${B}/mcp/${row.t}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) }).then((r) => r.text())
if (what === "pregunta") console.log(await fetch(`${B}/api/sessions/${row.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "PREGUNTA" }) }).then((r) => r.status))
if (what === "resultado") console.log((await mcp("report_result", { status: "done", summary: "Listo el banco de prueba del aviso." })).slice(0, 120))
if (what === "tarea") console.log((await mcp("create_user_task", { title: "Loguearse en el CLI de prueba", steps: ["Abrí Herramientas → CLIs"], blocking: true })).slice(0, 120))
