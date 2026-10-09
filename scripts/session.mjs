// Finds the annotate server that belongs to the Claude Code session running this hook.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const SESSIONS = path.join(os.homedir(), ".cache", "claude-annotate", "sessions");
const parentOf = (pid) => { try { return Number(execSync(`ps -o ppid= -p ${pid}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()); } catch { return 0; } };

// Walk up the process tree (hook → shell → claude) until a session file matches.
// No match means no annotate session for this tree: return null, never guess another session's page.
export function findSession() {
  for (let pid = process.ppid, i = 0; pid > 1 && i < 4; pid = parentOf(pid), i++) {
    const f = path.join(SESSIONS, `${pid}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  return null;
}

export function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(input || "{}")); } catch { resolve({}); } });
  });
}
