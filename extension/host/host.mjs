#!/usr/bin/env node
// Native messaging host for the Claude Annotate extension. Chrome starts it per message and
// talks over stdio: a 4-byte little-endian length, then that many bytes of JSON, each way.
//
// { type: "sessions" } → { ok, sessions: [{ pid, endpoint, token, cwd, startedAt, lastPromptAt }] }
// Live sessions only (the Claude Code process named by the file still runs and its annotate
// server answers), the one the user typed in last first. Only this extension's id may start the host (allowed_origins).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS = process.env.ANNOTATE_SESSIONS_DIR || path.join(os.homedir(), ".cache", "claude-annotate", "sessions");

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
      sessions.push({ pid, endpoint: s.endpoint, token: s.token, cwd: s.cwd ?? null, startedAt: s.startedAt ?? 0, lastPromptAt: s.lastPromptAt ?? null });
    } catch {
      // Being written or removed right now: skip it this time.
    }
  }
  const recency = (s) => s.lastPromptAt ?? s.startedAt;
  return sessions.sort((a, b) => recency(b) - recency(a));
}

async function answers(session) {
  try {
    const res = await fetch(`${session.endpoint}/overview`, { headers: { "X-Annot-Token": session.token }, signal: AbortSignal.timeout(PROBE_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

async function reachableSessions() {
  const sessions = liveSessions();
  const ok = await Promise.all(sessions.map(answers));
  return sessions.filter((_, i) => ok[i]);
}

async function answer(message) {
  if (message?.type === "sessions") return { ok: true, sessions: await reachableSessions() };
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
