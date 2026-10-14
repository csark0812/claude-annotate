import { startServer, launch, sleep, until, notesOf } from "./lib.mjs";
const URL0 = process.argv[2];
const srv = await startServer();
const b = await launch(srv.session);
const p = b.page;
p.on("console", (m) => { if (m.type() === "error") console.log("PAGE ERROR:", m.text().slice(0, 200)); });
await p.goto(URL0);
await p.waitForSelector("#lazy-panel");
await p.click("#open-modal");
await p.waitForSelector("#modal");
await b.on();
for (const [sel, t] of [["#memo-card", "memo"], ["#fancy-input", "fwdref"], ["#themed-label", "ctx"], ["#ui-btn", "scoped"], ["#title", "title"], ["#lazy-panel", "lazy"], ["#modal-text", "portal"]]) {
  await b.noteOn(p, sel, t);
  await sleep(150);
}
console.log(notesOf(await srv.next(8000)));
// what the inspect tool says
console.log("INSPECT memo:", (await srv.tool("annotate_inspect", { selector: "#memo-card" })).split("\n").filter((l) => /react|components|source/.test(l)).join(" "));
await b.close(); await srv.close();
