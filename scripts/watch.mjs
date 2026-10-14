#!/usr/bin/env node
// Follows the annotate server of the Claude Code session that started it, for the bar above the
// prompt (hooks/pane.tsx): one line per thing worth a look. "up" when connected, "rev N" when what
// the bar shows changed, "down" when the link dropped. It stays up through the server restarting
// (a new token: the session file is read again each time) and ends with the session.
import { findSession } from "./session.mjs";

const BACKOFF_MS = [250, 500, 1000, 2000, 5000];
const say = (line) => process.stdout.write(`${line}\n`);
process.stdout.on("error", () => process.exit(0)); // the bar stopped reading

let tries = 0;
for (;;) {
  if (process.ppid === 1) process.exit(0); // Claude Code is gone
  const session = findSession();
  if (session && (await follow(session))) tries = 0;
  await new Promise((r) => setTimeout(r, BACKOFF_MS[Math.min(tries++, BACKOFF_MS.length - 1)]));
}

// true when the stream opened (and has now ended).
async function follow(session) {
  let res;
  try {
    res = await fetch(`${session.endpoint}/events`, { headers: { "X-Annot-Token": session.token } });
  } catch {
    return false;
  }
  if (!res.ok || !res.body) return false;
  say("up");
  let buf = "";
  try {
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const m = JSON.parse(line.slice(5));
            if (m.type === "rev") say(`rev ${m.rev}`);
          } catch { /* not JSON */ }
        }
      }
    }
  } catch { /* dropped */ }
  say("down");
  return true;
}
