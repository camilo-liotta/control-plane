// Capturas: node scripts/ux/ux.mjs shots --base http://127.0.0.1:4721 --out ~/.cache/cp-ux/<carpeta>
//   [--set inventario|claves|bandeja] [--widths 1440,900,380] [--themes light,dark] [--only texto]
// Necesita el navegador del banco (ux.mjs browser) y el server sembrado (ux.mjs server + seed).
import os from "node:os"
import path from "node:path"

import { open, sleep, snapshot } from "./cdp.mjs"
import { SERVER_PORT } from "./paths.mjs"

const argv = process.argv.slice(3)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const base = opt("base", `http://127.0.0.1:${SERVER_PORT}`)
const out = path.resolve(opt("out", path.join(os.homedir(), ".cache/cp-ux/capturas")).replace(/^~/, os.homedir()))
const set = opt("set", "inventario")
const widths = opt("widths", set === "inventario" ? "1440,900,380" : "1440").split(",").map(Number)
const themes = opt("themes", "light,dark").split(",")
const only = opt("only")

const s = await snapshot(base)
const S = (n) => s.sessions.find((x) => x.name === n)
const P = (n) => s.projects.find((x) => x.name === n)?.id
const sess = (n) => `/p/${S(n).projectId}/s/${S(n).id}`
const portal = `/p/${P("portal-alquileres")}`
const ALL = Object.fromEntries(["review", "proposals", "pending-reports", "task", "reports", "changes", "scheduled", "subagents", "attachments", "tools", "details", "project-repos", "project-scheduled", "project-environments", "project-apps"].map((k) => [k, true]))
const menu = async (t, label) => { await t.press('button[aria-label="Más acciones"]'); await t.clickText(label, { within: "[role=menu]" }) }

// [nombre, ruta, { sections, act, wait, mask, sidebar }] (sidebar: lo que está en la barra lateral)
const SCREENS = {
  inventario: [
    ["01-inicio", "/"],
    ["02-proyecto", portal, { sections: ALL }],
    ["03-proyecto-propuestas", `/p/${P("agenda-turnos")}`],
    ["04-proyecto-vacio", `/p/${P("lago-de-datos")}`],
    ["05-sesion-trabajando", sess("API")],
    ["05b-sesion-panel-abierto", sess("API"), { sections: ALL }],
    ["06-sesion-pregunta", sess("BASE")],
    ["07-sesion-permiso", sess("MIGRACION")],
    ["08-sesion-error", sess("SOPORTE")],
    ["09-sesion-subagente", sess("WEB"), { sections: ALL }],
    ["10-orquestadora-cola", sess("ORQ-PORTAL"), { sections: ALL }],
    ["11-orquestadora-propuestas", sess("ORQ-TURNOS"), { sections: ALL }],
    ["12-chat-vacio", sess("ORQ-DATOS")],
    ["13-sesion-programado", sess("COSTOS"), { sections: ALL }],
    ["14-sesion-compactacion", sess("FACTURACION")],
    ["15-sesion-detenida", sess("INGESTA")],
    ["16-herramientas", "/tools"],
    // Con el PATH del banco no hay CLIs reales; igual se tapa la lista por las dudas.
    ["17-herramientas-clis", "/tools", { act: (t) => t.clickText("CLIs"), wait: 2500, mask: "main ul" }],
    ["18-herramientas-proyecto", `${portal}/tools`],
    ["20-modal-nuevo-proyecto", "/", { act: (t) => t.clickText("Nuevo proyecto") }],
    ["21-modal-nueva-sesion", portal, { sidebar: true, act: (t) => t.clickText("Nueva sesión", { within: "[data-sidebar=sidebar]" }) }],
    ["22-menu-proyecto", portal, { act: (t) => t.press('button[aria-label="Más acciones"]') }],
    ["23-modal-ajustes-proyecto", portal, { act: (t) => menu(t, "Configuración del proyecto") }],
    ["24-modal-borrar-proyecto", portal, { act: (t) => menu(t, "Borrar") }],
    ["25-modal-importar-sesion", portal, { act: (t) => menu(t, "Importar") }],
    ["26-menu-sesion", sess("API"), { act: (t) => t.press('button[aria-label="Más acciones"]') }],
    ["27-paleta", sess("API"), { act: (t) => t.key("k", { mod: true }) }],
    ["28-ayuda-atajos", sess("API"), { act: async (t) => { await t.ev("document.activeElement?.blur(); 1"); await t.key("?", { shift: true, code: "Slash" }) } }],
    ["29-bandeja", "/", { sidebar: true, act: (t) => t.clickText("Bandeja") }],
    ["30-menu-ajustes", "/", { sidebar: true, act: (t) => t.press('button[aria-label="Ajustes"]') }],
    ["31-selector-de-cuenta", "/", { sidebar: true, act: (t) => t.clickText("Principal") }],
    ["32-selector-de-modelo", sess("API"), { act: (t) => t.clickText("Modelo por defecto") }],
    ["33-terminal", sess("PAGOS"), { act: (t) => t.press('button[aria-label="Abrir la terminal"], button[aria-label="Terminal"]'), wait: 2500 }],
    ["34-subagente", sess("WEB"), { sections: ALL, act: (t) => t.clickText("revisar") }],
    ["35-toast", portal, { sections: ALL, act: (t) => t.press('button[aria-label="Copiar usuario"]'), wait: 400 }],
    ["36-app-log", portal, { sections: ALL, act: (t) => t.press('button[aria-label^="Ver el log"]') }],
    ["37-archivadas", portal, { act: (t) => t.ev(`[...document.querySelectorAll("main section, main div")].reverse().find((e) => /archivad/i.test(e.firstElementChild?.textContent ?? ""))?.scrollIntoView({ block: "center" }); 1`) }],
  ],
  claves: [
    ["sesion", sess("API"), { sections: { task: true, changes: true, reports: true } }],
    ["proyecto", portal, { sections: { "project-repos": true, "project-apps": true, "project-environments": true } }],
    ["modal-ajustes", portal, { act: (t) => menu(t, "Configuración del proyecto") }],
    ["modal-borrar", portal, { act: (t) => menu(t, "Borrar") }],
  ],
  bandeja: [
    ["bandeja", "/", { sidebar: true, act: (t) => t.clickText("Bandeja") }],
    ["bandeja-proyecto", portal, { sidebar: true, act: (t) => t.clickText("Bandeja") }],
    ["paleta", sess("API"), { act: (t) => t.key("k", { mod: true }) }],
    ["paleta-busqueda", sess("API"), { act: async (t) => { await t.key("k", { mod: true }); await t.send("Input.insertText", { text: "detener" }); await sleep(400) } }],
    ["ayuda-atajos", sess("API"), { act: async (t) => { await t.ev("document.activeElement?.blur(); 1"); await t.key("?", { shift: true, code: "Slash" }) } }],
    ["toast", portal, { sections: { "project-environments": true }, act: (t) => t.press('button[aria-label="Copiar usuario"]'), wait: 400 }],
  ],
}[set]
if (!SCREENS) throw new Error(`No conozco el juego "${set}"`)

const t = await open({ base })
let fails = 0
for (const theme of themes)
  for (const width of widths)
    for (const [name, route, o = {}] of SCREENS) {
      if (only && !name.includes(only)) continue
      const file = path.join(out, `${name}--${theme}-${width}.png`)
      try {
        await t.size(width, 900)
        await t.goto(route, 300)
        await t.theme(theme, o.sections ?? {})
        // En angosto la barra lateral es un panel que se abre: para lo que vive ahí, se abre primero.
        if (o.sidebar && width < 768) await t.press('[data-sidebar="trigger"]', 600)
        if (o.act) { await o.act(t); await sleep(o.wait ?? 700) }
        if (o.mask) await t.mask(o.mask)
        await t.shot(file)
      } catch (err) {
        fails++
        console.log(`✗ ${name} ${theme} ${width}: ${err.message}`)
      }
    }
await t.close()
console.log(`Listo: ${out}${fails ? ` (${fails} sin capturar)` : ""}`)
