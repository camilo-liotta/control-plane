const params = new URLSearchParams(location.search)
const reason = params.get("reason") ?? "loading"
const port = Number(params.get("port")) || null
const detail = params.get("detail")
const $ = (id) => document.getElementById(id)

const show = (title, message) => {
  $("title").textContent = title
  $("message").textContent = message
  if (detail) {
    $("detail").textContent = detail
    $("detail").hidden = false
  }
}

// Cualquier respuesta alcanza para saber que hay algo escuchando: el server rechaza este
// origen, pero una respuesta opaca igual resuelve (sin server, la conexión falla).
async function probe() {
  if (!port) return false
  try {
    await fetch(`http://127.0.0.1:${port}/`, { mode: "no-cors", cache: "no-store" })
    return true
  } catch {
    return false
  }
}

async function retry() {
  const btn = $("retry")
  btn.disabled = true
  $("status").hidden = false
  $("status").textContent = "Buscando el server…"
  if (await probe()) {
    location.replace(`http://127.0.0.1:${port}/`)
    return
  }
  $("status").textContent = "Sigue sin responder. Vuelvo a probar solo cada unos segundos."
  btn.disabled = false
}

if (reason === "no-server" && port) {
  show(
    "No hay un server en el puerto " + port,
    "Levantalo y la app lo toma sola, o tocá Reintentar."
  )
  $("retry").hidden = false
  $("retry").addEventListener("click", retry)
  setInterval(async () => {
    if (await probe()) location.replace(`http://127.0.0.1:${port}/`)
  }, 3000)
} else if (reason === "port") {
  show("No puedo usar ese puerto", "Revisá la configuración y volvé a abrir la app.")
} else if (reason !== "loading") {
  show("Algo salió mal", "Volvé a abrir la app. Si sigue pasando, mirá el log del server.")
}
