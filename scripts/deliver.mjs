#!/usr/bin/env node
// Async rewake hook, armed at session start and again after annotate_open and annotate_done.
// It waits in the background until the user hits Send, then exits 2 with the batch on stderr.
// Claude Code wakes the session and shows the batch in the chat. Exit 0 (silent) when there
// is nothing to wait for.
import { findSession, readStdin } from "./session.mjs";

const SESSION_WAIT_MS = 30000; // at session start the annotate server may not have written its file yet

const input = await readStdin();
let session = findSession();
const waitMs = input.hook_event_name === "SessionStart" ? SESSION_WAIT_MS : 0;
for (const until = Date.now() + waitMs; !session && Date.now() < until; session = findSession()) {
  await new Promise((r) => setTimeout(r, 1000));
}
if (!session) process.exit(0);

for (;;) {
  let res;
  try {
    res = await fetch(`${session.endpoint}/next`, { headers: { "X-Annot-Token": session.token }, signal: AbortSignal.timeout(300000) });
  } catch {
    process.exit(0); // the server is gone (session ended)
  }
  if (res.status === 204) continue; // the long poll expired: ask again
  if (res.status !== 200) process.exit(0); // a newer hook took over (410), or not in chat delivery (409)
  const { content } = await res.json();
  process.stderr.write(content);
  process.exit(2);
}
