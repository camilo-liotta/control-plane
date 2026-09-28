// Falla si un .sh del repo tiene `$var` pegado a un carácter que no es ASCII (`"Bajo $file…"`).
// El bash 3.2 de la Mac, con un locale que no es UTF-8 (por SSH, o la app abierta desde el
// Finder), lee esos bytes como parte del nombre de la variable y, con set -u, el script se corta.
// Con llaves no pasa: `${file}…`.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const files = execFileSync("git", ["ls-files", "*.sh"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)
const BAD = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/

const problems = []
for (const rel of files) {
  fs.readFileSync(path.join(root, rel), "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (BAD.test(line)) problems.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
}
if (problems.length) {
  console.error(`✗ Variables pegadas a un carácter que no es ASCII (usá \${var}):\n${problems.map((p) => `  ${p}`).join("\n")}`)
  process.exit(1)
}
console.log(`✓ ${files.length} scripts .sh sin variables pegadas a caracteres que no son ASCII.`)
