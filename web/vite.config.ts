import fs from "fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const server = `http://127.0.0.1:${process.env.CONTROL_PLANE_PORT ?? 4700}`

/** La versión de la web (la de su package.json), para comparar con la del server. */
const webVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")).version as string

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __WEB_VERSION__: JSON.stringify(webVersion) },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../server/src/shared"),
    },
  },
  build: {
    // App local: un solo bundle está bien.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 4701,
    strictPort: true,
    host: "localhost",
    proxy: {
      "/api": { target: server, changeOrigin: true },
      "/ws": { target: server, changeOrigin: true, ws: true },
    },
  },
})
