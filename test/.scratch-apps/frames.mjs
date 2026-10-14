import { startServer, launch, sleep, until, notesOf } from "./lib.mjs";
import { serve } from "./lab-server.mjs";
const s1 = await serve(5201, "http://127.0.0.1:5202");
const s2 = await serve(5202, "");
const srv = await startServer();
const b = await launch(srv.session);
const p = b.page;
try {
  await p.goto("http://localhost:5201/lab");
  await sleep(500);
  const id = await b.on();
  await sleep(500);
  console.log("probes:", JSON.stringify(await b.sw.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => [location.href, !!window.__claudeAnnotateProbe] })).map((r) => r.result), id)));
  const inner = await p.frameLocator(`#cross`).locator("#in-btn").boundingBox();
  await p.mouse.move(inner.x + 5, inner.y + 5); await sleep(400);
  console.log("highlight label:", await p.evaluate(() => document.querySelector("claude-annotate").shadowRoot.querySelector(".lab")?.textContent));
  const wb = await p.evaluate(() => { const r = document.querySelector("#wc").shadowRoot.querySelector("#inner-btn").getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  await b.noteAt(p, wb[0] + wb[2] / 2, wb[1] + wb[3] / 2, "shadow button");
  await sleep(200);
  const sb = await p.frameLocator(`#same`).locator("#in-btn").boundingBox();
  await b.noteAt(p, sb.x + 5, sb.y + 5, "same frame btn");
  console.log(await srv.next(6000));
  console.log("READ:", (await srv.tool("annotate_read", {})).slice(0, 1500));
} finally { await b.close(); await srv.close(); s1.close(); s2.close(); }
