import { inDesktop, trayIconPlace } from "./notify"

declare const __WEB_VERSION__: string

/** La versión de esta página (la de `web/package.json` al compilar). */
export const webVersion = __WEB_VERSION__

/**
 * Si el server es de otra versión que la página o la app de escritorio. Pasa cuando la app se
 * actualizó y quedó corriendo un server anterior: la web nueva le pide rutas que no tiene.
 */
export function versionMismatch(serverVersion: string | undefined): { server: string; expected: string; where: "app" | "web" } | null {
  if (!serverVersion) return null
  const app = inDesktop() ? window.__CONTROL_PLANE_DESKTOP__?.version : undefined
  if (app && app !== serverVersion) return { server: serverVersion, expected: app, where: "app" }
  if (webVersion && webVersion !== serverVersion) return { server: serverVersion, expected: webVersion, where: "web" }
  return null
}

/** Dónde se reinicia el server, para los textos. */
export function restartHint() {
  return inDesktop() ? `desde ${trayIconPlace()} → Reiniciar el server (las sesiones se retoman solas)` : "reinicialo (por ejemplo, npm start)"
}

/** El texto para un 404 de una función nueva: el server no la conoce. */
export const STALE_SERVER = "El server es de una versión anterior y no tiene esto: reinicialo."

/** Si un error de la API es un 404 (una ruta que el server no conoce). */
export function isNotFound(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  return msg === "Not Found" || msg === "Error 404" || msg === "no encontrado"
}
