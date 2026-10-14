import http from "node:http";
import { startServer, launch, sleep, until, notesOf } from "./lib.mjs";
const VARIANT = process.argv[2] || "tt";
const pages = {
  tt: { csp: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types default", js: `trustedTypes.createPolicy("default", { createHTML: (s) => { window.ttHits = (window.ttHits||0)+1; return s; } });` },
  overrides: { csp: "", js: `
    const osa = Element.prototype.setAttribute; Element.prototype.setAttribute = function (k, v) { if (String(k).startsWith("data-claude")) { window.blocked = (window.blocked||0)+1; return; } return osa.call(this, k, v); };
    const ods = EventTarget.prototype.dispatchEvent; EventTarget.prototype.dispatchEvent = function (e) { return ods.call(this, e); };
    const oae = EventTarget.prototype.addEventListener; EventTarget.prototype.addEventListener = function (t, f, o) { window.added = (window.added||0)+1; return oae.call(this, t, f, o); };
    console.error = function () { window.swallowed = (window.swallowed||0)+1; };
    window.CustomEvent = function () { throw new Error("no custom events here"); };` },
  freeze: { csp: "", js: `Object.freeze(console); Object.freeze(History.prototype); Object.freeze(history);` },
};
const v = pages[VARIANT];
const html = `<!doctype html><meta charset="utf-8"><title>Hostile ${VARIANT}</title><body style="font:16px system-ui;margin:40px">
<h1 id="h">Hostile</h1><button id="buy">Buy</button><a id="spa" href="/two">two</a>
<script>${v.js}
function Checkout() {}
document.getElementById("buy").__reactFiber$x = { type: "button", return: { type: Checkout, _debugSource: { fileName: "/src/Checkout.tsx", lineNumber: 12 }, return: null } };
document.getElementById("spa").addEventListener("click", (e) => { e.preventDefault(); history.pushState({}, "", "/two"); document.getElementById("h").textContent = "Two"; });
</script>`;
const site = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html", ...(v.csp ? { "Content-Security-Policy": v.csp } : {}) }); res.end(html); });
await new Promise((r) => site.listen(5210, "127.0.0.1", r));
const srv = await startServer();
const b = await launch(srv.session);
const p = b.page;
const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
try {
  await p.goto("http://localhost:5210/");
  const id = await b.tabId("http://localhost:5210/");
  await b.click(id);
  const ok = await until("overlay", async () => (await b.mode()) === "draw", 6000).catch(() => false);
  console.log(VARIANT, "overlay:", await b.mode(), "badge:", await b.sw.evaluate((i) => chrome.action.getTitle({ tabId: i }), id));
  if (ok) {
    await b.noteOn(p, "#buy", "buy note");
    console.log(notesOf(await srv.next(6000)));
    await p.evaluate(() => { console.error("err from page"); setTimeout(() => { throw new Error("thrown in page"); }); }); await sleep(200);
    console.log("console tool:", (await srv.tool("annotate_console", {})).replace(/\s+/g, " ").slice(0, 400));
    console.log("page globals:", JSON.stringify(await p.evaluate(() => ({ tt: window.ttHits, blocked: window.blocked, swallowed: window.swallowed }))));
  }
  console.log("page errors:", errs);
} finally { await b.close(); await srv.close(); site.close(); }
