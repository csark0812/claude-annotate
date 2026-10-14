// Claude Annotate: turns annotation mode on and off per tab.
//
// On: ask the native host for the live Claude Code sessions, pick one (the chat chosen for this tab
// in the toolbar's chat pill, else the one picked in the icon's right-click menu, else the one
// working in the folder of the dev server behind the page, else the one typed in last), and mount
// the overlay.
//  - A local dev page: in the page's main world with the session's endpoint and token, so it
//    can read React's component and source data. The page is the user's own code.
//  - Any other page: in this extension's isolated world. The page's scripts can't see it, and
//    its requests go through this worker (the "annotate" port), so the token never enters the page.
// Off: unmount it. A tab that is on stays on across reloads and navigations.
// Recording: one tab at a time is recorded with tabCapture into an offscreen document while the user
// uses the page; the overlay shows that it is recording and gets the video as a note when it stops.

import { relayPage } from "./relay.js";

const HOST = "com.claude_annotate.host";
const INSTALL_HINT = "Run `npm run extension:install` in the claude-annotate repo, then reload this extension.";
const ICONS = (kind) => Object.fromEntries([16, 32, 48, 128].map((s) => [s, `icons/${kind}-${s}.png`]));

// Mirrors isLocalHost() in overlay.js: where the overlay may hold the token in the page's main world.
function isLocalUrl(url) {
  let h;
  try { h = new URL(url).hostname; } catch { return false; }
  // This machine only: a LAN device or an intranet site (192.168.x, *.local, *.internal) is
  // somebody else's code, and is annotated from the isolated world like any other site.
  return /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/.test(h) || /\.(localhost|test)$/.test(h);
}

// Pages the overlay can be put into: http, https and file pages, every site. Chrome keeps
// extensions out of its own pages (chrome://, the new tab page, the Web Store, other extensions);
// those are annotated as a picture instead (snapshot.html).
function isWebUrl(url) {
  try { return /^(https?|file):$/.test(new URL(url).protocol) && !isWebStore(url); } catch { return false; }
}
function isWebStore(url) {
  try { const u = new URL(url); return u.hostname === "chromewebstore.google.com" || (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")); } catch { return false; }
}
// Chrome's refusal to run a script in a page, as executeScript words it.
const isScriptRefusal = (e) => /cannot (access|be scripted)|chrome:\/\/|extensions gallery|file URL/i.test(String(e?.message));

// ---------------------------------------------------------------------------
// Pictures of pages the overlay can't enter: snapshot.html#<id> shows one and annotates it. The
// notes are filed under the page's own URL.
// ---------------------------------------------------------------------------
const SNAPSHOT_PAGE = chrome.runtime.getURL("snapshot.html");
const isSnapshotTab = (tab) => String(tab?.url ?? "").startsWith(SNAPSHOT_PAGE);
async function snapshots() {
  return (await chrome.storage.session.get("snapshots")).snapshots ?? {};
}
// The page a tab is about: the pictured page's URL for a snapshot tab.
async function pageUrlOf(tab) {
  if (!isSnapshotTab(tab)) return tab.url;
  return (await snapshots())[new URL(tab.url).hash.slice(1)]?.url ?? tab.url;
}
async function openSnapshot(tab) {
  if (tab.url?.startsWith("file:") && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    throw new Error('Turn on "Allow access to file URLs" for Claude Annotate in chrome://extensions to annotate files.');
  }
  let image;
  try {
    image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 90 });
  } catch (e) {
    throw new Error(`Chrome doesn't let extensions into this page, and it couldn't be captured either (${e.message}).`);
  }
  const id = crypto.randomUUID();
  const all = await snapshots();
  all[id] = { url: tab.url, title: tab.title || tab.url, image, w: tab.width, h: tab.height, at: Date.now() };
  // Keep the newest few: storage.session holds 10 MB.
  for (const old of Object.keys(all).sort((a, b) => all[a].at - all[b].at).slice(0, -4)) delete all[old];
  await chrome.storage.session.set({ snapshots: all });
  await chrome.tabs.create({ url: `${SNAPSHOT_PAGE}#${id}`, index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
// With a page url, the host puts the sessions working on that page's project first.
async function listSessions(url) {
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, { type: "sessions", url });
    if (!reply?.ok) throw new Error(reply?.error || "no reply");
    return reply.sessions;
  } catch (e) {
    throw new Error(`Can't reach the annotate host (${e.message}). ${INSTALL_HINT}`);
  }
}

async function getPinnedPid() {
  return (await chrome.storage.local.get("pinnedPid")).pinnedPid ?? null;
}

async function targetSession(url, tabId) {
  const sessions = await listSessions(url);
  const { sessionsByPid = {}, chosen = {} } = await chrome.storage.session.get(["sessionsByPid", "chosen"]);
  for (const s of sessions) sessionsByPid[s.pid] = s;
  await chrome.storage.session.set({ sessionsByPid });
  const pinned = await getPinnedPid();
  const pick = (pid) => pid != null && sessions.find((s) => s.pid === pid);
  // Automatic: the page's project, else the chat typed in last. A chat picked in the bar or the
  // icon's menu holds instead.
  const picked = pick(chosen[tabId]) || pick(pinned);
  const session = picked || sessions[0] || null;
  return { session, sessions, pinned, automatic: !picked };
}

// The chat a tab's notes go to, chosen in the overlay's chat pill. It holds across reloads until
// the tab closes or that chat ends.
async function chooseForTab(tabId, pid) {
  const { chosen = {} } = await chrome.storage.session.get("chosen");
  if (pid == null) delete chosen[tabId];
  else chosen[tabId] = pid;
  await chrome.storage.session.set({ chosen });
}

// What the overlay may know about a chat: never its endpoint or token.
function chatInfo(s) {
  return { pid: s.pid, title: s.title, lastPrompt: s.lastPrompt ?? null, folder: folder(s.cwd), servesPage: !!s.servesPage, at: s.lastPromptAt ?? s.startedAt, typed: s.lastPromptAt != null };
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
// carry: unsent marks and comments brought over from the chat the tab sent to before.
// A tab being recorded gets the overlay in recording mode; one whose recording was saved while its
// page was loading gets the video to make a note of.
async function mountOverlay(tabId, url, session, { carry = null, automatic = true } = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (isSnapshotTab(tab)) {
    // Our own page: it can't be scripted, so it asks for its config as it loads.
    await setTabSession(tabId, session.pid);
    const { snapshotMounts = {} } = await chrome.storage.session.get("snapshotMounts");
    snapshotMounts[tabId] = { carry, automatic };
    await chrome.storage.session.set({ snapshotMounts });
    await chrome.tabs.reload(tabId);
    return;
  }
  await unmountOverlay(tabId); // a page may still carry an overlay for another session
  await setTabSession(tabId, session.pid);
  const local = isLocalUrl(url);
  const world = local ? "MAIN" : "ISOLATED";
  const cfg = await overlayConfig(tabId, url, session, { carry, automatic });
  await chrome.scripting.executeScript({ target: { tabId }, world, func: (c) => { window.__CLAUDE_ANNOTATE__ = c; }, args: [cfg] });
  await chrome.scripting.executeScript({ target: { tabId }, world, files: ["overlay.js"] });
  // The DOM relay serves an overlay in the page's own world, which has no extension API. An
  // isolated overlay asks the worker directly: no page script can drive the extension or read
  // its answers (the chat list, a screenshot of the tab).
  if (local) await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: relayPage });
  await addFrameHelpers(tabId);
}

// What the overlay is told. Only a local dev page (the user's own code) holds the endpoint and token;
// any other page talks to its session through this worker's "annotate" port.
async function overlayConfig(tabId, url, session, { carry = null, automatic = true, pageUrl = null } = {}) {
  const version = chrome.runtime.getManifest().version;
  const rec = await getRecording();
  const recording = rec?.tabId === tabId ? { startedAt: rec.startedAt, phase: rec.phase } : null;
  const recordingSaved = recording ? null : (await savedVideos())[tabId] ?? null;
  if (recording) await showRecording(tabId, true); // a page load clears the tab's badge
  const common = { renderOnly: false, version, startMode: "draw", sendsTo: session.title || folder(session.cwd), sendsFolder: folder(session.cwd), sendsPrompt: session.lastPrompt ?? null, automatic, chat: session.pid, carry, recording, recordingSaved, pageUrl };
  return isLocalUrl(url) && !pageUrl ? { endpoint: session.endpoint, token: session.token, ...common } : { transport: "port", ...common };
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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target === "offscreen") return; // the recorder's
  if (msg?.type === "rec-start" && sender.tab) {
    startRecording(sender.tab).then((r) => reply({ ok: true, startedAt: r.startedAt }), (e) => reply({ ok: false, error: e.message, code: e.code ?? "failed" }));
    return true;
  }
  if (msg?.type === "rec-stop" && sender.tab) recordingOf(sender.tab.id).then((r) => r && stopRecording({ cancel: !!msg.cancel }));
  if (msg?.type === "rec-event" && sender.tab && sender.frameId === 0) logRecording(sender.tab.id, msg.event);
  if (msg?.type === "rec-taken" && sender.tab) forgetSavedVideo(sender.tab.id);
  if (msg?.type === "rec-autostop") autostopRecording(msg.reason);
  if (msg?.type === "exit" && sender.tab) turnOff(sender.tab).then(refreshMenu);
  // A snapshot tab, loaded: the picture and the overlay's config, or null when either is gone.
  if (msg?.type === "snapshot-ready" && isSnapshotTab(sender.tab)) {
    const tab = sender.tab;
    (async () => {
      const snap = (await snapshots())[msg.id];
      if (!snap) return null;
      const { snapshotMounts = {} } = await chrome.storage.session.get("snapshotMounts");
      const opts = snapshotMounts[tab.id] ?? {};
      delete snapshotMounts[tab.id];
      await chrome.storage.session.set({ snapshotMounts });
      const { session, automatic } = await targetSession(snap.url, tab.id);
      if (!session) return { snap, cfg: null };
      await setTabSession(tab.id, session.pid);
      return { snap, cfg: await overlayConfig(tab.id, snap.url, session, { automatic, ...opts, pageUrl: snap.url }) };
    })().then(reply, () => reply(null));
    return true;
  }
  if (msg?.type === "shoot" && sender.tab) {
    // JPEG keeps a retina screenshot well under the server's upload limit.
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 85 })
      .then((image) => reply({ image }), (e) => reply({ image: "", error: e.message }));
    return true; // answered asynchronously
  }
  if (msg?.type === "chats" && sender.tab) {
    const tab = sender.tab;
    pageUrlOf(tab).then((url) => Promise.all([targetSession(url, tab.id), onTabs()]))
      .then(([{ sessions }, tabs]) => reply({ current: tabs[tab.id] ?? null, chats: sessions.map(chatInfo) }), () => reply(null));
    return true;
  }
  // Following the active chat: which chat this tab should send to now, when that changed.
  if (msg?.type === "recheck" && sender.tab) {
    const tab = sender.tab;
    pageUrlOf(tab).then((url) => Promise.all([targetSession(url, tab.id), onTabs()]))
      .then(([{ session, automatic }, tabs]) => reply({ pid: automatic && session && session.pid !== tabs[tab.id] ? session.pid : null }), () => reply({ pid: null }));
    return true;
  }
  // The overlay lost its server: ask the host again. The same chat may be back with a new token (its
  // server restarted), or gone, and then the tab follows the open chat.
  if (msg?.type === "relink" && sender.tab) {
    const tab = sender.tab;
    pageUrlOf(tab).then((url) => targetSession(url, tab.id))
      .then(({ session }) => reply(!session ? null : isLocalUrl(tab.url) ? { pid: session.pid, endpoint: session.endpoint, token: session.token } : { pid: session.pid }), () => reply(null));
    return true;
  }
  // Back to following the open chat.
  if (msg?.type === "choose" && sender.tab && msg.follow) {
    const tab = sender.tab;
    (async () => {
      await chooseForTab(tab.id, null);
      const { session, automatic } = await targetSession(await pageUrlOf(tab), tab.id);
      if (session) await mountOverlay(tab.id, tab.url, session, { carry: msg.carry, automatic });
    })().catch(() => {});
  }
  // A chat picked in the bar (auto: the active chat changed, the tab keeps following).
  if (msg?.type === "choose" && sender.tab && Number.isInteger(msg.pid)) {
    const tab = sender.tab;
    (async () => {
      if (!msg.auto) await chooseForTab(tab.id, msg.pid);
      const { sessions, automatic } = await targetSession(await pageUrlOf(tab), tab.id);
      const session = sessions.find((s) => s.pid === msg.pid);
      if (session) await mountOverlay(tab.id, tab.url, session, { carry: msg.carry, automatic: msg.auto ? true : automatic });
    })().catch(() => {});
  }
});

// Every page can be annotated: in the page itself where Chrome lets the extension in, else as a
// picture of it, opened in the next tab.
async function turnOn(tab, opts) {
  const { session, automatic } = await targetSession(await pageUrlOf(tab), tab.id);
  if (!session) throw new Error("No Claude Code session is running with the annotate plugin. Start one, then try again.");
  if (!isWebUrl(tab.url) && !isSnapshotTab(tab)) return openSnapshot(tab);
  try {
    await mountOverlay(tab.id, tab.url, session, { ...opts, automatic });
  } catch (e) {
    await setTabSession(tab.id, null);
    if (isScriptRefusal(e)) return openSnapshot(tab);
    throw e;
  }
}

// A snapshot tab exists to be annotated: turning it off closes it, back to the page it pictures.
async function turnOff(tab) {
  await setTabSession(tab.id, null);
  if (isSnapshotTab(tab)) {
    if (tab.openerTabId != null) await chrome.tabs.update(tab.openerTabId, { active: true }).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  await unmountOverlay(tab.id);
}

async function toggle(tab, opts) {
  if ((await onTabs())[tab.id] != null) await turnOff(tab);
  else await turnOn(tab, opts);
}

// Re-points every tab that is on at the session now chosen.
async function remountAll() {
  const tabs = await onTabs();
  for (const id of Object.keys(tabs).map(Number)) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) continue;
    const { session, automatic } = await targetSession(await pageUrlOf(tab), id).catch(() => ({ session: null }));
    if (!session) { await turnOff(tab); continue; }
    await mountOverlay(id, tab.url, session, { automatic }).catch(() => setTabSession(id, null));
  }
}

// ---------------------------------------------------------------------------
// Recording a tab
// ---------------------------------------------------------------------------
// This worker owns the recording: { tabId, startedAt, phase: "recording" | "saving", events } in
// session storage, so it outlives the worker sleeping and the tab loading other pages (the overlay
// that comes back reads it). The offscreen document holds the stream and the MediaRecorder. Stop
// comes from the overlay's pill, the icon, ⌥⇧R, the time limit or the tab closing; the video goes
// to the session the tab sends to at that moment, and back to the tab as a note to describe. A video
// saved while the tab had no overlay to take it waits in `savedVideos` until the next one does.
const REC_MAX_MS = 180000; // in step with the overlay's limit
const REC_EVENTS_MAX = 300;
const OFFSCREEN_URL = "offscreen.html";

async function getRecording() {
  return (await chrome.storage.session.get("recording")).recording ?? null;
}
async function setRecording(r) {
  if (r) await chrome.storage.session.set({ recording: r });
  else await chrome.storage.session.remove("recording");
}
async function recordingOf(tabId) {
  const r = await getRecording();
  return r?.tabId === tabId ? r : null;
}
async function savedVideos() {
  return (await chrome.storage.session.get("savedVideos")).savedVideos ?? {};
}
async function forgetSavedVideo(tabId) {
  const saved = await savedVideos();
  if (!(tabId in saved)) return;
  delete saved[tabId];
  await chrome.storage.session.set({ savedVideos: saved });
}

class RecordingError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

let offscreenReady = null;
function ensureOffscreen() {
  offscreenReady ??= (async () => {
    const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (!open.length) await chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: ["USER_MEDIA"], justification: "Records the tab the user asked to record." });
  })().finally(() => { offscreenReady = null; });
  return offscreenReady;
}
async function closeOffscreen() {
  await chrome.offscreen.closeDocument().catch(() => {}); // none open
}

// The overlay in the tab hears how its recording goes (no overlay mid-load: it reads the state when it mounts).
function tellTab(tabId, state) {
  chrome.tabs.sendMessage(tabId, { type: "rec-state", ...state }, { frameId: 0 }).catch(() => {});
}
// The icon says so too: a red REC badge, and the tooltip says how to stop.
async function showRecording(tabId, on) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#E5484D" }).catch(() => {});
  await chrome.action.setBadgeTextColor?.({ tabId, color: "#FFFFFF" }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: on ? "REC" : "" }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: on ? "Claude Annotate: recording this tab. Click to stop (⌥⇧R)." : "Claude Annotate" }).catch(() => {});
}

async function startRecording(tab) {
  const now = await getRecording();
  if (now) throw new RecordingError(now.tabId === tab.id ? "this tab is already being recorded" : "another tab is being recorded. Stop that one first.", "busy");
  if (!isWebUrl(tab.url)) throw new RecordingError("Chrome doesn't let extensions record this page.", "failed");
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    // Chrome allows it only after the icon or a shortcut was used on this site in this tab.
    const notInvoked = /invoked|activeTab/i.test(e.message);
    throw new RecordingError(notInvoked ? "press ⌥⇧R (or click the icon) on this tab first" : e.message, notInvoked ? "not-invoked" : "failed");
  }
  await ensureOffscreen();
  const size = await viewportOf(tab); // the video keeps the page's shape: no black bars
  const started = await chrome.runtime.sendMessage({ target: "offscreen", type: "start", streamId, size, maxMs: REC_MAX_MS }).catch((e) => ({ ok: false, error: e.message }));
  if (!started?.ok) {
    await closeOffscreen();
    throw new RecordingError(`the recorder didn't start: ${started?.error ?? "no answer"}`, "failed");
  }
  const rec = { tabId: tab.id, pid: (await onTabs())[tab.id] ?? null, startedAt: started.startedAt, phase: "recording", events: [] };
  await setRecording(rec);
  await showRecording(tab.id, true);
  tellTab(tab.id, { state: "recording", startedAt: rec.startedAt });
  return rec;
}

// What the tab shows of the page, in CSS pixels; the tab's own size counts its window, not the page.
async function viewportOf(tab) {
  const [hit] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ w: innerWidth, h: innerHeight }) }).catch(() => []);
  return hit?.result?.w > 0 ? hit.result : { w: tab.width || 1280, h: tab.height || 800 };
}

// One stop at a time: the pill, the icon and the time limit can all ask at once.
let stopping = null;
function stopRecording(opts) {
  stopping ??= finishRecording(opts).finally(() => { stopping = null; });
  return stopping;
}
async function finishRecording({ cancel = false } = {}) {
  const rec = await getRecording();
  if (!rec || rec.phase !== "recording") return;
  await setRecording({ ...rec, phase: "saving" });
  tellTab(rec.tabId, { state: "saving" });
  // The chat the tab sends to now; else the one it sent to when recording began (a page load to a
  // site the extension can't draw on turns annotating off, not the recording).
  const { sessionsByPid = {} } = await chrome.storage.session.get("sessionsByPid");
  const session = cancel ? null : (await sessionForTab(rec.tabId)) ?? sessionsByPid[rec.pid] ?? null;
  const result = await chrome.runtime.sendMessage({
    target: "offscreen", type: "stop", cancel: !session, events: rec.events,
    upload: session ? { endpoint: session.endpoint, token: session.token } : null,
  }).catch((e) => ({ ok: false, error: e.message }));
  await setRecording(null);
  await closeOffscreen();
  await showRecording(rec.tabId, false);
  if (cancel) return tellTab(rec.tabId, { state: "cancelled" });
  if (!session) return tellTab(rec.tabId, { state: "failed", error: "no Claude Code chat to send it to" });
  if (!result?.ok) return tellTab(rec.tabId, { state: "failed", error: result?.error ?? "the recorder didn't answer" });
  const saved = await savedVideos();
  saved[rec.tabId] = result.video;
  await chrome.storage.session.set({ savedVideos: saved });
  tellTab(rec.tabId, { state: "saved", video: result.video });
}

// The recorder stopped by itself: the time limit keeps the video; a capture that ended means the tab
// closed or crashed, and nobody is left to describe it.
async function autostopRecording(reason) {
  const rec = await getRecording();
  if (!rec) return;
  const tabAlive = await chrome.tabs.get(rec.tabId).then(() => true, () => false);
  await stopRecording({ cancel: reason === "ended" && !tabAlive });
}

// What the user did, in order: from the overlay (clicks, keys, typing) and from here (page loads).
let logChain = Promise.resolve();
function logRecording(tabId, event) {
  logChain = logChain.then(async () => {
    const rec = await getRecording();
    if (rec?.tabId !== tabId || rec.phase !== "recording" || rec.events.length >= REC_EVENTS_MAX) return;
    rec.events.push(event);
    await setRecording(rec);
  }).catch(() => {});
}
async function logNavigation({ tabId, frameId, url, transitionType }, kind) {
  if (frameId !== 0) return;
  const rec = await recordingOf(tabId);
  if (!rec) return;
  logRecording(tabId, { t: Math.round((Date.now() - rec.startedAt) / 100) / 10, kind: transitionType === "reload" ? "reload" : kind, url });
}
chrome.webNavigation.onCommitted.addListener((d) => logNavigation(d, "navigate"));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => logNavigation(d, "navigate"));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => logNavigation(d, "navigate"));

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === "loading" && (await recordingOf(tabId))) await showRecording(tabId, true); // a page load clears the badge
  if (info.status !== "complete") return;
  if (isSnapshotTab(tab)) return; // it asks for its overlay as it loads
  if ((await onTabs())[tabId] == null) return;
  if (!isWebUrl(tab.url)) return setTabSession(tabId, null);
  try {
    const { session, automatic } = await targetSession(tab.url, tabId);
    if (!session) return setTabSession(tabId, null);
    await mountOverlay(tabId, tab.url, session, { automatic }); // fails on a site the user never granted: off
  } catch {
    await setTabSession(tabId, null);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getRecording())?.tabId === tabId) await stopRecording({ cancel: true });
  await forgetSavedVideo(tabId);
  await chooseForTab(tabId, null);
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
    await flagIcon(tab.id, e.message);
  }
  refreshMenu();
}
async function flagIcon(tabId, message) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#FF4D8D" }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: `Claude Annotate: ${message}` }).catch(() => {});
}

// The toolbar icon is the switch; on a tab being recorded, it stops the recording.
async function onIconClick(tab) {
  if ((await getRecording())?.tabId === tab.id) return stopRecording();
  return toggleFromUser(tab);
}
chrome.action.onClicked.addListener(onIconClick);

// ⌥⇧A: annotate. The pointer is still where the user left it, so what it hovers is held.
// ⌥⇧R: record the tab, annotating it first if it isn't; again to stop.
async function onShortcut(command, tab) {
  if (!tab) return;
  if (command === "toggle-annotate") {
      if ((await getRecording())?.tabId === tab.id) return stopRecording();
    return toggleFromUser(tab);
  }
  if (command === "toggle-record") {
      if ((await getRecording())?.tabId === tab.id) return stopRecording();
    try {
      if ((await onTabs())[tab.id] == null) await turnOn(tab);
      await startRecording(tab);
    } catch (e) {
      await flagIcon(tab.id, e.message);
    }
  }
}
chrome.commands.onCommand.addListener(onShortcut);

// The icon and the shortcuts by hand, for the journey tests and the worker's DevTools console:
// claudeAnnotate.click(tabId), claudeAnnotate.shortcut("toggle-record", tabId).
self.claudeAnnotate = {
  click: async (tabId) => onIconClick(await chrome.tabs.get(tabId)),
  shortcut: async (command, tabId) => onShortcut(command, await chrome.tabs.get(tabId)),
  // What following another chat does to a tab: the overlay taken off and put on again.
  remount: async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    const { session, automatic } = await targetSession(await pageUrlOf(tab), tabId);
    await mountOverlay(tabId, tab.url, session, { automatic });
  },
};

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
  chrome.contextMenus.create({ id: MENU_PARENT, title: "Send notes to", contexts: ["action"] });
  if (!sessions.length) {
    chrome.contextMenus.create({ id: "none", parentId: MENU_PARENT, title: "No Claude Code session running", enabled: false, contexts: ["action"] });
    return;
  }
  const isPinned = sessions.some((s) => s.pid === pinned);
  chrome.contextMenus.create({ id: "pid:auto", parentId: MENU_PARENT, type: "radio", checked: !isPinned, title: "Automatic: the chat I typed in last (the page's project first)", contexts: ["action"] });
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


chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!String(info.menuItemId).startsWith("pid:")) return;
  const pid = info.menuItemId === "pid:auto" ? null : Number(String(info.menuItemId).slice(4));
  await chrome.storage.local.set({ pinnedPid: pid });
  await chrome.storage.session.set({ chosen: {} }); // the menu speaks for every tab
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

// Forwards the server's event stream (text/event-stream) as one message per event. query names the
// tab's page, so the server counts the tab as annotating while the stream is open.
async function relayEvents(port, session, signal, query) {
  const res = await fetch(`${session.endpoint}/events?t=${session.token}${query ? `&${query}` : ""}`, { signal });
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
  const tab = port.sender.tab, tabId = tab.id;
  let relay = null; // the open event stream; the overlay closes it to open another after a drop
  const endRelay = () => { if (relay) relay.abort(); relay = null; };
  port.onDisconnect.addListener(endRelay);
  const ask = (session, m) => fetch(session.endpoint + m.path, {
    method: m.method,
    headers: { "Content-Type": "application/json", "X-Annot-Token": session.token },
    body: m.body === undefined ? undefined : JSON.stringify(m.body),
  });

  port.onMessage.addListener(async (m) => {
    if (m.unsubscribe) return endRelay();
    let session = await sessionForTab(tabId);
    if (m.subscribe) {
      endRelay();
      if (!session) return port.postMessage({ closed: true });
      const mine = (relay = new AbortController());
      relayEvents(port, session, mine.signal, m.query).catch(() => {}).finally(() => { if (!mine.signal.aborted) port.postMessage({ closed: true }); });
      return;
    }
    if (!m.id) return;
    if (!session) return port.postMessage({ id: m.id, ok: false, error: "annotation mode is off in this tab" });
    try {
      let res = await ask(session, m);
      // 403: the session's server restarted with a new token. Look it up again and ask once more.
      if (res.status === 403) {
        await targetSession(tab.url, tabId).catch(() => {});
        const fresh = await sessionForTab(tabId);
        if (fresh && fresh.token !== session.token) res = await ask((session = fresh), m);
      }
      const data = await res.json().catch(() => ({}));
      port.postMessage({ id: m.id, ok: res.ok, status: res.status, data });
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, error: e.message });
    }
  });
});
