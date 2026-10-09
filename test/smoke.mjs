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

for (const f of ["server/index.mjs", "server/overlay.js", "scripts/ticker.mjs", "scripts/deliver.mjs", "scripts/session.mjs", "scripts/prompted.mjs", "scripts/install-extension.mjs", "extension/background.js", "extension/host/host.mjs"]) {
  const r = spawnSync(process.execPath, ["--check", path.join(root, f)], { encoding: "utf8" });
  assert.equal(r.status, 0, `${f} does not parse:\n${r.stderr}`);
}
console.log("✓ syntax");

// The hook must exit 0 and stay silent with nothing to talk to.
// An empty HOME hides the session files of any Claude Code session that runs this test.
const noSessionEnv = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "annotate-smoke-")) };
const hook = spawnSync(process.execPath, [path.join(root, "scripts/ticker.mjs")], { input: JSON.stringify({ tool_name: "Edit", cwd: root, tool_input: { file_path: path.join(root, "x.ts") } }), encoding: "utf8", env: noSessionEnv });
assert.equal(hook.status, 0, "hook exit code");
assert.equal(hook.stdout + hook.stderr, "", "hook must be silent");
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
async function askHost(message, sessionsDir) {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  const child = spawn(process.execPath, [path.join(root, "extension/host/host.mjs")], { env: { ...process.env, ANNOTATE_SESSIONS_DIR: sessionsDir } });
  const out = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stdin.end(Buffer.concat([head, body]));
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, "host exit code");
  const stdout = Buffer.concat(out);
  assert.equal(stdout.length, 4 + stdout.readUInt32LE(0), "one whole framed reply");
  return JSON.parse(stdout.subarray(4).toString("utf8"));
}
const fakeServer = http.createServer((req, res) => { res.writeHead(req.url === "/overview" ? 200 : 404); res.end("{}"); });
await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
const fake = `http://127.0.0.1:${fakeServer.address().port}`;
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-host-"));
const deadPid = 2 ** 22 + 7; // above macOS and Linux pid limits: never a live process
fs.writeFileSync(path.join(hostDir, `${deadPid}.json`), JSON.stringify({ endpoint: fake, token: "dead", startedAt: 9e12 }));
fs.writeFileSync(path.join(hostDir, "1.json"), JSON.stringify({ endpoint: "http://127.0.0.1:1", token: "silent", startedAt: 9e12 })); // pid 1 lives; its server does not
fs.writeFileSync(path.join(hostDir, `${process.pid}.json`), JSON.stringify({ endpoint: fake, token: "me", cwd: "/b", startedAt: 5 }));
fs.writeFileSync(path.join(hostDir, `${process.ppid}.json`), JSON.stringify({ endpoint: fake, token: "parent", cwd: "/c", startedAt: 1, lastPromptAt: 10 }));
const listed = await askHost({ type: "sessions" }, hostDir);
assert.equal(listed.ok, true);
assert.deepEqual(listed.sessions.map((s) => s.token), ["parent", "me"], "dead process and silent server dropped, last typed first");
assert.deepEqual(listed.sessions[1], { pid: process.pid, endpoint: fake, token: "me", cwd: "/b", startedAt: 5, lastPromptAt: null });
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
assert.deepEqual(names, ["annotate_clear", "annotate_close", "annotate_done", "annotate_open", "annotate_progress", "annotate_pull", "annotate_reply", "annotate_screenshot", "annotate_wait"]);
console.log("✓ 9 tools, no debug tool without ANNOTATE_DEBUG");

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
const url = "http://localhost:1/";
const put = await (await fetch(`${endpoint}/state`, { method: "PUT", headers: H, body: JSON.stringify({ url, shapes: [{ id: "s", type: "rect", color: "pink", x: 1, y: 1, w: 10, h: 10 }], notes: [{ id: "n", n: 1, x: 2, y: 2, color: "pink", text: "hi" }] }) })).json();
assert.deepEqual(put.totals, { notes: 1, shapes: 1, pages: 1, unsent: 2, open: 0, batches: 0 });
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

// The chat hook's long poll: a newer hook takes over and the older one is told to stop asking (410).
const first = fetch(`${endpoint}/next`, { headers: H });
await sleep(100);
const secondAbort = new AbortController();
const second = fetch(`${endpoint}/next`, { headers: H, signal: secondAbort.signal }).catch(() => null);
assert.equal((await first).status, 410, "older long poll told to stop when a newer hook arrives");
secondAbort.abort();
await second;
console.log("✓ chat long poll: one hook at a time");

// The hook finds the session by parent pid and posts a status line: watch it arrive on the SSE stream.
const events = await fetch(`${endpoint}/events?t=${token}`);
const reader = events.body.getReader();
const dec = new TextDecoder();
const hook2 = spawnSync(process.execPath, [path.join(root, "scripts/ticker.mjs")], { input: JSON.stringify({ tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, "src/x.ts") } }), encoding: "utf8" });
assert.equal(hook2.status, 0);
let seen = "";
for (let i = 0; i < 20 && !/wrote src\/x\.ts/.test(seen); i++) {
  const { value, done } = await Promise.race([reader.read(), sleep(200).then(() => ({ value: null, done: false }))]);
  if (done) break;
  if (value) seen += dec.decode(value);
}
assert.match(seen, /wrote src\/x\.ts/, `hook status reached the page stream:\n${seen}`);
await reader.cancel().catch(() => {});
console.log("✓ hook reaches the bridge and the page");

await client.close();
for (let i = 0; i < 50 && fs.existsSync(sessionFile); i++) await sleep(100);
assert.ok(!fs.existsSync(sessionFile), "session file removed on shutdown");
assert.doesNotMatch(stderr, /error/i, `server stderr clean:\n${stderr}`);
console.log("✓ clean shutdown");
console.log("all good");
