// Long-lived browser controller for the soak: Chromium + the unpacked extension, the real native
// host through hostproxy. POST /eval with JS (async body) to drive it.
import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
const R = process.env.R, S = process.env.S;
const extDir = path.join(R, "extension");
const { key } = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
const hex = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
const EXT_ID = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EV = path.join(S, "logs", "events.log");
const ev = (...a) => fs.appendFileSync(EV, `${new Date().toISOString().slice(11, 23)} ${a.join(" ")}\n`);
const profile = fs.mkdtempSync(path.join(S, "profile-"));
const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--allowlisted-extension-id=${EXT_ID}`] });
async function stub(w) {
  await w.evaluate(() => { chrome.runtime.sendNativeMessage = async (_h, msg) => (await fetch("http://127.0.0.1:5399/host", { method: "POST", body: JSON.stringify(msg) })).json(); });
}
let sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`)) || await context.waitForEvent("serviceworker", (w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`));
await stub(sw);
context.on("serviceworker", async (w) => { if (w.url().startsWith(`chrome-extension://${EXT_ID}/`)) { sw = w; ev("SW restarted; stubbing again"); await stub(w).catch((e) => ev("stub failed", e.message)); } });
const tabs = []; // index -> page
const first = context.pages()[0]; if (first) tabs.push(first);
const watchPage = (p) => {
  p.on("console", (m) => { if (m.type() === "error") ev(`tab${tabs.indexOf(p)} console.error`, m.text().slice(0, 200)); });
  p.on("pageerror", (e) => ev(`tab${tabs.indexOf(p)} pageerror`, e.message.slice(0, 200)));
};
if (first) watchPage(first);
async function tab(url) { const p = await context.newPage(); watchPage(p); tabs.push(p); if (url) await p.goto(url); return tabs.length - 1; }
const tabIdOf = (i) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, tabs[i].url());
async function on(i) { const id = await tabIdOf(i); await sw.evaluate((id) => self.claudeAnnotate.click(id), id); await until("overlay", () => mode(i).then((m) => m === "draw")); return id; }
const mode = (i) => tabs[i].evaluate(() => { const h = document.querySelector("claude-annotate"); return !h ? "none" : h.classList.contains("rec") ? "record" : h.classList.contains("draw") ? "draw" : "browse"; });
async function until(what, fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => undefined); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }
async function note(i, sel, text, { enter = true } = {}) {
  const p = tabs[i]; const box = await p.locator(sel).first().boundingBox();
  await p.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
  const c = p.locator("claude-annotate .pop textarea"); await c.waitFor({ timeout: 8000 });
  await c.pressSequentially(text, { delay: 5 }); if (enter) await c.press("Enter");
  ev(`tab${i} note on ${sel}: "${text}"`);
}
const barText = (i) => tabs[i].locator("claude-annotate .bar").innerText().catch(() => "?");
const pins = (i) => tabs[i].evaluate(() => [...document.querySelector("claude-annotate")?.shadowRoot?.querySelectorAll(".pin") ?? []].map((p) => p.dataset.id + ":" + p.className));
const link = (i) => tabs[i].evaluate(() => { const r = document.querySelector("claude-annotate")?.shadowRoot; const d = r?.querySelector(".grip .dot, .link, [class*=link]"); return d ? d.className : "?"; });
// toast watcher
const seenToasts = new Map(); const toastLog = [];
const waitToast = (i, sub, ms = 15000) => { const since = Date.now() - 3000; return until(`toast ${sub}`, async () => toastLog.find((x) => x.i === i && x.at >= since && x.t.includes(sub)), ms); };
setInterval(async () => {
  for (const [i, p] of tabs.entries()) {
    if (p.isClosed()) continue;
    const ts = await p.evaluate(() => [...document.querySelector("claude-annotate")?.shadowRoot?.querySelectorAll(".toast") ?? []].filter((t) => !t.dataset.soak && (t.dataset.soak = "1")).map((t) => t.textContent)).catch(() => []);
    for (const t of ts) { ev(`tab${i} TOAST: ${t}`); toastLog.push({ i, t, at: Date.now() }); }
  }
}, 400);
const api = { toastLog, waitToast, context, get sw() { return sw; }, tabs, tab, on, note, mode, until, sleep, barText, pins, link, ev, tabIdOf };
http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", async () => {
    try { const fn = new Function(...Object.keys(api), `return (async () => { ${body} })()`); const out = await fn(...Object.values(api)); res.end(JSON.stringify(out ?? "ok", null, 1) + "\n"); }
    catch (e) { res.end("ERR " + (e.stack || e.message) + "\n"); }
  });
}).listen(5398, "127.0.0.1");
ev("ctl ready", EXT_ID);
