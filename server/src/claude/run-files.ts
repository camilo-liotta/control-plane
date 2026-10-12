import fs from "node:fs"
import path from "node:path"

/**
 * Lo que cada `claude` lanzado por el dashboard lee de archivos en vez de la línea de comandos: la config
 * del MCP y los settings llevan el token de la sesión (/mcp/<token>, /hooks/<token>/…), y los argumentos
 * de un proceso los ve cualquier usuario de la máquina (`ps aux`, /proc/<pid>/cmdline). Acá van en
 * <home>/run/<sesión>/: la carpeta en 0700 y los archivos en 0600; se escriben en cada lanzamiento y se
 * borran cuando la sesión termina, se archiva o, al arrancar el server, si quedaron de antes.
 */

export const RUN_DIR = "run"

// Sin "." ni ".." solos: no pueden apuntar fuera de la carpeta.
const SAFE_ID = /^(?!\.+$)[\w.-]+$/

/** Dónde van las carpetas de las sesiones, dentro de la carpeta de datos. */
export const runRootOf = (home: string) => path.join(home, RUN_DIR)

function privateDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // El mkdir respeta el umask y no toca una carpeta que ya existía: que quede en 0700 igual.
  fs.chmodSync(dir, 0o700)
}

/** La carpeta privada de una sesión (la crea si hace falta). */
export function sessionRunDir(root: string, sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`Id de sesión inválido: ${sessionId}`)
  privateDir(root)
  const dir = path.join(root, sessionId)
  privateDir(dir)
  return dir
}

/** Escribe un archivo que solo lee el dueño. */
export function writePrivateFile(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/** Borra la carpeta de una sesión (con lo que tenga). No falla si no existe. */
export function removeSessionRunDir(root: string, sessionId: string) {
  if (!SAFE_ID.test(sessionId)) return
  fs.rmSync(path.join(root, sessionId), { recursive: true, force: true })
}

/** Al arrancar el server ninguna sesión corre todavía: lo que haya quedado de antes sobra. */
export function cleanRunRoot(root: string): number {
  let removed = 0
  let names: string[] = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return 0
  }
  for (const name of names) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
      removed++
    } catch {
      // un archivo que no se puede borrar no frena el arranque
    }
  }
  return removed
}
