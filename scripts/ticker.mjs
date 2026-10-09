#!/usr/bin/env node
// PostToolUse hook: tells the page which file Claude just edited. Best effort,
// silent on every failure, never blocks the tool.
import path from "node:path";
import { findSession, readStdin } from "./session.mjs";

const j = await readStdin();
try {
  const file = j.tool_input?.file_path || j.tool_input?.notebook_path;
  const session = file ? findSession() : null;
  if (session) {
    const cwd = j.cwd || process.cwd();
    const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    const verb = j.tool_name === "Write" ? "wrote" : "edited";
    await fetch(`${session.endpoint}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Annot-Token": session.token },
      body: JSON.stringify({ text: `${verb} ${rel}` }),
      signal: AbortSignal.timeout(800),
    });
  }
} catch { /* silent */ }
