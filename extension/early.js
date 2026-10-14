// Runs in the extension's isolated world before the page's own scripts. It holds the first window
// capture listener for the events the toolbar must see first (keys typed in a comment, presses on
// the toolbar), so a page that grabs them on the window and stops them can't take them away. Until
// annotating is on in the tab it does nothing: the overlay registers its handlers here (overlay.js,
// onWindowFirst). No wheel or touch listener: one that can cancel would slow scrolling on every site.
(() => {
  if (window.__claudeAnnotateEarly) return;
  const types = ["keydown", "keyup", "keypress", "beforeinput", "input", "pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "pointerover", "pointerenter", "pointerout", "mousedown", "mouseup", "mousemove", "mouseover", "mouseenter", "mouseout", "mouseleave", "click", "dblclick", "auxclick", "contextmenu", "focusin", "focusout", "focus", "blur", "dragstart", "selectstart", "copy", "cut", "paste", "compositionstart", "compositionupdate", "compositionend", "gotpointercapture", "lostpointercapture"];
  const handlers = new Map(types.map((t) => [t, []]));
  for (const t of types) {
    addEventListener(t, (e) => { for (const fn of [...handlers.get(t)]) fn(e); }, { capture: true, passive: false });
  }
  window.__claudeAnnotateEarly = {
    types,
    add: (t, fn) => handlers.get(t).push(fn),
    remove: (t, fn) => { const list = handlers.get(t); const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
  };
})();
