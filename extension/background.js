// Claude Annotate: turns annotation mode on and off per tab.
//
// On: ask the native host for the live Claude Code sessions, pick one (the one the user
// pinned in the popup, else the one they typed in last), and mount the overlay.
//  - A local dev page: in the page's main world with the session's endpoint and token, so it
//    can read React's component and source data. The page is the user's own code.
//  - Any other page: in this extension's isolated world. The page's scripts can't see it, and
//    its requests go through this worker (the "annotate" port), so the token never enters the page.
// Off: unmount it. A tab that is on stays on across reloads and navigations.

const HOST = "com.claude_annotate.host";
const INSTALL_HINT = "Run `npm run extension:install` in the claude-annotate repo, then reload this extension.";
const ICONS = (kind) => Object.fromEntries([16, 32, 48, 128].map((s) => [s, `icons/${kind}-${s}.png`]));

// Mirrors isLocalHost() in overlay.js: where the overlay may hold the token in the page's main world.
function isLocalUrl(url) {
  let h;
  try { h = new URL(url).hostname; } catch { return false; }
  return /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$/.test(h) || /\.(localhost|test|local|internal)$/.test(h);
}

// http and https pages. Chrome refuses scripts on its own pages and the Web Store anyway.
function isWebUrl(url) {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
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
  await chrome.storage.session.set({ sessionsByPid: Object.fromEntries(sessions.map((s) => [s.pid, s])) });
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
  for (const world of ["MAIN", "ISOLATED"]) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world,
      func: async () => { await window.__claudeAnnotate?.unmount?.(); },
    }).catch(() => {}); // the page is gone or not scriptable: nothing to remove
  }
}

// Records the tab's session first: an isolated overlay asks for it over the port as soon as it runs.
async function mountOverlay(tabId, url, session) {
  await unmountOverlay(tabId); // a page may still carry an overlay for another session
  await setTabSession(tabId, session.pid);
  const version = chrome.runtime.getManifest().version;
  const local = isLocalUrl(url);
  const world = local ? "MAIN" : "ISOLATED";
  const cfg = local ? { endpoint: session.endpoint, token: session.token, renderOnly: false, version } : { transport: "port", renderOnly: false, version };
  await chrome.scripting.executeScript({ target: { tabId }, world, func: (c) => { window.__CLAUDE_ANNOTATE__ = c; }, args: [cfg] });
  await chrome.scripting.executeScript({ target: { tabId }, world, files: ["overlay.js"] });
}

async function turnOn(tab) {
  if (!isWebUrl(tab.url)) throw new Error("Chrome doesn't let extensions draw on this page. Open a website or your dev server.");
  const { session } = await targetSession();
  if (!session) throw new Error("No Claude Code session is running with the annotate plugin. Start one, then try again.");
  try {
    await mountOverlay(tab.id, tab.url, session);
  } catch (e) {
    await setTabSession(tab.id, null);
    throw e;
  }
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
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) continue;
    await mountOverlay(id, tab.url, session).catch(() => setTabSession(id, null));
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  if ((await onTabs())[tabId] == null) return;
  if (!isWebUrl(tab.url)) return setTabSession(tabId, null);
  try {
    const { session } = await targetSession();
    if (!session) return setTabSession(tabId, null);
    await mountOverlay(tabId, tab.url, session); // fails on a site the user never granted: off
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
    return { on: tabs[tabId] != null, onPid: tabs[tabId] ?? null, web: isWebUrl(url), local: isLocalUrl(url), sessions, pinned, hostError };
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

// ---------------------------------------------------------------------------
// The "annotate" port: an isolated-world overlay's line to its session's server
// ---------------------------------------------------------------------------
async function sessionForTab(tabId) {
  const pid = (await onTabs())[tabId];
  const { sessionsByPid = {} } = await chrome.storage.session.get("sessionsByPid");
  return pid == null ? null : sessionsByPid[pid] ?? null;
}

// Forwards the server's event stream (text/event-stream) as one message per event.
async function relayEvents(port, session, signal) {
  const res = await fetch(`${session.endpoint}/events?t=${session.token}`, { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  port.postMessage({ open: true });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) port.postMessage({ event: data });
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "annotate" || !port.sender?.tab) return port.disconnect();
  const tabId = port.sender.tab.id;
  const stop = new AbortController();
  port.onDisconnect.addListener(() => stop.abort());

  port.onMessage.addListener(async (m) => {
    const session = await sessionForTab(tabId);
    if (m.subscribe) {
      if (!session) return port.postMessage({ closed: true });
      relayEvents(port, session, stop.signal).catch(() => {}).finally(() => { if (!stop.signal.aborted) port.postMessage({ closed: true }); });
      return;
    }
    if (!m.id) return;
    if (!session) return port.postMessage({ id: m.id, ok: false, error: "annotation mode is off in this tab" });
    try {
      const res = await fetch(session.endpoint + m.path, {
        method: m.method,
        headers: { "Content-Type": "application/json", "X-Annot-Token": session.token },
        body: m.body === undefined ? undefined : JSON.stringify(m.body),
      });
      const data = await res.json().catch(() => ({}));
      port.postMessage({ id: m.id, ok: res.ok, status: res.status, data });
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, error: e.message });
    }
  });
});
