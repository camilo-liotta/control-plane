// Hook de control-plane (PreCompact, PostCompact y PreToolUse de SendMessage).
// Le pasa el evento al dashboard y escribe lo que responda: para PreCompact, Claude Code agrega ese
// texto a las instrucciones del resumen; para PreToolUse, es la decisión (un JSON con permissionDecision).
// Si el dashboard no responde, no escribe nada y todo sigue como siempre: la compactación nunca se
// bloquea (sale siempre con 0). Con --deny-on-error (el cerrojo de SendMessage) pasa al revés: sin
// respuesta del dashboard, deniega, porque ante la duda el mensaje no se manda.
import http from "node:http"

const url = process.argv[2]
const denyOnError = process.argv.includes("--deny-on-error")
const WAIT_MS = 15_000

function deny() {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "No pude consultar al dashboard para saber a quién va el mensaje, y por seguridad no se envía. Reintentá en un momento.",
      },
    })
  )
  process.exit(0)
}
const fail = () => (denyOnError ? deny() : process.exit(0))
// Un error del script sale con código 1, que Claude Code toma como "seguí": el cerrojo tiene que denegar igual.
process.on("uncaughtException", fail)

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  if (!url) return fail()
  // El cerrojo no espera para siempre; la compactación sí: en modo "esperarme" el dashboard responde recién cuando elegís.
  if (denyOnError) setTimeout(fail, WAIT_MS).unref()
  const req = http.request(url, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
    let body = ""
    res.setEncoding("utf8")
    res.on("data", (chunk) => (body += chunk))
    res.on("end", () => {
      if (res.statusCode === 200) {
        if (body) process.stdout.write(body)
        process.exit(0)
      }
      fail()
    })
  })
  req.on("error", fail)
  req.end(input || "{}")
})
