// User journeys in a real browser: Playwright's Chromium with the extension loaded, a channel server
// for the session, and a small fixture site on localhost. No model, no network. Run it with
// `npm run test:journeys` (needs `npx playwright install chromium` once). HEADED=1 shows the window.
//
//  1. Annotating holds the page: a hover menu, a hover tooltip, a focused field and its suggestions
//     stay as they were while you mark them; the page hears no pointer, focus, key or "click outside".
//  2. Recording: the page works as normal while a red edge, a pill and a REC badge say it is
//     recording; it goes on across a full page load; Stop makes a note with the video, stills and a
//     timeline of what you did.
//  3. Record from the shortcut with annotation off, stop from the icon; and Discard throws it away.
//  4. Where Chrome won't let the extension capture the tab, the page records itself.
//  5. The link: annotating shows in the session at once, a note is there as soon as it is saved
//     (no Add to chat), and a restarted server is found again with no one doing anything.
//  6. Claude's tab tools read, inspect and hear the errors of the tab being annotated; the bar's ✕
//     in Claude Code turns annotating off.
//  7. Any page: a site that is not local stays annotated across a reload, and a page Chrome keeps
//     extensions out of (chrome://) is annotated as a picture, its notes filed under its own URL.
//  8. A local page fighting back: a strict CSP, a page that grabs every key, scripts that wrap
//     fetch. Notes still go, Esc still leaves, the page never sees the token, and React's data
//     comes through the page helper.
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADED = process.env.HEADED === "1";
fs.copyFileSync(path.join(root, "server", "overlay.js"), path.join(extDir, "overlay.js")); // what extension:install does

function extensionId() {
  const { key } = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  const hex = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
const EXT_ID = extensionId();

// ---------------------------------------------------------------------------
// The session: the channel server, as Claude Code starts it, in a scratch HOME
// ---------------------------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-journeys-"));
const sessionsDir = path.join(home, ".cache", "claude-annotate", "sessions");
// Starts the session's server (again, for journey 5: same Claude pid, new port and token).
async function startServer(previousToken = null) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server", "index.mjs")], env: { ...process.env, HOME: home }, stderr: "pipe" });
  const client = new Client({ name: "journeys", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  let found = null;
  for (let i = 0; i < 50 && !found; i++) {
    const f = fs.existsSync(sessionsDir) && fs.readdirSync(sessionsDir).find((x) => x.endsWith(".json"));
    const s = f && JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8"));
    if (s && s.token !== previousToken) found = { pid: Number(f.replace(".json", "")), ...s };
    else await sleep(100);
  }
  assert.ok(found, "the server wrote its session file");
  const session = { ...found, title: "Journeys", lastPromptAt: Date.now(), lastPrompt: null, servesPage: true, focusedAt: null };
  return { client, session, H: { "Content-Type": "application/json", "X-Annot-Token": session.token } };
}
let { client, session, H } = await startServer();
const stateOf = async (url) => (await fetch(`${session.endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json();

// ---------------------------------------------------------------------------
// The fixture site
// ---------------------------------------------------------------------------
const HOME_PAGE = `<!doctype html><meta charset="utf-8"><title>Fixture</title>
<style>
  body { font: 16px system-ui; margin: 40px; height: 1600px; }
  .menu { position: relative; display: inline-block; padding: 10px; background: #eee; }
  .dropdown { display: none; position: absolute; left: 0; top: 100%; width: 160px; padding: 10px; background: #ddd; }
  #tip { position: absolute; left: 180px; top: 0; }
  form { position: relative; display: inline-block; }
  #suggest { position: absolute; left: 0; top: 100%; margin: 0; background: #fff; }
  .menu:hover .dropdown { display: block; }
  #search { outline: none; border: 2px solid #999; }
  #search:focus { border-color: rgb(255, 0, 0); }
  form:focus-within { background: rgb(0, 0, 255); }
  #tip, #suggest { display: none; }
  #tip.on, #suggest.on { display: block; }
</style>
<div class="menu" id="menu">Menu<div class="dropdown" id="dropdown">Item one</div><div id="tip">A tooltip</div></div>
<form id="form" onsubmit="return false"><input id="search" placeholder="Search"><ul id="suggest"><li>apple</li></ul></form>
<button id="inc">Add one</button> <span id="count">0</span>
<select id="size"><option>Small</option><option>Large</option></select>
<a id="next" href="/next">Next page</a>
<script>
  window.heard = { outside: 0, keys: [], leaves: 0, blurs: 0 };
  const menu = document.getElementById("menu"), tip = document.getElementById("tip");
  menu.addEventListener("mouseenter", () => tip.classList.add("on"));
  menu.addEventListener("mouseleave", () => { tip.classList.remove("on"); heard.leaves++; });
  const search = document.getElementById("search"), suggest = document.getElementById("suggest");
  search.addEventListener("focus", () => suggest.classList.add("on"));
  search.addEventListener("blur", () => { suggest.classList.remove("on"); heard.blurs++; });
  // A "click outside" closer, the way dropdown libraries listen: on the document, capturing.
  document.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target) && !document.getElementById("form").contains(e.target)) heard.outside++; }, true);
  document.addEventListener("keydown", (e) => heard.keys.push(e.key), true);
  document.getElementById("inc").addEventListener("click", () => { const c = document.getElementById("count"); c.textContent = Number(c.textContent) + 1; });
</script>`;
const NEXT_PAGE = `<!doctype html><meta charset="utf-8"><title>Next</title><body style="font:16px system-ui;margin:40px"><h1>Next</h1><button id="done">Done</button></body>`;
// Journey 8's page: everything a local page can do to get in the way.
const HOSTILE_PAGE = `<!doctype html><meta charset="utf-8"><title>Hostile</title><body style="font:16px system-ui;margin:40px">
<h1 id="h">Hostile</h1><button id="buy">Buy</button>
<script>
  addEventListener("keydown", (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, true);
  addEventListener("keypress", (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, true);
  window.seen = [];
  const f = window.fetch; window.fetch = function (u, o) { window.seen.push(JSON.stringify([String(u), o && o.headers])); return f.apply(this, arguments); };
  function Checkout() {}
  document.getElementById("buy").__reactFiber$j8 = { type: "button", return: { type: Checkout, _debugSource: { fileName: "/src/Checkout.tsx", lineNumber: 12 }, return: null } };
</script>`;
const HOSTILE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'none'; connect-src 'self'";
const site = http.createServer((req, res) => {
  if (req.url.startsWith("/hostile")) { res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": HOSTILE_CSP }); return res.end(HOSTILE_PAGE); }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(req.url.startsWith("/next") ? NEXT_PAGE : HOME_PAGE);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://localhost:${site.address().port}`;

// ---------------------------------------------------------------------------
// The browser, with the extension and the session it would find through the native host
// ---------------------------------------------------------------------------
// allowCapture: Chrome lets an extension capture a tab after its icon or shortcut was used there;
// the tests call the same handlers directly, so this switch stands in for that click. Without it,
// the overlay falls back to the page recording itself; the other switch accepts that share prompt.
async function launch({ allowCapture = true, extraArgs = [] } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-profile-"));
  const args = [...extraArgs, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--auto-accept-this-tab-capture", "--auto-select-tab-capture-source-by-title=Fixture"];
  if (allowCapture) args.push(`--allowlisted-extension-id=${EXT_ID}`);
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: !HEADED, viewport: null, args: [...args, "--window-size=1280,860"] });
  let sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`));
  if (!sw) sw = await context.waitForEvent("serviceworker", (w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`));
  // The native host's answer: this test's session only.
  await sw.evaluate((s) => { chrome.runtime.sendNativeMessage = async () => ({ ok: true, sessions: [s] }); }, session);
  const page = context.pages()[0] || (await context.newPage());
  return { context, sw, page, profile };
}
const tabIdOf = (sw, url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u))?.id, url);
const click = (sw, tabId) => sw.evaluate((id) => self.claudeAnnotate.click(id), tabId);
const shortcut = (sw, command, tabId) => sw.evaluate(([c, id]) => self.claudeAnnotate.shortcut(c, id), [command, tabId]);
const badge = (sw, tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
const overlayMode = (page) => page.evaluate(() => { const h = document.querySelector("claude-annotate"); return !h ? "none" : h.classList.contains("rec") ? "record" : h.classList.contains("draw") ? "draw" : "browse"; });
async function until(what, fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const shown = (page, sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).display !== "none", sel);
const bar = (page) => page.locator("claude-annotate .bar");

const results = [];
const ONLY = process.env.ONLY ? Number(process.env.ONLY) : null; // ONLY=2 runs the second journey
let journeyNo = 0;
async function journey(name, fn) {
  if (ONLY && ++journeyNo !== ONLY) return;
  const started = Date.now();
  try { await fn(); results.push(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`); console.log(results.at(-1)); }
  catch (e) { results.push(`✗ ${name}: ${e.message}`); console.log(results.at(-1)); process.exitCode = 1; }
}

// ---------------------------------------------------------------------------
// 1. Annotating holds the page
// ---------------------------------------------------------------------------
{
  const { context, sw, page } = await launch();
  await journey("annotating holds hover, focus and the page's listeners", async () => {
    await page.goto(SITE);
    await page.click("#search"); // focused: the red border, the suggestions, the blue form
    await page.hover("#menu"); // hovered: the dropdown (CSS) and the tooltip (JS)
    assert.ok(await shown(page, "#dropdown") && await shown(page, "#tip") && await shown(page, "#suggest"), "the fixture's states are up before annotating");
    const tabId = await tabIdOf(sw, SITE);
    await shortcut(sw, "toggle-annotate", tabId); // ⌥⇧A with the pointer on the menu
    await until("the overlay", async () => (await overlayMode(page)) === "draw");
    await until("the held badge", async () => /Hover & focus held/.test(await bar(page).innerText()));

    // The pointer wanders off, over other elements: nothing closes.
    await page.mouse.move(600, 500, { steps: 8 });
    await page.mouse.move(20, 20, { steps: 8 });
    assert.ok(await shown(page, "#dropdown"), "CSS hover menu held");
    assert.ok(await shown(page, "#tip"), "JS hover tooltip held (no mouseleave heard)");
    assert.ok(await shown(page, "#suggest"), "focus-driven suggestions held (no blur heard)");
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("search")).borderTopColor), "rgb(255, 0, 0)", ":focus style held");
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("form")).backgroundColor), "rgb(0, 0, 255)", ":focus-within style held");

    // Mark the held dropdown item and write a comment: the page hears no press, focus loss or keys.
    const box = await page.locator("#dropdown").boundingBox();
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    const comment = page.locator("claude-annotate .pop textarea");
    await comment.waitFor();
    await comment.pressSequentially("tighten the spacing");
    await comment.press("Enter");
    await until("the saved note", async () => (await stateOf(`${SITE}/`)).notes?.some((n) => n.text === "tighten the spacing"));
    const heard = await page.evaluate(() => window.heard);
    assert.deepEqual({ outside: heard.outside, keys: heard.keys, leaves: heard.leaves, blurs: heard.blurs }, { outside: 0, keys: [], leaves: 0, blurs: 0 }, "the page heard nothing");
    assert.ok(await shown(page, "#dropdown") && await shown(page, "#tip") && await shown(page, "#suggest"), "still held after the comment");
    const note = (await stateOf(`${SITE}/`)).notes.find((n) => n.text === "tighten the spacing");
    assert.match(note.ctx.selector, /dropdown/, "the note is on the held dropdown");

    // The wheel scrolls the page under the overlay once, not twice; a pin drags.
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 300);
    await until("the scroll", async () => (await page.evaluate(() => scrollY)) > 0);
    await sleep(200);
    assert.equal(await page.evaluate(() => scrollY), 300, "one wheel, one scroll");
    await page.mouse.wheel(0, -300);
    await until("back at the top", async () => (await page.evaluate(() => scrollY)) === 0);
    const dot = await page.locator("claude-annotate .pin .dot").first().boundingBox();
    await page.mouse.move(dot.x + 9, dot.y + 9);
    await page.mouse.down();
    await page.mouse.move(dot.x + 120, dot.y + 60, { steps: 6 });
    await page.mouse.up();
    const moved = await until("the pin moved", async () => (await stateOf(`${SITE}/`)).notes.find((n) => n.text === "tighten the spacing" && Math.abs(n.x - (note.x + 111)) < 4 ? n : null));
    assert.ok(moved, "pin dragged");
    assert.equal((await page.evaluate(() => window.heard)).outside, 0, "the drag was the overlay's alone");

    // Keys aimed at the held page go nowhere: no typing into the focused field.
    await page.keyboard.type("xyz");
    assert.equal(await page.inputValue("#search"), "", "typing doesn't reach the held field");

    // Hold Space: the page is the page; let go: held again.
    await page.keyboard.down(" ");
    await until("the page let go", async () => !(await page.evaluate(() => !!document.querySelector("[data-claude-annotate-hover]"))));
    await page.keyboard.up(" ");

    // Leave: no trace of the hold, and focus is back in the field.
    await click(sw, tabId);
    await until("the overlay gone", async () => (await overlayMode(page)) === "none");
    assert.equal(await page.evaluate(() => document.querySelectorAll("[data-claude-annotate-hover],[data-claude-annotate-focus],[data-claude-annotate-focus-within]").length), 0, "hold attributes removed");
    const twins = await page.evaluate(() => [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => /data-claude-annotate/.test(r.cssText)).length);
    assert.equal(twins, 0, "twin rules removed");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "search", "focus stays in the page's field");
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// 2. Recording while using the page, across a page load
// ---------------------------------------------------------------------------
{
  const { context, sw, page } = await launch();
  await journey("recording: the page works as normal, survives a page load, becomes a note with a timeline", async () => {
    await fetch(`${session.endpoint}/clear`, { method: "POST", headers: H });
    await page.goto(SITE);
    const tabId = await tabIdOf(sw, SITE);
    await click(sw, tabId); // the icon: annotate
    await until("the overlay", async () => (await overlayMode(page)) === "draw");
    await page.locator('claude-annotate .bar [data-act="record"]').click();
    await until("recording mode", async () => (await overlayMode(page)) === "record");

    // It says so: the red edge, the pill, the REC badge.
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("claude-annotate").shadowRoot.querySelector(".recframe")).display), "block", "red edge shown");
    assert.match(await bar(page).innerText(), /Recording\s+0:0\d/, "pill shows Recording and the time");
    assert.equal(await badge(sw, tabId), "REC", "REC badge on the icon");

    // The page is the page: clicks, typing, choices, hover all work.
    await page.click("#inc");
    await page.click("#inc");
    assert.equal(await page.textContent("#count"), "2", "clicks reach the page");
    await page.fill("#search", "apples");
    assert.equal(await page.inputValue("#search"), "apples", "typing reaches the page");
    await page.selectOption("#size", "Large");
    await page.hover("#menu");
    assert.ok(await shown(page, "#dropdown"), "hover works as normal");
    await page.keyboard.press("Escape");
    assert.equal(await overlayMode(page), "record", "Esc doesn't end the recording");
    await sleep(1500); // a person's pace: the recording has a few seconds to it

    // A full page load: the recording goes on and the pill comes back.
    if (process.env.DEBUG) await page.evaluate(() => { addEventListener("click", (e) => { window.lastClick = { target: e.target.id || e.target.tagName, prevented: e.defaultPrevented, path: e.composedPath().slice(0, 3).map((n) => n.id || n.tagName || String(n)) }; }); });
    if (process.env.DEBUG) console.log("at link:", await page.evaluate(() => { const r = document.getElementById("next").getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return [el.tagName, el.id, JSON.stringify(r)]; }));
    await page.click("#next");
    await sleep(500);
    if (process.env.DEBUG) console.log("lastClick:", await page.evaluate(() => window.lastClick));
    if (process.env.DEBUG) console.log("url after click:", page.url(), await page.evaluate(() => document.title).catch((e) => e.message));
    await page.waitForURL(`${SITE}/next`);
    await until("recording mode after the load", async () => (await overlayMode(page)) === "record");
    if (process.env.DEBUG) console.log("rec state:", JSON.stringify(await sw.evaluate(async () => { const r = (await chrome.storage.session.get("recording")).recording; return { startedAt: r.startedAt, phase: r.phase, now: Date.now() }; })), await page.evaluate(() => Date.now()));
    await sleep(600);
    const clock = await bar(page).innerText();
    assert.match(clock, /Recording\s+\d:\d\d/, `the pill is back (${clock})`);
    assert.ok(Number(/(\d):(\d\d)/.exec(clock).slice(1).reduce((m, s) => m * 60 + Number(s), 0)) >= 1, `the clock carries on (${clock})`);
    assert.equal(await badge(sw, tabId), "REC", "badge still REC after the load");
    await page.click("#done");
    await sleep(1200);

    // Stop: saving, then a note to describe.
    await page.locator('claude-annotate .bar [data-act="rec-stop"]').click();
    const comment = page.locator("claude-annotate .pop textarea");
    await comment.waitFor({ timeout: 30000 });
    assert.equal(await comment.getAttribute("placeholder"), "What should Claude look at in this recording?");
    assert.equal(await badge(sw, tabId), "", "badge cleared");
    await comment.pressSequentially("the counter flickers on Add one");
    await comment.press("Enter");
    const note = await until("the recording note", async () => (await stateOf(`${SITE}/next`)).notes?.find((n) => n.video && n.text));
    assert.ok(fs.existsSync(note.video.file), "video file kept");
    assert.ok(note.video.frames.length >= 4, `stills cut (${note.video.frames.length})`);
    const tl = note.video.timeline.join("\n");
    for (const want of [/click <button#inc> "Add one"/, /typed in <input#search> "Search"/, /changed <select#size>.* → Large/, /navigate http:\/\/localhost:\d+\/next/, /click <button#done> "Done"/, /still .*frame-\d\d-/]) assert.match(tl, want, `timeline has ${want}`);
    assert.doesNotMatch(tl, /apples/, "typed text is not recorded");

    // What Claude receives. The tab's view goes up first, as Add to chat does, so no browser is needed.
    const tinyJpeg = "data:image/jpeg;base64,/9j/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
    await fetch(`${session.endpoint}/view`, { method: "POST", headers: H, body: JSON.stringify({ url: `${SITE}/next`, image: tinyJpeg, viewport: { w: 1280, h: 800 }, scroll: { x: 0, y: 0 } }) });
    await fetch(`${session.endpoint}/send`, { method: "POST", headers: H, body: "{}" });
    const pulled = await client.callTool({ name: "annotate_pull", arguments: {} });
    const text = pulled.content.map((c) => c.text || "").join("\n");
    assert.match(text, /timeline \(what the user did, with stills; read every still\)/, "Claude gets the timeline");
    assert.doesNotMatch(tl, /typed in <select/, "a choice is not typing");
    if (process.env.KEEP_STILLS) for (const f of note.video.frames) fs.copyFileSync(f, path.join(process.env.KEEP_STILLS, path.basename(f)));
    console.log(`  timeline as Claude reads it:\n${note.video.timeline.map((l) => `    ${l}`).join("\n")}`);
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// 3. ⌥⇧R with annotation off; the icon stops it. Discard throws one away.
// ---------------------------------------------------------------------------
{
  const { context, sw, page } = await launch();
  await journey("record from the shortcut, stop from the icon; discard leaves nothing", async () => {
    await fetch(`${session.endpoint}/clear`, { method: "POST", headers: H });
    await page.goto(SITE);
    const tabId = await tabIdOf(sw, SITE);
    await shortcut(sw, "toggle-record", tabId);
    await until("recording mode", async () => (await overlayMode(page)) === "record");
    await page.click("#inc");
    await sleep(1200);
    await click(sw, tabId); // the icon stops it
    await page.locator("claude-annotate .pop textarea").waitFor({ timeout: 30000 });
    assert.equal(await overlayMode(page), "draw", "back to annotating with the note open");

    await page.keyboard.press("Escape"); // drop the empty comment; the note stays without words
    await page.locator('claude-annotate .bar [data-act="record"]').click();
    await until("recording again", async () => (await overlayMode(page)) === "record");
    await sleep(800);
    const before = (await stateOf(`${SITE}/`)).notes.length;
    await page.locator('claude-annotate .bar [data-act="rec-cancel"]').click();
    await until("annotating again", async () => (await overlayMode(page)) === "draw");
    await sleep(500);
    assert.equal((await stateOf(`${SITE}/`)).notes.length, before, "discard adds no note");
    assert.equal(await badge(sw, tabId), "", "badge cleared");
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// 4. Chrome won't let the extension capture: the page records itself
// ---------------------------------------------------------------------------
{
  const { context, sw, page } = await launch({ allowCapture: false });
  await journey("fallback: the page records itself through the share prompt", async () => {
    await fetch(`${session.endpoint}/clear`, { method: "POST", headers: H });
    await page.goto(SITE);
    const tabId = await tabIdOf(sw, SITE);
    await click(sw, tabId);
    await until("the overlay", async () => (await overlayMode(page)) === "draw");
    await page.locator('claude-annotate .bar [data-act="record"]').click();
    await until("recording mode", async () => (await overlayMode(page)) === "record", 15000);
    await page.click("#inc");
    await sleep(1500);
    await page.locator('claude-annotate .bar [data-act="rec-stop"]').click();
    const comment = page.locator("claude-annotate .pop textarea");
    await comment.waitFor({ timeout: 30000 });
    await comment.pressSequentially("fallback works");
    await comment.press("Enter");
    const note = await until("the recording note", async () => (await stateOf(`${SITE}/`)).notes?.find((n) => n.video && n.text));
    assert.match(note.video.timeline.join("\n"), /click <button#inc>/, "the page's own log made it");
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// 5. The link: instant, no Add to chat, heals after a server restart
// ---------------------------------------------------------------------------
const overviewOf = async () => (await fetch(`${session.endpoint}/overview`, { headers: H })).json();
async function noteOn(page, selector, text) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const comment = page.locator("claude-annotate .pop textarea");
  await comment.waitFor();
  await comment.pressSequentially(text);
  await comment.press("Enter");
}
{
  const { context, sw, page } = await launch();
  await journey("the link: annotating and notes reach the session at once, and a restarted server is found again", async () => {
    await fetch(`${session.endpoint}/clear`, { method: "POST", headers: H });
    await page.goto(SITE);
    const tabId = await tabIdOf(sw, SITE);
    await click(sw, tabId);
    await until("the overlay", async () => (await overlayMode(page)) === "draw");
    const tabs = await until("the session knows the tab is annotating", async () => { const o = await overviewOf(); return o.tabs.length === 1 && o.tabs; }, 2000);
    assert.deepEqual([tabs[0].url, tabs[0].kind, tabs[0].local], [`${SITE}/`, "annotating", true]);
    assert.equal(await page.locator('claude-annotate .bar [data-act="add"]').count(), 0, "no Add to chat: notes are in the chat's bar already");

    await noteOn(page, "#inc", "before the restart");
    await until("the note in the session as soon as it is saved", async () => (await overviewOf()).pages.some((p) => p.notes.some((n) => n.text === "before the restart")), 1500);

    // The session's server restarts: same Claude pid, a new port and token. Nobody touches anything.
    const oldToken = session.token;
    await client.close();
    ({ client, session, H } = await startServer(oldToken));
    await sw.evaluate((s) => { chrome.runtime.sendNativeMessage = async () => ({ ok: true, sessions: [s] }); }, session);
    await until("the tab back in the new server", async () => (await overviewOf()).tabs.length === 1, 10000);
    await until("the page's notes restored there", async () => (await stateOf(`${SITE}/`)).notes?.some((n) => n.text === "before the restart"), 5000);
    assert.ok(await page.evaluate(() => document.querySelector("claude-annotate").classList.contains("link-on")), "the dot is green again");
    await noteOn(page, "#size", "after the restart");
    await until("a new note reaches the new server", async () => (await stateOf(`${SITE}/`)).notes?.some((n) => n.text === "after the restart"), 1500);
  });

  // -------------------------------------------------------------------------
  // 6. Claude's tab tools, and the bar's ✕
  // -------------------------------------------------------------------------
  await journey("tab tools read, inspect and hear the annotating tab; the bar's ✕ turns annotating off", async () => {
    const said = (r) => r.content.map((c) => c.text || "").join("\n");
    assert.match(said(await client.callTool({ name: "annotate_read", arguments: {} })), /Add one/, "the page's text");
    const inspected = said(await client.callTool({ name: "annotate_inspect", arguments: { selector: "#inc" } }));
    assert.match(inspected, /button#inc/);
    assert.match(inspected, /"styles"/);
    const n = (await stateOf(`${SITE}/`)).notes.find((k) => k.text === "after the restart").n;
    assert.match(said(await client.callTool({ name: "annotate_inspect", arguments: { note: n } })), /select#size/, "the element under a note");
    await page.evaluate(() => { console.error("journey console error"); setTimeout(() => { throw new Error("journey boom"); }); });
    await sleep(100);
    const heard = said(await client.callTool({ name: "annotate_console", arguments: {} }));
    assert.match(heard, /journey console error/);
    assert.match(heard, /journey boom/);
    assert.match(said(await client.callTool({ name: "annotate_tab", arguments: {} })), /"viewport"/);

    await fetch(`${session.endpoint}/stop`, { method: "POST", headers: H });
    await until("annotating off", async () => (await overlayMode(page)) === "none", 5000);
    await until("the session no longer lists the tab", async () => (await overviewOf()).tabs.length === 0, 2000);
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// 7. Any page
// ---------------------------------------------------------------------------
{
  // shop.example: a site that is not local, served by the fixture through Chrome's resolver.
  const { context, sw, page } = await launch({ extraArgs: [`--host-resolver-rules=MAP shop.example 127.0.0.1:${site.address().port}`] });
  await journey("any page: a site that is not local survives a reload; a chrome:// page is annotated as a picture", async () => {
    await fetch(`${session.endpoint}/clear`, { method: "POST", headers: H });
    const remote = "http://shop.example/";
    await page.goto(remote);
    const tabId = await tabIdOf(sw, remote);
    await click(sw, tabId);
    await until("the overlay on the remote site", async () => (await overlayMode(page)) === "draw");
    await page.reload();
    await until("the overlay back after the reload", async () => (await overlayMode(page)) === "draw", 5000);

    // Following the open chat mounts the overlay again: the old one leaves, and a note saved after
    // reaches Claude by itself. Then Esc leaves annotating.
    const before = await page.evaluate(() => document.querySelector("claude-annotate")?.shadowRoot?.querySelector(".bar") ? 1 : 0);
    await page.evaluate(() => { window.__oldOverlay = document.querySelector("claude-annotate"); });
    await sw.evaluate((id) => self.claudeAnnotate.remount(id), tabId);
    assert.equal(before, 1, "the overlay was up before the remount");
    assert.ok(await page.evaluate(() => window.__oldOverlay && !window.__oldOverlay.isConnected), "the old overlay left the page");
    // A page's own script can't drive the extension: a fake choose from the page does nothing.
    const leaked = await page.evaluate(() => new Promise((resolve) => {
      document.addEventListener("claude-annotate:chat-list", (e) => resolve(e.detail || "empty"), { once: true });
      document.dispatchEvent(new CustomEvent("claude-annotate:chats"));
      setTimeout(() => resolve(null), 1000);
    }));
    assert.equal(leaked, null, "the page gets no chat list");
    await until("one overlay after the remount", async () => (await page.evaluate(() => document.querySelectorAll("claude-annotate").length)) === 1 && (await overlayMode(page)) === "draw");
    await noteOn(page, "#inc", "after following the chat");
    const auto = await (await fetch(`${session.endpoint}/next`, { headers: H, signal: AbortSignal.timeout(5000) })).json(); // throws when nothing comes
    assert.match(auto.content, /### Note \d+ — "after following the chat"/, "the note reached the chat hook with no Send");
    await page.mouse.move(600, 500);
    await page.keyboard.press("Escape");
    await until("Esc removes the overlay", async () => (await overlayMode(page)) === "none", 3000);

    // A chrome:// page: Chrome captures it only after a real icon click, so the picture is seeded
    // here the way openSnapshot stores it after the capture.
    const chromePage = await context.newPage();
    await chromePage.goto("chrome://version/");
    const image = `data:image/png;base64,${(await chromePage.screenshot()).toString("base64")}`;
    await sw.evaluate(async ({ image }) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.storage.session.set({ snapshots: { j7: { url: "chrome://version/", title: "About Version", image, w: tab.width, h: tab.height, at: Date.now() } } });
      await chrome.tabs.create({ url: chrome.runtime.getURL("snapshot.html#j7"), index: tab.index + 1, openerTabId: tab.id });
    }, { image });
    const snap = await until("the picture's tab", async () => context.pages().find((p) => p.url().includes("snapshot.html")));
    await snap.bringToFront();
    await until("the overlay on the picture", async () => (await overlayMode(snap)) === "draw");
    await noteOn(snap, "#snap", "on a chrome page");
    const sent = await (await fetch(`${session.endpoint}/next`, { headers: H, signal: AbortSignal.timeout(5000) })).json(); // it goes by itself
    assert.match(sent.content, /annotated as a picture/, "Claude is told it is a picture");
    await snap.locator('claude-annotate .bar [data-act="exit"]').click();
    await until("Done closes the picture", async () => !context.pages().some((p) => p.url().includes("snapshot.html")));
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// 8. A local page that fights back
// ---------------------------------------------------------------------------
{
  const { context, sw, page } = await launch();
  await journey("a hostile local page: notes still go, Esc leaves, no token on the page, React through the helper", async () => {
    await fetch(`${session.endpoint}/clear`, { method: "POST", headers: H });
    const url = `${SITE}/hostile`;
    await page.goto(url);
    await click(sw, await tabIdOf(sw, url));
    await until("the overlay", async () => (await overlayMode(page)) === "draw");
    await noteOn(page, "#buy", "typed past the page");
    const got = await (await fetch(`${session.endpoint}/next`, { headers: H, signal: AbortSignal.timeout(5000) })).json();
    assert.match(got.content, /### Note \d+ — "typed past the page"/, "a page that grabs every key and has a strict CSP: the note goes");
    assert.match(got.content, /Checkout/, "React's component, read in the page's own world");
    const seen = await page.evaluate(() => window.seen.join("\n") + JSON.stringify(window.__CLAUDE_ANNOTATE__ ?? null));
    assert.ok(!seen.includes(session.token), "the page's scripts never see the token");
    await page.mouse.move(600, 500);
    await page.keyboard.press("Escape");
    await until("Esc leaves", async () => (await overlayMode(page)) === "none", 3000);
  });
  await context.close();
}

site.close();
await client.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(process.exitCode ? "\nsome journeys failed" : "\nall journeys passed");
