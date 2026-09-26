import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Lo deja scripts/bundle.mjs en cada bundle: sirve para reconocer uno anterior antes de borrarlo. */
export const BUNDLE_MARKER = ".control-plane-bundle"

/** La ruta real (con symlinks resueltos) aunque todavía no exista: resuelve el tramo que sí existe. */
function real(p: string): string {
  const abs = path.resolve(p)
  let base = abs
  const rest: string[] = []
  while (!fs.existsSync(base)) {
    const parent = path.dirname(base)
    if (parent === base) break
    rest.unshift(path.basename(base))
    base = parent
  }
  return path.join(fs.realpathSync(base), ...rest)
}

/** a está dentro de b (o es b). */
const inside = (a: string, b: string) => {
  const rel = path.relative(b, a)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * Si se puede usar `out` como carpeta del bundle (se borra y se regenera). Devuelve el motivo si no.
 * Nunca la raíz, el home ni algo que contenga al server o esté dentro de su código; si ya existe,
 * tiene que estar vacía o ser un bundle anterior.
 */
export function checkOut(out: string, opts: { serverDir: string; home?: string }): string | null {
  const target = real(out)
  const home = real(opts.home ?? os.homedir())
  const serverDir = real(opts.serverDir)
  if (target === path.parse(target).root) return `--out no puede ser la raíz del sistema (${target}).`
  if (inside(home, target)) return `--out no puede ser tu home ni una carpeta que lo contenga (${target}).`
  if (inside(serverDir, target)) return `--out no puede ser el repo ni una carpeta que lo contenga (${target}).`
  if (inside(target, path.join(serverDir, "src"))) return `--out no puede estar dentro de server/src (${target}).`
  if (!fs.existsSync(target)) return null
  if (!fs.statSync(target).isDirectory()) return `--out existe y no es una carpeta (${target}).`
  const entries = fs.readdirSync(target)
  if (!entries.length) return null
  const previous = entries.includes(BUNDLE_MARKER) || (entries.includes("server.mjs") && entries.includes("THIRD_PARTY_LICENSES"))
  if (!previous) return `${target} no está vacía y no es un bundle anterior: no la borro. Elegí otra carpeta o vaciala.`
  return null
}
