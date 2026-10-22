import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  accessIndicator,
  canDo,
  CONTROL_CONFIRM_COPY,
  ENABLE_CONFIRM_PARAGRAPHS,
  ENABLE_CONFIRM_TITLE,
  isRemoteCode,
  parsePairHash,
  toastsRemoteError,
  remoteErrorMessage,
  tierLabel,
  type Capability,
} from "../src/shared/remote-access.ts"
import type { RemoteCapabilities } from "../src/shared/types.ts"

const caps = (mode: RemoteCapabilities["mode"], paired?: boolean): RemoteCapabilities => ({ mode, ...(paired === undefined ? {} : { paired }) })
const ALL: Capability[] = ["view", "respond", "control", "manage"]
const allowed = (c: RemoteCapabilities | null) => ALL.filter((cap) => canDo(c, cap))

describe("canDo: qué puede hacer cada modo", () => {
  it("desde esta máquina puede todo", () => {
    assert.deepEqual(allowed(caps("local")), ["view", "respond", "control", "manage"])
  })
  it("remoto de lectura: solo ver", () => {
    assert.deepEqual(allowed(caps("remote-read", true)), ["view"])
  })
  it("remoto de respuesta: ver y responder", () => {
    assert.deepEqual(allowed(caps("remote-respond", true)), ["view", "respond"])
  })
  it("remoto de control: todo menos gestionar", () => {
    assert.deepEqual(allowed(caps("remote-control", true)), ["view", "respond", "control"])
  })
  it("remoto sin vincular o sin cargar: nada", () => {
    assert.deepEqual(allowed(caps("remote-read", false)), [])
    assert.deepEqual(allowed(null), [])
  })
  it("gestionar nunca es remoto, en ningún nivel", () => {
    for (const mode of ["remote-read", "remote-respond", "remote-control"] as const) assert.equal(canDo(caps(mode, true), "manage"), false)
  })
})

describe("parsePairHash: el token del enlace de vinculación", () => {
  const token = "AbC-123_xyzAbC-123_xyzAbC-123_xyzAbC-123_xyz"
  it("lee #pair=TOKEN", () => {
    assert.equal(parsePairHash(`#pair=${token}`), token)
  })
  it("acepta el hash sin la almohadilla", () => {
    assert.equal(parsePairHash(`pair=${token}`), token)
  })
  it("rechaza vacío, otro hash, caracteres raros y tokens muy cortos", () => {
    assert.equal(parsePairHash(""), null)
    assert.equal(parsePairHash("#"), null)
    assert.equal(parsePairHash("#/p/123"), null)
    assert.equal(parsePairHash("#pair="), null)
    assert.equal(parsePairHash("#pair=abc"), null)
    assert.equal(parsePairHash(`#pair=${token}<script>`), null)
    assert.equal(parsePairHash(`#pair=${token}&x=1`), null)
  })
})

describe("remoteErrorMessage: los códigos remote_* en castellano", () => {
  it("cada código tiene su mensaje (sin usar el del server)", () => {
    assert.equal(remoteErrorMessage("remote_forbidden", ""), "No se puede hacer desde un dispositivo remoto.")
    assert.equal(remoteErrorMessage("remote_tier", ""), "No se pudo: este dispositivo no tiene permiso para esa acción.")
    assert.equal(remoteErrorMessage("remote_origin", ""), "No se pudo: el pedido no vino desde la página de este dispositivo. Recargala y probá de nuevo.")
    assert.equal(remoteErrorMessage("remote_unpaired", ""), "Este dispositivo no está vinculado.")
    assert.equal(remoteErrorMessage("remote_length_required", ""), "No se pudo enviar: el pedido no es válido.")
    assert.equal(remoteErrorMessage("remote_too_large", ""), "No se pudo enviar: es demasiado grande.")
    assert.equal(remoteErrorMessage("remote_json", ""), "No se pudo enviar: el pedido no es válido.")
    assert.equal(remoteErrorMessage("remote_needs_local", ""), "Esta herramienta se aprueba desde la máquina del server.")
  })
  it("limitado: dice cuánto esperar si el server lo informa", () => {
    assert.equal(remoteErrorMessage("remote_rate_limited", "", 42), "Demasiados pedidos: probá de nuevo en 42 segundos.")
    assert.equal(remoteErrorMessage("remote_rate_limited", "", 1), "Demasiados pedidos: probá de nuevo en 1 segundo.")
    assert.equal(remoteErrorMessage("remote_rate_limited", ""), "Demasiados pedidos: probá de nuevo en un rato.")
  })
  it("un código que no es remote_* deja el mensaje del server, y sin mensaje, el estado", () => {
    assert.equal(remoteErrorMessage("invalid", "No se pudo guardar: valor inválido."), "No se pudo guardar: valor inválido.")
    assert.equal(remoteErrorMessage(undefined, "", undefined, 500), "Error 500")
    assert.equal(remoteErrorMessage(undefined, "Falló", undefined, 500), "Falló")
  })
  it("un remote_* desconocido cae en el mensaje del server o en uno general", () => {
    assert.equal(remoteErrorMessage("remote_nuevo", "Algo pasó."), "Algo pasó.")
    assert.equal(remoteErrorMessage("remote_nuevo", ""), "No se pudo: el acceso remoto no lo permite.")
  })
  it("isRemoteCode distingue los remote_*", () => {
    assert.equal(isRemoteCode("remote_tier"), true)
    assert.equal(isRemoteCode("remote_unpaired"), true)
    assert.equal(isRemoteCode("invalid"), false)
    assert.equal(isRemoteCode(undefined), false)
  })
})

describe("toastsRemoteError: cuáles errores remotos avisan solos", () => {
  it("los de permisos, origen, tamaño y límite avisan", () => {
    for (const c of ["remote_forbidden", "remote_tier", "remote_origin", "remote_rate_limited", "remote_length_required", "remote_too_large", "remote_json"]) {
      assert.equal(toastsRemoteError(c), true, c)
    }
  })
  it("sin vincular lleva a la pantalla de vinculación y el vínculo inválido lo cuenta esa pantalla: no avisan", () => {
    assert.equal(toastsRemoteError("remote_unpaired"), false)
    // la tarjeta del permiso lo explica en su lugar
    assert.equal(toastsRemoteError("remote_needs_local"), false)
    assert.equal(toastsRemoteError("remote_pair_invalid"), false)
    assert.equal(toastsRemoteError("invalid"), false)
    assert.equal(toastsRemoteError(undefined), false)
  })
})

describe("accessIndicator: el aviso de acceso remoto", () => {
  it("local, activo: cuenta los dispositivos", () => {
    assert.equal(accessIndicator(caps("local"), { active: true, devices: 3 }), "Acceso remoto activo · 3 dispositivos")
    assert.equal(accessIndicator(caps("local"), { active: true, devices: 1 }), "Acceso remoto activo · 1 dispositivo")
    assert.equal(accessIndicator(caps("local"), { active: true, devices: 0 }), "Acceso remoto activo · sin dispositivos")
  })
  it("local, apagado o sin exposición: no hay aviso", () => {
    assert.equal(accessIndicator(caps("local"), { active: false, devices: 2 }), null)
    assert.equal(accessIndicator(caps("local"), null), null)
  })
  it("remoto vinculado: desde qué dispositivo y con qué nivel", () => {
    const c: RemoteCapabilities = { mode: "remote-read", paired: true, device: { name: "Celu de Ana", tier: "read" } }
    assert.equal(accessIndicator(c, null), "Desde Celu de Ana · Ver")
    const r: RemoteCapabilities = { mode: "remote-control", paired: true, device: { name: "Notebook", tier: "control" } }
    assert.equal(accessIndicator(r, null), "Desde Notebook · Control")
  })
  it("remoto sin vincular o sin cargar: no hay aviso", () => {
    assert.equal(accessIndicator(caps("remote-read", false), null), null)
    assert.equal(accessIndicator(null, null), null)
  })
})

describe("textos fijos", () => {
  it("los niveles tienen su nombre", () => {
    assert.equal(tierLabel("read"), "Ver")
    assert.equal(tierLabel("respond"), "Ver y responder")
    assert.equal(tierLabel("control"), "Control (todo menos la terminal)")
  })
  it("la confirmación de prender dice qué se comparte y que responder o controlar equivale a ejecutar comandos", () => {
    const text = ENABLE_CONFIRM_PARAGRAPHS.join(" ")
    assert.match(text, /--dangerously-skip-permissions/)
    assert.match(text, /equivale a ejecutar comandos/)
    assert.match(text, /solo de lectura/)
    assert.match(text, /terminal nunca/)
    assert.ok(ENABLE_CONFIRM_TITLE.endsWith("?"))
  })
  it("la confirmación avisa que las sesiones corren sin pedir permisos", () => {
    assert.match(CONTROL_CONFIRM_COPY, /--dangerously-skip-permissions/)
    assert.match(CONTROL_CONFIRM_COPY, /ejecutar comandos/)
    assert.match(CONTROL_CONFIRM_COPY, /iniciar sesiones/)
    assert.match(CONTROL_CONFIRM_COPY, /aprobar permisos/)
    assert.match(CONTROL_CONFIRM_COPY, /AFK/)
  })
})
