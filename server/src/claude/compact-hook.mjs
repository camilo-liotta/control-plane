// Hook de compactación de control-plane (PreCompact y PostCompact).
// Le pasa el evento al dashboard y escribe lo que responda: para PreCompact, Claude Code agrega ese
// texto a las instrucciones del resumen. Si el dashboard no responde, no escribe nada y la
// compactación sigue como siempre. Nunca bloquea la compactación (sale siempre con 0).
import http from "node:http"

const url = process.argv[2]
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  if (!url) process.exit(0)
  // http.request no tiene límite de espera: en modo "esperarme" el dashboard responde recién cuando elegís.
  const req = http.request(url, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
    let body = ""
    res.setEncoding("utf8")
    res.on("data", (chunk) => (body += chunk))
    res.on("end", () => {
      if (res.statusCode === 200 && body) process.stdout.write(body)
      process.exit(0)
    })
  })
  req.on("error", () => process.exit(0))
  req.end(input || "{}")
})
