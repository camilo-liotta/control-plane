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
must(
  `  if (msg.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } })`,
  `  if (msg.type === "control_request") {
    const extra = msg.request?.subtype === "side_question" ? { response: ${JSON.stringify(DRAFT)} } : {}
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: extra } })`
)
const DEMO = fs.readFileSync(new URL("./fake-demo.js.txt", import.meta.url), "utf8")
must('  // "PREGUNTA": pide contestar', DEMO + '  // "PREGUNTA": pide contestar')
fs.writeFileSync(bin, s, { mode: 0o755 })
console.log(FAKE_CLAUDE)
