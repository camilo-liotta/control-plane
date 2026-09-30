import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Arranque en producción (`npm start`) portable: `NODE_ENV=production node …` no existe en el cmd de Windows.
 * El import es dinámico porque uno estático se evalúa antes de esta asignación y config.ts ya habría leído NODE_ENV.
 */
export async function start(load: () => Promise<unknown> = () => import("./index.ts")) {
  process.env.NODE_ENV = "production"
  await load()
}

if (pathToFileURL(path.resolve(process.argv[1] ?? "")).href === import.meta.url) await start()
