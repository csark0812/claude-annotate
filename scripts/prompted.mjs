#!/usr/bin/env node
// UserPromptSubmit hook: stamps this session's file with the time of the user's latest prompt.
// The browser extension sends to the session the user last typed in unless they pick another.
import fs from "node:fs";
import { findSessionFile, readStdin } from "./session.mjs";

await readStdin();
const file = findSessionFile();
if (file) {
  try {
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...session, lastPromptAt: Date.now() }));
  } catch {
    // The session ended while this ran: nothing to stamp.
  }
}
