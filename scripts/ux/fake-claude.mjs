// Arma el Claude falso del banco a partir del de los tests (server/test/fake-claude.ts), con lo que
// hace falta para ver todos los estados en pantalla:
// - "DEMO …": un turno con pensamiento, Read, Bash, Edit y una respuesta en markdown;
// - "PERMISO": pide permiso para un Bash y se queda esperando;
// - "MUERE": el proceso termina con error (la sesión queda en "Error");
// - una sesión con "FACTURACION" en el nombre arranca con el contexto lleno, y el borrador de
//   compactación (side_question) devuelve puntos para elegir (la compactación queda por decidir).
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { CACHE, FAKE_CLAUDE, REPO } from "./paths.mjs"

const { writeFakeClaude } = await import(pathToFileURL(path.join(REPO, "server/test/fake-claude.ts")).href)
fs.mkdirSync(CACHE, { recursive: true })
const bin = writeFakeClaude(CACHE)
let s = fs.readFileSync(bin, "utf8")
const must = (from, to) => {
  if (!s.includes(from)) throw new Error(`El Claude falso de los tests cambió: no encuentro ${JSON.stringify(from.slice(0, 60))}`)
  s = s.replace(from, to)
}
must('let full = process.env.FAKE_FULL === "1"', 'let full = process.env.FAKE_FULL === "1" || name.includes("FACTURACION")')
const DRAFT = JSON.stringify({
  sections: [
    { title: "Objetivo", points: ["Emitir facturas electrónicas desde el portal", "Solo comprobantes B por ahora"] },
    { title: "Decisiones", points: ["El certificado va en secrets/afip.crt", "Los reintentos van con espera de 1, 6 y 24 h"] },
    { title: "Archivos", points: ["src/billing/afip-client.ts", "src/billing/invoices.ts"] },
  ],
})
// Los comandos que devuelve el initialize, para ver el menú de / del composer.
const COMMANDS = [
  { name: "compact", description: "Compacta la conversación eligiendo qué queda", argumentHint: "[instrucciones]", builtin: true },
  { name: "clear", description: "Empieza una conversación nueva", argumentHint: "", builtin: true },
  { name: "context", description: "Muestra cuánto contexto usa la sesión", argumentHint: "", builtin: true },
  { name: "cost", description: "Muestra lo que lleva gastado la sesión", argumentHint: "", builtin: true },
  { name: "model", description: "Cambia el modelo", argumentHint: "[modelo]", builtin: true },
  { name: "review", description: "Revisa un pull request", argumentHint: "[número]", builtin: true },
  { name: "commit", description: "Arma el commit de lo que cambió", argumentHint: "", builtin: false },
  { name: "deploy-check", description: "Lista lo que hay que revisar antes de un deploy", argumentHint: "", builtin: false },
  { name: "release-notes", description: "Escribe las notas de la versión a partir de los commits", argumentHint: "[desde]", builtin: false },
]
must(
  `  if (msg.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } })`,
  `  if (msg.type === "control_request") {
    const extra = msg.request?.subtype === "side_question" ? { response: ${JSON.stringify(DRAFT)} } : msg.request?.subtype === "initialize" ? { commands: ${JSON.stringify(COMMANDS)} } : {}
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: extra } })`
)
const DEMO = fs.readFileSync(new URL("./fake-demo.js.txt", import.meta.url), "utf8")
must('  // "PREGUNTA": pide contestar', DEMO + '  // "PREGUNTA": pide contestar')
// Interrumpir: el loop de stdin está esperando el turno largo, así que el pedido de interrupt se
// atiende aparte (contesta, corta la espera y el turno cierra como interrumpido).
must(
  '  if (text.includes("LARGO")) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LONG_MS ?? 30000)))',
  `  if (text.includes("LARGO")) {
    const cut = await new Promise((r) => { const t = setTimeout(() => r(false), Number(process.env.FAKE_LONG_MS ?? 30000)); globalThis.__cpInterrupt = () => { clearTimeout(t); r(true) } })
    globalThis.__cpInterrupt = null
    if (cut) { result({ subtype: "error_during_execution", is_error: false, terminal_reason: "aborted_streaming" }); continue }
  }`
)
must(
  'for await (const line of readline.createInterface({ input: process.stdin })) {',
  `process.stdin.on("data", (chunk) => {
  for (const l of String(chunk).split("\\n")) {
    if (!l.includes('"interrupt"')) continue
    try {
      const m = JSON.parse(l)
      if (m.type === "control_request" && m.request?.subtype === "interrupt" && globalThis.__cpInterrupt) {
        out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } })
        globalThis.__cpInterrupt()
      }
    } catch {}
  }
})
for await (const line of readline.createInterface({ input: process.stdin })) {`
)
fs.writeFileSync(bin, s, { mode: 0o755 })
console.log(FAKE_CLAUDE)
