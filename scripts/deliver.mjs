#!/usr/bin/env node
// Async rewake hook, armed at session start, at the end of every turn (Stop), and after
// annotate_open and annotate_done. Each delivery uses one up, so the Stop arming keeps Send working
// when Claude finishes a batch without calling annotate_done. A newer hook replaces an older one (410).
// It waits in the background until the user hits Send, then exits 2 with the batch on stderr.
// Claude Code wakes the session and shows the batch in the chat. Exit 0 (silent) when there
// is nothing to wait for.
import { chatFields, findSession, findSessionFile, readStdin, stampSession } from "./session.mjs";

const SESSION_WAIT_MS = 30000; // at session start the annotate server may not have written its file yet

const input = await readStdin();
let session = findSession();
const waitMs = input.hook_event_name === "SessionStart" ? SESSION_WAIT_MS : 0;
for (const until = Date.now() + waitMs; !session && Date.now() < until; session = findSession()) {
  await new Promise((r) => setTimeout(r, 1000));
}
if (!session) process.exit(0);
const file = findSessionFile();
if (file && input.transcript_path) stampSession(file, chatFields(input)); // so the extension can name this chat before anyone types

const RESTART_WAIT_MS = 30000; // a restarted server (same chat, new port and token) writes its file again

for (;;) {
  let res;
  try {
    res = await fetch(`${session.endpoint}/next`, { headers: { "X-Annot-Token": session.token }, signal: AbortSignal.timeout(300000) });
  } catch {
    // The server is gone: the chat ended, or its server restarted. Wait on the new one if it comes.
    const gone = session.token;
    session = null;
    for (const until = Date.now() + RESTART_WAIT_MS; !session && Date.now() < until;) {
      await new Promise((r) => setTimeout(r, 1000));
      const found = findSession();
      if (found && found.token !== gone) session = found; // a file left by the dead server is not a new one
    }
    if (!session) process.exit(0);
    continue;
  }
  if (res.status === 204) continue; // the long poll expired: ask again
  if (res.status !== 200) process.exit(0); // a newer hook took over (410), or not in chat delivery (409)
  const { content } = await res.json();
  process.stderr.write(content);
  process.exit(2);
}
