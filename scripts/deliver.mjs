#!/usr/bin/env node
// Async rewake hook, armed after annotate_open and annotate_done. It waits in the background
// until the user hits Send, then exits 2 with the batch on stderr. Claude Code wakes the
// session and shows the batch in the chat. Exit 0 (silent) when there is nothing to wait for.
import { findSession, readStdin } from "./session.mjs";

await readStdin();
const session = findSession();
if (!session) process.exit(0);

for (;;) {
  let res;
  try {
    res = await fetch(`${session.endpoint}/next`, { headers: { "X-Annot-Token": session.token }, signal: AbortSignal.timeout(300000) });
  } catch {
    process.exit(0); // the server is gone (session ended or browser closed)
  }
  if (res.status === 204) continue; // long poll expired, or a newer hook took over
  if (res.status !== 200) process.exit(0); // not in chat delivery
  const { content } = await res.json();
  process.stderr.write(content);
  process.exit(2);
}
