#!/usr/bin/env node
// One-shot probe: does an async rewake hook reach the chat in this Claude Code surface?
// Runs only when the flag file exists, and removes it so it fires in one session only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FLAG = path.join(os.homedir(), ".cache", "claude-annotate", "rewake-test");
if (!fs.existsSync(FLAG)) process.exit(0);
fs.rmSync(FLAG, { force: true });
await new Promise((r) => setTimeout(r, 20000));
process.stderr.write("annotate test: a background hook reached this chat. Reply with exactly: REWAKE OK");
process.exit(2);
