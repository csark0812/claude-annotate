// A picture of a page Chrome keeps extensions out of (chrome://, the Web Store, other extensions),
// annotated in its own tab. It shows the tab as it was at its own CSS size, then asks the worker for
// the overlay's config: the notes are filed under the pictured page's URL.
import { relayPage } from "./relay.js";

const img = document.getElementById("snap");
const answer = await chrome.runtime.sendMessage({ type: "snapshot-ready", id: location.hash.slice(1) }).catch(() => null);

if (!answer?.snap) {
  img.remove();
  document.body.insertAdjacentHTML("beforeend", "<p>This picture is gone. Turn annotating on in the page again.</p>");
} else {
  const { snap, cfg } = answer;
  document.title = `✎ ${snap.title}`;
  img.alt = `A picture of ${snap.url}, taken when annotating began (Chrome doesn't let extensions into that page)`;
  img.style.width = `${snap.w}px`;
  img.src = snap.image;
  await img.decode().catch(() => {});
  if (!cfg) {
    document.body.insertAdjacentHTML("beforeend", "<p>No Claude Code session is running with the annotate plugin. Start one, then reload this tab.</p>");
  } else {
    relayPage();
    window.__CLAUDE_ANNOTATE__ = cfg;
    const overlay = document.createElement("script");
    overlay.src = "overlay.js";
    document.body.append(overlay);
  }
}
