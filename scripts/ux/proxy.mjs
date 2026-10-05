// Sirve un web/dist con la API, el MCP y el WS del server sembrado. Uso: node proxy.mjs <puerto> <web/dist>
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"

import { SERVER_PORT } from "./paths.mjs"

const port = Number(process.argv[2])
const dist = path.resolve(process.argv[3] ?? "")
if (!port || !fs.existsSync(path.join(dist, "index.html"))) {
  console.error("Uso: node proxy.mjs <puerto> <carpeta web/dist ya compilada>")
  process.exit(1)
}
const UP = { host: "127.0.0.1", port: SERVER_PORT }
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".json": "application/json" }
const backend = (p) => /^\/(api|mcp|hooks|ws|terminal)(\/|\?|$)/.test(p)
// El server solo acepta su propio Host y Origin: se los ponemos.
const fix = (h) => ({ ...h, host: `127.0.0.1:${SERVER_PORT}`, ...(h.origin ? { origin: ORIGIN } : {}), ...(h.referer ? { referer: ORIGIN + "/" } : {}) })
const server = http.createServer((req, res) => {
  if (backend(req.url)) {
    const up = http.request({ ...UP, path: req.url, method: req.method, headers: fix(req.headers) }, (r) => {
      res.writeHead(r.statusCode, r.headers)
      r.pipe(res)
    })
    up.on("error", () => { res.writeHead(502); res.end("El server sembrado no responde (node scripts/ux/ux.mjs server)") })
    return void req.pipe(up)
  }
  let file = path.join(dist, decodeURIComponent(req.url.split("?")[0]))
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html")
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" })
  fs.createReadStream(file).pipe(res)
})
server.on("upgrade", (req, sock, head) => {
  const up = net.connect(UP, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(fix(req.headers)).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n")
    up.write(head)
    sock.pipe(up)
    up.pipe(sock)
  })
  up.on("error", () => sock.destroy())
  sock.on("error", () => up.destroy())
})
server.listen(port, "127.0.0.1", () => console.log(`proxy :${port} → ${dist} (API del :${SERVER_PORT})`))
