import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p === "/") p = "/index.html";
  const f = path.join(process.cwd(), p);
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end("nf"); } res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : "text/plain", "Cache-Control": "no-store" }); res.end(b); });
}).listen(port, "127.0.0.1");
