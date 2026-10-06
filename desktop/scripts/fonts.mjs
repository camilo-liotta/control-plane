// Copia a ui/fonts/ las fuentes de la pantalla local, de los mismos paquetes de Fontsource que usa la
// web (OFL; las licencias van al lado). No se versionan: las arma `npm run stage`, antes de cada build.
// Solo latín y el eje de peso: Instrument Sans (texto), Bricolage Grotesque (título), Geist Mono (log).
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const here = path.dirname(new URL(import.meta.url).pathname)
const out = path.join(here, "../ui/fonts")
const web = path.join(here, "../../web")
const fonts = [
  ["instrument-sans", "instrument-sans-latin-wght-normal.woff2", "instrument-sans-OFL.txt"],
  ["bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2", "bricolage-grotesque-OFL.txt"],
  ["geist-mono", "geist-mono-latin-wght-normal.woff2", "geist-mono-OFL.txt"],
]
fs.mkdirSync(out, { recursive: true })
for (const [pkg, file, license] of fonts) {
  const dir = path.dirname(require.resolve(`@fontsource-variable/${pkg}/package.json`, { paths: [web] }))
  fs.copyFileSync(path.join(dir, "files", file), path.join(out, file))
  fs.copyFileSync(path.join(web, "fonts", license), path.join(out, license))
}
console.log(`Fuentes de la pantalla local en ${path.relative(process.cwd(), out)}`)
