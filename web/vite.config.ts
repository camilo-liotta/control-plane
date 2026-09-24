import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const server = `http://127.0.0.1:${process.env.CONTROL_PLANE_PORT ?? 4700}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
