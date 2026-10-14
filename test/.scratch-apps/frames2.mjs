import { startServer, launch, sleep } from "./lib.mjs";
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
  const cf = p.frames().find((f) => f.url().startsWith("http://127.0.0.1:5202"));
  await cf.evaluate(() => { window.__m = []; addEventListener("message", (e) => window.__m.push([JSON.stringify(e.data), e.source === window.parent, e.origin])); });
  await p.evaluate(() => { window.__m = []; addEventListener("message", (e) => window.__m.push([JSON.stringify(e.data), e.origin])); });
  const inner = await cf.locator("#in-btn").boundingBox();
  await p.mouse.move(inner.x + 5, inner.y + 5); await sleep(600);
  console.log("frame got:", JSON.stringify(await cf.evaluate(() => window.__m)));
  console.log("top got:", JSON.stringify(await p.evaluate(() => window.__m)));
  // same thing with the frame at localhost (same site different port)
} finally { await b.close(); await srv.close(); s1.close(); s2.close(); }
