// Finds the annotate server that belongs to the Claude Code session running this hook.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const SESSIONS = path.join(os.homedir(), ".cache", "claude-annotate", "sessions");
const ps = (field, pid) => { try { return execSync(`ps -o ${field}= -p ${pid}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const parentOf = (pid) => Number(ps("ppid", pid)) || 0;
const isClaude = (pid) => path.basename(ps("comm", pid)) === "claude";

// Walk up the process tree (hook → shell → claude) until a session file matches, and no further
// than the first Claude Code: a claude started inside another chat (claude -p from a tool) has its
// own session, never the outer chat's. No match: return null, never guess another session's page.
export function findSession() {
  const file = findSessionFile();
  return file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

export function findSessionFile() {
  for (let pid = process.ppid, i = 0; pid > 1 && i < 4; pid = parentOf(pid), i++) {
    const f = path.join(SESSIONS, `${pid}.json`);
    if (fs.existsSync(f)) return f;
    if (isClaude(pid)) return null;
  }
  return null;
}

// Adds fields to this session's file: when the user last typed, and the chat's transcript, where
// the extension reads the chat's title. A session that ended meanwhile has nothing to stamp.
export function stampSession(file, fields) {
  try {
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...session, ...fields }), { mode: 0o600 });
  } catch {
    // Gone or being rewritten: skip it this time.
  }
}

// What a hook's input says about the chat it runs in.
export function chatFields(input) {
  return input?.transcript_path ? { transcriptPath: input.transcript_path } : {};
}

export function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(input || "{}")); } catch { resolve({}); } });
  });
}
