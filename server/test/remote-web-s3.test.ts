import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  auditKindLabel,
  auditOutcomeLabel,
  canAttachFiles,
  CONTROL_CONFIRM_COPY,
  describeAudit,
  draftEditMode,
  ENABLE_CONFIRM_PARAGRAPHS,
  remoteErrorMessage,
  tierNeedsConfirm,
  TIER_OPTIONS,
  toastsRemoteError,
} from "../src/shared/remote-access.ts"
import type { RemoteAuditEntry, RemoteCapabilities } from "../src/shared/types.ts"

const caps = (mode: RemoteCapabilities["mode"]): RemoteCapabilities => ({ mode, paired: true })

describe("respond: sin adjuntos y borradores solo con título y prompt", () => {
  it("los adjuntos solo se suben desde esta máquina (la subida nunca se abre en remoto)", () => {
    assert.equal(canAttachFiles(caps("local")), true)
    for (const m of ["remote-read", "remote-respond", "remote-control"] as const) assert.equal(canAttachFiles(caps(m)), false, m)
    assert.equal(canAttachFiles(null), false)
  })

  it("el editor de borradores y planes es completo en local y básico (título y prompt) en cualquier modo remoto", () => {
    assert.equal(draftEditMode(caps("local")), "full")
    for (const m of ["remote-read", "remote-respond", "remote-control"] as const) assert.equal(draftEditMode(caps(m)), "basic", m)
    // Sin cargar el modo, lo más restringido.
    assert.equal(draftEditMode(null), "basic")
  })
})

describe("niveles: opciones del diálogo y confirmación de control", () => {
  it("tres opciones, en orden, con su nombre", () => {
    assert.deepEqual(TIER_OPTIONS.map((o) => o.value), ["read", "respond", "control"])
    assert.deepEqual(TIER_OPTIONS.map((o) => o.label), ["Ver", "Ver y responder", "Control (todo menos la terminal)"])
  })

  it("solo subir a control pide la confirmación", () => {
    assert.equal(tierNeedsConfirm("control"), true)
    assert.equal(tierNeedsConfirm("respond"), false)
    assert.equal(tierNeedsConfirm("read"), false)
  })

  it("la confirmación de control sigue diciendo que equivale a ejecutar comandos", () => {
    assert.match(CONTROL_CONFIRM_COPY, /ejecutar comandos/)
  })

  it("la confirmación de prender ya no dice que el acceso es solo de lectura \"por ahora\"", () => {
    const text = ENABLE_CONFIRM_PARAGRAPHS.join(" ")
    assert.doesNotMatch(text, /por ahora/i)
    assert.match(text, /de forma predeterminada|por defecto/i)
    assert.match(text, /solo de lectura/)
    assert.match(text, /equivale a ejecutar comandos/)
  })
})

describe("errores nuevos del servidor", () => {
  it("un cuerpo inválido y un permiso que ya no está pendiente tienen su mensaje", () => {
    assert.equal(remoteErrorMessage("remote_body", ""), "No se pudo enviar: el pedido no es válido.")
    assert.equal(toastsRemoteError("remote_body"), true)
    assert.equal(remoteErrorMessage("remote_not_pending", "El pedido ya no está pendiente"), "El pedido ya no está pendiente")
    assert.equal(toastsRemoteError("remote_not_pending"), false)
    assert.equal(remoteErrorMessage("confirm_required", "No se pudo subir el nivel a Control: falta la confirmación en esta máquina."), "No se pudo subir el nivel a Control: falta la confirmación en esta máquina.")
  })
})

describe("auditoría: textos del tab", () => {
  const row = (over: Partial<RemoteAuditEntry> = {}): RemoteAuditEntry => ({
    id: 1,
    at: 1_700_000_000_000,
    deviceId: "d1",
    kind: "request",
    method: "POST",
    route: "/api/sessions/:id/messages",
    targetId: "s1",
    toolName: null,
    inputHash: null,
    status: 200,
    outcome: "ok",
    reason: null,
    ...over,
  })

  it("cada tipo y cada resultado tienen su etiqueta en castellano", () => {
    for (const k of ["request", "pair", "revoke", "tier", "enable", "disable", "kill", "ws"]) assert.ok(auditKindLabel(k).length > 0, k)
    for (const o of ["ok", "denied", "unauthenticated", "rate_limited", "invalid", "error"]) assert.ok(auditOutcomeLabel(o).length > 0, o)
    assert.equal(auditOutcomeLabel("rate_limited"), "Limitado")
    assert.equal(auditKindLabel("kill"), "Corte")
    // Un valor desconocido no rompe la pantalla.
    assert.equal(auditKindLabel("otro"), "otro")
  })

  it("describe un pedido con la ruta legible, y un permiso con su herramienta y huella", () => {
    assert.equal(describeAudit(row()), "POST /api/sessions/:id/messages · s1")
    assert.equal(describeAudit(row({ route: "/api/sessions/:id/permission", toolName: "Bash", inputHash: "0123456789abcdef" })), "POST /api/sessions/:id/permission · s1 · Bash (0123456789abcdef)")
    assert.equal(describeAudit(row({ kind: "kill", method: null, route: null, targetId: null })), "")
  })

  it("sin ruta ni método no inventa nada", () => {
    assert.equal(describeAudit(row({ method: null, route: null, targetId: null })), "")
  })
})
