// Runs in the page's isolated world and carries the overlay's DOM events (either world) to the worker:
//  - "claude-annotate:exit" (Esc): turn the tab off, as a click on the icon would.
//  - "claude-annotate:shoot" (Send): capture the visible tab; the answer comes back as
//    "claude-annotate:shot" with a data URL, or "" when it could not be captured.
//  - "claude-annotate:chats" (the chat pill opens): the answer comes back as
//    "claude-annotate:chat-list", JSON { current, chats }, or "" when the list can't be had.
//  - "claude-annotate:choose" (a chat was picked), JSON { pid, carry }: the overlay is mounted
//    again, sending to that chat.
//  - "claude-annotate:relink" (the link to the server dropped): the answer comes back as
//    "claude-annotate:relinked", JSON { pid, endpoint?, token? } for the chat to send to now
//    (endpoint and token only for a local page, which holds them anyway), or "" for none.
// Details cross between worlds as strings: an object from the page's world arrives empty.
export function relayPage() {
  if (window.__claudeAnnotateRelay) return;
  window.__claudeAnnotateRelay = true;
  document.addEventListener("claude-annotate:exit", () => {
    try { chrome.runtime.sendMessage({ type: "exit" }); } catch { /* the extension was reloaded */ }
  });
  document.addEventListener("claude-annotate:shoot", async () => {
    let image = "";
    try { image = (await chrome.runtime.sendMessage({ type: "shoot" }))?.image || ""; } catch { /* reloaded */ }
    document.dispatchEvent(new CustomEvent("claude-annotate:shot", { detail: image }));
  });
  document.addEventListener("claude-annotate:chats", async () => {
    let list = "";
    try { list = JSON.stringify(await chrome.runtime.sendMessage({ type: "chats" })); } catch { /* reloaded */ }
    document.dispatchEvent(new CustomEvent("claude-annotate:chat-list", { detail: list }));
  });
  document.addEventListener("claude-annotate:recheck", async () => {
    let pid = "";
    try { pid = String((await chrome.runtime.sendMessage({ type: "recheck" }))?.pid ?? ""); } catch { /* reloaded */ }
    document.dispatchEvent(new CustomEvent("claude-annotate:retarget", { detail: pid }));
  });
  document.addEventListener("claude-annotate:relink", async () => {
    let at = "";
    try { at = JSON.stringify(await chrome.runtime.sendMessage({ type: "relink" })); } catch { /* reloaded */ }
    document.dispatchEvent(new CustomEvent("claude-annotate:relinked", { detail: at }));
  });
  document.addEventListener("claude-annotate:choose", (e) => {
    let choice;
    try { choice = JSON.parse(e.detail); } catch { return; }
    try { chrome.runtime.sendMessage({ type: "choose", pid: choice.pid ?? null, carry: choice.carry ?? null, auto: !!choice.auto, follow: !!choice.follow }); } catch { /* reloaded */ }
  });
  // Recording: "rec-start" is answered by "rec-started", JSON { ok, startedAt } or { ok: false, error, code }.
  document.addEventListener("claude-annotate:rec-start", async () => {
    let answer = "";
    try { answer = JSON.stringify(await chrome.runtime.sendMessage({ type: "rec-start" })); } catch { /* reloaded */ }
    document.dispatchEvent(new CustomEvent("claude-annotate:rec-started", { detail: answer }));
  });
  document.addEventListener("claude-annotate:rec-stop", (e) => {
    let cancel = false;
    try { cancel = !!JSON.parse(e.detail).cancel; } catch { /* stop */ }
    try { chrome.runtime.sendMessage({ type: "rec-stop", cancel }); } catch { /* reloaded */ }
  });
  document.addEventListener("claude-annotate:rec-event", (e) => {
    try { chrome.runtime.sendMessage({ type: "rec-event", event: JSON.parse(e.detail) }); } catch { /* reloaded */ }
  });
  document.addEventListener("claude-annotate:rec-taken", () => {
    try { chrome.runtime.sendMessage({ type: "rec-taken" }); } catch { /* reloaded */ }
  });
  // How this tab's recording goes, from the background: to the overlay, in either world.
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === "rec-state") document.dispatchEvent(new CustomEvent("claude-annotate:rec-state", { detail: JSON.stringify(m) }));
  });
}
