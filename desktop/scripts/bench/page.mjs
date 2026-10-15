// Evalúa una expresión sincrónica en la página de la app, por el inspector remoto de WebKit
// (WEBKIT_INSPECTOR_HTTP_SERVER). Uso: node page.mjs '<expresión>' [puerto=9235]
const [expr, port = "9235"] = process.argv.slice(2)
const ws = new WebSocket(`ws://127.0.0.1:${port}/socket/1/1/WebPage`)
const done = (v) => (console.log(v), process.exit(0))
setTimeout(() => done("sin respuesta"), 8000)
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "page") {
    const message = JSON.stringify({ id: 7, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })
    ws.send(JSON.stringify({ id: 1, method: "Target.sendMessageToTarget", params: { targetId: m.params.targetInfo.targetId, message } }))
  }
  if (m.method === "Target.dispatchMessageFromTarget") {
    const r = JSON.parse(m.params.message)
    if (r.id === 7) done(JSON.stringify(r.result?.result?.value ?? r.result ?? r.error))
  }
}
