// Claude Annotate: turns annotation mode on and off per tab.
//
// On: ask the native host for the live Claude Code sessions, pick one (the one the user
// picked in the icon's right-click menu, else the one they typed in last), and mount the overlay.
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
// freezeHover: hold what the pointer rests on hovered (turned on from the keyboard).
async function mountOverlay(tabId, url, session, { freezeHover = false } = {}) {
  await unmountOverlay(tabId); // a page may still carry an overlay for another session
  await setTabSession(tabId, session.pid);
  const version = chrome.runtime.getManifest().version;
  const local = isLocalUrl(url);
  const world = local ? "MAIN" : "ISOLATED";
  const common = { renderOnly: false, version, startMode: "draw", freezeHover };
  const cfg = local ? { endpoint: session.endpoint, token: session.token, ...common } : { transport: "port", ...common };
  await chrome.scripting.executeScript({ target: { tabId }, world, func: (c) => { window.__CLAUDE_ANNOTATE__ = c; }, args: [cfg] });
  await chrome.scripting.executeScript({ target: { tabId }, world, files: ["overlay.js"] });
  await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: relayExit });
  await addFrameHelpers(tabId);
}

// The element picker asks each frame what is under the pointer. overlay.js run inside a frame is
// only that helper. Frames from sites the extension can't reach are skipped (they are picked whole);
// "Allow inside embedded frames" in the icon's menu grants them.
async function addFrameHelpers(tabId, frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, world: "ISOLATED", files: ["overlay.js"] }).catch(() => {});
}

// A frame that loads (or reloads) while the tab is annotating gets its helper too.
chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId }) => {
  if (frameId === 0 || (await onTabs())[tabId] == null) return;
  await addFrameHelpers(tabId, [frameId]);
});

// Runs in the page's isolated world: Esc in the overlay (either world) fires a DOM event, and this
// asks the worker to turn the tab off, as a click on the icon would.
function relayExit() {
  if (window.__claudeAnnotateExitRelay) return;
  window.__claudeAnnotateExitRelay = true;
  document.addEventListener("claude-annotate:exit", () => {
    try { chrome.runtime.sendMessage({ type: "exit" }); } catch { /* the extension was reloaded */ }
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "exit" && sender.tab) turnOff(sender.tab).then(refreshMenu);
});

async function turnOn(tab, opts) {
  if (!isWebUrl(tab.url)) throw new Error("Chrome doesn't let extensions draw on this page. Open a website or your dev server.");
  const { session } = await targetSession();
  if (!session) throw new Error("No Claude Code session is running with the annotate plugin. Start one, then try again.");
  try {
    await mountOverlay(tab.id, tab.url, session, opts);
  } catch (e) {
    await setTabSession(tab.id, null);
    throw e;
  }
}

async function turnOff(tab) {
  await unmountOverlay(tab.id);
  await setTabSession(tab.id, null);
}

async function toggle(tab, opts) {
  if ((await onTabs())[tab.id] != null) await turnOff(tab);
  else await turnOn(tab, opts);
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

// Toggles and says what went wrong on the icon itself: a "!" badge, the reason in its tooltip.
async function toggleFromUser(tab, opts) {
  try {
    await toggle(tab, opts);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Claude Annotate" });
  } catch (e) {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#FF4D8D" }).catch(() => {});
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
    await chrome.action.setTitle({ tabId: tab.id, title: `Claude Annotate: ${e.message}` }).catch(() => {});
  }
  refreshMenu();
}

// Asks for the site so the toolbar comes back after a reload there. Called before any await, while
// the click still counts as a user gesture. Declined or unavailable, it works until the page reloads.
function askForSite(tab) {
  if (!isWebUrl(tab.url) || isLocalUrl(tab.url)) return;
  chrome.permissions.request({ origins: [`${new URL(tab.url).origin}/*`] }).catch(() => {});
}

// The toolbar icon is the switch.
chrome.action.onClicked.addListener((tab) => {
  askForSite(tab);
  toggleFromUser(tab, { freezeHover: false });
});

// The keyboard switch also holds the hover state: the pointer is still where the user left it.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-annotate" || !tab) return;
  askForSite(tab);
  toggleFromUser(tab, { freezeHover: true });
});

// ---------------------------------------------------------------------------
// Right-click on the icon: which session the notes go to
// ---------------------------------------------------------------------------
const MENU_PARENT = "send-to";
let menuBuiltAt = 0;

async function refreshMenu() {
  menuBuiltAt = Date.now();
  let sessions = [], pinned = null;
  try { ({ sessions, pinned } = await targetSession()); } catch { /* host missing: the menu says so */ }
  await chrome.contextMenus.removeAll();
  const allSites = await chrome.permissions.contains({ origins: ALL_SITES });
  if (!allSites) chrome.contextMenus.create({ id: "allow-frames", title: "Allow inside embedded frames on all sites", contexts: ["action"] });
  chrome.contextMenus.create({ id: MENU_PARENT, title: "Send notes to", contexts: ["action"] });
  if (!sessions.length) {
    chrome.contextMenus.create({ id: "none", parentId: MENU_PARENT, title: "No Claude Code session running", enabled: false, contexts: ["action"] });
    return;
  }
  const isPinned = sessions.some((s) => s.pid === pinned);
  chrome.contextMenus.create({ id: "pid:auto", parentId: MENU_PARENT, type: "radio", checked: !isPinned, title: `The session I typed in last (${folder(sessions[0].cwd)})`, contexts: ["action"] });
  for (const s of sessions) {
    chrome.contextMenus.create({ id: `pid:${s.pid}`, parentId: MENU_PARENT, type: "radio", checked: s.pid === pinned, title: describeSession(s), contexts: ["action"] });
  }
}

function folder(cwd) {
  return cwd ? cwd.split("/").filter(Boolean).pop() : "unknown folder";
}
function describeSession(s) {
  const at = s.lastPromptAt ?? s.startedAt;
  const min = Math.max(0, Math.round((Date.now() - at) / 60000));
  const ago = min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
  return `${folder(s.cwd)} · ${s.lastPromptAt ? "typed" : "started"} ${ago}`;
}

const ALL_SITES = ["http://*/*", "https://*/*"];

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "allow-frames") {
    // Embedded frames often come from another site (a document viewer, a payment form). Without
    // access there, the element picker can only pick the whole frame.
    const granted = await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false);
    if (granted) { await remountAll(); refreshMenu(); }
    return;
  }
  if (!String(info.menuItemId).startsWith("pid:")) return;
  const pid = info.menuItemId === "pid:auto" ? null : Number(String(info.menuItemId).slice(4));
  await chrome.storage.local.set({ pinnedPid: pid });
  await remountAll();
  refreshMenu();
});

chrome.runtime.onInstalled.addListener(refreshMenu);
chrome.runtime.onStartup.addListener(refreshMenu);
// Sessions come and go: rebuild at most every 30 s as the user moves between tabs.
chrome.tabs.onActivated.addListener(() => { if (Date.now() - menuBuiltAt > 30000) refreshMenu(); });

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
