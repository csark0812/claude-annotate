// Runs the real native host per request, with the soak's sessions and desktop dirs.
import http from "node:http"; import { spawn } from "node:child_process";
const S = process.env.S, R = process.env.R;
http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const child = spawn(process.execPath, [`${R}/extension/host/host.mjs`], { env: { ...process.env, ANNOTATE_SESSIONS_DIR: `${S}/sessions`, ANNOTATE_DESKTOP_DIR: `${S}/desktop` } });
    const msg = Buffer.from(body); const head = Buffer.alloc(4); head.writeUInt32LE(msg.length); child.stdin.end(Buffer.concat([head, msg]));
    const out = []; child.stdout.on("data", (d) => out.push(d));
    child.on("close", () => { const b = Buffer.concat(out); res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(b.length > 4 ? b.subarray(4, 4 + b.readUInt32LE(0)) : '{"ok":false,"error":"no reply"}'); });
  });
}).listen(5399, "127.0.0.1");
