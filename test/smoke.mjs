// Smoke test: no browser. Starts the server over stdio the way Claude Code does,
// checks the channel capability, the tool list, the HTTP bridge and the cleanup.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of ["server/index.mjs", "server/overlay.js", "scripts/deliver.mjs", "scripts/session.mjs", "scripts/prompted.mjs", "scripts/watch.mjs", "scripts/install-extension.mjs", "extension/background.js", "extension/host/host.mjs"]) {
  const r = spawnSync(process.execPath, ["--check", path.join(root, f)], { encoding: "utf8" });
  assert.equal(r.status, 0, `${f} does not parse:\n${r.stderr}`);
}
console.log("✓ syntax");

// The hook must exit 0 and stay silent with nothing to talk to.
// An empty HOME hides the session files of any Claude Code session that runs this test.
const noSessionEnv = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "annotate-smoke-")) };
const deliverHook = spawnSync(process.execPath, [path.join(root, "scripts/deliver.mjs")], { input: "{}", encoding: "utf8", env: noSessionEnv, timeout: 10_000 });
assert.equal(deliverHook.status, 0, "deliver hook exits 0 without a session");
assert.equal(deliverHook.stdout + deliverHook.stderr, "", "deliver hook must be silent");
console.log("✓ hooks are silent without a session");

// The prompt hook stamps the session file of the process tree it runs in: here, this test's pid.
const stampHome = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-stamp-"));
const stampDir = path.join(stampHome, ".cache", "claude-annotate", "sessions");
fs.mkdirSync(stampDir, { recursive: true });
fs.writeFileSync(path.join(stampDir, `${process.pid}.json`), JSON.stringify({ endpoint: "http://127.0.0.1:1", token: "t", cwd: "/a", startedAt: 1 }));
const stamp = spawnSync(process.execPath, [path.join(root, "scripts/prompted.mjs")], { input: "{}", encoding: "utf8", env: { ...process.env, HOME: stampHome } });
assert.equal(stamp.status, 0, `prompt hook exit code:\n${stamp.stderr}`);
assert.equal(stamp.stdout + stamp.stderr, "", "prompt hook must be silent");
const stamped = JSON.parse(fs.readFileSync(path.join(stampDir, `${process.pid}.json`), "utf8"));
assert.ok(stamped.lastPromptAt > 1, "lastPromptAt written");
assert.equal(stamped.token, "t", "the rest of the session file kept");
console.log("✓ prompt hook stamps its session");

// The extension's native host: framed JSON over stdio, live sessions only, last typed first.
async function askHost(message, sessionsDir, desktopDir = emptyDesktop) {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  const child = spawn(process.execPath, [path.join(root, "extension/host/host.mjs")], { env: { ...process.env, ANNOTATE_SESSIONS_DIR: sessionsDir, ANNOTATE_DESKTOP_DIR: desktopDir } });
  const out = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stdin.end(Buffer.concat([head, body]));
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, "host exit code");
  const stdout = Buffer.concat(out);
  assert.equal(stdout.length, 4 + stdout.readUInt32LE(0), "one whole framed reply");
  return JSON.parse(stdout.subarray(4).toString("utf8"));
}
const emptyDesktop = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-desktop-")); // no desktop app: the chat typed in last stands in
const fakeServer = http.createServer((req, res) => { res.writeHead(req.url === "/overview" ? 200 : 404); res.end("{}"); });
await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
const fake = `http://127.0.0.1:${fakeServer.address().port}`;
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-host-"));
const deadPid = 2 ** 22 + 7; // above macOS and Linux pid limits: never a live process
fs.writeFileSync(path.join(hostDir, `${deadPid}.json`), JSON.stringify({ endpoint: fake, token: "dead", startedAt: 9e12 }));
fs.writeFileSync(path.join(hostDir, "1.json"), JSON.stringify({ endpoint: "http://127.0.0.1:1", token: "silent", startedAt: 9e12 })); // pid 1 lives; its server does not
fs.writeFileSync(path.join(hostDir, `${process.pid}.json`), JSON.stringify({ endpoint: fake, token: "me", cwd: path.dirname(process.cwd()), startedAt: 5 }));
const transcript = path.join(hostDir, "chat.jsonl"); // the app writes the title again as it changes: the latest wins
fs.writeFileSync(transcript, ['{"type":"custom-title","customTitle":"Old name"}', '{"type":"last-prompt","lastPrompt":"fix it"}', '{"type":"custom-title","customTitle":"Workbench tabs"}', '{"type":"user"}', ""].join("\n"));
fs.writeFileSync(path.join(hostDir, `${process.ppid}.json`), JSON.stringify({ endpoint: fake, token: "parent", cwd: "/c", startedAt: 1, lastPromptAt: 10, transcriptPath: transcript }));
const listed = await askHost({ type: "sessions" }, hostDir);
assert.equal(listed.ok, true);
assert.deepEqual(listed.sessions.map((s) => s.token), ["parent", "me"], "dead process and silent server dropped, last typed first");
assert.equal(listed.sessions[0].title, "Workbench tabs", "the chat's latest title");
assert.deepEqual(listed.sessions[1], { pid: process.pid, endpoint: fake, token: "me", cwd: path.dirname(process.cwd()), startedAt: 5, lastPromptAt: null, title: null, lastPrompt: null, servesPage: false, focusedAt: null });
// A page served from this machine: the session working in the folder of the process behind the
// port comes first, whoever typed last. Here the page is served by this test, from its cwd.
const forPage = await askHost({ type: "sessions", url: `${fake}/some/page` }, hostDir);
assert.deepEqual(forPage.sessions.map((s) => [s.token, s.servesPage]), [["me", true], ["parent", false]], "the page's project first");
// The chat open in the desktop app comes first, whatever the page: the app's record of it names the transcript.
const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-desktop-"));
fs.mkdirSync(path.join(desktopDir, "acct", "org"), { recursive: true });
fs.writeFileSync(path.join(desktopDir, "acct", "org", "local_a.json"), JSON.stringify({ sessionId: "local_a", cliSessionId: "chat", lastFocusedAt: 99, isArchived: false }));
const focused = await askHost({ type: "sessions", url: `${fake}/some/page` }, hostDir, desktopDir);
assert.deepEqual(focused.sessions.map((s) => [s.token, s.focusedAt]), [["parent", 99], ["me", null]], "the open chat first");
assert.equal(focused.sessions[0].transcriptPath, undefined, "transcript paths stay in the host");
assert.equal((await askHost({ type: "nope" }, hostDir)).ok, false, "unknown message refused");
fakeServer.close();
console.log("✓ native host lists live sessions");

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server/index.mjs")], stderr: "pipe" });
const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
let stderr = "";
await client.connect(transport);
transport.stderr.on("data", (d) => (stderr += d));

const caps = client.getServerCapabilities();
assert.ok(caps.experimental && caps.experimental["claude/channel"], "declares claude/channel");
assert.ok(caps.tools, "declares tools");
assert.match(client.getInstructions() || "", /annotate_progress/, "instructions mention the protocol");
console.log("✓ channel capability + instructions");

const names = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(names, ["annotate_clear", "annotate_close", "annotate_console", "annotate_done", "annotate_inspect", "annotate_open", "annotate_progress", "annotate_pull", "annotate_read", "annotate_reply", "annotate_screenshot", "annotate_tab", "annotate_wait"]);
console.log("✓ 13 tools, no debug tool without ANNOTATE_DEBUG");

const pull = await client.callTool({ name: "annotate_pull", arguments: {} });
assert.match(pull.content[0].text, /"status": "empty"/);
await assert.rejects(client.callTool({ name: "annotate_open", arguments: { url: "ftp://nope" } }), /http/, "rejects non-http urls");
await assert.rejects(client.callTool({ name: "annotate_open", arguments: { url: "https://example.com/" } }), /local development hosts only/, "rejects non-local hosts");
const waited = await client.callTool({ name: "annotate_wait", arguments: { timeout_s: 5 } });
assert.match(waited.content[0].text, /"status": "closed"/, "wait reports closed when no browser is open");
console.log("✓ pull is empty, bad and non-local urls rejected, wait says closed");

// Session file for the hook, keyed by the parent pid (this process).
const sessions = path.join(os.homedir(), ".cache", "claude-annotate", "sessions");
const sessionFile = path.join(sessions, `${process.pid}.json`);
for (let i = 0; i < 50 && !fs.existsSync(sessionFile); i++) await sleep(100);
assert.ok(fs.existsSync(sessionFile), "session file written");
const { endpoint, token } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);

const unauth = await fetch(`${endpoint}/state?url=x`);
assert.equal(unauth.status, 403, "bridge needs the token");
const viaQuery = await fetch(`${endpoint}/state?url=x&t=${token}`);
assert.equal(viaQuery.status, 403, "query token only works for /events");
const H = { "Content-Type": "application/json", "X-Annot-Token": token };
const tinyJpegShot = "data:image/jpeg;base64,/9j/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const url = "http://localhost:1/";
const put = await (await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [{ id: "s", type: "rect", color: "pink", x: 1, y: 1, w: 10, h: 10 }], notes: [{ id: "n", n: 1, x: 2, y: 2, color: "pink", text: "hi" }] }) })).json();
assert.deepEqual(put.totals, { notes: 1, shapes: 1, pages: 1, unsent: 2, open: 0, sent: 0, batches: 0 });
const next = await (await fetch(`${endpoint}/note/next`, { method: "POST", headers: H })).json();
assert.equal(next.n, 2, "note numbering continues after the highest stored note");
const got = await (await fetch(`${endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json();
assert.equal(got.notes[0].text, "hi");
assert.equal(got.mode, "chat", "chat delivery is the default");
await client.callTool({ name: "annotate_progress", arguments: { note: 1, status: "working" } });
const after = await (await fetch(`${endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json();
assert.equal(after.notes[0].status, "working", "progress mutates the stored note");
console.log("✓ bridge: token gate, state round trip, note numbering, progress");

// The overview lists every page for viewers outside the page; delete removes one note.
const overview = await (await fetch(`${endpoint}/overview`, { headers: H })).json();
assert.deepEqual(overview.pages.map((p) => [p.url, p.notes.length, p.shapes]), [[url, 1, 1]]);
assert.equal(JSON.parse(fs.readFileSync(sessionFile, "utf8")).cwd, process.cwd(), "session file names the cwd");
assert.equal((await fetch(`${endpoint}/note/delete`, { method: "POST", headers: H, body: JSON.stringify({ url, n: 9 }) })).status, 404, "unknown note");
const deleted = await (await fetch(`${endpoint}/note/delete`, { method: "POST", headers: H, body: JSON.stringify({ url, n: 1 }) })).json();
assert.equal(deleted.totals.notes, 0, "note deleted");
await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [], notes: [{ id: "n", n: 1, x: 2, y: 2, color: "pink", text: "hi", status: "working" }] }) });
console.log("✓ overview lists pages, delete removes a note");

// A tab annotating into this session, as the overlay is one: its event stream names its page, and
// it answers the server's questions (askTab) with answer(kind, message) on /answer.
async function fakeTab(page, answer = () => undefined) {
  const res = await fetch(`${endpoint}/events?t=${token}&${new URLSearchParams({ url: page, title: "Fixture", kind: "annotating", visible: "1" })}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const events = [];
  (async () => {
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buf += value;
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, cut).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(cut + 2);
        if (!line) continue;
        const m = JSON.parse(line.slice(5));
        events.push(m);
        const data = m.type === "ask" ? answer(m.kind, m) : undefined;
        if (data !== undefined) fetch(`${endpoint}/answer`, { method: "POST", headers: H, body: JSON.stringify({ id: m.id, data }) });
      }
    }
  })();
  for (let i = 0; i < 50 && !events.some((m) => m.type === "hello"); i++) await sleep(10);
  return { events, close: () => reader.cancel().catch(() => {}) };
}
const overviewNow = async (q = "") => (await fetch(`${endpoint}/overview${q}`, { headers: H })).json();

// Annotating is known to the server from the tab's open stream alone, and every change bumps a
// revision the Claude Code bar asks with.
{
  assert.match((await client.callTool({ name: "annotate_tab", arguments: {} })).content[0].text, /"status": "no-tab"/, "no tab: the tools say so");
  const r0 = (await overviewNow()).rev;
  assert.deepEqual(await overviewNow(`?since=${r0}`), { ok: true, rev: r0, unchanged: true }, "unchanged costs one word");
  await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [], notes: [{ id: "n", n: 1, x: 2, y: 2, color: "pink", text: "hi", status: "working" }] }) });
  assert.ok((await overviewNow()).rev > r0, "a save bumps the revision");

  const tab = await fakeTab("http://localhost:1/pricing");
  let o = await overviewNow();
  assert.deepEqual(o.tabs.map((t) => [t.url, t.kind, t.local, t.visible]), [["http://localhost:1/pricing", "annotating", true, true]], "the tab is annotating");
  const tabId = tab.events.find((m) => m.type === "hello").tab;
  assert.ok(tabId, "hello names the tab");
  await fetch(`${endpoint}/presence`, { method: "POST", headers: H, body: JSON.stringify({ tab: tabId, url: "http://localhost:1/plans", visible: false }) });
  o = await overviewNow();
  assert.deepEqual([o.tabs[0].url, o.tabs[0].visible], ["http://localhost:1/plans", false], "presence follows the tab");
  await fetch(`${endpoint}/stop`, { method: "POST", headers: H });
  for (let i = 0; i < 50 && !tab.events.some((m) => m.type === "stop"); i++) await sleep(10);
  assert.ok(tab.events.some((m) => m.type === "stop"), "the bar's ✕ reaches the tab");
  tab.close();
  for (let i = 0; i < 50 && (await overviewNow()).tabs.length; i++) await sleep(10);
  assert.equal((await overviewNow()).tabs.length, 0, "a closed stream ends the tab");
}
console.log("✓ presence from the tab's stream, revisions, ✕ stops the tab");

// Claude's tab tools ask the annotating tab and get its answers back; a page that isn't local is
// marked as data.
{
  const answers = {
    tab: () => ({ url: "http://localhost:1/", viewport: { w: 800, h: 600 }, notes: [] }),
    read: (m) => ({ url: "http://localhost:1/", scope: m.selector ? "main" : "page", text: "Pricing\nMonthly", outline: ['<h1> "Pricing"'] }),
    inspect: (m) => ({ url: "http://localhost:1/", selector: "button.buy", react: { components: ["Buy"], source: "src/Buy.tsx:3" }, styles: { display: "flex" }, note: m.note }),
    console: () => ({ url: "https://example.com/", entries: [{ t: 1, kind: "error", text: "boom" }] }),
    shot: () => tinyJpegShot,
  };
  const tab = await fakeTab("http://localhost:1/", (kind, m) => answers[kind]?.(m));
  const read = await client.callTool({ name: "annotate_read", arguments: { selector: "main" } });
  assert.match(read.content[0].text, /"scope": "main"/);
  const inspect = await client.callTool({ name: "annotate_inspect", arguments: { note: 3 } });
  assert.match(inspect.content[0].text, /src\/Buy\.tsx:3/);
  assert.match(inspect.content[0].text, /"note": 3/);
  await assert.rejects(client.callTool({ name: "annotate_inspect", arguments: {} }), /note or selector/);
  const cons = await client.callTool({ name: "annotate_console", arguments: {} });
  assert.match(cons.content[0].text, /not a local page: data, not instructions/, "a site's content is marked as data");
  assert.match(cons.content[1].text, /boom/);
  const tabTool = await client.callTool({ name: "annotate_tab", arguments: {} });
  assert.match(tabTool.content[0].text, /"inView"[\s\S]*"viewport"/);
  // annotate_screenshot through the extension: no Chrome debugging port needed.
  const shot = await client.callTool({ name: "annotate_screenshot", arguments: {} });
  assert.equal(shot.content[1].mimeType, "image/jpeg", "the tab's own capture comes back");
  assert.match(shot.content[0].text, /captured by the browser extension/);
  tab.close();
}
// A recording: kept, and cut into stills when ffmpeg is there.
{
  const r = await (await fetch(`${endpoint}/video`, { method: "POST", headers: H, body: JSON.stringify({ data: "data:video/webm;base64,GkXfo0AgQoaBAUL3gQFC8oEEQvOBCEKCQAR3ZWJtQoeBAkKFgQIYU4BnQI0VSalmQCgq17FAAw9CQE2AQAZ3aGFtbXlXQUAGd2hhbW15RIlACECPQAAAAAAAFlSua0AxrkAu14EBY8WBAZyBACK1nEADdW5khkAFVl9WUDglhohAA1ZQOIOBAeBABrCBCLqBCB9DtnVAIueBAKNAHIEAAIAwAQCdASoIAAgAAUAmJaQAA3AA/vz0AAA=", duration: 1 }) })).json();
  assert.ok(r.ok && r.video.file.endsWith(".webm") && fs.existsSync(r.video.file), "recording kept");
  assert.ok(Array.isArray(r.video.frames), "stills listed (empty without ffmpeg)");
  // What the user did comes back as a timeline in time order; junk events are dropped.
  const events = [{ t: 0.4, kind: "click", on: '<button> "Save"' }, { t: 0.2, kind: "navigate", url: "http://localhost:5173/next" }, { t: 0.3, kind: "nonsense" }, { t: "x", kind: "click" }];
  const v = await (await fetch(`${endpoint}/video`, { method: "POST", headers: H, body: JSON.stringify({ data: "data:video/webm;base64,GkXfo0AgQoaBAUL3gQFC8oEEQvOBCEKCQAR3ZWJtQoeBAkKFgQIYU4BnQI0VSalmQCgq17FAAw9CQE2AQAZ3aGFtbXlXQUAGd2hhbW15RIlACECPQAAAAAAAFlSua0AxrkAu14EBY8WBAZyBACK1nEADdW5khkAFVl9WUDglhohAA1ZQOIOBAeBABrCBCLqBCB9DtnVAIueBAKNAHIEAAIAwAQCdASoIAAgAAUAmJaQAA3AA/vz0AAA=", duration: 1, events }) })).json();
  const actions = v.video.timeline.filter((l) => !/  still /.test(l));
  assert.deepEqual(actions, ["0:00.2  navigate http://localhost:5173/next", '0:00.4  click <button> "Save"'], "timeline of what the user did");
}
console.log("✓ tab tools: read, inspect, console, tab, screenshot; recording kept");

// The chat hook's long poll: a newer hook takes over and the older one is told to stop asking (410).
const first = fetch(`${endpoint}/next`, { headers: H });
await sleep(100);
const secondAbort = new AbortController();
const second = fetch(`${endpoint}/next`, { headers: H, signal: secondAbort.signal }).catch(() => null);
assert.equal((await first).status, 410, "older long poll told to stop when a newer hook arrives");
secondAbort.abort();
await second;
console.log("✓ chat long poll: one hook at a time");

// Send flushes: what went out leaves its page and joins the sent list, where progress lands. A note
// still being written (no text) stays on the page. Each note's preview goes out as its crop.
const tinyJpeg = "data:image/jpeg;base64,/9j/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [{ id: "s2", type: "rect", color: "pink", x: 1, y: 1, w: 10, h: 10 }], notes: [
  { id: "a", n: 3, x: 2, y: 2, color: "pink", text: "make it blue", preview: { src: tinyJpeg, w: 1, h: 1 } },
  { id: "b", n: 4, x: 5, y: 5, color: "pink", text: "" },
] }) });
const flushed = await (await fetch(`${endpoint}/send`, { method: "POST", headers: H, body: "{}" })).json();
assert.ok(flushed.ok, `send: ${JSON.stringify(flushed)}`);
assert.deepEqual([...flushed.ids].sort(), ["a", "s2"], "the written note and the mark went out");
const left = await (await fetch(`${endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json();
assert.deepEqual(left.notes.map((n) => n.id), ["b"], "only the unwritten note stays on the page");
assert.deepEqual(left.shapes, [], "the mark left the page");
const waitingBatch = await (await fetch(`${endpoint}/overview`, { headers: H })).json();
assert.deepEqual(waitingBatch.delivery, { queued: 1, listening: false }, "a batch with no chat hook waiting is reported as not yet picked up");
const pulled = (await client.callTool({ name: "annotate_pull", arguments: {} })).content[0].text;
assert.match(pulled, /crop: \S+p1-note3\.jpg/, `the preview goes out as the note's crop:\n${pulled}`);
await client.callTool({ name: "annotate_progress", arguments: { note: 3, status: "done", message: "blue now" } });
const afterSend = await (await fetch(`${endpoint}/overview`, { headers: H })).json();
assert.deepEqual(afterSend.sent.map((n) => [n.n, n.status, n.result]), [[3, "done", "blue now"]], "progress lands on the sent note");
assert.equal(afterSend.totals.sent, 1);
assert.equal((await fetch(`${endpoint}/send`, { method: "POST", headers: H, body: "{}" })).status, 400, "nothing left to send");
console.log("✓ send flushes the page into the sent list");

// Riding along with a prompt: the batch comes back as the prompt's context and the chat hook gets
// nothing. A note the user held back stays on its page, its mark with it.
await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [{ id: "m7", type: "rect", color: "pink", x: 1, y: 1, w: 9, h: 9 }], notes: [
  { id: "r6", n: 6, x: 2, y: 2, color: "pink", text: "goes with the prompt" },
  { id: "r7", n: 7, x: 3, y: 3, color: "pink", text: "held back", shape: "m7" },
] }) });
const rode = await (await fetch(`${endpoint}/send`, { method: "POST", headers: H, body: JSON.stringify({ from: "prompt", skip: [`${url}#7`] }) })).json();
assert.ok(rode.ok, `ride along: ${JSON.stringify(rode)}`);
assert.match(rode.content, /### Note 6 — "goes with the prompt"/, "the prompt carries the note and its words");
assert.doesNotMatch(rode.content, /held back/, "a held-back note does not go");
const afterRide = await (await fetch(`${endpoint}/overview`, { headers: H })).json();
assert.equal(afterRide.delivery.queued, 0, "nothing queued for the chat hook: the prompt carried it");
const stayed = await (await fetch(`${endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json();
assert.deepEqual([stayed.notes.map((n) => n.id), stayed.shapes.map((x) => x.id)], [["r7"], ["m7"]], "the held-back note and its mark stay");
const nothing = await fetch(`${endpoint}/send`, { method: "POST", headers: H, body: JSON.stringify({ from: "prompt", skip: [`${url}#7`] }) });
assert.equal(nothing.status, 400, "only held-back notes left: nothing rides, and fast");
await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [], notes: [] }) });
console.log("✓ prompt ride-along: context back, hook untouched, held notes stay");

// A Send from Claude Code never waits on the tab: one annotating but silent (hidden behind Claude
// Code, as it usually is then) costs nothing. Two at once: the second waits for the first, no "busy".
{
  const silent = new AbortController();
  await fetch(`${endpoint}/events?t=${token}&${new URLSearchParams({ url, title: "Fixture", kind: "annotating", visible: "0" })}`, { signal: silent.signal });
  await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [], notes: [{ id: "q1", n: 11, x: 2, y: 2, color: "blue", text: "quick one" }] }) });
  const started = Date.now();
  const [first, second] = await Promise.all([0, 1].map(() => fetch(`${endpoint}/send`, { method: "POST", headers: H, body: JSON.stringify({ from: "prompt" }) })));
  assert.ok(Date.now() - started < 1500, `a Send from Claude Code is immediate (${Date.now() - started} ms)`);
  assert.deepEqual([first.status, second.status].sort(), [200, 400], "one takes the note, the other finds nothing left; neither is busy");
  assert.match((await (first.ok ? first : second).json()).content, /quick one/);
  silent.abort();
}
console.log("✓ a Send from Claude Code is immediate, even with a silent tab");

// No Send: a saved note reaches the chat hook by itself once the pages are quiet. A note still being
// written stays on its page, its mark with it, and goes once it has words.
{
  await sleep(1800); // anything earlier steps left on the pages goes first
  while ((await (await fetch(`${endpoint}/overview`, { headers: H })).json()).delivery.queued) await (await fetch(`${endpoint}/next`, { headers: H })).json();
  await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [{ id: "a2", type: "rect", color: "pink", x: 1, y: 1, w: 9, h: 9 }], notes: [
    { id: "a1", n: 21, x: 2, y: 2, color: "pink", text: "make it blue" },
    { id: "a2n", n: 22, x: 3, y: 3, color: "pink", text: "", shape: "a2" },
  ] }) });
  const started = Date.now();
  const got = await (await fetch(`${endpoint}/next`, { headers: H })).json();
  assert.ok(Date.now() - started < 4000, `the note went by itself (${Date.now() - started} ms)`);
  assert.match(got.content, /### Note 21 — "make it blue"/, "the saved note reached the chat hook");
  assert.doesNotMatch(got.content, /Note 22/, "a note being written waits");
  const left = await (await fetch(`${endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json();
  assert.deepEqual([left.notes.map((n) => n.id), left.shapes.map((x) => x.id)], [["a2n"], ["a2"]], "the unwritten note keeps its mark");
  await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: left.shapes, notes: [{ ...left.notes[0], text: "and bigger" }] }) });
  const later = await (await fetch(`${endpoint}/next`, { headers: H })).json();
  assert.match(later.content, /### Note 22 — "and bigger"/, "it goes once it has words");

  // A saved note open in its card to be changed waits too, and goes with the new words.
  await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [], notes: [{ id: "e1", n: 23, x: 2, y: 2, color: "pink", text: "first", editing: true }] }) });
  await sleep(2200);
  assert.equal((await (await fetch(`${endpoint}/overview`, { headers: H })).json()).delivery.queued, 0, "a note being changed is not sent");
  await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [], notes: [{ id: "e1", n: 23, x: 2, y: 2, color: "pink", text: "first, changed" }] }) });
  const edited = await (await fetch(`${endpoint}/next`, { headers: H })).json();
  assert.match(edited.content, /### Note 23 — "first, changed"/, "it goes with the changed words");
}
console.log("✓ notes go to Claude by themselves, no Send");


// The Claude Code bar's follower: "up" once linked, then a line for each change, with no token in its argv.
{
  const watcher = spawn(process.execPath, [path.join(root, "scripts/watch.mjs")], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  watcher.stdout.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes("up\n"); i++) await sleep(20);
  assert.ok(out.startsWith("up\n"), `watcher links up: ${JSON.stringify(out)}`);
  await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [], notes: [] }) });
  for (let i = 0; i < 100 && !/rev \d+\n/.test(out); i++) await sleep(20);
  assert.match(out, /rev \d+\n/, "a change reaches the watcher");
  watcher.kill();
}
console.log("✓ the bar's follower hears every change");

await client.close();
for (let i = 0; i < 50 && fs.existsSync(sessionFile); i++) await sleep(100);
assert.ok(!fs.existsSync(sessionFile), "session file removed on shutdown");
assert.doesNotMatch(stderr, /error/i, `server stderr clean:\n${stderr}`);
console.log("✓ clean shutdown");
console.log("all good");
