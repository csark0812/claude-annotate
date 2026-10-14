import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extDir = path.join(root, "extension");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.copyFileSync(path.join(root, "server", "overlay.js"), path.join(extDir, "overlay.js"));
const { key } = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
const hex = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
export const EXT_ID = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

export async function startServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-qa-"));
  const sessionsDir = path.join(home, ".cache", "claude-annotate", "sessions");
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "server", "index.mjs")], env: { ...process.env, HOME: home }, stderr: "pipe" });
  const client = new Client({ name: "qa", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  let found = null;
  for (let i = 0; i < 50 && !found; i++) {
    const f = fs.existsSync(sessionsDir) && fs.readdirSync(sessionsDir).find((x) => x.endsWith(".json"));
    if (f) found = { pid: Number(f.replace(".json", "")), ...JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8")) };
    else await sleep(100);
  }
  const session = { ...found, title: "QA", lastPromptAt: Date.now(), lastPrompt: null, servesPage: true, focusedAt: null };
  const H = { "Content-Type": "application/json", "X-Annot-Token": session.token };
  const api = {
    client, session, H, home,
    state: async (url) => (await fetch(`${session.endpoint}/state?url=${encodeURIComponent(url)}`, { headers: H })).json(),
    overview: async () => (await fetch(`${session.endpoint}/overview`, { headers: H })).json(),
    clear: () => fetch(`${session.endpoint}/clear`, { method: "POST", headers: H, body: "{}" }),
    next: async (ms = 6000) => { try { const r = await fetch(`${session.endpoint}/next`, { headers: H, signal: AbortSignal.timeout(ms) }); return r.status === 200 ? (await r.json()).content : `HTTP ${r.status}`; } catch (e) { return null; } },
    tool: async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text || `[${c.type}]`).join("\n"),
    close: async () => { await client.close(); fs.rmSync(home, { recursive: true, force: true }); },
  };
  return api;
}

export async function launch(session, { extraArgs = [], headless = process.env.HEADED !== "1" } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-qa-profile-"));
  const args = [...extraArgs, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--allowlisted-extension-id=${EXT_ID}`, "--auto-accept-this-tab-capture", "--window-size=1280,860"];
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless, viewport: null, args });
  let sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`));
  if (!sw) sw = await context.waitForEvent("serviceworker", (w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`));
  await sw.evaluate((s) => { chrome.runtime.sendNativeMessage = async () => ({ ok: true, sessions: [s] }); }, session);
  const page = context.pages()[0] || (await context.newPage());
  const b = {
    context, sw, page,
    tabId: (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u))?.id, url),
    click: (tabId) => sw.evaluate((id) => self.claudeAnnotate.click(id), tabId),
    shortcut: (c, tabId) => sw.evaluate(([c, id]) => self.claudeAnnotate.shortcut(c, id), [c, tabId]),
    mode: (p = page) => p.evaluate(() => { const h = document.querySelector("claude-annotate"); return !h ? "none" : h.classList.contains("rec") ? "record" : h.classList.contains("draw") ? "draw" : "browse"; }),
    async on(p = page) {
      const id = await b.tabId(p.url());
      await b.click(id);
      await until("overlay", async () => (await b.mode(p)) === "draw");
      return id;
    },
    async noteAt(p, x, y, text) {
      await p.mouse.click(x, y);
      const c = p.locator("claude-annotate .pop textarea");
      await c.waitFor({ timeout: 4000 });
      await c.pressSequentially(text);
      await c.press("Enter");
    },
    async noteOn(p, selector, text) {
      const box = await p.locator(selector).first().boundingBox();
      await b.noteAt(p, box.x + box.width / 2, box.y + box.height / 2, text);
    },
    close: async () => { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); },
  };
  return b;
}
export async function until(what, fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
export const notesOf = (content) => (content || "").split("\n").filter((l) => /^(### Note|on:|in:|component:|source:|## Page|frame)/.test(l)).join("\n");
