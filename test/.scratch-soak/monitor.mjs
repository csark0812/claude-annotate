// Logs every change in each soak chat's server overview, and server RSS each minute.
import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";
const S = process.env.S; const LOG = path.join(S, "logs", "monitor.log");
const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${s}\n`);
const last = new Map(); let tick = 0;
const name = (pid) => { for (const n of ["A", "B", "C", "D"]) { try { if (JSON.parse(fs.readFileSync(`${S}/logs/${n}.pid`)).claude === pid) return n; } catch {} } return String(pid); };
setInterval(async () => {
  tick++;
  for (const f of fs.readdirSync(`${S}/sessions`)) {
    const pid = Number(f.replace(".json", ""));
    let s; try { s = JSON.parse(fs.readFileSync(`${S}/sessions/${f}`, "utf8")); } catch { if (last.get(pid) !== "nofile") { log(`${name(pid)} no session file`); last.set(pid, "nofile"); } continue; }
    let o; try { o = await (await fetch(`${s.endpoint}/overview`, { headers: { "X-Annot-Token": s.token }, signal: AbortSignal.timeout(1500) })).json(); } catch (e) { if (last.get(pid) !== "down") { log(`${name(pid)} server DOWN (${s.endpoint})`); last.set(pid, "down"); } continue; }
    const view = JSON.stringify({ mode: o.mode, totals: o.totals, tabs: o.tabs.map((t) => `${t.url}${t.visible ? "" : "(bg)"}`), pages: o.pages.map((p) => `${p.url}: ${p.notes.map((n) => `${n.n}${n.text ? "" : "(empty)"}${n.editing ? "(editing)" : ""}`).join(",")} +${p.shapes}sh`), sent: o.sent.map((n) => `${n.n}:${n.status}:b${n.batch}`), batches: o.batches.map((b) => `${b.id}${b.done ? "✓" : ""}`), delivery: o.delivery });
    if (last.get(pid) !== view) { log(`${name(pid)} srv${s.pid} ${view}`); last.set(pid, view); }
    if (tick % 30 === 1) { try { log(`${name(pid)} rss ${execSync(`ps -o rss= -p ${s.pid}`).toString().trim()}KB`); } catch {} }
  }
}, 2000);
