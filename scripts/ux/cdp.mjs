// Driver chico de CDP para el navegador headless del banco. Cada open() abre una pestaña propia.
//   import { open } from "./cdp.mjs"
//   const t = await open({ base: "http://127.0.0.1:4721", width: 1440, height: 900 })
//   await t.goto("/p/<id>"); await t.theme("dark"); await t.press('button[aria-label="Ajustes"]')
//   await t.shot("~/.cache/cp-ux/x.png"); await t.close()
import fs from "node:fs"
import path from "node:path"

import { CDP_PORT, SERVER_PORT } from "./paths.mjs"

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CDP = `http://127.0.0.1:${CDP_PORT}`

export async function snapshot(base = `http://127.0.0.1:${SERVER_PORT}`) {
  return (await fetch(base + "/api/snapshot")).json()
}

export async function open({ base = `http://127.0.0.1:${SERVER_PORT}`, width = 1440, height = 900 } = {}) {
  const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json()
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j) })
  let n = 0
  const pending = new Map()
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  await send("Page.enable")
  await send("Runtime.enable")
  const size = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  await size(width, height)
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval")
    return r.result?.result?.value
  }
  const point = async (sel) => {
    const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
    if (!r) throw new Error("no está: " + sel)
    return r
  }
  const t = {
    send, ev, size, base,
    async goto(p, wait = 1500) {
      await send("Page.navigate", { url: p.startsWith("http") ? p : base + p })
      await sleep(wait)
    },
    /** Tema ("light" | "dark") y las secciones plegables abiertas (las guarda la web en localStorage). */
    async theme(name, sections) {
      if (!String(await ev("location.origin")).startsWith("http")) await t.goto("/", 800)
      await ev(`localStorage.setItem("theme", ${JSON.stringify(name)}); ${sections ? `localStorage.setItem("session-panel-open", ${JSON.stringify(JSON.stringify(sections))});` : ""} 1`)
      await send("Page.reload")
      await sleep(1600)
    },
    async click(sel, wait = 500) { await ev(`document.querySelector(${JSON.stringify(sel)}).click(); 1`); await sleep(wait) },
    /** Click real (eventos de puntero): hace falta para los menús de Radix. */
    async press(sel, wait = 500) {
      const { x, y } = await point(sel)
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 })
      await sleep(wait)
    },
    async hover(sel, wait = 900) { const { x, y } = await point(sel); await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await sleep(wait) },
    /** El primer botón, link o ítem visible cuyo texto incluye `text`. */
    async clickText(text, { within = "body", wait = 500, real = true } = {}) {
      const ok = await ev(`(() => { const root = document.querySelector(${JSON.stringify(within)}); if (!root) return false; const el = [...root.querySelectorAll("button, a, [role=menuitem], [role=tab], [role=option]")].find(e => e.getClientRects().length && e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return false; el.setAttribute("data-cpux", "1"); return true })()`)
      if (!ok) throw new Error("no hay un botón con: " + text)
      await (real ? t.press("[data-cpux]", wait) : t.click("[data-cpux]", wait))
      await ev(`document.querySelectorAll("[data-cpux]").forEach(e => e.removeAttribute("data-cpux")); 1`)
    },
    async key(key, { mod = false, shift = false, code } = {}, wait = 500) {
      const modifiers = (mod ? 2 : 0) | (shift ? 8 : 0)
      const vk = key === "Escape" ? 27 : key === "?" ? 191 : key.toUpperCase().charCodeAt(0)
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, text: type === "keyDown" && key.length === 1 && !mod ? key : undefined, code: code ?? (key.length === 1 && /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : key), modifiers, windowsVirtualKeyCode: vk })
      await sleep(wait)
    },
    async escape() { await t.key("Escape", { code: "Escape" }, 400) },
    /** Tapa con un bloque gris lo que matchee (datos reales de la máquina, por ejemplo). */
    async mask(sel) { await ev(`document.querySelectorAll(${JSON.stringify(sel)}).forEach(e => { e.style.filter = "blur(6px)" }); 1`) },
    async shot(file, { full = false } = {}) {
      let clip
      if (full) clip = { x: 0, y: 0, width: await ev("innerWidth"), height: await ev("Math.max(document.documentElement.scrollHeight, innerHeight)"), scale: 1 }
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(clip), ...(clip ? { clip } : {}) })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.from(r.result.data, "base64"))
    },
    async close() { ws.close(); await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {}) },
  }
  return t
}
