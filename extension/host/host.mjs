#!/usr/bin/env node
// Native messaging host for the Claude Annotate extension. Chrome starts it per message and
// talks over stdio: a 4-byte little-endian length, then that many bytes of JSON, each way.
//
// { type: "sessions", url? } → { ok, sessions: [{ pid, endpoint, token, cwd, startedAt, lastPromptAt, title, lastPrompt, servesPage }] }
// { type: "alive", pid } → { ok, alive }: whether that chat's Claude Code process still runs
// Live sessions only (the Claude Code process named by the file still runs and its annotate
// server answers). Order: with a local url, the sessions working in the folder of the dev server
// behind that page come first (servesPage, deepest folder first); then the one the user typed in
// last. Only this extension's id may start the host (allowed_origins).
import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS = process.env.ANNOTATE_SESSIONS_DIR || path.join(os.homedir(), ".cache", "claude-annotate", "sessions");
// The Claude desktop app's record of its chats: each file names the chat's transcript id and when it
// was last focused in the app. Not a public interface: when it is missing or changes shape, the chat
// typed in last stands in for the open one.
const DESKTOP_CHATS = process.env.ANNOTATE_DESKTOP_DIR || path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
const DESKTOP_RECENT = 30; // the app rewrites a chat's file when it is focused: only the newest few are read

const PROBE_MS = 800;

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

function liveSessions(dir = SESSIONS) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const sessions = [];
  for (const name of names) {
    const pid = Number(name.replace(/\.json$/, ""));
    if (!pid || !name.endsWith(".json") || !isAlive(pid)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      sessions.push({ pid, endpoint: s.endpoint, token: s.token, cwd: s.cwd ?? null, startedAt: s.startedAt ?? 0, lastPromptAt: s.lastPromptAt ?? null, transcriptPath: s.transcriptPath ?? null, ...chatNames(s.transcriptPath) });
    } catch {
      // Being written or removed right now: skip it this time.
    }
  }
  const recency = (s) => s.lastPromptAt ?? s.startedAt;
  return sessions.sort((a, b) => recency(b) - recency(a));
}

// The chat's name as the app shows it (the latest title record near the end of its transcript) and
// what the user typed there last: several chats can share a title. Nulls when the hooks haven't
// recorded the transcript yet.
const TITLE_TAIL = 1 << 20;
function chatNames(transcriptPath) {
  if (!transcriptPath) return { title: null, lastPrompt: null };
  let text;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TITLE_TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch {
    return { title: null, lastPrompt: null };
  }
  let lastPrompt = null, title = null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if ((title || (!line.includes('"custom-title"') && !line.includes('"ai-title"'))) && (lastPrompt || !line.includes('"last-prompt"'))) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // the first line of the tail is cut
    if (!title && r.type === "custom-title" && r.customTitle) title = r.customTitle;
    if (!title && r.type === "ai-title" && r.aiTitle) title = r.aiTitle;
    if (!lastPrompt && r.type === "last-prompt" && r.lastPrompt) lastPrompt = r.lastPrompt.replace(/<!--[\s\S]*?-->/g, "").replace(/^[\s>]+/, "").replace(/\s+/g, " ").trim().slice(0, 80) || null;
    if (title && lastPrompt) break;
  }
  return { title: title ?? lastPrompt, lastPrompt };
}

async function answers(session) {
  try {
    const res = await fetch(`${session.endpoint}/overview`, { headers: { "X-Annot-Token": session.token }, signal: AbortSignal.timeout(PROBE_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

// The folder of the process listening on a local page's port: the dev server's project.
// null for a page that isn't served from this machine, or when lsof can't tell.
// A name like postprint.internal or app.test counts when it resolves to this machine.
async function pageFolder(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!(await isThisMachine(u.hostname))) return null;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const lsof = (args) => execFileSync("lsof", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
  try {
    const pid = lsof(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n").find(Boolean);
    if (!pid) return null;
    const cwd = lsof(["-a", "-p", pid, "-d", "cwd", "-Fn"]).split("\n").find((l) => l.startsWith("n"));
    return cwd ? cwd.slice(1) : null;
  } catch {
    return null;
  }
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/;
async function isThisMachine(host) {
  if (LOOPBACK.test(host) || /\.localhost$/.test(host)) return true;
  try {
    const all = await dns.lookup(host.replace(/^\[|\]$/g, ""), { all: true });
    return all.length > 0 && all.every((a) => LOOPBACK.test(a.address));
  } catch {
    return false;
  }
}

const isInside = (folder, cwd) => !!cwd && (folder === cwd || folder.startsWith(cwd.endsWith("/") ? cwd : cwd + "/"));

// Sessions working on the page's project first, the deepest folder first (a worktree's session
// before the repo's); otherwise the order stays: the one typed in last first.
function rankForPage(sessions, folder) {
  for (const s of sessions) s.servesPage = !!folder && isInside(folder, s.cwd);
  const depth = (s) => (s.servesPage ? s.cwd.length : -1);
  return sessions.map((s, i) => [s, i]).sort(([a, i], [b, j]) => depth(b) - depth(a) || i - j).map(([s]) => s);
}

// transcript id → when the desktop app last focused that chat.
function desktopFocus(dir = DESKTOP_CHATS) {
  const files = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try { files.push([p, fs.statSync(p).mtimeMs]); } catch { /* gone */ }
      }
    }
  };
  walk(dir, 0);
  const focus = new Map();
  for (const [p] of files.sort((a, b) => b[1] - a[1]).slice(0, DESKTOP_RECENT)) {
    let head;
    try {
      const fd = fs.openSync(p, "r");
      try { const buf = Buffer.alloc(4096); head = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, 4096, 0)); } finally { fs.closeSync(fd); }
    } catch { continue; }
    const id = /"cliSessionId"\s*:\s*"([^"]+)"/.exec(head)?.[1];
    const at = Number(/"lastFocusedAt"\s*:\s*(\d+)/.exec(head)?.[1]);
    const archived = /"isArchived"\s*:\s*true/.test(head);
    if (id && at && !archived) focus.set(id, Math.max(at, focus.get(id) ?? 0));
  }
  return focus;
}

// The chat open in the desktop app first (focused last); then, as before, the page's project and
// the chat typed in last.
function rankByFocus(sessions, focus) {
  for (const s of sessions) {
    const id = s.transcriptPath ? path.basename(s.transcriptPath, ".jsonl") : null;
    s.focusedAt = (id && focus.get(id)) || null;
  }
  // The chat used last: focused in the desktop app, or typed in (a terminal chat has no focus record,
  // and one just typed in must not lose to a desktop chat focused before it).
  // No desktop app: the order for the page stands (its project first, then typed in last).
  if (!sessions.some((s) => s.focusedAt)) return sessions;
  const lastUsed = (s) => Math.max(s.focusedAt ?? 0, s.lastPromptAt ?? 0);
  return sessions.map((s, i) => [s, i]).sort(([a, i], [b, j]) => lastUsed(b) - lastUsed(a) || i - j).map(([s]) => s);
}

async function reachableSessions(url) {
  const sessions = liveSessions();
  const ok = await Promise.all(sessions.map(answers));
  const ranked = rankForPage(sessions.filter((_, i) => ok[i]), url ? await pageFolder(url) : null);
  return rankByFocus(ranked, desktopFocus()).map(({ transcriptPath, ...s }) => s);
}

async function answer(message) {
  if (message?.type === "sessions") return { ok: true, sessions: await reachableSessions(message.url) };
  // Is this chat still running (its Claude Code process, whatever its server is doing)?
  if (message?.type === "alive") return { ok: true, alive: Number.isInteger(message.pid) && message.pid > 1 && isAlive(message.pid) };
  return { ok: false, error: `unknown message type: ${message?.type}` };
}

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length >= 4 + len) resolve(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
    });
    process.stdin.on("end", () => reject(new Error("stdin closed before a whole message")));
  });
}

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return new Promise((resolve) => process.stdout.write(Buffer.concat([head, body]), resolve)); // a pipe writes async
}

let reply;
try {
  reply = await answer(await readMessage());
} catch (e) {
  reply = { ok: false, error: String(e.message ?? e) };
}
await writeMessage(reply);
process.exit(0);
