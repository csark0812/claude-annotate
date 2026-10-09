// The toolbar popup: the on/off switch for this tab and which session the notes go to.
const $ = (id) => document.getElementById(id);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

const ask = (type, extra = {}) => chrome.runtime.sendMessage({ type, tabId: tab.id, url: tab.url, tab, ...extra });

function folder(cwd) {
  return cwd ? cwd.split("/").filter(Boolean).pop() : "unknown folder";
}
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const describe = (s) => `${folder(s.cwd)} · ${s.lastPromptAt ? `typed ${ago(s.lastPromptAt)}` : `started ${ago(s.startedAt)}`}`;

function render(st) {
  const error = $("error");
  error.hidden = st.ok && !st.hostError;
  error.textContent = st.ok ? st.hostError ?? "" : st.error;
  if (!st.ok) return;

  const toggle = $("toggle");
  toggle.setAttribute("aria-checked", String(st.on));
  toggle.disabled = !st.on && (!st.local || !st.sessions.length);

  const select = $("session");
  select.replaceChildren();
  const auto = new Option(st.sessions[0] ? `Last typed in: ${describe(st.sessions[0])}` : "No sessions running", "");
  select.add(auto);
  for (const s of st.sessions) select.add(new Option(describe(s), String(s.pid)));
  select.value = st.pinned != null && st.sessions.some((s) => s.pid === st.pinned) ? String(st.pinned) : "";
  select.disabled = !st.sessions.length;

  const target = st.sessions.find((s) => s.pid === st.onPid);
  $("note").innerHTML = !st.local
    ? "Open a local dev page (localhost, *.test, a private IP) to annotate it."
    : !st.sessions.length
      ? "Start a Claude Code session with the annotate plugin to send notes to it."
      : st.on
        ? `On. Notes go to <b>${esc(folder(target?.cwd))}</b>. Shortcut: <kbd>⌥⇧A</kbd>.`
        : "Off. Turn it on to draw and pin notes on this page. Shortcut: <kbd>⌥⇧A</kbd>.";
}

$("toggle").addEventListener("click", async () => render(await ask("toggle")));
$("session").addEventListener("change", async (e) => render(await ask("pin", { pid: e.target.value ? Number(e.target.value) : null })));

render(await ask("status"));
