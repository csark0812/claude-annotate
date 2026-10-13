/* Annotate — in-page overlay.
 *
 * window.__CLAUDE_ANNOTATE__ says how it reaches the session's annotate server:
 *  - { endpoint, token }: direct, from the page's main world. Local dev pages only: injected
 *    by the annotation browser before the page's scripts run, or by the extension.
 *  - { transport: "port" }: through the browser extension, from its isolated world. Any page:
 *    the page's scripts never see the token, the requests or the overlay itself.
 *  - { state, renderOnly }: no server at all. The marks to draw for a screenshot.
 * Everything lives in a
 * Shadow DOM on a host appended to <html>, so the page's CSS never touches it and ours
 * never leaks out. Document coordinates everywhere, so marks stay put while the window scrolls.
 * A mark drawn over a scroll container (an app shell's pane) is anchored to it and moves, and is
 * clipped, as that container scrolls. Anchors live in memory: after a reload a mark stays where it
 * was last saved.
 */
(() => {
  if (window.top !== window) { installFrameProbe(); return; } // inside a frame: only answer the element picker
  const CFG = window.__CLAUDE_ANNOTATE__;
  try { delete window.__CLAUDE_ANNOTATE__; } catch { window.__CLAUDE_ANNOTATE__ = undefined; } // the token never stays on the page
  if (!CFG || window.__claudeAnnotate) return;
  const VIA_PORT = CFG.transport === "port";
  const INLINE = !!CFG.state;
  // The token in a page's main world: local development hosts only. A third-party page must never see the bridge.
  if (!VIA_PORT && !INLINE && !isLocalHost(location.hostname)) return;
  const F = window.fetch.bind(window), ES = window.EventSource; // taken before page scripts can patch them
  const RENDER_ONLY = !!CFG.renderOnly || !!window.__CLAUDE_ANNOTATE_RENDER_ONLY__;

  function isLocalHost(h) {
    return /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})$/.test(h) || /\.(localhost|test|local|internal)$/.test(h);
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  // One ink, as in Codex. The others stay so marks saved by an older overlay still draw.
  const INKS = [
    { id: "blue", hex: "#3B82F6", dark: "#FFFFFF" },
    { id: "pink", hex: "#FF4D8D", dark: "#2A0A17" },
    { id: "sun", hex: "#FFD23F", dark: "#2B2206" },
    { id: "cyan", hex: "#35D7FF", dark: "#062530" },
    { id: "lime", hex: "#9BFF4D", dark: "#142A05" },
  ];
  const CLICK_SLOP = 5; // a press that moves less than this is a click: it marks the element under it
  const ICON = {
    pen: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    arrow: '<path d="M5 19 19 5"/><path d="M9 5h10v10"/>',
    line: '<path d="M5 19 19 5"/>',
    rect: '<rect x="3" y="5" width="18" height="14" rx="3"/>',
    element: '<path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h2"/><path d="M14 3h1"/><path d="M3 9v1"/><path d="M21 9v2"/><path d="M3 14v1"/><path d="m12 12 4 10 1.7-4.3L22 16Z"/>',
    note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6"/><path d="M9 10h6"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    send: '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    chevron: '<path d="m6 15 6-6 6 6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
    annotate: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/>',
    shot: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 8 10 8a17.6 17.6 0 0 1-2.16 3.19"/><path d="M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="m2 2 20 20"/>',
    grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  };
  const svgIcon = (name, size = 18) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const api = { ready: false };
  window.__claudeAnnotate = api;

  const pageUrl = () => location.href;
  let shapes = []; // { id, type, color, ...geometry, ctx, batch }
  let notes = []; // { id, n, x, y, color, text, status, ctx, batch, result }
  const ink = INKS[0];
  // draw ("Annotating") | browse. annotate_open starts in browse, so every page stays usable until Annotate is pressed.
  // The extension's toolbar icon is the switch: there the overlay exists only while annotating.
  let mode = CFG.startMode === "draw" ? "draw" : "browse";
  let draft = null;
  const undo = [];
  const redo = [];
  let totals = { notes: 0, shapes: 0, pages: 0, unsent: 0, open: 0, batches: 0 };
  let linkState = "connecting"; // connecting | on | off
  let phase = "idle"; // idle | sending | sent | done
  let confirmDiscard = false; // the "Discard all pending annotations?" dialog is up
  let markersHidden = false; // Hide markers: the pins and marks step aside, annotating goes on
  let spaceHeld = false; // Space held: the page takes the pointer until it is let go
  let sse = null;
  let quietTimer = null; // fires the "ask Claude to pull" hint when a Send gets no reaction
  const off = new AbortController(); // aborted by unmount(): the extension's toggle turns the overlay off
  // Turned on with the keyboard while the pointer rests on something: keep that hovered.
  const frozen = CFG.freezeHover && !RENDER_ONLY ? freezeHover() : null;

  // ---------------------------------------------------------------------------
  // Hover freeze
  // ---------------------------------------------------------------------------
  // Once the overlay covers the page, the browser moves :hover to it and the page hears the
  // pointer leave, so menus and hover styles vanish. This holds both while the overlay is up:
  //  - CSS: every rule with :hover gets a twin that matches [data-claude-annotate-hover]
  //    instead, and the elements hovered right now get that attribute.
  //  - JS: pointer leave/out/move events never reach the page, and presses, focus and keys in
  //    the overlay stop at its host, so "click outside" and "focus outside" handlers stay quiet.
  // Stylesheets from other origins can't be read; their hover styles are not held.
  function freezeHover() {
    const ATTR = "data-claude-annotate-hover";
    const hovered = [...document.querySelectorAll(":hover")].filter((e) => e !== document.documentElement && e !== document.body);
    if (!hovered.length) return null;
    for (const e of hovered) e.setAttribute(ATTR, "");

    const twins = []; // [container, rule]
    const visit = (container) => {
      let rules;
      try { rules = [...container.cssRules]; } catch { return; } // another origin's sheet
      for (const r of rules) {
        if (r.selectorText && /:hover\b/.test(r.selectorText)) {
          const text = r.cssText.replace(r.selectorText, r.selectorText.replace(/:hover\b/g, `[${ATTR}]`));
          try {
            const at = container.insertRule(text, container.cssRules.length);
            twins.push([container, container.cssRules[at]]);
          } catch { /* a selector this browser won't take twice */ }
        }
        if (r.cssRules && !r.selectorText) visit(r); // @media, @supports, @layer
      }
    };
    for (const sheet of [...document.styleSheets]) visit(sheet);

    const LEAVE = ["pointerout", "pointerleave", "mouseout", "mouseleave", "pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"];
    const ours = (e) => host && e.composedPath().includes(host);
    const holdPage = (e) => { if (!ours(e)) e.stopImmediatePropagation(); };
    for (const t of LEAVE) window.addEventListener(t, holdPage, { capture: true, signal: off.signal });

    off.signal.addEventListener("abort", () => {
      for (const [container, rule] of twins) {
        const i = [...container.cssRules].indexOf(rule);
        if (i >= 0) container.deleteRule(i);
      }
      for (const e of hovered) e.removeAttribute(ATTR);
      // The page never heard the pointer leave: tell it now. If the pointer is still there, the
      // browser sends enter again on its next move.
      const deepest = hovered[hovered.length - 1];
      for (const [type, Ev, bubbles] of [["pointerout", PointerEvent, true], ["mouseout", MouseEvent, true]]) deepest.dispatchEvent(new Ev(type, { bubbles, composed: true }));
      for (const e of [...hovered].reverse()) {
        e.dispatchEvent(new PointerEvent("pointerleave"));
        e.dispatchEvent(new MouseEvent("mouseleave"));
      }
    });
    return { elements: hovered.length, rules: twins.length };
  }
  // While frozen, what happens in the overlay stays there: the page's bubbling listeners never see it.
  function sealHost() {
    const QUIET = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "focusin", "focusout", "keydown", "keyup", "keypress", "wheel"];
    for (const t of QUIET) host.addEventListener(t, (e) => e.stopPropagation(), { signal: off.signal });
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------
  // req(method, path, body) → the server's JSON answer. events() → { onopen, onerror, onmessage, close }.
  const transport = VIA_PORT ? portTransport() : INLINE ? inlineTransport() : directTransport();
  const req = transport.req;

  function directTransport() {
    const H = { "Content-Type": "application/json", "X-Annot-Token": CFG.token };
    return {
      async req(method, p, body) {
        const r = await F(CFG.endpoint + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText);
        return j;
      },
      events: () => new ES(`${CFG.endpoint}/events?t=${CFG.token}`),
    };
  }

  // The extension's background holds the token and makes the requests. One port per page:
  // requests carry an id, server-sent events come back without one.
  function portTransport() {
    const waiting = new Map();
    let port = null, seq = 0, subscribed = false, closed = false;
    // A message into the extension's worker keeps it from being stopped while the page listens.
    const keepAlive = setInterval(() => { if (port && subscribed) port.postMessage({ ping: true }); }, 20000);
    const stream = { onopen: null, onerror: null, onmessage: null, close() { closed = true; clearInterval(keepAlive); if (port) port.disconnect(); } };
    // The extension was reloaded or removed: this overlay belongs to a context that is gone.
    const orphaned = () => !(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id);
    const connect = () => {
      if (orphaned()) { closed = true; clearInterval(keepAlive); setTimeout(() => api.unmount && api.unmount(), 0); throw new Error("extension reloaded"); }
      port = globalThis.chrome.runtime.connect({ name: "annotate" }); // the extension API; `chrome` here is the toolbar
      port.onMessage.addListener((m) => {
        if (m.id) {
          const w = waiting.get(m.id);
          waiting.delete(m.id);
          if (w) m.ok ? w.resolve(m.data) : w.reject(new Error((m.data && m.data.error) || m.error || `HTTP ${m.status}`));
        } else if (m.open) stream.onopen && stream.onopen();
        else if (m.event != null) stream.onmessage && stream.onmessage({ data: m.event });
        else if (m.closed) stream.onerror && stream.onerror();
      });
      port.onDisconnect.addListener(() => {
        port = null;
        for (const w of waiting.values()) w.reject(new Error("extension disconnected"));
        waiting.clear();
        if (closed) return;
        stream.onerror && stream.onerror();
        // The extension's worker restarted: come back and listen again.
        if (subscribed) setTimeout(() => {
          if (closed || port) return;
          try { connect(); port.postMessage({ subscribe: true }); } catch { /* orphaned: unmounting */ }
        }, 1000);
      });
    };
    connect();
    return {
      req(method, p, body) {
        try { if (!port) connect(); } catch (e) { return Promise.reject(e); }
        const id = ++seq;
        return new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          port.postMessage({ id, method, path: p, body });
        });
      },
      events() {
        try { if (!port) connect(); } catch { return stream; }
        subscribed = true;
        port.postMessage({ subscribe: true });
        return stream;
      },
    };
  }

  // A screenshot of a page that isn't open: the marks come with the script, nothing goes back.
  function inlineTransport() {
    return {
      async req(method, p) {
        if (method === "GET" && p.startsWith("/state")) return { ok: true, ...CFG.state };
        return { ok: true };
      },
      events: () => ({ close() {} }),
    };
  }
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    const url = pageUrl(); // not when the timer fires: an SPA navigation may happen in between
    saveTimer = setTimeout(async () => {
      try {
        const r = await req("PUT", "/state", { url, shapes, notes });
        if (r.totals) { totals = r.totals; renderToolbar(); }
      } catch { setLink("off"); }
    }, 120);
  };

  // ---------------------------------------------------------------------------
  // DOM scaffold
  // ---------------------------------------------------------------------------
  let host, root, docLayer, svg, shapesG, draftG, pinsLayer, chrome, bar, popover, toasts, ticker, rim, hl, ghost, confirmBox, chatMenu;

  const CSS = `
:host { all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; display: block; }
*, *::before, *::after { box-sizing: border-box; }
.doc { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
svg.ink { position: absolute; top: 0; left: 0; display: block; overflow: visible; pointer-events: none; touch-action: none; }
:host(.draw) svg.ink { pointer-events: auto; cursor: var(--cursor, crosshair); }
:host(.draw.pass) svg.ink { pointer-events: none; }
svg.ink .hit { stroke: transparent; fill: none; stroke-width: 16; pointer-events: none; }
:host(.dragging) svg.ink .hit, :host(.dragging) .pin .dot { cursor: grabbing !important; }
svg.ink .halo { fill: none; stroke: rgba(10,8,14,.42); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
svg.ink .box { stroke-dasharray: 7 5; stroke-linecap: butt; stroke-linejoin: miter; } /* a box reads as a selection */
svg.ink .line:not(.box) { fill: none; }
svg.ink .line { stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
svg.ink .head { stroke: rgba(10,8,14,.42); stroke-width: 2; stroke-linejoin: round; }
svg.ink g.draft { opacity: .9; }
:host(.capturing) svg.ink .hit, :host(.capturing) .chrome, :host(.capturing) .pop { display: none !important; }
:host(.capturing) .pin .tag { white-space: normal; width: max-content; max-width: 260px; border-radius: 12px; }
:host(.capturing) .pin .dot { animation: none; }

.pins { position: absolute; top: 0; left: 0; pointer-events: none; }
.pin { position: absolute; width: 0; height: 0; pointer-events: none; }
.pin.out { visibility: hidden; }
.pin .dot {
  pointer-events: auto; position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border-radius: 999px;
  display: grid; place-items: center; cursor: grab; border: 0; padding: 0; touch-action: none;
  background: var(--ink); color: var(--ink-dark);
  font: 700 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px rgba(20,17,26,.9), 0 6px 16px -6px rgba(0,0,0,.7);
  transition: transform .15s cubic-bezier(.2,.8,.2,1);
  animation: pop .3s cubic-bezier(.34,1.56,.64,1) both;
}
.pin .dot:hover { transform: scale(1.1); }
.pin .dot:active { transform: scale(.94); }
.pin .dot:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.pin .ring { position: absolute; left: -15px; top: -15px; width: 30px; height: 30px; border-radius: 999px; border: 2px solid transparent; border-top-color: var(--ink); opacity: 0; pointer-events: none; }
.pin.working .ring { opacity: 1; animation: spin 1s linear infinite; }
.pin.working .dot { animation: pulse 1.4s ease-in-out infinite; }
.pin.done .dot { background: #4ADE80; color: #06240F; }
.pin.done .dot .n { display: none; }
.pin.done .dot .ic { display: block; }
.pin .dot .ic { display: none; }
.pin.skipped .dot { background: #6B6775; color: #F4F1F7; }
.pin.pending .dot { box-shadow: 0 0 0 2px rgba(20,17,26,.9), 0 0 0 4px var(--ink-soft), 0 6px 16px -6px rgba(0,0,0,.7); }
.pin .tag {
  position: absolute; left: 16px; top: -11px; max-width: 220px; padding: 4px 9px 5px; border-radius: 999px;
  background: rgba(20,17,26,.86); color: #F4F1F7; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.1), 0 0 0 1px rgba(255,255,255,.07), 0 10px 24px -12px rgba(0,0,0,.7);
  font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .005em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: auto; cursor: pointer;
  animation: slide .3s cubic-bezier(.2,.8,.2,1) both;
}
.pin.done .tag .txt { text-decoration: line-through; color: rgba(244,241,247,.55); }
.pin.skipped .tag .txt { color: rgba(244,241,247,.6); }
/* Send: what went out shrinks away from the page. */
.pin.flushed { animation: flush .38s cubic-bezier(.4,0,.2,1) both; }
svg.ink g.flushed { transform-box: fill-box; transform-origin: center; animation: flush .38s cubic-bezier(.4,0,.2,1) both; }

.chrome { position: fixed; inset: 0; pointer-events: none; color: #F4F1F7; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 13px; }
.chrome > * { pointer-events: auto; }
.hl { position: fixed; pointer-events: none; border: 1.5px solid var(--ink); background: color-mix(in srgb, var(--ink) 10%, transparent); border-radius: 2px; transition: left .06s, top .06s, width .06s, height .06s; }
.hl.hidden { display: none; }
.hl .lab { position: absolute; left: -1.5px; bottom: calc(100% + 4px); padding: 2px 6px; border-radius: 5px; white-space: nowrap; background: var(--ink); color: var(--ink-dark); font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
:host(.draw.t-element) svg.ink { cursor: default; }
.rim { pointer-events: none; position: fixed; inset: 0; box-shadow: inset 0 0 0 3px var(--ink); opacity: 0; }
.rim.flash { animation: rimflash .7s cubic-bezier(.2,.8,.2,1) both; }

.bar {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 2px; padding: 6px; border-radius: 999px;
  background: rgba(20,17,26,.84); backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 0 0 1px rgba(255,255,255,.07), 0 24px 60px -24px rgba(0,0,0,.7);
  animation: rise .35s cubic-bezier(.2,.8,.2,1) both; user-select: none; -webkit-user-select: none;
}
.bar { width: max-content; } /* left: 50% would otherwise give it half the viewport and squeeze the buttons */
.bar > * { flex-shrink: 0; }
.bar.dragging { transition: none; }
.bar .grip { color: rgba(244,241,247,.35); cursor: grab; padding: 0 2px 0 4px; display: grid; place-items: center; }
.bar .grip:active { cursor: grabbing; }
.sep { width: 1px; height: 22px; background: rgba(255,255,255,.08); margin: 0 4px; }
.tb {
  position: relative; width: 36px; height: 36px; border-radius: 999px; border: 0; padding: 0; display: grid; place-items: center;
  background: transparent; color: rgba(244,241,247,.72); cursor: pointer;
  transition: background .15s cubic-bezier(.2,.8,.2,1), color .15s, transform .15s, box-shadow .15s;
}
.tb:hover { background: rgba(255,255,255,.08); color: #F4F1F7; }
.tb:active { transform: scale(.94); }
.tb:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
.tb.on { background: color-mix(in srgb, var(--ink) 20%, transparent); color: var(--ink); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 45%, transparent); }
.tb .kbd { position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translate(-50%, 4px); opacity: 0; pointer-events: none;
  padding: 4px 8px; border-radius: 8px; background: rgba(20,17,26,.95); color: #F4F1F7; font-size: 11.5px; font-weight: 600; white-space: nowrap;
  box-shadow: 0 0 0 1px rgba(255,255,255,.08); transition: opacity .15s, transform .15s cubic-bezier(.2,.8,.2,1); }
.tb .kbd b { color: rgba(244,241,247,.5); font-weight: 600; margin-left: 6px; }
.tb:hover .kbd, .tb:focus-visible .kbd { opacity: 1; transform: translate(-50%, 0); transition-delay: .35s; }
/* The link to the session: a dot on the grip. */
.grip { position: relative; }
.grip .st { position: absolute; right: -1px; top: -3px; width: 7px; height: 7px; border-radius: 999px; background: #6B6775; box-shadow: 0 0 0 2px rgba(20,17,26,1); transition: background .3s; }
:host(.link-on) .grip .st { background: #4ADE80; }
:host(.link-connecting) .grip .st { background: #FFD23F; animation: pulse 1.2s ease-in-out infinite; }
:host(.link-off) .grip .st { background: #FF5C5C; }
.frozen { margin-left: 4px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #35D7FF; background: rgba(53,215,255,.12); box-shadow: inset 0 0 0 1px rgba(53,215,255,.35); white-space: nowrap; }

.inks { display: flex; gap: 9px; padding: 0 8px; }
.inkb { width: 22px; height: 22px; border-radius: 999px; border: 0; padding: 0; cursor: pointer; background: var(--c);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 0 0 2px transparent; transition: transform .15s cubic-bezier(.2,.8,.2,1), box-shadow .15s; }
.inkb:hover { transform: scale(1.12); }
.inkb:active { transform: scale(.94); }
.inkb.on { box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 0 0 2px rgba(20,17,26,1), 0 0 0 3.5px var(--c); }
.inkb:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

.send {
  height: 36px; padding: 0 14px; margin-left: 2px; border: 0; border-radius: 999px; display: flex; align-items: center; gap: 8px;
  background: var(--ink); color: var(--ink-dark); cursor: pointer; font: 600 13px/1 inherit; font-family: inherit; letter-spacing: .005em;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.35); transition: transform .15s cubic-bezier(.2,.8,.2,1), filter .15s, background .3s, color .3s;
}
.send { cursor: default; }
.send.idle { background: rgba(255,255,255,.08); color: rgba(244,241,247,.75); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
.send.idle .live { display: block; background: #4ADE80; }
.send:active { transform: scale(.96); }
.send:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.send:disabled { cursor: default; filter: saturate(.6); opacity: .85; }
.send:has(.cnt):not(.sending, .sent) { padding-right: 6px; } /* tight against the count bubble, which sending/sent hide */
.send .cnt { min-width: 24px; height: 24px; padding: 0 7px; border-radius: 999px; display: grid; place-items: center; background: rgba(20,17,26,.9); color: #F4F1F7; font-weight: 700; font-variant-numeric: tabular-nums; transition: transform .2s cubic-bezier(.34,1.56,.64,1); }
.send .cnt.bump { animation: bump .35s cubic-bezier(.34,1.56,.64,1); }
.send .cnt .ic { display: none; }
.send .live { width: 8px; height: 8px; border-radius: 999px; background: var(--ink-dark); display: none; }
.send.sending .live, .send.sent .live { display: block; animation: pulse 1.2s ease-in-out infinite; }
.send.sending .cnt, .send.sent .cnt { display: none; }
.send.done { background: #4ADE80; color: #06240F; }
.send.done .cnt { background: rgba(6,36,15,.85); }
.send.done .cnt .ic { display: block; }
.send.done .cnt .num { display: none; }
/* The chat pill: which chat the notes go to, and how that chat is doing (the dot). */
.send.chat { cursor: pointer; padding: 0 10px 0 14px; max-width: 260px; }
.send.chat .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.send.chat .live { flex: none; }
.send.chat .ic { flex: none; opacity: .7; }
.send.chat.idle:hover, .send.chat[aria-expanded="true"] { background: rgba(255,255,255,.14); color: #F4F1F7; }
.chats { position: fixed; width: min(340px, calc(100vw - 24px)); max-height: min(420px, calc(100vh - 120px)); overflow: auto; padding: 6px; border-radius: 16px;
  background: rgba(24,22,28,.97); color: #F4F1F7; backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.08), 0 16px 40px -16px rgba(0,0,0,.7);
  font: 13px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; transform-origin: 50% 100%; animation: popin .18s cubic-bezier(.34,1.56,.64,1) both; }
.chats.hidden { display: none; }
.chats .hd { padding: 6px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: rgba(244,241,247,.5); }
.chats .msg { padding: 10px; color: rgba(244,241,247,.65); }
.chats button { width: 100%; display: grid; grid-template-columns: 1fr 18px; align-items: center; gap: 2px 8px; padding: 8px 10px; border: 0; border-radius: 10px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.chats button:hover, .chats button:focus-visible { background: rgba(255,255,255,.08); outline: none; }
.chats .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chats .s { grid-column: 1; font-size: 11.5px; color: rgba(244,241,247,.5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chats .ic { grid-column: 2; grid-row: 1 / span 2; color: #4ADE80; }
.danger { color: rgba(244,241,247,.55); }
.danger:hover { color: #FF8A8A; background: rgba(255,92,92,.14); }
.danger.armed { width: auto; padding: 0 12px; gap: 6px; display: flex; align-items: center; color: #FF8A8A; background: rgba(255,92,92,.16); box-shadow: inset 0 0 0 1px rgba(255,92,92,.4); font-weight: 600; }
.danger.glow { animation: glow 1.6s ease-in-out infinite; color: #F4F1F7; }

.ticker { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); padding: 6px 12px; border-radius: 999px; white-space: nowrap;
  background: rgba(20,17,26,.78); color: rgba(244,241,247,.8); font-size: 12px; font-weight: 500; letter-spacing: .01em;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.06); opacity: 0; transition: opacity .3s; pointer-events: none; }
.ticker.show { opacity: 1; }
.ticker .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #F4F1F7; }

.toasts { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
.toast { max-width: min(560px, 90vw); padding: 10px 14px 11px; border-radius: 14px; background: rgba(20,17,26,.9); color: #F4F1F7; font-size: 13px; line-height: 1.35; font-weight: 500;
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.1), 0 0 0 1px rgba(255,255,255,.08), 0 20px 50px -20px rgba(0,0,0,.7);
  animation: drop .35s cubic-bezier(.2,.8,.2,1) both; display: flex; gap: 10px; align-items: flex-start; }
.toast.out { animation: lift .25s cubic-bezier(.2,.8,.2,1) both; }
.toast .ic { flex: none; margin-top: 1px; color: var(--ink); }
.toast.ok .ic { color: #4ADE80; }

.pop { position: fixed; width: min(340px, calc(100vw - 24px)); display: flex; align-items: center; gap: 6px; padding: 5px 5px 5px 7px; border-radius: 999px;
  background: rgba(24,22,28,.96); color: #F4F1F7; backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.08), 0 16px 40px -16px rgba(0,0,0,.7);
  transform-origin: var(--ox, 0) var(--oy, 0); animation: popin .18s cubic-bezier(.34,1.56,.64,1) both; }
.pop.multi { border-radius: 16px; align-items: flex-end; }
.pop.hidden { display: none; }
.pop .num { flex: none; width: 20px; height: 20px; border-radius: 999px; display: grid; place-items: center; background: var(--ink); color: var(--ink-dark); font-weight: 700; font-size: 11px; font-variant-numeric: tabular-nums; }
.pop.multi .num { margin-bottom: 4px; }
.pop textarea { flex: 1; min-width: 0; height: 22px; max-height: 140px; resize: none; border: 0; outline: 0; padding: 2px 2px; margin: 0; background: transparent;
  color: #F4F1F7; font: 500 13px/18px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.pop textarea::placeholder { color: rgba(244,241,247,.42); }
.pop .ok, .pop .del { flex: none; width: 26px; height: 26px; border: 0; padding: 0; border-radius: 999px; display: grid; place-items: center; cursor: pointer; transition: transform .15s, filter .15s, background .15s; }
.pop .ok { background: var(--ink); color: var(--ink-dark); }
.pop .ok:hover { filter: brightness(1.08); }
.pop .ok:active, .pop .del:active { transform: scale(.92); }
.pop .del { background: transparent; color: rgba(244,241,247,.5); }
.pop .del:hover { background: rgba(255,92,92,.16); color: #FF8A8A; }
.pop .ok:focus-visible, .pop .del:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }


/* ---- Annotating, as Codex does it ---------------------------------------------------------- */
/* One blue. Pins are small numbered dots; the comment shows on hover. */
.pin .dot { left: -9px; top: -9px; width: 18px; height: 18px; font-size: 10px; color: #fff;
  box-shadow: 0 0 0 1.5px rgba(255,255,255,.9), 0 4px 12px -4px rgba(0,0,0,.6); }
.pin .ring { left: -13px; top: -13px; width: 26px; height: 26px; }
.pin.pending .dot { box-shadow: 0 0 0 1.5px rgba(255,255,255,.9), 0 4px 12px -4px rgba(0,0,0,.6); }
.pin .tag { left: 14px; top: -12px; opacity: 0; transform: translateX(-4px); pointer-events: none; animation: none;
  transition: opacity .12s, transform .12s cubic-bezier(.2,.8,.2,1); background: rgba(24,24,27,.94); }
.pin:hover .tag, .pin.peek .tag { opacity: 1; transform: none; }
:host(.capturing) .pin .tag { opacity: 1; transform: none; }
.pin.editing .tag { display: none; }
/* An element mark shows only while its comment is open (and in screenshots); an area keeps a faint fill. */
svg.ink .shape.el .halo, svg.ink .shape.el .line { display: none; }
svg.ink .shape.el.active .line, :host(.capturing) svg.ink .shape.el .line { display: inline; stroke-dasharray: none; fill-opacity: .06; }
svg.ink .shape.shot { display: none; }
svg.ink .shape.region .halo { display: none; }
svg.ink .shape.region .line { stroke-opacity: 0; fill-opacity: .1; }
svg.ink .shape.region.active .line, svg.ink g.draft .line, :host(.capturing) svg.ink .shape.region .line { stroke-opacity: 1; }
svg.ink g.draft .halo { display: none; }
svg.ink .line.box { stroke-width: 1.5; stroke-dasharray: 4 3; }
:host(.hidemarks:not(.capturing)) svg.ink .shapes, :host(.hidemarks:not(.capturing)) .pins,
:host(.browse:not(.capturing)) svg.ink .shapes, :host(.browse:not(.capturing)) .pins { visibility: hidden; }
/* Hover: the element is outlined and a pin follows the pointer. */
.hl { border-width: 2px; background: color-mix(in srgb, var(--ink) 6%, transparent); border-radius: 3px; }
.hl .lab { display: none; }
.ghost { position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 999px; background: var(--ink); pointer-events: none;
  box-shadow: 0 0 0 1.5px rgba(255,255,255,.9), 0 4px 12px -4px rgba(0,0,0,.6); opacity: .95; }
.ghost.hidden { display: none; }
:host(.space) svg.ink { pointer-events: none; }
:host(.space) .hl, :host(.space) .ghost { display: none; }
/* The bar at the bottom: grip · Annotating · N · screenshot · hide markers · discard · Send · ×. */
.bar { gap: 4px; padding: 5px 6px; border-radius: 14px; background: rgba(24,24,27,.94); }
.bar .grip { padding: 0 4px; }
.bar .count { padding: 0 8px 0 2px; font-size: 13px; font-weight: 500; color: #F4F1F7; white-space: nowrap; font-variant-numeric: tabular-nums; }
.tb { width: 32px; height: 32px; border-radius: 9px; }
.tb.on { background: rgba(255,255,255,.12); color: #F4F1F7; box-shadow: none; }
.tb[disabled] { opacity: .35; cursor: default; }
.tb .kbd { bottom: calc(100% + 10px); }
.go { height: 30px; padding: 0 14px; border: 0; border-radius: 9px; background: var(--ink); color: #fff; cursor: pointer;
  font: 600 13px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; transition: filter .15s, transform .15s; display: flex; align-items: center; gap: 6px; }
.go:hover { filter: brightness(1.1); }
.go:active { transform: scale(.96); }
.go[disabled] { opacity: .45; cursor: default; filter: none; }
.go:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.go .live { width: 7px; height: 7px; border-radius: 999px; background: #fff; animation: pulse 1.2s ease-in-out infinite; }
.go.chat { padding: 0 6px; margin-left: -2px; }
.go.start { padding: 0 12px 0 10px; }
.bar.off { padding: 5px; }
.bar .to { height: 30px; max-width: 320px; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 10px; border: 0; border-radius: 9px; cursor: pointer;
  background: rgba(255,255,255,.07); color: #F4F1F7; font: 500 12.5px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.bar .to:hover, .bar .to[aria-expanded="true"] { background: rgba(255,255,255,.13); }
.bar .to .lbl { color: rgba(244,241,247,.5); }
.bar .to .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.bar .to .auto { flex: none; padding: 2px 6px; border-radius: 999px; font-size: 10.5px; font-weight: 600; color: #4ADE80; background: rgba(74,222,128,.12); }
.bar .to .ic { flex: none; opacity: .6; transform: rotate(180deg); }
.bar .to:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.bar .count.rec { color: #FF8A8A; display: flex; align-items: center; gap: 7px; }
.bar .recdot { width: 8px; height: 8px; border-radius: 999px; background: #FF5C5C; animation: pulse 1.2s ease-in-out infinite; }
.tb.recb { color: #FF8A8A; background: rgba(255,92,92,.16); }
/* Discard all pending annotations? */
.confirm { position: fixed; left: 0; right: 0; top: 32%; margin: 0 auto; width: min(320px, calc(100vw - 32px)); padding: 16px; border-radius: 14px;
  background: rgba(30,30,33,.98); color: #F4F1F7; box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 0 0 1px rgba(255,255,255,.08), 0 24px 60px -20px rgba(0,0,0,.8);
  animation: popin .16s cubic-bezier(.34,1.56,.64,1) both; }
.confirm.hidden { display: none; }
.confirm h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.confirm p { margin: 0 0 14px; font-size: 12.5px; color: rgba(244,241,247,.6); }
.confirm .row { display: flex; justify-content: flex-end; gap: 8px; }
.confirm button { height: 30px; padding: 0 14px; border: 0; border-radius: 9px; font: 600 13px/1 ui-sans-serif, system-ui, -apple-system, sans-serif; cursor: pointer; }
.confirm .no { background: rgba(255,255,255,.1); color: #F4F1F7; }
.confirm .yes { background: rgba(255,92,92,.18); color: #FF8A8A; }
.confirm button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
/* The comment: a pill beside the pin; editing a saved one, a card with Cancel and Save. */
.pop { width: min(300px, calc(100vw - 24px)); padding: 4px 4px 4px 12px; background: rgba(24,24,27,.96); }
.pop .ok { width: 24px; height: 24px; background: #F4F1F7; color: #18181B; }
.pop .ok.hidden { display: none; }
.pop.card { flex-direction: column; align-items: stretch; gap: 8px; padding: 10px 10px 8px 12px; border-radius: 14px; }
.pop.card textarea { min-height: 20px; }
.pop .row { display: flex; align-items: center; gap: 6px; }
.pop .row .sp { flex: 1; }
.pop .txt { height: 26px; padding: 0 10px; border: 0; border-radius: 999px; font: 600 12px/1 ui-sans-serif, system-ui, -apple-system, sans-serif; cursor: pointer; }
.pop .cancel { background: rgba(255,255,255,.08); color: #F4F1F7; }
.pop .save { background: #F4F1F7; color: #18181B; }
.pop .txt:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }

@keyframes pop { from { transform: scale(.4); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes slide { from { transform: translateX(-6px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes rise { from { transform: translate(-50%, 12px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
@keyframes drop { from { transform: translateY(-10px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes lift { to { transform: translateY(-8px); opacity: 0; } }
@keyframes popin { from { transform: scale(.85); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes flush { to { transform: scale(.5); opacity: 0; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
@keyframes rimflash { 0% { opacity: 0; } 20% { opacity: .9; } 100% { opacity: 0; } }
@keyframes glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(255,138,138,0); } 50% { box-shadow: 0 0 0 4px rgba(255,138,138,.35); } }
@keyframes wiggle { 0% { transform: none; } 30% { transform: translateY(-6px) scale(1.12); } 60% { transform: translateY(0) scale(.96); } 100% { transform: none; } }
.pin .dot.wiggle { animation: wiggle .5s cubic-bezier(.34,1.56,.64,1) both; }
@keyframes riseN { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }
/* Narrow windows: the bar wraps into rows, centred and inside the viewport. Keep 720 in sync with NARROW. */
@media (max-width: 720px) {
  .bar { left: 8px; right: 8px; bottom: 8px; width: fit-content; max-width: calc(100vw - 16px); margin: 0 auto; transform: none; animation-name: riseN;
    flex-wrap: wrap; justify-content: center; row-gap: 4px; border-radius: 24px; }
  .bar .grip, .bar .sep { display: none; }
  .ticker { bottom: 108px; max-width: calc(100vw - 24px); overflow: hidden; text-overflow: ellipsis; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

  function mount() {
    if (host) return;
    host = document.createElement("claude-annotate");
    host.setAttribute("data-claude-annotate", "");
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    docLayer = el("div", "doc");
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ink");
    svg.innerHTML = '<g class="shapes"></g><g class="draftg"></g>';
    shapesG = svg.firstElementChild;
    draftG = svg.lastElementChild;
    docLayer.appendChild(svg);
    pinsLayer = el("div", "pins");
    docLayer.appendChild(pinsLayer);
    root.appendChild(docLayer);

    chrome = el("div", "chrome");
    rim = el("div", "rim");
    chrome.appendChild(rim);
    toasts = el("div", "toasts");
    toasts.setAttribute("aria-live", "polite");
    chrome.appendChild(toasts);
    ticker = el("div", "ticker");
    ticker.setAttribute("aria-live", "polite");
    chrome.appendChild(ticker);
    hl = el("div", "hl hidden", '<span class="lab"></span>');
    chrome.appendChild(hl);
    ghost = el("div", "ghost hidden");
    chrome.appendChild(ghost);
    confirmBox = el("div", "confirm hidden");
    confirmBox.setAttribute("role", "alertdialog");
    confirmBox.setAttribute("aria-label", "Discard annotations");
    chrome.appendChild(confirmBox);
    chatMenu = el("div", "chats hidden");
    chatMenu.setAttribute("role", "menu");
    chatMenu.setAttribute("aria-label", "Send notes to");
    chrome.appendChild(chatMenu);
    popover = el("div", "pop hidden");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Note");
    chrome.appendChild(popover);
    bar = el("div", "bar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Annotate");
    chrome.appendChild(bar);
    root.appendChild(chrome);

    document.documentElement.appendChild(host);
    if (frozen) sealHost();
    // Turned on to draw: the tool keys must not type into a search box the page focused. Not while
    // holding a hover state, where moving focus could close the very menu being held.
    else if (mode === "draw" && isTextField(document.activeElement)) document.activeElement.blur();
    if (RENDER_ONLY) host.classList.add("capturing");
    applyInk();
    setMode(mode);
    renderToolbar();
    sizeDoc();
    bindEvents();
    restoreBarPos();
    hydrate().finally(() => { api.ready = true; }); // the server screenshots temp pages once ready
    connectSse();
  }

  function isTextField(e) {
    return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName));
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }



  // ---------------------------------------------------------------------------
  // Sizing / coordinates
  // ---------------------------------------------------------------------------
  function docSize() {
    // Body, not <html>: our own layer is a child of <html> and would hold the old size forever.
    const d = document.documentElement, b = document.body;
    return { w: Math.max(b ? b.scrollWidth : 0, d.clientWidth), h: Math.max(b ? b.scrollHeight : 0, d.clientHeight) };
  }
  let lastSize = { w: 0, h: 0 };
  function sizeDoc() {
    const s = docSize();
    if (s.w === lastSize.w && s.h === lastSize.h) return;
    lastSize = s;
    docLayer.style.width = s.w + "px";
    docLayer.style.height = s.h + "px";
    svg.setAttribute("width", s.w);
    svg.setAttribute("height", s.h);
    svg.setAttribute("viewBox", `0 0 ${s.w} ${s.h}`);
  }
  const toDoc = (e) => [Math.round(e.clientX + scrollX), Math.round(e.clientY + scrollY)];

  // ---------------------------------------------------------------------------
  // Element context (what is under a point)
  // ---------------------------------------------------------------------------
  function elementAt(x, y) {
    host.style.visibility = "hidden"; // takes the host out of hit testing
    const e = document.elementFromPoint(clamp(x - scrollX, 0, innerWidth - 1), clamp(y - scrollY, 0, innerHeight - 1));
    host.style.visibility = "";
    return !e || e === document.documentElement ? null : e;
  }
  function shortSel(e) {
    if (!e || e.nodeType !== 1) return "";
    let s = e.tagName.toLowerCase();
    if (e.id) return `${s}#${e.id}`;
    const cls = [...e.classList].filter((c) => !/^(css-|sc-|_)/.test(c) && c.length < 40).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    const role = e.getAttribute("role");
    if (role) s += `[role=${role}]`;
    const dt = e.getAttribute("data-testid");
    if (dt) s += `[data-testid=${dt}]`;
    return s;
  }
  function reactInfo(e) {
    const out = { components: [], source: null };
    try {
      let node = e, fiber = null;
      for (let i = 0; i < 6 && node && !fiber; i++) {
        const k = Object.keys(node).find((key) => key.startsWith("__reactFiber$"));
        if (k) fiber = node[k];
        else node = node.parentElement;
      }
      if (!fiber) return out;
      const isLibFile = (file) => /node_modules|\/@(?!fs\/)|react-dom|react-refresh|chunk-|\.vite\//.test(file);
      // ponytail: React 19 line numbers are post-transform (esbuild-shifted under Vite, chunk
      // offsets under Turbopack). The file is right, the line is a hint. React 18 is exact.
      // Where this fiber was created: React <19 keeps _debugSource, React 19 keeps the
      // owner stack. Returns { src, user } with src like "src/App.tsx:12".
      const callSite = (f) => {
        if (f._debugSource && f._debugSource.fileName) {
          const file = f._debugSource.fileName;
          return { src: `${relPath(file)}:${f._debugSource.lineNumber}`, user: !isLibFile(file) };
        }
        const st = f._debugStack;
        const stack = typeof st === "string" ? st : st && st.stack;
        if (!stack) return null;
        const frames = [...stack.matchAll(/\(?((?:https?:\/\/[^\s)]+?)|(?:\/[^\s)]+?)):(\d+):(\d+)\)?/g)].map((x) => ({ file: x[1], line: x[2] }));
        const user = frames.find((fr) => !isLibFile(fr.file));
        if (user) return { src: `${relPath(user.file)}:${user.line}`, user: true };
        return frames.length ? { src: null, user: false } : null;
      };
      const nameOf = (t) => (typeof t === "function" ? (t.displayName || t.name) : t && typeof t === "object" ? (t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name))) : null) || null;
      const NOISE = /Slot|Collection|Provider|Consumer|Context|Impl$|^Primitive|Presence|Portal|FocusScope|Dismissable|RovingFocus|^Fragment$|^Suspense$|^StrictMode$|^Profiler$|^Root$/;
      let f = fiber;
      for (let depth = 0; f && depth < 80; depth++, f = f.return) {
        const name = nameOf(f.type);
        const site = callSite(f);
        if (!out.source && site && site.user) out.source = site.src;
        if (name && !name.startsWith("_") && !NOISE.test(name) && out.components.length < 5 && !out.components.includes(name)) {
          // Keep components that appear in the user's own JSX (or whose origin is unknown).
          if (!site || site.user) out.components.push(name);
        }
        if (out.components.length >= 5 && out.source) break;
      }
    } catch { /* not react */ }
    return out;
  }
  function relPath(p) {
    if (!/^https?:/.test(p)) return p.replace(/^\/\.\//, ""); // FS path (React 18) or webpack-internal "/./app/page.tsx"
    try { p = new URL(p).pathname; } catch { return p; } // Vite: drop origin and ?t=
    return p.startsWith("/@fs/") ? p.slice(4) : p.replace(/^\//, ""); // /@fs/abs → /abs, /src/x.tsx → src/x.tsx
  }

  function describe(e) {
    const doc = e && e.ownerDocument;
    if (!e || e === doc.body || e === doc.documentElement) return null;
    const win = doc.defaultView;
    const r = e.getBoundingClientRect();
    const text = (e.innerText || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90);
    const chain = [];
    let p = e.parentElement;
    while (p && p !== doc.body && chain.length < 3) { chain.unshift(shortSel(p)); p = p.parentElement; }
    return {
      selector: shortSel(e), text,
      rect: [Math.round(r.left + win.scrollX), Math.round(r.top + win.scrollY), Math.round(r.width), Math.round(r.height)],
      chain: chain.join(" > "), react: reactInfo(e),
    };
  }

  // ---------------------------------------------------------------------------
  // Element picker, across frames
  // ---------------------------------------------------------------------------
  // pickIn(doc, x, y) → { rect: [left, top, w, h] in doc's viewport, ctx, frames } for the element
  // under the point. A same-origin frame is searched directly; a frame from another origin is asked
  // over postMessage, where the extension's frame helper (installFrameProbe) answers, forwarding
  // to its own frames the same way. A frame with no helper is picked as a whole.
  // hideOverlay: the top document's call, which must look past the overlay. Frames never touch it.
  async function pickIn(doc, x, y, hideOverlay = false) {
    if (hideOverlay) host.style.visibility = "hidden";
    const el = doc.elementFromPoint(x, y);
    if (hideOverlay) host.style.visibility = "";
    if (!el || el === doc.body || el === doc.documentElement) return null;
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      const r = el.getBoundingClientRect(), ox = r.left + el.clientLeft, oy = r.top + el.clientTop;
      let inner = null;
      try { inner = el.contentDocument; } catch { /* another origin */ }
      const sub = inner ? await pickIn(inner, x - ox, y - oy) : await askFrame(el.contentWindow, x - ox, y - oy);
      if (sub) return { rect: [sub.rect[0] + ox, sub.rect[1] + oy, sub.rect[2], sub.rect[3]], ctx: sub.ctx, frames: [frameName(el), ...(sub.frames || [])] };
    }
    const r = el.getBoundingClientRect();
    return { rect: [r.left, r.top, r.width, r.height], ctx: describe(el), frames: [] };
  }
  function frameName(el) {
    const src = el.getAttribute("src");
    if (!src) return el.hasAttribute("srcdoc") ? "inline frame" : "blank frame";
    try { const u = new URL(src, el.ownerDocument.baseURI); return u.origin + u.pathname; } catch { return src.slice(0, 80); }
  }
  let askSeq = 0;
  function askFrame(win, x, y) {
    return new Promise((resolve) => {
      const id = `${Math.random().toString(36).slice(2)}:${++askSeq}`;
      const done = (v) => { clearTimeout(timer); removeEventListener("message", onAnswer); resolve(v); };
      const onAnswer = (e) => { if (e.source === win && e.data && e.data.claudeAnnotate === "here" && e.data.id === id) done(e.data.pick || null); };
      const timer = setTimeout(() => done(null), 250);
      addEventListener("message", onAnswer);
      try { win.postMessage({ claudeAnnotate: "at", id, x, y }, "*"); } catch { done(null); }
    });
  }
  // In a frame: answer "what is at (x, y)?" with this frame's element. Only a page that contains
  // this frame may ask (the asker can be further up when it searched a same-origin frame itself);
  // the answer goes back to the asker alone.
  function installFrameProbe() {
    if (window.__claudeAnnotateProbe) return;
    window.__claudeAnnotateProbe = true;
    const isAncestor = (w) => { for (let a = window.parent; ; a = a.parent) { if (a === w) return true; if (a === a.parent) return false; } };
    addEventListener("message", async (e) => {
      if (!e.data || e.data.claudeAnnotate !== "at" || !e.source || !isAncestor(e.source)) return;
      let pick = null;
      try { pick = await pickIn(document, e.data.x, e.data.y); } catch { /* answer null */ }
      e.source.postMessage({ claudeAnnotate: "here", id: e.data.id, pick }, "*");
    });
  }
  function ctxAtPoint(x, y) { return describe(elementAt(x, y)); }
  function ctxForBox(x, y, w, h) {
    const c = ctxAtPoint(x + w / 2, y + h / 2);
    const inside = [];
    try {
      const hasOwnText = (n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      const cands = [];
      for (const n of document.body.querySelectorAll("*")) {
        if (n.closest("svg")) continue;
        const interactive = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|IMG|LABEL)$/.test(n.tagName) || n.getAttribute("role") === "button";
        if (!interactive && !hasOwnText(n)) continue;
        const r = n.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const nx = r.left + scrollX, ny = r.top + scrollY;
        if (nx >= x - 4 && ny >= y - 4 && nx + r.width <= x + w + 4 && ny + r.height <= y + h + 4) {
          const t = (n.textContent || n.getAttribute("alt") || n.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40);
          const fs = parseFloat(getComputedStyle(n).fontSize) || 0;
          cands.push({ n, t, fs, area: r.width * r.height });
        }
      }
      cands.sort((a, b) => b.fs - a.fs || b.area - a.area);
      const seen = new Set();
      for (const c of cands) {
        const key = `${shortSel(c.n)}|${c.t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inside.push(`<${shortSel(c.n)}>${c.t ? ` "${c.t}"` : ""}`);
        if (inside.length >= 6) break;
      }
    } catch { /* ignore */ }
    if (c) c.inside = inside;
    return c;
  }
  function ctxForShape(s) {
    const b = bbox(s);
    if (s.type === "arrow") return ctxAtPoint(s.x2, s.y2);
    if (s.type === "rect" || s.type === "ellipse") return ctxForBox(b.x, b.y, b.w, b.h);
    return ctxForBox(b.x, b.y, b.w, b.h); // pen: usually a circle around something
  }

  // ---------------------------------------------------------------------------
  // Geometry + rendering of marks
  // ---------------------------------------------------------------------------
  function bbox(s) {
    if (s.type === "pen") {
      const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    if (s.type === "arrow" || s.type === "line") {
      const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
      return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    }
    return { x: s.x, y: s.y, w: s.w, h: s.h };
  }
  function penPath(pts) {
    if (pts.length < 2) return `M${pts[0][0]} ${pts[0][1]}`;
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
    }
    const l = pts[pts.length - 1];
    d += ` L${l[0]} ${l[1]}`;
    return d;
  }
  function arrowParts(s) {
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const size = 11; // in step with the 2px line
    const bx = s.x2 - Math.cos(a) * size * 0.75, by = s.y2 - Math.sin(a) * size * 0.75;
    const p1 = [s.x2 - size * Math.cos(a - 0.5), s.y2 - size * Math.sin(a - 0.5)];
    const p2 = [s.x2 - size * Math.cos(a + 0.5), s.y2 - size * Math.sin(a + 0.5)];
    return { line: `M${s.x1} ${s.y1} L${bx} ${by}`, head: `${s.x2},${s.y2} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}` };
  }
  function shapeSvg(s, cls = "shape") {
    const hex = (INKS.find((i) => i.id === s.color) || INKS[0]).hex;
    let body = "", hit = "";
    if (s.type === "pen") {
      const d = penPath(s.points);
      body = `<path class="halo" d="${d}"/><path class="line" stroke="${hex}" d="${d}"/>`;
      hit = `<path class="hit" d="${d}"/>`;
    } else if (s.type === "rect") {
      const a = `x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}"`;
      body = `<rect class="halo box" ${a}/><rect class="line box" stroke="${hex}" fill="${hex}" fill-opacity=".07" ${a}/>`;
      hit = `<rect class="hit" ${a}/>`;
    } else if (s.type === "ellipse") {
      const a = `cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}"`;
      body = `<ellipse class="halo" ${a}/><ellipse class="line" stroke="${hex}" ${a}/>`;
      hit = `<ellipse class="hit" ${a}/>`;
    } else if (s.type === "arrow") {
      const { line, head } = arrowParts(s);
      body = `<path class="halo" d="${line}"/><path class="line" stroke="${hex}" d="${line}"/><polygon class="head" fill="${hex}" points="${head}"/>`;
      hit = `<path class="hit" d="M${s.x1} ${s.y1} L${s.x2} ${s.y2}"/>`;
    } else if (s.type === "line") {
      const d = `M${s.x1} ${s.y1} L${s.x2} ${s.y2}`;
      body = `<path class="halo" d="${d}"/><path class="line" stroke="${hex}" d="${d}"/>`;
      hit = `<path class="hit" d="${d}"/>`;
    }
    // An element mark, an area, or a screenshot of the view; "active" while its comment is open.
    const kind = s.type !== "rect" ? "" : s.shot ? " shot" : s.element ? " el" : " region";
    const active = popNote && popNote.shape === s.id ? " active" : "";
    return `<g class="${cls}${kind}${active}" data-id="${s.id}">${body}${hit}</g>`;
  }
  // An anchored mark is drawn inside a nested <svg> the size of its scroll container's visible
  // area: the viewBox keeps document coordinates, and the nested viewport clips what scrolled out.
  function renderInk() {
    shapesG.innerHTML = shapes.map((s) => {
      const c = clipRect(s.id);
      return c ? `<svg x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" viewBox="${c.x} ${c.y} ${c.w} ${c.h}" overflow="hidden">${shapeSvg(s)}</svg>` : shapeSvg(s);
    }).join("");
    renderDraft();
  }
  function renderDraft() { draftG.innerHTML = draft ? shapeSvg(draft, "draft") : ""; }
  // ---------------------------------------------------------------------------
  // Pins
  // ---------------------------------------------------------------------------
  function renderPins() {
    pinsLayer.innerHTML = "";
    for (const n of notes) {
      const inkDef = INKS.find((i) => i.id === n.color) || INKS[0];
      const p = el("div", `pin ${n.status || "draft"}`);
      p.dataset.id = n.id;
      p.style.cssText = `left:${n.x}px;top:${n.y}px;--ink:${inkDef.hex};--ink-dark:${inkDef.dark};--ink-soft:${inkDef.hex}55`;
      if (scrolledOut(n)) p.classList.add("out");
      if (popNote && popNote.id === n.id) p.classList.add("editing");
      p.innerHTML = `<span class="ring"></span><button class="dot" type="button" aria-label="Note ${n.n}"><span class="n">${n.n}</span>${svgIcon("check", 12)}</button>${n.text ? `<span class="tag" title="${esc(n.text)}">${tagHtml(n)}</span>` : ""}`;
      pinsLayer.appendChild(p);
    }
  }
  function tagHtml(n) { return `<span class="txt">${esc(n.text || "…")}</span>`; } // Claude's reply stays in Claude Code
  function updatePin(n) {
    const p = pinsLayer.querySelector(`.pin[data-id="${n.id}"]`);
    if (!p) return renderPins();
    p.className = `pin ${n.status || "draft"}`;
    const tag = p.querySelector(".tag");
    if (tag) tag.innerHTML = tagHtml(n);
    else renderPins();
  }
  function wigglePins(stagger = 50) {
    [...pinsLayer.querySelectorAll(".pin .dot")].forEach((d, i) => {
      setTimeout(() => { d.classList.remove("wiggle"); void d.offsetWidth; d.classList.add("wiggle"); }, i * stagger);
    });
  }

  // ---------------------------------------------------------------------------
  // Scroll anchors: marks over a scroll container move with it
  // ---------------------------------------------------------------------------
  // mark id → [{ el, left, top }]: each scroll container between the element under the mark and
  // the document, with the scroll offset its mark's coordinates are current for. The window's own
  // scroll needs none: marks are in document coordinates.
  const anchors = new Map();
  function scrollersOf(e) {
    const list = [];
    for (let n = e; n && n !== document.body && n !== document.documentElement; n = n.parentElement || n.getRootNode().host) {
      if (n.nodeType !== 1) continue;
      const st = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(st.overflowY + st.overflowX)) list.push({ el: n, left: n.scrollLeft, top: n.scrollTop });
    }
    return list;
  }
  // The point a mark is about: an arrow's head, a pin, else the middle of the mark.
  function anchorPoint(m) {
    if (m.type === "arrow" || m.type === "line") return [m.x2, m.y2];
    if (m.type) { const b = bbox(m); return [b.x + b.w / 2, b.y + b.h / 2]; }
    return [m.x, m.y];
  }
  function anchorMark(m) {
    const linked = !m.type && m.shape && anchors.get(m.shape);
    if (linked) { anchors.set(m.id, linked); return; } // a mark's comment moves with its mark
    const [x, y] = anchorPoint(m);
    const at = elementAt(x, y);
    const list = at ? scrollersOf(at) : [];
    if (list.length) anchors.set(m.id, list);
    else anchors.delete(m.id);
  }
  function anchorAll() {
    anchors.clear();
    for (const s of shapes) anchorMark(s);
    for (const n of notes) anchorMark(n);
  }
  function shiftMark(m, dx, dy) {
    if (m.type === "pen") m.points = m.points.map(([x, y]) => [x + dx, y + dy]);
    else if (m.type === "arrow" || m.type === "line") { m.x1 += dx; m.y1 += dy; m.x2 += dx; m.y2 += dy; }
    else { m.x += dx; m.y += dy; }
  }
  // Moves every anchored mark by how far its containers scrolled since it was last placed.
  // A comment shares its mark's anchor list, so the list is brought up to date once per frame.
  let followFrame = 0;
  function followScrollSoon() {
    if (!anchors.size || followFrame) return;
    followFrame = requestAnimationFrame(followScroll);
  }
  function followScroll() {
    followFrame = 0;
    const deltas = new Map(); // anchor list → [dx, dy]
    for (const list of new Set(anchors.values())) {
      let dx = 0, dy = 0;
      for (const a of list) {
        dx += a.left - a.el.scrollLeft; dy += a.top - a.el.scrollTop;
        a.left = a.el.scrollLeft; a.top = a.el.scrollTop;
      }
      if (dx || dy) deltas.set(list, [dx, dy]);
    }
    if (!deltas.size) return;
    for (const m of [...shapes, ...notes]) {
      const d = deltas.get(anchors.get(m.id));
      if (d) shiftMark(m, d[0], d[1]);
    }
    renderInk();
    renderPins();
    placePopover();
    save();
  }
  // What of the document an anchored mark may show in: the visible area its containers share.
  function clipRect(id) {
    const list = anchors.get(id);
    if (!list || !list.some((a) => a.el.isConnected)) return null;
    let l = -Infinity, t = -Infinity, r = Infinity, b = Infinity;
    for (const a of list) {
      if (!a.el.isConnected) continue;
      const box = a.el.getBoundingClientRect();
      l = Math.max(l, box.left + a.el.clientLeft); t = Math.max(t, box.top + a.el.clientTop);
      r = Math.min(r, box.left + a.el.clientLeft + a.el.clientWidth); b = Math.min(b, box.top + a.el.clientTop + a.el.clientHeight);
    }
    return { x: Math.round(l + scrollX), y: Math.round(t + scrollY), w: Math.max(0, Math.round(r - l)), h: Math.max(0, Math.round(b - t)) };
  }
  function scrolledOut(n) {
    const c = clipRect(n.id);
    return !!c && (n.x < c.x || n.y < c.y || n.x > c.x + c.w || n.y > c.y + c.h);
  }

  // ---------------------------------------------------------------------------
  // Popover (note text)
  // ---------------------------------------------------------------------------
  let popNote = null;
  // The dev server may full-reload the page mid-sentence; keep the open note's text so mount can reopen it.
  const DRAFT_KEY = "claude-annotate:draft";
  const stashDraft = (v) => { try { v ? sessionStorage.setItem(DRAFT_KEY, JSON.stringify(v)) : sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };
  function reopenDraft() {
    let d; try { d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { return; }
    if (!d || d.url !== pageUrl() || popNote) return;
    let note = notes.find((k) => k.id === d.note.id);
    if (!note) { if (!d.isNew) return stashDraft(null); note = d.note; notes.push(note); renderPins(); }
    openPopover(note, d.isNew, d.text);
  }
  // New: a pill beside the pin, "Add a comment…", a check once there is text. Enter saves,
  // Shift+Enter breaks the line, Esc drops it only while empty. Saved: a card to retype it, with
  // a trash, Cancel and Save.
  function openPopover(note, isNew = false, text = note.text) {
    popNote = note;
    const inkDef = INKS.find((i) => i.id === note.color) || INKS[0];
    popover.style.setProperty("--ink", inkDef.hex);
    popover.style.setProperty("--ink-dark", inkDef.dark);
    popover.classList.toggle("card", !isNew);
    popover.innerHTML = isNew
      ? `<textarea placeholder="Add a comment…" rows="1" maxlength="600" aria-label="Comment ${note.n}"></textarea>
      <button class="ok hidden" type="button" title="Save (↵)" aria-label="Save">${svgIcon("check", 14)}</button>`
      : `<textarea rows="1" maxlength="600" aria-label="Comment ${note.n}"></textarea>
      <div class="row"><button class="del" type="button" title="Delete" aria-label="Delete">${svgIcon("trash", 14)}</button><span class="sp"></span>
      <button class="txt cancel" type="button">Cancel</button><button class="txt save" type="button">Save</button></div>`;
    const ta = popover.querySelector("textarea");
    ta.value = text || "";
    popover.classList.remove("hidden");
    pinsLayer.querySelector(`.pin[data-id="${note.id}"]`)?.classList.add("editing");
    renderInk(); // its mark shows while the comment is open
    const ok = popover.querySelector(".ok");
    // One line, like a chat field; it grows, and turns from a pill into a card, past one.
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(140, ta.scrollHeight) + "px";
      if (isNew) popover.classList.toggle("multi", ta.scrollHeight > 26);
      if (ok) ok.classList.toggle("hidden", !ta.value.trim());
    };
    ta.addEventListener("input", grow);
    const url = pageUrl();
    ta.addEventListener("input", () => stashDraft({ url, note, isNew, text: ta.value }));
    grow();
    placePopover();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitPopover(); }
      if (e.key === "Escape") {
        e.preventDefault();
        if (!isNew) closePopover(); // Cancel: the saved words stay
        else if (!ta.value.trim()) cancelPopover(true);
      }
    });
    if (ok) ok.addEventListener("click", commitPopover);
    popover.querySelector(".save")?.addEventListener("click", commitPopover);
    popover.querySelector(".cancel")?.addEventListener("click", () => closePopover());
    popover.querySelector(".del")?.addEventListener("click", () => { deleteNote(note.id); closePopover(); });
  }
  // Beside the pin, to its right; to its left or above where the window ends.
  function placePopover() {
    if (!popNote || popover.classList.contains("hidden")) return;
    const w = popover.offsetWidth || 300, h = popover.offsetHeight || 36;
    const px = popNote.x - scrollX, py = popNote.y - scrollY;
    let left = px + 16, top = py - 16;
    let ox = "0", oy = "0";
    if (left + w > innerWidth - 12) { left = px - 16 - w; ox = "100%"; }
    if (top + h > innerHeight - 12) { top = Math.max(12, py - h + 16); oy = "100%"; }
    popover.style.left = clamp(left, 12, innerWidth - w - 12) + "px";
    popover.style.top = clamp(top, 12, innerHeight - h - 12) + "px";
    popover.style.setProperty("--ox", ox);
    popover.style.setProperty("--oy", oy);
  }
  function commitPopover() {
    if (!popNote) return;
    const ta = popover.querySelector("textarea");
    const t = (ta.value || "").trim();
    if (!t) { deleteNote(popNote.id, false, true); closePopover(); return; }
    pushUndo();
    const note = popNote;
    note.text = t;
    closePopover();
    renderPins();
    save();
    renderToolbar();
    capturePreview(note);
  }
  function cancelPopover(isNew) {
    if (isNew && popNote && !popNote.text) deleteNote(popNote.id, true, true);
    closePopover();
  }
  function closePopover() {
    const was = popNote;
    popover.classList.add("hidden");
    popover.classList.remove("card", "multi");
    popover.innerHTML = "";
    popNote = null;
    stashDraft(null);
    pinsLayer.querySelector(".pin.editing")?.classList.remove("editing");
    if (was && was.shape) renderInk();
    if (was) { const d = pinsLayer.querySelector(`.pin[data-id="${was.id}"] .dot`); if (d) d.focus({ preventScroll: true }); }
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------
  function snapshot() { return JSON.stringify({ shapes, notes }); }
  function pushUndo() { undo.push(snapshot()); if (undo.length > 60) undo.shift(); redo.length = 0; renderToolbar(); }
  function restore(json) { const s = JSON.parse(json); shapes = s.shapes; notes = s.notes; anchorAll(); renderInk(); renderPins(); save(); renderToolbar(); }
  function doUndo() { if (!undo.length) return; redo.push(snapshot()); restore(undo.pop()); }
  function doRedo() { if (!redo.length) return; undo.push(snapshot()); restore(redo.pop()); }
  function addShape(s) { pushUndo(); if (!s.ctx) s.ctx = ctxForShape(s); shapes.push(s); anchorMark(s); renderInk(); save(); renderToolbar(); }
  // Deleting a mark's comment deletes the mark (keepShape: the comment was only dismissed).
  function deleteNote(id, silent = false, keepShape = false) {
    if (!silent) pushUndo();
    const note = notes.find((n) => n.id === id);
    notes = notes.filter((n) => n.id !== id);
    if (note && note.shape && !keepShape) { shapes = shapes.filter((s) => s.id !== note.shape); renderInk(); }
    renderPins();
    save();
  }
  let creating = false;
  // A comment on a mark (shape) is a note pinned to it: it reports what the mark covers, and
  // deleting it deletes the mark. Left empty, the note goes and the mark stays.
  async function createNote(x, y, shape = null, extra = null) {
    if (creating) return;
    creating = true;
    try {
      let n;
      try { n = (await req("POST", "/note/next")).n; } catch { /* numbered here */ }
      if (!Number.isInteger(n)) n = Math.max(0, ...notes.map((k) => k.n)) + 1;
      const note = { id: uid(), n, x, y, color: shape ? shape.color : ink.id, text: "", status: "draft", ctx: shape ? shape.ctx : ctxAtPoint(x, y), batch: null };
      if (shape) note.shape = shape.id;
      if (extra) Object.assign(note, extra);
      notes.push(note);
      anchorMark(note);
      renderPins();
      openPopover(note, true);
    } finally { creating = false; }
  }
  async function clearAll() {
    pushUndo();
    shapes = []; notes = []; anchors.clear(); phase = "idle";
    renderInk(); renderPins(); renderToolbar();
    try { await req("POST", "/clear"); toast("Cleared. Fresh page.", "ok"); } catch (e) { toast(e.message === "busy" ? "Still sending, clear again in a moment." : `Couldn't clear: ${e.message}`); }
  }

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------
  function applyInk() {
    host.style.setProperty("--ink", ink.hex);
    host.style.setProperty("--ink-dark", ink.dark);
    host.style.setProperty("--cursor", "default");
  }
  // Annotate on or off. On: every click marks. Off: the page is the page again; the pins hide but
  // stay, as in Codex, and come back when Annotate is pressed again.
  function setMode(m) {
    mode = m;
    host.classList.toggle("draw", m === "draw");
    host.classList.toggle("browse", m === "browse");
    if (m !== "draw") { hideHighlight(); setSpace(false); if (popNote) commitPopover(); }
    renderToolbar();
  }
  // Space held: the page takes the pointer (to open a menu, scroll, type) until it is let go.
  function setSpace(on) {
    spaceHeld = on;
    host.classList.toggle("space", on);
    if (on) hideHighlight();
  }
  function setMarkersHidden(on) {
    markersHidden = on;
    host.classList.toggle("hidemarks", on);
    renderToolbar();
  }
  function setLink(s) {
    linkState = s;
    host.classList.toggle("link-on", s === "on");
    host.classList.toggle("link-connecting", s === "connecting");
    host.classList.toggle("link-off", s === "off");
  }
  // Where this page's notes stand, for the Send button's title and the ticker.
  function streamState() {
    const waiting = waitingComments();
    if (phase === "sending") return { label: "Sending…", cls: "sending" };
    if (waiting) return { label: `${waiting} to send`, cls: "idle" };
    if (phase === "sent" && totals.open > 0) return { label: "Claude is on it", cls: "sent" };
    if (phase === "done" && totals.batches > 0) return { label: "Done", cls: "done" };
    return { label: "Nothing to send", cls: "idle" };
  }
  // Off: one Annotate button. On: grip · Annotating · N · screenshot · record · hide markers ·
  // discard · the chat the notes go to · Add to chat · ×.
  let lastBar = "";
  function renderToolbar() {
    if (!bar) return;
    const waiting = waitingComments();
    const tb = (act, icon, title, extra = "", attrs = "") =>
      `<button class="tb ${extra}" type="button" data-act="${act}" aria-label="${title}" ${attrs}>${svgIcon(icon)}<span class="kbd">${title}</span></button>`;
    const grip = `<span class="grip" title="Drag">${svgIcon("grip", 16)}<span class="st"></span></span>`;
    const secs = recorder ? Math.floor((Date.now() - recStart) / 1000) : 0;
    const status = recorder
      ? `<span class="count rec" role="status"><span class="recdot"></span>Recording ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}</span>`
      : `<span class="count" role="status" aria-live="polite">Annotating · ${waiting}</span>`;
    const to = CHOOSES_CHAT
      ? `<button class="to" type="button" data-act="chats" aria-haspopup="menu" aria-expanded="${chatMenuOpen}" title="${esc(CFG.sendsPrompt ? `Last message there: ${CFG.sendsPrompt}` : "Click to pick another chat")}"><span class="lbl">To</span><span class="name">${esc(chatLabel())}</span>${CFG.automatic ? '<span class="auto">open chat</span>' : ""}${svgIcon("chevron", 13)}</button>`
      : "";
    const html = mode !== "draw"
      ? `${grip}<button class="go start" type="button" data-act="annotate" aria-label="Annotate">${svgIcon("annotate", 15)}<span>Annotate</span></button>`
      : `${grip}${frozen ? `
      <span class="frozen" title="The page's hover state is held while you annotate">Hover held</span>` : ""}
      ${status}
      ${tb("shot", "shot", "Take a screenshot")}
      ${recorder ? tb("record", "stop", "Stop recording", "on recb") : tb("record", "video", "Record the tab", "", navigator.mediaDevices?.getDisplayMedia ? "" : "disabled")}
      ${tb("hide", markersHidden ? "eye" : "eyeoff", markersHidden ? "Show markers" : "Hide markers", markersHidden ? "on" : "", `aria-pressed="${markersHidden}"`)}
      ${tb("discard", "trash", "Discard annotations", "", shapes.length || notes.length ? "" : "disabled")}
      <span class="sep"></span>${to}
      <button class="go" type="button" data-act="add" title="The notes wait above the prompt in Claude Code and go with your next message (⌘↵)" ${!waiting || recorder ? "disabled" : ""}><span>Add to chat</span></button>
      ${tb("exit", "x", "Exit annotation mode")}`;
    if (html !== lastBar) { lastBar = html; bar.innerHTML = html; bar.classList.toggle("off", mode !== "draw"); }
  }

  // ---------------------------------------------------------------------------
  // Recording the tab: a note whose subject is a short screen recording
  // ---------------------------------------------------------------------------
  const REC_MAX_MS = 60000;
  let recorder = null, recStart = 0, recTimer = null, recChunks = [];
  async function startRecording() {
    if (recorder) return;
    if (popNote) commitPopover();
    let stream;
    try {
      // The browser asks which tab, window or screen; this tab is offered first.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude" });
    } catch { return; } // declined
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
    recChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1500000 });
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => finishRecording(stream, type);
    stream.getVideoTracks()[0]?.addEventListener("ended", stopRecording); // "Stop sharing" in the browser's bar
    recorder.start(1000);
    recStart = Date.now();
    recTimer = setInterval(() => { renderToolbar(); if (Date.now() - recStart >= REC_MAX_MS) stopRecording(); }, 500);
    renderToolbar();
  }
  function stopRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }
  async function finishRecording(stream, type) {
    clearInterval(recTimer); recTimer = null;
    for (const t of stream.getTracks()) t.stop();
    const duration = (Date.now() - recStart) / 1000;
    recorder = null;
    renderToolbar();
    const blob = new Blob(recChunks, { type: type || "video/webm" });
    recChunks = [];
    if (blob.size < 1000) return;
    tick("saving the recording…");
    let video;
    try {
      const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
      video = (await req("POST", "/video", { data: String(data).replace(/^data:video\/webm;[^,]*,/, "data:video/webm;base64,"), duration })).video;
    } catch (e) { return toast(`Couldn't keep the recording: ${e.message}`); }
    // The view in front of you, marked as a recording; its comment says what to look at.
    const s = { id: uid(), type: "rect", shot: true, color: ink.id, x: Math.round(scrollX + 1), y: Math.round(scrollY + 1), w: innerWidth - 2, h: innerHeight - 2 };
    s.ctx = { selector: "recording", text: `${Math.round(duration)} s`, rect: [s.x, s.y, s.w, s.h], chain: "", react: { components: [], source: null } };
    addShape(s);
    createNote(Math.round(scrollX + innerWidth / 2), Math.round(scrollY + innerHeight / 2), s, { video });
  }

  // ---------------------------------------------------------------------------
  // Claude's annotate_screenshot: the tab in view on that page captures itself
  // ---------------------------------------------------------------------------
  const samePage = (url) => { try { const u = new URL(url, location.href); return u.origin === location.origin && u.pathname.replace(/\/$/, "") === location.pathname.replace(/\/$/, ""); } catch { return false; } };
  async function verifyShot(m) {
    if (CFG.startMode !== "draw" || document.visibilityState !== "visible" || (m.url && !samePage(m.url))) return;
    let target = null;
    if (m.selector) {
      try { target = document.querySelector(m.selector); } catch { /* not a selector */ }
      if (target) {
        const r = target.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) { target.scrollIntoView({ block: "nearest" }); await new Promise((res) => setTimeout(res, 120)); }
      }
    }
    host.style.display = "none"; // the page alone: no toolbar, pins or marks
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
    let image = null;
    try { image = await askExtensionForShot(); } catch { /* none */ }
    host.style.display = "";
    if (!image) return;
    if (target) {
      try {
        const shot = await decodeDataUrl(image);
        const r = target.getBoundingClientRect(), k = shot.width / innerWidth;
        const x0 = clamp(r.left, 0, innerWidth), y0 = clamp(r.top, 0, innerHeight), x1 = clamp(r.right, x0 + 1, innerWidth), y1 = clamp(r.bottom, y0 + 1, innerHeight);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round((x1 - x0) * k); canvas.height = Math.round((y1 - y0) * k);
        canvas.getContext("2d").drawImage(shot, x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k, 0, 0, canvas.width, canvas.height);
        shot.close();
        image = canvas.toDataURL("image/jpeg", 0.9);
      } catch { /* the whole view goes */ }
    }
    await req("POST", "/verify-shot", { id: m.id, image }).catch(() => {});
  }

  // Discard all pending annotations? Cancel / Discard, as Codex asks.
  function openDiscard() {
    confirmDiscard = true;
    confirmBox.innerHTML = `<h2>Discard all pending annotations?</h2><p>All edits will be removed from the page</p><div class="row"><button class="no" type="button">Cancel</button><button class="yes" type="button">Discard</button></div>`;
    confirmBox.classList.remove("hidden");
    confirmBox.querySelector(".no").addEventListener("click", closeDiscard);
    confirmBox.querySelector(".yes").addEventListener("click", () => { closeDiscard(); clearAll(); });
    confirmBox.querySelector(".no").focus();
  }
  function closeDiscard() {
    confirmDiscard = false;
    confirmBox.classList.add("hidden");
    confirmBox.innerHTML = "";
  }
  // Leaving annotation mode: through the extension (it unmounts us), or back to browsing.
  function exitAnnotating() {
    if (popNote) commitPopover();
    if (CFG.startMode === "draw") document.dispatchEvent(new CustomEvent("claude-annotate:exit"));
    else setMode("browse");
  }
  // Take a screenshot: the part of the page in view becomes an area mark, with a comment to write.
  function screenshotView() {
    if (popNote) commitPopover();
    const s = { id: uid(), type: "rect", shot: true, color: ink.id, x: Math.round(scrollX + 1), y: Math.round(scrollY + 1), w: innerWidth - 2, h: innerHeight - 2 };
    s.ctx = { selector: "screenshot", text: "", rect: [s.x, s.y, s.w, s.h], chain: "", react: { components: [], source: null } };
    addShape(s);
    createNote(Math.round(scrollX + innerWidth / 2), Math.round(scrollY + innerHeight / 2), s);
  }

  // ---------------------------------------------------------------------------
  // Toolbar position (draggable, remembered per origin)
  // ---------------------------------------------------------------------------
  const POS_KEY = "claude-annotate:bar";
  const NARROW = matchMedia("(max-width: 720px)"); // the CSS lays the bar out there; no dragging
  function restoreBarPos() {
    if (NARROW.matches) { bar.removeAttribute("style"); return; }
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p && typeof p.x === "number") placeBar(p.x, p.y);
    } catch { /* ignore */ }
  }
  function placeBar(x, y) {
    bar.style.animation = "none"; // the rise keyframes keep translateX(-50%) applied and would shift a positioned bar
    const w = bar.offsetWidth || 560, h = bar.offsetHeight || 48;
    x = clamp(x, 8, innerWidth - w - 8);
    y = clamp(y, 8, innerHeight - h - 8);
    bar.style.left = x + "px";
    bar.style.top = y + "px";
    bar.style.bottom = "auto";
    bar.style.transform = "none";
  }
  function bindDrag() {
    let start = null;
    bar.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".grip")) return;
      const r = bar.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.classList.add("dragging");
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => { if (start) placeBar(e.clientX - start.dx, e.clientY - start.dy); });
    const stop = () => {
      if (!start) return;
      start = null;
      bar.classList.remove("dragging");
      const r = bar.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top })); } catch { /* ignore */ }
    };
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function bindEvents() {
    // Toolbar clicks (delegated; toolbar re-renders often)
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.disabled) return;
      switch (b.dataset.act) {
        case "annotate": return setMode("draw");
        case "shot": return screenshotView();
        case "hide": return setMarkersHidden(!markersHidden);
        case "discard": return openDiscard();
        case "add": return addToChat();
        case "record": return recorder ? stopRecording() : startRecording();
        case "exit": return exitAnnotating();
        case "chats": return chatMenuOpen ? closeChatMenu() : openChatMenu();
      }
    });
    bindDrag();

    // A press anywhere else closes the chat menu.
    root.addEventListener("pointerdown", (e) => { if (chatMenuOpen && !e.composedPath().some((n) => n === chatMenu || (n.dataset && n.dataset.act === "chats"))) closeChatMenu(); }, true);

    // Drawing
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("contextmenu", (e) => { if (mode === "draw") e.preventDefault(); });
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerleave", hideHighlight);

    // Pins: press opens the note, drag moves it (any mode)
    pinsLayer.addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".dot, .tag");
      const pin = e.target.closest(".pin");
      if (!handle || !pin || e.button !== 0) return;
      const n = notes.find((k) => k.id === pin.dataset.id);
      if (!n) return;
      e.preventDefault();
      e.stopPropagation();
      const [x, y] = toDoc(e);
      drag = { kind: "pin", n, pin, ox: n.x, oy: n.y, x, y, before: snapshot(), moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    pinsLayer.addEventListener("pointermove", (e) => {
      if (!drag || drag.kind !== "pin") return;
      const [x, y] = toDoc(e);
      const dx = x - drag.x, dy = y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) { drag.moved = true; host.classList.add("dragging"); closePopover(); }
      drag.n.x = Math.round(drag.ox + dx); drag.n.y = Math.round(drag.oy + dy);
      drag.pin.style.left = drag.n.x + "px"; drag.pin.style.top = drag.n.y + "px";
    });
    const endPinDrag = () => {
      if (!drag || drag.kind !== "pin") return;
      const d = drag; drag = null;
      host.classList.remove("dragging");
      if (d.moved) { undo.push(d.before); if (undo.length > 60) undo.shift(); redo.length = 0; d.n.ctx = ctxAtPoint(d.n.x, d.n.y); renderPins(); save(); renderToolbar(); }
      else openPopover(d.n, false);
    };
    pinsLayer.addEventListener("pointerup", endPinDrag);
    pinsLayer.addEventListener("pointercancel", endPinDrag);

    // Window-level listeners go through `off` so unmount() removes them all at once.
    const { signal } = off;
    // The server hides the toolbar for screenshots. A DOM event reaches the overlay in any world.
    document.addEventListener("claude-annotate:capture", (e) => api.capture(!!e.detail), { signal });

    // Keyboard
    window.addEventListener("keydown", onKey, { capture: true, signal });
    window.addEventListener("keyup", onKeyUp, { capture: true, signal });
    window.addEventListener("blur", () => setSpace(false), { signal }); // a Space let go in another window

    // Keep things aligned
    window.addEventListener("scroll", placePopover, { passive: true, signal });
    document.addEventListener("scroll", (e) => { if (e.target !== document) followScrollSoon(); }, { capture: true, passive: true, signal });
    window.addEventListener("resize", () => { sizeDoc(); placePopover(); restoreBarPos(); if (chatMenuOpen) placeChatMenu(); if (anchors.size) { renderInk(); renderPins(); } }, { passive: true, signal });
    const ro = new ResizeObserver(() => sizeDoc());
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
    signal.addEventListener("abort", () => ro.disconnect());
    const keeper = setInterval(() => {
      if (!host.isConnected) document.documentElement.appendChild(host); // hydration or innerHTML replaced <html>'s children
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body); // idempotent; re-arms after a body swap
      sizeDoc();
      onUrlChange(); // an isolated world's history wrappers never see the page's own pushState
    }, 1500);
    signal.addEventListener("abort", () => clearInterval(keeper));

    // SPA navigation: same document, new URL → reload state for the new URL
    const fire = () => setTimeout(onUrlChange, 50);
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      const wrapped = function (...a) { const r = orig.apply(this, a); if (!signal.aborted) fire(); return r; };
      history[m] = wrapped;
      signal.addEventListener("abort", () => { if (history[m] === wrapped) history[m] = orig; });
    }
    window.addEventListener("popstate", fire, { signal });
    window.addEventListener("hashchange", fire, { signal });
  }
  let currentUrl = location.href;
  function onUrlChange() {
    if (off.signal.aborted || location.href === currentUrl) return;
    currentUrl = location.href;
    closePopover();
    hydrate();
  }

  // A click marks the element under it; a drag selects an area (see onMove).
  function onDown(e) {
    if (mode !== "draw" || spaceHeld || e.button !== 0) return;
    // A click away from an open comment closes it: kept when it has words, dropped when empty.
    if (!popover.classList.contains("hidden")) { commitPopover(); e.preventDefault(); return; }
    const [x, y] = toDoc(e);
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    pressAt = [x, y];
    pressAlt = e.altKey;
    elementPress = [e.clientX, e.clientY];
  }
  // Element tool: the element under the pointer is outlined, frames included; a click marks it.
  let hoverSeq = 0, hoverAt = null, hoverBusy = false;
  async function hoverElement(cx, cy) {
    hoverAt = [cx, cy];
    if (hoverBusy) return; // one question at a time; the latest point is asked next
    hoverBusy = true;
    try {
      while (hoverAt) {
        const [x, y] = hoverAt; hoverAt = null;
        const seq = ++hoverSeq;
        const pick = await pickIn(document, x, y, true);
        if (seq === hoverSeq && mode === "draw" && !spaceHeld) showHighlight(pick);
      }
    } finally { hoverBusy = false; }
  }
  function showHighlight(pick) {
    if (!pick) { hl.classList.add("hidden"); return; }
    const [l, t, w, h] = pick.rect;
    hl.style.cssText = `left:${l}px;top:${t}px;width:${w}px;height:${h}px`;
    hl.querySelector(".lab").textContent = `${pick.ctx ? pick.ctx.selector : "frame"} · ${Math.round(w)}×${Math.round(h)}${pick.frames.length ? " · in frame" : ""}`;
    hl.classList.remove("hidden");
  }
  function hideHighlight() { hoverSeq++; if (hl) hl.classList.add("hidden"); if (ghost) ghost.classList.add("hidden"); }
  // The pin that will drop: it follows the pointer while annotating.
  function moveGhost(cx, cy) {
    ghost.style.left = cx + "px";
    ghost.style.top = cy + "px";
    ghost.classList.remove("hidden");
  }
  // The pin goes where the click was, on the element it picked.
  async function pickElement(cx, cy) {
    const pick = await pickIn(document, cx, cy, true);
    hideHighlight();
    const at = [Math.round(cx + scrollX), Math.round(cy + scrollY)];
    if (!pick || pick.rect[2] < 2 || pick.rect[3] < 2) return;
    const [l, t, w, h] = pick.rect;
    const ctx = pick.ctx ? { ...pick.ctx } : { selector: "iframe", text: "", rect: [0, 0, 0, 0], chain: "", react: { components: [], source: null } };
    if (pick.frames.length) ctx.frames = pick.frames;
    const s = { id: uid(), type: "rect", element: true, color: ink.id, x: Math.round(l + scrollX), y: Math.round(t + scrollY), w: Math.round(w), h: Math.round(h), ctx };
    addShape(s);
    createNote(at[0], at[1], s);
  }

  // The overlay sits outside the page's elements, so the browser would scroll nothing (or only
  // the document) under it. The wheel goes to what would scroll under the pointer: the nearest
  // scrollable ancestor that can still move that way (body and the document included), else the
  // smallest scrollable area on screen that holds the pointer (a container beside a fixed layer).
  // A frame from another origin (a document viewer) can't be scrolled from here: the overlay steps
  // aside so the browser sends the wheel to it, and comes back once the wheel goes quiet.
  const PASS_MS = 700;
  let passTimer = null;
  function onWheel(e) {
    hideHighlight(); // the page moves under it
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    const target = scrollerAt(document, e.clientX, e.clientY, dx, dy);
    e.preventDefault();
    if (target === FOREIGN_FRAME) return passThrough();
    if (target) target.scrollBy({ left: dx, top: dy, behavior: "instant" });
  }
  function passThrough() {
    host.classList.add("pass");
    clearTimeout(passTimer);
    passTimer = setTimeout(() => host.classList.remove("pass"), PASS_MS);
  }
  const FOREIGN_FRAME = {}; // scrollerAt's answer for a frame we cannot reach into
  function canScroll(el, dx, dy) {
    const doc = el.ownerDocument;
    const root = el === doc.scrollingElement;
    const st = doc.defaultView.getComputedStyle(el);
    const yOk = root ? st.overflowY !== "hidden" && st.overflowY !== "clip" : /(auto|scroll|overlay)/.test(st.overflowY);
    const xOk = root ? st.overflowX !== "hidden" && st.overflowX !== "clip" : /(auto|scroll|overlay)/.test(st.overflowX);
    const moveY = dy !== 0 && yOk && (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    const moveX = dx !== 0 && xOk && (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    return moveY || moveX;
  }
  // What would scroll at (cx, cy) in doc: same-origin frames are searched inside, at their own coordinates.
  function scrollerAt(doc, cx, cy, dx, dy) {
    if (doc === document) host.style.visibility = "hidden";
    const hit = doc.elementFromPoint(cx, cy);
    if (doc === document) host.style.visibility = "";
    if (hit && (hit.tagName === "IFRAME" || hit.tagName === "FRAME")) {
      let inner = null;
      try { inner = hit.contentDocument; } catch { /* another origin */ }
      if (!inner) return FOREIGN_FRAME;
      const r = hit.getBoundingClientRect();
      const found = scrollerAt(inner, cx - r.left - hit.clientLeft, cy - r.top - hit.clientTop, dx, dy);
      if (found) return found;
    }
    for (let el = hit; el; el = el.parentElement) if (canScroll(el, dx, dy)) return el;
    const root = doc.scrollingElement;
    if (root && canScroll(root, dx, dy)) return root;
    if (doc !== document) return null;
    let best = null, bestArea = Infinity;
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) continue;
      const r = el.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea && canScroll(el, dx, dy)) { best = el; bestArea = area; }
    }
    return best;
  }
  let drag = null; // { kind: "pin", ... } while a pin is being moved
  let pressAt = null, farthest = 0; // where the press began, and how far the pointer has gone since
  let elementPress = null; // client point of an Element-tool press that hasn't become a drag yet
  let pressAlt = false; // ⌥ held at the press: mark through an existing area instead of opening its comment
  let lastPointer = [0, 0]; // the document point a drag is at
  function onMove(e) {
    if (mode !== "draw" || spaceHeld) return;
    if (elementPress && !draft) {
      const [x, y] = toDoc(e);
      if (Math.hypot(x - pressAt[0], y - pressAt[1]) < CLICK_SLOP) return;
      hl.classList.add("hidden");
      draft = { id: uid(), type: "rect", color: ink.id, x: pressAt[0], y: pressAt[1], w: 0, h: 0, _ox: pressAt[0], _oy: pressAt[1] };
      sizeDoc();
    }
    if (!draft) {
      if (!popover.classList.contains("hidden")) return hideHighlight(); // a comment is open: the next click closes it
      moveGhost(e.clientX, e.clientY);
      if (!e.altKey && commentedMarkAt(...toDoc(e))) { hl.classList.add("hidden"); hoverSeq++; return; } // a click here opens that comment
      return hoverElement(e.clientX, e.clientY);
    }
    const [x, y] = toDoc(e);
    farthest = Math.max(farthest, Math.hypot(x - pressAt[0], y - pressAt[1]));
    lastPointer = [x, y];
    draft.x = Math.min(draft._ox, x); draft.y = Math.min(draft._oy, y);
    draft.w = Math.abs(x - draft._ox); draft.h = Math.abs(y - draft._oy);
    moveGhost(e.clientX, e.clientY); // the pin rides the corner being dragged
    renderDraft();
  }
  function onUp() {
    const press = elementPress;
    elementPress = null;
    if (press && !draft) { openOrCreate(() => pickElement(press[0], press[1])); return; }
    if (!draft) return;
    const d = draft; draft = null;
    const wasClick = farthest < CLICK_SLOP;
    farthest = 0;
    if (wasClick) { renderDraft(); const [x, y] = pressAt; openOrCreate(() => createNote(x, y)); return; }
    // An area: the pin sits where the drag ended.
    const ok = d.w >= 8 && d.h >= 8;
    delete d._ox; delete d._oy;
    if (!ok) { renderDraft(); return; }
    addShape(d);
    hideHighlight();
    createNote(Math.round(lastPointer[0]), Math.round(lastPointer[1]), d);
  }
  // A click on a mark that has a comment opens that comment to retype; with ⌥ it marks through.
  function openOrCreate(create) {
    const note = !pressAlt && commentedMarkAt(pressAt[0], pressAt[1]);
    if (note) openPopover(note, false);
    else create();
  }
  // The comment of the innermost mark under a document point: inside a box, circle or stroke's
  // bounds, or near an arrow or line.
  const NEAR = 8;
  function commentedMarkAt(x, y) {
    let best = null, bestArea = Infinity;
    for (const s of shapes) {
      if (s.element || s.shot) continue; // an element's outline is hidden, a screenshot covers the view: neither catches clicks
      const note = notes.find((n) => n.shape === s.id);
      if (!note) continue;
      const b = bbox(s);
      const hit = s.type === "arrow" || s.type === "line"
        ? distToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= NEAR
        : x >= b.x - NEAR && x <= b.x + b.w + NEAR && y >= b.y - NEAR && y <= b.y + b.h + NEAR;
      const area = Math.max(1, b.w * b.h);
      if (hit && area < bestArea) { best = note; bestArea = area; }
    }
    return best;
  }
  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  // Keys while annotating: Space held lets the page have the pointer; Esc backs out one step
  // (the discard dialog, the chat list, then annotation mode); ⌘Z / ⇧⌘Z undo and redo; ⌘↵ sends.
  function onKey(e) {
    if (RENDER_ONLY) return;
    const target = e.composedPath()[0];
    const inOurs = host && (target === host || host.shadowRoot.contains(target));
    const editing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (editing && !inOurs) return; // the page's own inputs
    if (inOurs && editing) return; // our textarea handles itself
    if (mode !== "draw") return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (meta && e.key === "Enter") { e.preventDefault(); addToChat(); return; }
    if (meta || e.altKey) return;
    if (e.key === " " && !inOurs) {
      e.preventDefault(); // not a page scroll: Space is held to use the page
      if (!spaceHeld) setSpace(true);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (confirmDiscard) closeDiscard();
      else if (chatMenuOpen) closeChatMenu();
      else exitAnnotating();
    }
  }
  function onKeyUp(e) {
    if (e.key === " " && spaceHeld) { e.preventDefault(); setSpace(false); }
  }

  // ---------------------------------------------------------------------------
  // Which chat: the pill lists the live chats, this page's project first
  // ---------------------------------------------------------------------------
  // Only the extension knows the chats; an overlay put up by annotate_open belongs to its session.
  const CHOOSES_CHAT = CFG.startMode === "draw" && CFG.chat != null;
  const RECENT_MS = 12 * 3600e3; // other projects' chats older than this aren't offered
  let chatMenuOpen = false;
  let carried = CFG.carry || null;

  function openChatMenu() {
    chatMenuOpen = true;
    chatMenu.innerHTML = `<div class="hd">Add notes to</div><div class="msg">Looking for chats…</div>`;
    chatMenu.classList.remove("hidden");
    placeChatMenu();
    renderToolbar();
    askExtension("claude-annotate:chats", "claude-annotate:chat-list").then(renderChatMenu);
  }
  function closeChatMenu() {
    if (!chatMenuOpen) return;
    chatMenuOpen = false;
    chatMenu.classList.add("hidden");
    renderToolbar();
  }
  function placeChatMenu() {
    const pill = bar.querySelector('[data-act="chats"]');
    if (!pill) return;
    const r = pill.getBoundingClientRect(), w = chatMenu.offsetWidth || 340, h = chatMenu.offsetHeight || 120;
    chatMenu.style.left = clamp(r.left + r.width / 2 - w / 2, 12, innerWidth - w - 12) + "px";
    chatMenu.style.top = (r.top - h - 10 >= 12 ? r.top - h - 10 : r.bottom + 10) + "px";
  }
  function ago(at) {
    const min = Math.max(0, Math.round((Date.now() - at) / 60000));
    return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
  }
  function renderChatMenu(json) {
    if (!chatMenuOpen) return;
    let list = null;
    try { list = json ? JSON.parse(json) : null; } catch { /* below */ }
    if (!list || !Array.isArray(list.chats)) {
      chatMenu.innerHTML = `<div class="hd">Add notes to</div><div class="msg">Couldn't list the chats. Reload the extension and try again.</div>`;
      return placeChatMenu();
    }
    const item = (c) => `<button type="button" role="menuitemradio" aria-checked="${!CFG.automatic && c.pid === list.current}" data-pid="${c.pid}">
      <span class="t">${esc(c.title || c.folder)}</span>
      <span class="s">${esc(c.folder)} · ${c.typed ? "typed" : "started"} ${ago(c.at)}${c.lastPrompt ? ` · “${esc(c.lastPrompt)}”` : ""}</span>${!CFG.automatic && c.pid === list.current ? svgIcon("check", 16) : ""}</button>`;
    const follow = `<button type="button" role="menuitemradio" aria-checked="${!!CFG.automatic}" data-pid="follow">
      <span class="t">The chat open in Claude Code</span>
      <span class="s">Follows you as you switch chats</span>${CFG.automatic ? svgIcon("check", 16) : ""}</button>`;
    const mine = list.chats.filter((c) => c.servesPage);
    const others = list.chats.filter((c) => !c.servesPage && (c.pid === list.current || Date.now() - c.at < RECENT_MS));
    chatMenu.innerHTML = `<div class="hd">Add notes to</div>${follow}` +
      (mine.length ? `<div class="hd">This page's project</div>${mine.map(item).join("")}` : "") +
      (others.length ? `<div class="hd">${mine.length ? "Other chats" : "Chats"}</div>${others.map(item).join("")}` : "") +
      (mine.length || others.length ? "" : `<div class="msg">No Claude Code chat is running with the annotate plugin.</div>`);
    for (const b of chatMenu.querySelectorAll("button[data-pid]")) b.addEventListener("click", () => (b.dataset.pid === "follow" ? followAgain() : chooseChat(Number(b.dataset.pid))));
    placeChatMenu();
    (chatMenu.querySelector('[aria-checked="true"]') || chatMenu.querySelector("button"))?.focus({ preventScroll: true });
  }
  // Switching chats: what this chat has already got stays with it; unsent marks and comments go
  // along to the new one. The extension then mounts the overlay again for that chat.
  // auto: the open chat changed and the tab follows it (a pick in the menu holds instead).
  // add: the notes were on their way to the chat: the new overlay adds them there.
  async function chooseChat(pid, { auto = false, add = false } = {}) {
    closeChatMenu();
    if (pid === CFG.chat) return;
    if (popNote) commitPopover();
    const url = pageUrl();
    const carry = { url, add, shapes: shapes.filter((x) => !x.batch), notes: notes.filter((n) => !n.batch) };
    shapes = shapes.filter((x) => x.batch);
    notes = notes.filter((n) => n.batch);
    clearTimeout(saveTimer); saveTimer = null;
    await req("PUT", "/state", { url, shapes, notes }).catch(() => {});
    document.dispatchEvent(new CustomEvent("claude-annotate:choose", { detail: JSON.stringify({ pid, carry, auto }) }));
  }
  // The chat open in Claude Code changed: a tab on Automatic follows it, unsent notes and all.
  // Not mid-comment or mid-recording: the next change looks again.
  async function followOpenChat() {
    if (!CHOOSES_CHAT || !CFG.automatic || popNote || draft || recorder || phase === "sending") return;
    const pid = Number(await askExtension("claude-annotate:recheck", "claude-annotate:retarget"));
    if (Number.isInteger(pid) && pid > 0 && pid !== CFG.chat) chooseChat(pid, { auto: true });
  }
  const chatLabel = () => [CFG.sendsTo, CFG.sendsFolder].filter((v, i, a) => v && a.indexOf(v) === i).join(" · ") || "Claude";

  // Back to following the open chat after a pick in the menu.
  async function followAgain() {
    closeChatMenu();
    if (CFG.automatic) return;
    if (popNote) commitPopover();
    const url = pageUrl();
    const carry = { url, shapes: shapes.filter((x) => !x.batch), notes: notes.filter((n) => !n.batch) };
    shapes = shapes.filter((x) => x.batch);
    notes = notes.filter((n) => n.batch);
    clearTimeout(saveTimer); saveTimer = null;
    await req("PUT", "/state", { url, shapes, notes }).catch(() => {});
    document.dispatchEvent(new CustomEvent("claude-annotate:choose", { detail: JSON.stringify({ follow: true, carry }) }));
  }

  // The new chat's server numbers its own comments: carried ones get the next numbers there.
  async function takeCarried() {
    const c = carried;
    carried = null;
    if (!c || c.url !== pageUrl() || !(c.notes.length || c.shapes.length)) return;
    if (c.add) setTimeout(addToChat, 0); // after hydrate has drawn them
    for (const n of c.notes) {
      try { n.n = (await req("POST", "/note/next")).n; } catch { n.n = Math.max(0, ...notes.map((k) => k.n)) + 1; }
      n.status = "draft";
    }
    shapes.push(...c.shapes.filter((x) => !shapes.some((y) => y.id === x.id)));
    notes.push(...c.notes.filter((n) => !notes.some((k) => k.id === n.id)));
    save();
  }

  // ---------------------------------------------------------------------------
  // Send / clear
  // ---------------------------------------------------------------------------
  // Notes wait on the page until Send: the sidebar's button (the server asks the tab the user looks
  // at, so its screenshot goes along) or ⌘↵ here. What went out then leaves the page.
  const waitingComments = () => notes.filter((n) => !n.batch && n.text).length;
  // Add to chat: the notes wait in Claude Code's bar above the prompt and go with the next message
  // there. The tab's picture goes along now, so the notes reach Claude with the page as it was.
  async function addToChat() {
    if (popNote) commitPopover();
    if (!waitingComments() && !shapes.some((sh) => !sh.batch)) return;
    if (CHOOSES_CHAT && CFG.automatic) {
      const pid = Number(await askExtension("claude-annotate:recheck", "claude-annotate:retarget"));
      if (Number.isInteger(pid) && pid > 0 && pid !== CFG.chat) return chooseChat(pid, { auto: true, add: true }); // that chat's overlay adds them
    }
    clearTimeout(saveTimer); saveTimer = null;
    try { await req("PUT", "/state", { url: pageUrl(), shapes, notes }); } catch (e) { return toast(`Couldn't add them: ${e.message}`); }
    if (CFG.startMode === "draw") await uploadView();
    toast(`Added to ${chatLabel()}. Send your message there when you're ready.`, "ok");
    exitAnnotating();
  }
  async function send() {
    if (phase === "sending") return;
    if (popNote) commitPopover(); // a comment being written goes with this Send
    if (!waitingComments() && !shapes.some((sh) => !sh.batch)) return;
    phase = "sending";
    renderToolbar();
    clearTimeout(saveTimer);
    try { await req("PUT", "/state", { url: pageUrl(), shapes, notes }); } catch { /* fallthrough */ }
    if (CFG.startMode === "draw") await uploadView(); // the extension put us up: it takes the screenshot
    try {
      const r = await req("POST", "/send");
      totals = r.totals || totals;
      phase = "sent";
      tick(`sent ${r.notes} note${r.notes === 1 ? "" : "s"} to Claude`);
      await flushOut(r.ids || []);
      // The server cannot tell whether the channel is on. If nothing comes back, say what to do.
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { if (phase === "sent") toast("Nothing from Claude yet? In the session, ask Claude to pull the annotations."); }, 20000);
    } catch (e) {
      phase = "idle";
      renderToolbar();
      if (e.message === "busy") return; // another tab is sending; its batch takes this page's notes too
      if (e.message !== "Nothing to send yet.") toast(`Couldn't send to Claude: ${e.message}`);
    }
  }
  // What went out leaves the page: its pins and marks shrink away, then they are gone, undo history
  // included (an undo must not bring a sent note back to be sent again). The rest stays.
  const FLUSH_MS = 380;
  async function flushOut(ids) {
    const out = new Set(ids);
    const going = [...notes, ...shapes].filter((x) => out.has(x.id));
    if (!going.length) return renderToolbar();
    if (popNote && out.has(popNote.id)) closePopover();
    for (const x of going) {
      pinsLayer.querySelector(`.pin[data-id="${x.id}"]`)?.classList.add("flushed");
      shapesG.querySelector(`g[data-id="${x.id}"]`)?.classList.add("flushed");
    }
    await new Promise((r) => setTimeout(r, FLUSH_MS));
    notes = notes.filter((n) => !out.has(n.id));
    shapes = shapes.filter((x) => !out.has(x.id));
    for (const id of out) anchors.delete(id);
    undo.length = 0; redo.length = 0;
    renderInk(); renderPins(); renderToolbar();
  }

  // A small picture of the tab around a note, cut when the note is saved: the sidebar shows it, and
  // it goes to Claude as that note's crop. Only where the extension can capture the tab.
  const PREVIEW = { w: 280, maxH: 200, padX: 140, padY: 90 };
  async function capturePreview(note) {
    if (CFG.startMode !== "draw" || RENDER_ONLY) return;
    api.capture(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))));
    let image = null;
    try { image = await askExtensionForShot(); } catch { /* none */ }
    api.capture(false);
    if (!image || !notes.includes(note)) return;
    try {
      const shot = await decodeDataUrl(image);
      const shape = note.shape && shapes.find((s) => s.id === note.shape);
      const b = shape ? bbox(shape) : { x: note.x, y: note.y, w: 0, h: 0 };
      // The mark and its pin with room around, in viewport pixels, kept on screen.
      let x0 = Math.min(b.x, note.x) - scrollX - PREVIEW.padX, x1 = Math.max(b.x + b.w, note.x) - scrollX + PREVIEW.padX;
      let y0 = Math.min(b.y, note.y) - scrollY - PREVIEW.padY, y1 = Math.max(b.y + b.h, note.y) - scrollY + PREVIEW.padY;
      x0 = clamp(x0, 0, innerWidth); x1 = clamp(x1, x0 + 1, innerWidth);
      y0 = clamp(y0, 0, innerHeight); y1 = clamp(y1, y0 + 1, innerHeight);
      const k = shot.width / innerWidth; // the capture is in device pixels
      const scale = Math.min(PREVIEW.w / (x1 - x0), PREVIEW.maxH / (y1 - y0), k);
      const w = Math.max(1, Math.round((x1 - x0) * scale)), h = Math.max(1, Math.round((y1 - y0) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(shot, x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k, 0, 0, w, h);
      shot.close();
      note.preview = { src: canvas.toDataURL("image/jpeg", 0.75), w, h };
      save();
    } catch { /* no preview: the note still goes */ }
  }
  // Decoded by hand: an <img> or fetch of a data: URL would be subject to the page's CSP.
  function decodeDataUrl(url) {
    const [head, b64] = url.split(",");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: head.slice(5, head.indexOf(";")) }));
  }
  // What the tab shows, marks included and the toolbar hidden, captured by the extension and
  // uploaded so the session's server needs no connection to Chrome. Best effort: without it the
  // server tries its own screenshot, and sends the notes without one if that fails too.
  async function uploadView() {
    api.capture(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
    let image = null;
    try { image = await askExtensionForShot(); } catch { /* none */ }
    api.capture(false);
    if (!image) return;
    await req("POST", "/view", { url: pageUrl(), image, viewport: { w: innerWidth, h: innerHeight }, scroll: { x: Math.round(scrollX), y: Math.round(scrollY) } }).catch(() => {});
  }
  // The extension's isolated-world relay answers "claude-annotate:shoot" with "claude-annotate:shot"
  // (a data URL, or "" when the tab could not be captured). DOM events reach it from either world.
  async function askExtensionForShot() {
    const image = await askExtension("claude-annotate:shoot", "claude-annotate:shot");
    return image && image.startsWith("data:image/") ? image : null;
  }
  // One question to the extension's relay, answered by one event with a string detail (null: no answer).
  function askExtension(ask, answer, ms = 4000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), ms);
      const done = (v) => { clearTimeout(timer); document.removeEventListener(answer, onAnswer); resolve(v); };
      const onAnswer = (e) => done(typeof e.detail === "string" ? e.detail : null);
      document.addEventListener(answer, onAnswer);
      document.dispatchEvent(new CustomEvent(ask));
    });
  }

  // ---------------------------------------------------------------------------
  // Toasts / ticker
  // ---------------------------------------------------------------------------
  function toast(text, kind = "") {
    const t = el("div", `toast ${kind}`, `${svgIcon(kind === "ok" ? "check" : "note", 16)}<span>${esc(text)}</span>`);
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, kind === "ok" ? 3800 : 6000);
  }
  let tickerTimer = null;
  function tick(text, mono) {
    ticker.innerHTML = mono ? `Claude · <span class="mono">${esc(text)}</span>` : esc(text);
    ticker.classList.add("show");
    clearTimeout(tickerTimer);
    tickerTimer = setTimeout(() => ticker.classList.remove("show"), 6000);
  }

  // ---------------------------------------------------------------------------
  // Server link
  // ---------------------------------------------------------------------------
  async function hydrate() {
    try {
      const r = await req("GET", `/state?url=${encodeURIComponent(pageUrl())}`);
      shapes = r.shapes || [];
      notes = r.notes || [];
      await takeCarried();
      anchorAll();
      totals = r.totals || totals;
      if (totals.open > 0) phase = "sent";
      else if (totals.batches > 0 && totals.unsent === 0) phase = "done";
      renderInk(); renderPins(); renderToolbar();
      reopenDraft();
    } catch { setLink("off"); }
  }
  function connectSse() {
    if (INLINE) return;
    setLink("connecting");
    sse = transport.events();
    sse.onopen = () => setLink("on");
    sse.onerror = () => setLink("off");
    sse.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "progress" || m.type === "done" || m.type === "status" || m.type === "toast") clearTimeout(quietTimer);
      switch (m.type) {
        case "hello": setLink("on"); if (m.totals) { totals = m.totals; renderToolbar(); } break;
        case "progress": {
          const n = notes.find((k) => k.n === m.n);
          if (n) { n.status = m.status; updatePin(n); }
          tick(m.status === "working" ? `working on note ${m.n}` : `note ${m.n} ${m.status}`); // Claude's words stay in Claude Code
          if (m.status === "done") { const d = pinsLayer.querySelector(`.pin[data-id="${n ? n.id : ""}"] .dot`); if (d) d.classList.add("wiggle"); }
          break;
        }
        case "status": tick(m.text, true); break;
        case "toast": toast(m.text); break;
        case "sent": phase = "sent"; if (m.totals) totals = m.totals; flushOut(m.ids || []); break; // this or another tab sent
        case "send-request": // Send, pressed in the sidebar: the tab in view sends, with its screenshot when it has notes of its own
          if (document.visibilityState !== "visible") break;
          if (waitingComments() || shapes.some((sh) => !sh.batch)) send();
          else req("POST", "/send").catch(() => {}); // the notes are on other pages: send them without waiting for a tab that has them
          break;
        case "changed": if (m.url === pageUrl() && !draft && !popNote && !drag) hydrate(); break; // edited from outside the page
        case "chats": followOpenChat(); break; // a chat was opened, typed in, started or ended
        case "verify-shot": verifyShot(m); break; // Claude's annotate_screenshot
        case "done":
          for (const n of notes) if (n.batch && (!m.batch || n.batch === m.batch) && (n.status === "pending" || n.status === "working")) { n.status = "done"; updatePin(n); }
          phase = "done";
          totals.open = 0;
          renderToolbar();
          toast("Done. Claude's notes are in Claude Code.", "ok");
          wigglePins(70);
          break;
        case "clear":
          shapes = []; notes = []; anchors.clear(); phase = "idle"; undo.length = 0; redo.length = 0;
          totals = { notes: 0, shapes: 0, pages: 0, unsent: 0, open: 0, batches: 0 };
          closePopover(); renderInk(); renderPins(); renderToolbar();
          break;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Public hooks for the server
  // ---------------------------------------------------------------------------
  api.capture = (on) => { if (!host) return; host.classList.toggle("capturing", !!on); };

  // Removes the overlay and everything it hooked into the page. Unsaved edits are saved first.
  api.unmount = async () => {
    if (off.signal.aborted) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      await req("PUT", "/state", { url: pageUrl(), shapes, notes }).catch(() => {});
    }
    off.abort();
    if (sse) sse.close();
    for (const t of [quietTimer, tickerTimer, recTimer]) clearTimeout(t);
    if (host) host.remove();
    if (window.__claudeAnnotate === api) delete window.__claudeAnnotate;
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
