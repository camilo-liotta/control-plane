// Junta los toasts que manda el server (los mismos que la app de escritorio convierte en avisos).
// Uso: node toasts.mjs <puerto> <archivo.jsonl>
import fs from "node:fs"
const [port, out] = process.argv.slice(2)
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.type === "toast") fs.appendFileSync(out, JSON.stringify(m) + "\n")
}
ws.onclose = () => process.exit(0)
