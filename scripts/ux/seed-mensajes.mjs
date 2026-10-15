// Una conversación entre dos orquestadoras (ORQ-PORTAL y ORQ-TURNOS), escrita directo en la base del
// sembrado: las herramientas MCP de los mensajes entre proyectos todavía no las usa el seed.
// Se llama desde seed.mjs, o suelta: node scripts/ux/seed-mensajes.mjs (con CP_UX_HOME / CP_UX_PORT).
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

import { SRV } from "./paths.mjs"

export function seedMensajes() {
  const db = new DatabaseSync(path.join(SRV, "control-plane.db"))
  const orch = (name) => db.prepare("SELECT id, project_id AS p FROM sessions WHERE name = ?").get(name)
  const portal = orch("ORQ-PORTAL")
  const turnos = orch("ORQ-TURNOS")
  const worker = db.prepare("SELECT id FROM sessions WHERE name = 'API'").get()
  const now = Date.now()
  const min = 60_000
  const msg = (id, from, to, text, replyTo, at) =>
    db.prepare("INSERT INTO project_messages (id, from_project_id, to_project_id, from_session_id, to_session_id, text, reply_to, created_at, delivered_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, from.p, to.p, from.id, to.id, text, replyTo, at, at + 4000)
  const m1 = "Necesitamos que la agenda exponga GET /api/turnos?inquilino=<id> con los turnos de mantenimiento de las próximas 4 semanas. El portal los muestra en la ficha del contrato.\n¿Pueden tenerlo para el jueves?"
  const m2 = "Sí: lo hacemos nosotros. Va a devolver { id, fecha, estado }. Les confirmo cuando esté en staging."
  const m3 = "Perfecto. ¿Pueden incluir también el nombre del técnico asignado? Nos pidieron mostrarlo."
  msg("m_demo0001", portal, turnos, m1, null, now - 50 * min)
  msg("m_demo0002", turnos, portal, m2, "m_demo0001", now - 30 * min)
  msg("m_demo0003", portal, turnos, m3, "m_demo0002", now - 9 * min)
  const ev = (sid, ts, event) => db.prepare("INSERT INTO events (session_id, ts, kind, data) VALUES (?,?,?,?)").run(sid, ts, event.kind, JSON.stringify(event))
  const call = (sid, ts, id, name, input, content, isError = false) => {
    ev(sid, ts, { kind: "tool_use", id, name, input, parent: null })
    ev(sid, ts + 800, { kind: "tool_result", toolUseId: id, content, isError, parent: null })
  }
  const T = "mcp__control-plane__message_project"
  // ORQ-PORTAL: manda, recibe la respuesta, contesta, y un intento que el límite contra bucles frena.
  call(portal.id, now - 50 * min, "tu_demo_a", T, { project: "agenda-turnos", message: m1 }, "Mensaje enviado (m_demo0001).")
  ev(portal.id, now - 30 * min, { kind: "batch", reportIds: [], followUp: false, text: "[control-plane] Mensajes de otros proyectos: 1 mensaje nuevo (agenda-turnos).", projectMessages: [{ id: "m_demo0002", fromProjectId: turnos.p, fromProjectName: "agenda-turnos", text: m2, replyTo: "m_demo0001" }] })
  call(portal.id, now - 9 * min, "tu_demo_b", T, { project: "agenda-turnos", message: m3, replyTo: "m_demo0002" }, "Mensaje enviado (m_demo0003).")
  call(portal.id, now - 8 * min, "tu_demo_c", T, { project: "agenda-turnos", message: "¿Alguna novedad?" }, "No se pudo enviar: ya hubo 6 mensajes entre estos dos proyectos sin que el usuario participara. Esperá a que el usuario lo revise antes de seguir.", true)
  // ORQ-TURNOS: recibe el pedido junto con un resultado de un worker.
  const rep = db.prepare("SELECT id FROM reports WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?) LIMIT 1").get(turnos.p)
  ev(turnos.id, now - 50 * min + 4000, { kind: "batch", reportIds: rep ? [rep.id] : [], followUp: false, text: "[control-plane] Cola de resultados y mensajes de otros proyectos.", projectMessages: [{ id: "m_demo0001", fromProjectId: portal.p, fromProjectName: "portal-alquileres", text: m1, replyTo: null }] })
  call(turnos.id, now - 30 * min - 5000, "tu_demo_d", T, { project: "portal-alquileres", message: m2, replyTo: "m_demo0001" }, "Mensaje enviado (m_demo0002).")
  // Un worker intenta hablarle a otro proyecto: el cerrojo lo rechaza.
  call(worker.id, now - 5 * min, "tu_demo_e", "SendMessage", { to: "ORQ-TURNOS", message: "¿Me pasás el esquema de turnos?" }, "Bloqueado: las sesiones solo pueden escribirle a sesiones de su propio proyecto. Pedile a tu orquestadora que le escriba a la de «agenda-turnos».", true)
  db.close()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) seedMensajes()
