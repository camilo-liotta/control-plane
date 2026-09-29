import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { deliver, NetworkError } from "../src/shared/deliver.ts"

const noSleep = async () => {}

describe("deliver (el envío del composer)", () => {
  it("devuelve lo que contesta el server", async () => {
    assert.equal(await deliver({ send: async () => "ok", echoed: () => false, sleep: noSleep }), "ok")
  })

  it("si el server contesta con un error, falla con ese motivo y no reintenta", async () => {
    let calls = 0
    const send = async () => {
      calls++
      throw new Error("La sesión está archivada")
    }
    await assert.rejects(deliver({ send, echoed: () => false, sleep: noSleep }), /La sesión está archivada/)
    assert.equal(calls, 1)
  })

  it("si la respuesta se corta pero el eco del WS llegó, está enviado", async () => {
    let calls = 0
    const send = async () => {
      calls++
      throw new NetworkError(new TypeError("Load failed"))
    }
    assert.equal(await deliver({ send, echoed: () => true, sleep: noSleep }), null)
    assert.equal(calls, 1, "no hace falta reintentar")
  })

  it("el eco puede llegar un poco después del corte", async () => {
    let echo = false
    const send = async () => {
      throw new NetworkError(new TypeError("Load failed"))
    }
    const sleep = async () => {
      echo = true
    }
    assert.equal(await deliver({ send, echoed: () => echo, sleep }), null)
  })

  it("sin eco, reintenta (el server no duplica: mismo id de cliente)", async () => {
    let calls = 0
    const send = async () => {
      calls++
      if (calls === 1) throw new NetworkError(new TypeError("Load failed"))
      return "ok"
    }
    assert.equal(await deliver({ send, echoed: () => false, sleep: noSleep }), "ok")
    assert.equal(calls, 2)
  })

  it("si nunca contesta, falla diciendo que se cortó la conexión", async () => {
    let calls = 0
    const send = async () => {
      calls++
      throw new NetworkError(new TypeError("Load failed"))
    }
    await assert.rejects(deliver({ send, echoed: () => false, sleep: noSleep, retries: 2 }), /se cortó la conexión con el server local \(Load failed\)/)
    assert.equal(calls, 3)
  })
})
