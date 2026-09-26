/**
 * Variables que describen al server que está corriendo, no al usuario: las pone quien lo lanza
 * (la app de escritorio o `npm start`) para ese proceso. Un `claude` que hereda estas variables
 * le pasa a cualquier server que levante desde ahí (por ejemplo, un worker que desarrolla
 * control-plane) el launchId, la web y el hook del server de la app, y un `NODE_ENV=production`
 * que hace que `npm install` saltee las devDependencies.
 * `CONTROL_PLANE_PORT`, `_HOME` y `_HOST` quedan: pueden venir de la shell del usuario.
 */
export const SERVER_ONLY_ENV = ["CONTROL_PLANE_LAUNCH_ID", "CONTROL_PLANE_COMPACT_HOOK", "CONTROL_PLANE_WEB_DIST", "NODE_ENV"] as const

/** El entorno de un proceso que lanza el server (claude, un CLI): el suyo, más `extra`, sin lo del server. */
export function childEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra }
  for (const k of SERVER_ONLY_ENV) delete env[k]
  return env
}
