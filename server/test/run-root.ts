import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Una carpeta temporal para los archivos de lanzamiento (nunca la <home>/run real). */
export const tmpRunRoot = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cp-run-")), "run")
