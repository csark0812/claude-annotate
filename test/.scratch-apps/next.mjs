import { startServer, launch, sleep, until, notesOf } from "./lib.mjs";
const URL0 = process.argv[2];
const srv = await startServer();
const b = await launch(srv.session);
const p = b.page;
await p.goto(URL0);
await p.waitForSelector("#card-btn");
await sleep(1500); // hydration
await b.on();
for (const [sel, t] of [["#title", "server h1"], ["#card-title", "client h2"], ["#card-btn", "client btn"]]) { await b.noteOn(p, sel, t); await sleep(150); }
console.log(notesOf(await srv.next(8000)));
const stack = await p.evaluate(() => { const e = document.querySelector("#card-btn"); const k = Object.keys(e).find((k) => k.startsWith("__reactFiber$")); const f = e[k]; const s = f && f._debugStack; return k ? String(s && s.stack || s).slice(0, 600) : "no fiber"; });
console.log("RAW STACK:", stack);
await b.close(); await srv.close();
