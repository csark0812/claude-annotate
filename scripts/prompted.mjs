#!/usr/bin/env node
// UserPromptSubmit hook: stamps this session's file with the time of the user's latest prompt and
// the chat's transcript. The browser extension uses both to pick and name the chat notes go to.
import { chatFields, findSessionFile, readStdin, stampSession } from "./session.mjs";

const input = await readStdin();
const file = findSessionFile();
if (file) stampSession(file, { ...chatFields(input), lastPromptAt: Date.now() });
