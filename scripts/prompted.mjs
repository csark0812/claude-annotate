#!/usr/bin/env node
// UserPromptSubmit hook: stamps this session's file with the time of the user's latest prompt and
// the chat's transcript. The browser extension uses both to pick and name the chat notes go to.
// A batch of notes the chat hook delivered also arrives as a prompt: that is not the user typing
// there, and must not pull the tabs over to this chat.
import { chatFields, findSessionFile, readStdin, stampSession } from "./session.mjs";

const input = await readStdin();
const file = findSessionFile();
const delivered = typeof input.prompt === "string" && input.prompt.includes("Browser annotations · batch");
if (file) stampSession(file, delivered ? chatFields(input) : { ...chatFields(input), lastPromptAt: Date.now() });
