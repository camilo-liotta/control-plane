// La pantalla local: muestra lo que le pasa la app en la URL y sus botones le piden cosas
// navegando a /__action/<acción>?t=<token>. La app intercepta esa navegación (no hay IPC).
const params = new URLSearchParams(location.search)
const token = params.get("t") ?? ""
const $ = (id) => document.getElementById(id)

const LABELS = {
  retry: "Reintentar",
  launch: "Lanzar el server",
  "pick-node": "Elegir Node…",
  "get-node": "Descargar Node",
  "pick-claude": "Elegir Claude Code…",
  "get-claude": "Ver cómo instalarlo",
  "open-anyway": "Abrir igual",
  cancel: "Cancelar",
  "set-port": "Usar este puerto",
  "use-that": "Usar ese server",
  wait: "Esperar",
  log: "Ver log",
  stop: "Detener el server",
}
// La acción principal es la primera que no sea de las de consulta (ver el log, descargar…), como
// en la web: un solo botón principal por vista; el resto, secundarios.
const SECONDARY = new Set(["log", "cancel", "get-node", "get-claude", "wait", "stop"])

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
const primary = actions.find((a) => !SECONDARY.has(a))
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
    btn.className = "primary"
    btn.addEventListener("click", () => ask(action, { p: input.value }))
    input.addEventListener("keydown", (e) => e.key === "Enter" && btn.click())
    $("actions").append(btn)
    continue
  }
  const btn = document.createElement("button")
  btn.type = "button"
  btn.textContent = LABELS[action]
  if (action === primary) btn.className = "primary"
  btn.addEventListener("click", () => ask(action))
  $("actions").append(btn)
}
