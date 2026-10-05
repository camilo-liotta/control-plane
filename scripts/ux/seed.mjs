// Siembra el server del banco con datos INVENTADOS (el repo es público: nada de nombres, emails ni
// rutas reales). Correrlo una vez, con el server recién levantado con --reset.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { CACHE, REPOS, SERVER_PORT, SRV } from "./paths.mjs"

const B = `http://127.0.0.1:${SERVER_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${t}`)
  return t ? JSON.parse(t) : null
}
const snap = () => api("GET", "/api/snapshot")
const token = (name) => new DatabaseSync(path.join(SRV, "control-plane.db"), { readOnly: true }).prepare("SELECT mcp_token AS t FROM sessions WHERE name = ?").get(name).t
/** Llama una herramienta MCP como la llamaría esa sesión. */
const mcp = async (who, tool, args) => {
  const r = await fetch(`${B}/mcp/${token(who)}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) })
  const j = await r.json()
  const txt = j.result?.content?.[0]?.text ?? JSON.stringify(j)
  console.log(`  ${who} · ${tool}: ${txt.slice(0, 70)}`)
}
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.test", ...a], { cwd, stdio: "ignore" })

if ((await snap()).projects.length) throw new Error("El server ya tiene datos: levantalo con --reset para sembrar de cero")

// Repos de mentira (con una rama en un worktree y un archivo sin commitear).
const NAMES = { portal: "portal-alquileres", turnos: "agenda-turnos", datos: "lago-de-datos" }
for (const name of Object.values(NAMES)) {
  const dir = path.join(REPOS, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, "src/billing"), { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  git(dir, "commit", "-q", "--allow-empty", "-m", "Inicio")
  fs.writeFileSync(path.join(dir, "src/billing/invoices.ts"), "export const pending = []\n")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "Cobranzas: facturas pendientes por inquilino")
}
const portalDir = path.join(REPOS, NAMES.portal)
git(portalDir, "worktree", "add", "-q", path.join(REPOS, `${NAMES.portal}--recordatorios`), "-b", "feat/recordatorios")
fs.appendFileSync(path.join(portalDir, "src/billing/invoices.ts"), "// en curso\n")

await api("POST", "/api/accounts", { name: "Personal", configDir: path.join(CACHE, "home", ".claude-personal") }).catch((e) => console.log("cuenta:", e.message))

const proj = {}
for (const [key, orch] of [["portal", "ORQ-PORTAL"], ["turnos", "ORQ-TURNOS"], ["datos", "ORQ-DATOS"]]) {
  const p = await api("POST", "/api/projects", { name: NAMES[key], repoPath: path.join(REPOS, NAMES[key]), orchestratorName: orch })
  proj[key] = p.project?.id ?? p.id
}
const WORKERS = {
  portal: [["API", "Backend de cobranzas y contratos"], ["BASE", "Modelo de datos y migraciones"], ["WEB", "Portal de inquilinos"], ["PAGOS", "Integración con la pasarela de pagos"], ["MIGRACION", "Mudanza de la base a la nube"], ["FACTURACION", "Facturación electrónica"], ["SOPORTE", "Bugs que llegan por soporte"], ["VIEJA", "Prototipo descartado"]],
  turnos: [["COSTOS", "Bajar el costo de la nube"], ["MIGRACION-DB", "Postgres 14 → 16"]],
  datos: [["INGESTA", "Ingesta de los proveedores"]],
}
for (const [p, list] of Object.entries(WORKERS)) for (const [name, role] of list) await api("POST", `/api/projects/${proj[p]}/sessions`, { name, role })
let s = await snap()
const id = (name) => s.sessions.find((x) => x.name === name).id
const msg = (name, text) => api("POST", `/api/sessions/${id(name)}/messages`, { text })

// Conversaciones con contenido (ORQ-DATOS queda con el chat vacío, para ver ese estado).
for (const n of ["API", "BASE", "WEB", "PAGOS", "MIGRACION", "SOPORTE", "VIEJA", "COSTOS", "MIGRACION-DB", "INGESTA", "ORQ-PORTAL", "ORQ-TURNOS"]) await msg(n, "DEMO: revisá los recordatorios de pago y dejalos andando")
await sleep(4000)
await msg("WEB", "SUBAGENTE revisá la accesibilidad del portal")
await msg("COSTOS", "CRON 0 9 * * 1-5|1|1|Revisá el gasto de ayer y avisame si subió más de 10%")
await msg("COSTOS", "WAKEUP 1500|esperando el reporte de facturación")
await sleep(1500)

// Resultados, tareas para vos (con prioridad, etiquetas y cli), entornos y apps.
await mcp("PAGOS", "report_result", { status: "done", summary: "Webhook de pagos conectado con reintentos.\nLos pagos aprobados marcan la factura como paga en menos de 5 s.", details: "Archivos: src/payments/webhook.ts. Probar con `npm run pagos:sandbox`." })
await mcp("SOPORTE", "report_result", { status: "blocked", summary: "Los recibos duplicados vienen de un job que corre dos veces. Hay que decidir si se borra el cron viejo o se pone un lock." })
await mcp("API", "create_user_task", { title: "Reautenticar gcloud", steps: ["Herramientas → CLIs", "Reautenticar en Google Cloud CLI"], why: "Para leer los logs del servicio", blocking: true, cli: { id: "gcloud" }, priority: 1 })
await mcp("MIGRACION", "create_user_task", { title: "Crear la instancia de la base", steps: ["Abrí la consola de la nube → Bases de datos", "Creá una instancia Postgres 16 llamada portal-prod", "`gcloud sql instances describe portal-prod`"], priority: 2, tags: ["base-nueva"] })
await mcp("MIGRACION", "create_user_task", { title: "Darle acceso a la cuenta de servicio", steps: ["IAM → cuenta portal-migra", "Rol de cliente de la base"], priority: 3, tags: ["base-nueva"], due: new Date(Date.now() + 26 * 3600e3).toISOString() })
await mcp("FACTURACION", "create_user_task", { title: "Subir el certificado de facturación", steps: ["Descargá el .crt del entorno de homologación", "Copialo a `secrets/factura.crt`"] })
await mcp("API", "set_environment", { name: "Local", url: "http://localhost:3000", notes: "npm run dev en apps/web y la API en 4000" })
await mcp("API", "add_credential", { environment: "Local", name: "Inquilino", username: "inquilino.demo@example.test", secret: "Demo-Inquilino-1", notes: "Contrato activo, 2 recibos pendientes" })
await mcp("BASE", "add_credential", { environment: "Local", name: "Usuario admin", username: "admin@example.test", secret: "Demo-Admin-2", loginUrl: "http://localhost:3000/admin" })
await mcp("BASE", "set_environment", { name: "Staging", url: "https://staging.example.test" })
await mcp("BASE", "add_credential", { environment: "Staging", name: "Token de la API", secret: "demo_token_123", notes: "Bearer, vence el 15/10" })
const web = await api("POST", `/api/projects/${proj.portal}/apps`, { name: "web", command: "python3 -m http.server 5190 --bind 127.0.0.1", health: { kind: "http", url: "http://127.0.0.1:5190/" } })
const back = await api("POST", `/api/projects/${proj.portal}/apps`, { name: "api", command: "python3 -c \"import sys; print('Error: connect ECONNREFUSED 127.0.0.1:5432'); sys.exit(1)\"", health: { kind: "tcp", port: 5191 } })
await api("POST", `/api/projects/${proj.portal}/apps`, { name: "worker", command: "node worker.js" })
await api("POST", `/api/apps/${web.id}/start`).catch(() => {})
await api("POST", `/api/apps/${back.id}/start`).catch(() => {})
await mcp("API", "set_environment", { name: "Local", app: "web" })

// Estados vivos: trabajando, pregunta, permiso, compactación por decidir, error, detenida y archivada.
await msg("API", "LARGO: implementá los reintentos del webhook")
await msg("MIGRACION-DB", "LARGO: migrá las tablas de turnos")
await msg("BASE", "PREGUNTA")
await msg("MIGRACION", "PERMISO")
await msg("FACTURACION", "Armá el cliente de facturación")
await msg("SOPORTE", "MUERE")
await api("POST", `/api/sessions/${id("INGESTA")}/stop`)
await api("DELETE", `/api/sessions/${id("VIEJA")}`)
await sleep(2500)
await api("POST", `/api/sessions/${id("FACTURACION")}/compaction/draft`).catch((e) => console.log("compactación:", e.message))

// Propuestas (listas y en preparación) y cola de resultados (con la orquestadora trabajando).
await mcp("ORQ-TURNOS", "propose_prompt", { session: "COSTOS", title: "Apagar las máquinas ociosas de staging", prompt: "Listá las máquinas de staging sin uso en 7 días y proponé cuáles apagar, con el ahorro estimado." })
await mcp("ORQ-TURNOS", "propose_session", { name: "ALERTAS", role: "Alertas de presupuesto", title: "Alertas de presupuesto", prompt: "Configurá alertas al 50, 80 y 100% del presupuesto mensual." })
await msg("ORQ-TURNOS", "hola")
await mcp("ORQ-PORTAL", "propose_prompt", { session: "WEB", title: "Pantalla de recibos", prompt: "Armá la pantalla de recibos: lista por mes, estado y descarga en PDF." })
await msg("ORQ-PORTAL", "LARGO: revisá lo que llegó")
await sleep(1500)
await mcp("WEB", "report_result", { status: "partial", summary: "La pantalla de recibos lista por mes y descarga el PDF.\nFalta el estado \"vencido\": la API todavía no lo manda." })
await mcp("PAGOS", "report_result", { status: "done", summary: "Los reembolsos parciales ya se registran contra la factura original." })
await sleep(3000)

s = await snap()
console.log("\nSesiones:", s.sessions.map((x) => `${x.name}=${x.status}`).join(" "))
console.log("Propuestas:", s.drafts.map((d) => d.state).join(", "), "· Cola:", s.reports.map((r) => r.state).join(", "))
console.log("Apps:", s.apps.map((a) => `${a.name}=${a.state.status}`).join(", "), "· Tareas:", s.tasks.length, "· Compactaciones:", (s.compactions ?? []).length)
console.log("Proyectos:", JSON.stringify(proj))
