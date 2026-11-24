import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleCuda, shutdownCuda } from "../backend/api.mjs";
const root = path.resolve(process.argv[2] || ".");
const port = Number(process.env.PORT || 8000);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};
const server = http
  .createServer(async (req, res) => {
    try {
      if (await handleCuda(req, res)) return;
      const url = new URL(req.url, "http://localhost");
      let file = path.resolve(root, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep) && file !== root) {
        res.writeHead(403).end();
        return;
      }
      if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(
      "WynnBuilder with optimizer: http://127.0.0.1:" +
        server.address().port +
        "/builder/",
    ),
  );

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdownCuda();
    server.closeAllConnections();
    server.close();
  });
}
