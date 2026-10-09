// Claude Annotate: turns annotation mode on and off per tab.
//
// On: ask the native host for the live Claude Code sessions, pick one (the one the user
// pinned in the popup, else the one they typed in last), and mount the overlay in the page's
// main world with that session's endpoint and token. The overlay then talks to that
// session's annotate server directly, exactly as when annotate_open puts it on a page.
// Off: unmount it. A tab that is on stays on across reloads and navigations within local hosts.

const HOST = "com.claude_annotate.host";
const INSTALL_HINT = "Run `npm run extension:install` in the claude-annotate repo, then reload this extension.";
const ICONS = (kind) => Object.fromEntries([16, 32, 48, 128].map((s) => [s, `icons/${kind}-${s}.png`]));

// Mirrors isLocalHost() in overlay.js: the overlay refuses to mount anywhere else.
function isLocalUrl(url) {
  let h;
  try { h = new URL(url).hostname; } catch { return false; }
  return /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$/.test(h) || /\.(localhost|test|local|internal)$/.test(h);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function listSessions() {
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, { type: "sessions" });
    if (!reply?.ok) throw new Error(reply?.error || "no reply");
    return reply.sessions;
  } catch (e) {
    throw new Error(`Can't reach the annotate host (${e.message}). ${INSTALL_HINT}`);
  }
}

async function getPinnedPid() {
  return (await chrome.storage.local.get("pinnedPid")).pinnedPid ?? null;
}

async function targetSession() {
  const sessions = await listSessions();
  const pinned = await getPinnedPid();
  const session = sessions.find((s) => s.pid === pinned) ?? sessions[0] ?? null;
  return { session, sessions, pinned };
}

// ---------------------------------------------------------------------------
// Tabs that are on: tabId → session pid. Session storage survives the worker sleeping.
// ---------------------------------------------------------------------------
async function onTabs() {
  return (await chrome.storage.session.get("tabs")).tabs ?? {};
}
async function setTabSession(tabId, pid) {
  const tabs = await onTabs();
  if (pid == null) delete tabs[tabId];
  else tabs[tabId] = pid;
  await chrome.storage.session.set({ tabs });
  await chrome.action.setIcon({ tabId, path: ICONS(pid == null ? "off" : "on") }).catch(() => {});
}

// ---------------------------------------------------------------------------
// The overlay in the page
// ---------------------------------------------------------------------------
async function unmountOverlay(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => { await window.__claudeAnnotate?.unmount?.(); },
  }).catch(() => {}); // the page is gone or not scriptable: nothing to remove
}

async function mountOverlay(tabId, session) {
  await unmountOverlay(tabId); // a page may still carry an overlay for another session
  const cfg = { endpoint: session.endpoint, token: session.token, renderOnly: false, version: chrome.runtime.getManifest().version };
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: (c) => { window.__CLAUDE_ANNOTATE__ = c; }, args: [cfg] });
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["overlay.js"] });
}

async function turnOn(tab) {
  if (!isLocalUrl(tab.url)) throw new Error("Annotation works on local dev pages only (localhost, 127.0.0.1, *.localhost, *.test, private IPs).");
  const { session } = await targetSession();
  if (!session) throw new Error("No Claude Code session is running with the annotate plugin. Start one, then try again.");
  await mountOverlay(tab.id, session);
  await setTabSession(tab.id, session.pid);
}

async function turnOff(tab) {
  await unmountOverlay(tab.id);
  await setTabSession(tab.id, null);
}

async function toggle(tab) {
  if ((await onTabs())[tab.id] != null) await turnOff(tab);
  else await turnOn(tab);
}

// Re-points every tab that is on at the session now chosen.
async function remountAll() {
  const tabs = await onTabs();
  const { session } = await targetSession();
  for (const id of Object.keys(tabs).map(Number)) {
    if (!session) { await turnOff({ id }); continue; }
    await mountOverlay(id, session).catch(() => {});
    await setTabSession(id, session.pid);
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  if ((await onTabs())[tabId] == null) return;
  if (!isLocalUrl(tab.url)) return setTabSession(tabId, null); // navigated off local hosts: off
  try {
    const { session } = await targetSession();
    if (!session) return setTabSession(tabId, null);
    await mountOverlay(tabId, session);
    await setTabSession(tabId, session.pid);
  } catch {
    await setTabSession(tabId, null);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await onTabs();
  if (tabs[tabId] == null) return;
  delete tabs[tabId];
  await chrome.storage.session.set({ tabs });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-annotate" || !tab) return;
  try {
    await toggle(tab);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch (e) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({ tabId: tab.id, title: `Claude Annotate: ${e.message}` });
  }
});

// The popup's requests. Each answers { ok, ... } or { ok: false, error }.
const handlers = {
  async status({ tabId, url }) {
    const tabs = await onTabs();
    let sessions = [], pinned = null, hostError = null;
    try { ({ sessions, pinned } = await targetSession()); } catch (e) { hostError = e.message; }
    return { on: tabs[tabId] != null, onPid: tabs[tabId] ?? null, local: isLocalUrl(url), sessions, pinned, hostError };
  },
  async toggle({ tab }) {
    await toggle(tab);
    return handlers.status({ tabId: tab.id, url: tab.url });
  },
  async pin({ pid, tab }) {
    await chrome.storage.local.set({ pinnedPid: pid ?? null });
    await remountAll();
    return handlers.status({ tabId: tab.id, url: tab.url });
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: e.message }));
  return true; // answered asynchronously
});
