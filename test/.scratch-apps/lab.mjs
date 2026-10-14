import { startServer, launch, sleep, until, notesOf } from "./lib.mjs";
import { serve } from "./lab-server.mjs";
const s1 = await serve(5201, "http://127.0.0.1:5202");
const s2 = await serve(5202, "");
const srv = await startServer();
const b = await launch(srv.session, { extraArgs: process.env.DARK ? ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"] : [] });
const p = b.page;
try {
  await p.goto("http://localhost:5201/lab");
  await sleep(500);
  await b.on();
  const fr = (id) => p.locator(`#${id}`).boundingBox();
  const targets = [["#hdr-btn", "sticky header"], ["#wc", "web component"], ["#cv", "canvas"], ["#svtext", "svg text"], ["#zoomed", "zoomed"], ["#scaled", "scaled"]];
  for (const [sel, t] of targets) { try { await b.noteOn(p, sel, t); } catch (e) { console.log("FAILED", sel, e.message.split("\n")[0], JSON.stringify(await p.locator(sel).boundingBox())); await p.keyboard.press("Escape").catch(()=>{}); } await sleep(120); }
  // inside frames: click where the inner button is
  for (const id of ["same", "cross"]) {
    const box = await fr(id);
    const inner = await p.frameLocator(`#${id}`).locator("#in-btn").boundingBox();
    await b.noteAt(p, inner.x + inner.width / 2, inner.y + inner.height / 2, `${id} frame button`);
    await sleep(120);
  }
  // an inner scroller row after scrolling it
  await p.mouse.move(100, 500);
  await p.locator("#scroller").evaluate((e) => (e.scrollTop = document.getElementById("row1500").offsetTop - e.offsetTop - 50));
  await sleep(200);
  await b.noteOn(p, "#row1500", "row 1500");
  await sleep(120);
  // scrolled document: sticky header after scroll
  await p.evaluate(() => scrollTo(0, 1200));
  await sleep(300);
  await b.noteOn(p, "#hdr-btn", "sticky header after scroll");
  console.log(notesOf(await srv.next(8000)));
} finally { await b.close(); await srv.close(); s1.close(); s2.close(); }
