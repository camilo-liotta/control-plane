// La pantalla local: muestra lo que le pasa la app en la URL y sus botones le piden cosas
// navegando a /__action/<acción>?t=<token>. La app intercepta esa navegación (no hay IPC).
const params = new URLSearchParams(location.search)
const token = params.get("t") ?? ""
const $ = (id) => document.getElementById(id)

const LABELS = {
  retry: "Reintentar",
  launch: "Lanzarlo",
  "pick-node": "Elegir node…",
  "get-node": "Descargar Node",
  "open-anyway": "Abrir igual",
  cancel: "Cancelar",
  "set-port": "Usar este puerto",
  "use-that": "Usar ese",
  wait: "Esperar",
  log: "Ver log",
  stop: "Detener",
}
// Los que no son la acción principal van con un estilo más liviano.
const SECONDARY = new Set(["log", "cancel", "get-node", "wait", "stop"])

function ask(action, extra = {}) {
  const q = new URLSearchParams({ t: token, ...extra })
  location.href = `/__action/${action}?${q}`
}

function text(id, value) {
  const el = $(id)
  el.textContent = value ?? ""
  el.hidden = !value
}

document.body.dataset.tone = params.get("tone") ?? "loading"
$("title").textContent = params.get("title") ?? "Abriendo control-plane…"
document.title = $("title").textContent
text("message", params.get("message"))
text("detail", params.get("detail"))
text("log", params.get("log"))
text("notice", params.get("notice"))

const actions = (params.get("actions") ?? "").split(",").filter((a) => a in LABELS)
for (const action of actions) {
  if (action === "set-port") {
    const input = document.createElement("input")
    input.type = "number"
    input.min = "1024"
    input.max = "65535"
    input.value = params.get("port") ?? ""
    input.setAttribute("aria-label", "Puerto")
    $("actions").append(input)
    const btn = document.createElement("button")
    btn.type = "button"
    btn.textContent = LABELS[action]
    btn.addEventListener("click", () => ask(action, { p: input.value }))
    input.addEventListener("keydown", (e) => e.key === "Enter" && btn.click())
    $("actions").append(btn)
    continue
  }
  const btn = document.createElement("button")
  btn.type = "button"
  btn.textContent = LABELS[action]
  if (SECONDARY.has(action)) btn.className = "secondary"
  btn.addEventListener("click", () => ask(action))
  $("actions").append(btn)
}
