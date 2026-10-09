/** Shared plain-text tips for the shell and rendered Scribe pages. */
(() => {
  if (window.scribeTooltip) return;
  const style = document.createElement("style");
  style.textContent = `
    .scribe-tooltip {
      position: fixed; inset: auto; margin: 0; box-sizing: border-box;
      max-width: min(360px, calc(100vw - 16px)); max-height: calc(100vh - 16px);
      overflow: auto; padding: 8px 10px; border-radius: 7px;
      border: 1px solid var(--border, #41454e);
      background: var(--panel, var(--bg, #20232a)); color: var(--text, #e8eaf0);
      box-shadow: 0 6px 24px #0005; font: 12px/1.5 system-ui, sans-serif;
      white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: none;
      z-index: 2147483647;
    }
    .scribe-tooltip[hidden] { display: none; }
  `;
  document.head.append(style);
  const tip = document.createElement("div");
  tip.className = "scribe-tooltip";
  tip.id = "scribe-text-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("popover", "manual");
  tip.hidden = true;
  document.body.append(tip);
  let anchor = null;
  let timer = 0;
  const descriptions = new WeakMap();

  function hide() {
    clearTimeout(timer);
    if (anchor) {
      const ids = (anchor.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id !== tip.id);
      if (ids.length) anchor.setAttribute("aria-describedby", ids.join(" "));
      else anchor.removeAttribute("aria-describedby");
    }
    anchor = null;
    if (tip.hidePopover && tip.matches(":popover-open")) tip.hidePopover();
    tip.hidden = true;
  }

  function show() {
    if (!anchor?.isConnected || !anchor.dataset.tooltip || anchor.hasAttribute("data-rich-tooltip")) return hide();
    window.dispatchEvent(new Event("scribe-tooltip-show"));
    tip.textContent = anchor.dataset.tooltip;
    tip.hidden = false;
    if (tip.showPopover && !tip.matches(":popover-open")) tip.showPopover();
    const ids = new Set((anchor.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add(tip.id);
    anchor.setAttribute("aria-describedby", [...ids].join(" "));
    const rect = anchor.getBoundingClientRect();
    const width = tip.offsetWidth, height = tip.offsetHeight;
    const top = rect.top >= height + 8 ? rect.top - height - 8 : rect.bottom + 8;
    tip.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + "px";
    tip.style.top = Math.max(8, Math.min(top, innerHeight - height - 8)) + "px";
  }

  function target(node) {
    if (!(node instanceof Element)) return null;
    const el = node.closest("[data-tooltip]");
    return el?.dataset.tooltip && !el.hasAttribute("data-rich-tooltip") ? el : null;
  }
  function enter(el, delay) {
    if (anchor === el) return;
    hide();
    if (!el) return;
    anchor = el;
    timer = setTimeout(show, delay);
  }
  document.addEventListener("pointerover", event => {
    if (event.pointerType === "mouse" && !event.buttons) enter(target(event.target), 350);
  });
  document.addEventListener("pointerout", event => {
    if (anchor && !anchor.contains(event.relatedTarget)) hide();
  });
  document.addEventListener("focusin", event => enter(target(event.target), 0));
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  window.addEventListener("blur", hide);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);

  // Stored pages and third-party renderers may still assign title dynamically.
  // Leave iframe titles alone: they name the document for assistive technology.
  function sync(el) {
    if (!(el instanceof Element)) return;
    if (el.hasAttribute("title") && !el.matches("iframe")) {
      el.dataset.tooltip = el.getAttribute("title");
      el.removeAttribute("title");
    }
    const text = el.getAttribute("data-tooltip");
    const previous = descriptions.get(el);
    if (text) {
      if (!el.hasAttribute("aria-description") || el.getAttribute("aria-description") === previous) {
        el.setAttribute("aria-description", text);
        descriptions.set(el, text);
      }
    } else if (previous !== undefined) {
      if (el.getAttribute("aria-description") === previous) el.removeAttribute("aria-description");
      descriptions.delete(el);
    }
  }
  function scan(node) {
    sync(node);
    node.querySelectorAll?.("[title], [data-tooltip]").forEach(sync);
  }
  scan(document.body);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") sync(record.target);
      else record.addedNodes.forEach(scan);
    }
    if (anchor && !tip.hidden && records.some(record => record.type === "attributes" && record.target === anchor)) show();
    else if (anchor && !anchor.isConnected) hide();
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title", "data-tooltip", "data-rich-tooltip"] });
  window.scribeTooltip = { hide };
})();
