import fs from "node:fs";
import { startServer, launch, sleep, until, notesOf } from "./lib.mjs";
const [URL0, APPDIR] = process.argv.slice(2);
const appFile = `${APPDIR}/src/App.jsx`;
const orig = fs.readFileSync(appFile, "utf8");
const srv = await startServer();
const b = await launch(srv.session);
const p = b.page;
try {
  await p.goto(URL0);
  await p.waitForSelector("#lazy-panel");
  await b.on();
  // an unsent note in the comment box while HMR lands
  await p.mouse.click(300, 60); // somewhere on title
  const c = p.locator("claude-annotate .pop textarea");
  await c.waitFor();
  await c.pressSequentially("typing during hmr");
  fs.writeFileSync(appFile, "// one\n// two\n// three\n" + orig.replace("Home page", "Home page!"));
  await until("hmr applied", () => p.evaluate(() => document.querySelector("#title").textContent === "Home page!"), 8000);
  await sleep(300);
  console.log("overlay after HMR:", await b.mode(), "popover text:", await c.inputValue().catch((e) => "gone: " + e.message));
  await c.press("Enter");
  await b.noteOn(p, "#memo-card", "memo after hmr");
  console.log(notesOf(await srv.next(6000)));
  // full reload (vite: edit index.html)
  const ih = `${APPDIR}/index.html`; const ihOrig = fs.readFileSync(ih, "utf8");
  fs.writeFileSync(ih, ihOrig.replace("<title>RealApp</title>", "<title>RealApp2</title>"));
  await until("full reload", () => p.evaluate(() => document.title === "RealApp2"), 8000);
  fs.writeFileSync(ih, ihOrig);
  await sleep(1500);
  console.log("overlay after full reload:", await b.mode());
} finally {
  fs.writeFileSync(appFile, orig);
  await b.close(); await srv.close();
}
