/**
 * Las herramientas de entornos llevan secretos (contraseñas o tokens de prueba): Claude los manda o
 * los recibe, pero en el chat del dashboard (los eventos que se guardan y viajan por el WS) no van.
 */
const WRITES = /(^|__)(add_credential|update_credential)$/
const READS = /(^|__)list_environments$/

export const HIDDEN = "••••"
export const HIDDEN_RESULT = "Entornos y credenciales del proyecto (los secretos no se muestran en el chat: están en el resumen del proyecto, en Entornos)."

/** El input de una herramienta como se guarda en el chat: sin el secreto. */
export function redactInput(tool: string, input: unknown): unknown {
  if (!WRITES.test(tool) || !input || typeof input !== "object" || !("secret" in input)) return input
  const { secret, ...rest } = input as Record<string, unknown>
  return { ...rest, secret: secret ? HIDDEN : secret }
}

/** Si el resultado de esta herramienta trae secretos (y no se guarda tal cual en el chat). */
export function hidesResult(tool: string): boolean {
  return READS.test(tool)
}
