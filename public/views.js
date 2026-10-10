/**
 * Page links and the views they open: a peek (a fixed card over the page area) and a split
 * (two equal panes, kept per space). The focused pane always shows the active tab, so the tab
 * strip, the address and the floating chat follow focus; the split only stores the other pane.
 * app.js owns the frame pool; this decides which pooled iframe sits where. Frames are only ever
 * restyled, never moved in the DOM, because moving an iframe reloads it.
 */
window.createViews = function createViews(host) {
  const mainEl = host.mainEl;
  const SPLITS_KEY = "scribe.spaceSplits";
  const SPLIT_RATIO_KEY = "scribe.splitRatio";
  /** Below this page-area width a split opens as a peek instead. */
  const SPLIT_MIN_MAIN = 720;
  const SPLIT_MIN_PANE = 280;
  /** The least height of a stacked pane, header included. */
  const SPLIT_MIN_PANE_HEIGHT = 160;
  const PANES = ["a", "b"];
  const SPLIT_MIN_RATIO = 0.2;
  const SPLIT_MAX_RATIO = 0.8;
  const SPLIT_SNAP = 0.02;
  const PEEK_STACK_MAX = 8;
  const HOVER_DELAY = 120;

  const ICONS = {
    back: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13 8H3.5M7.5 3.5L3 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    split: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8.5 2.5v11" stroke="currentColor" stroke-width="1.3"/><rect x="8.5" y="3" width="5.5" height="10" fill="currentColor" opacity="0.35"/></svg>',
    peek: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="4.5" y="5" width="7" height="6" rx="1" fill="currentColor" opacity="0.5"/></svg>',
    tab: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 13.5v-8a1.5 1.5 0 0 1 1.5-1.5h3.5l1.5 2h5a1.5 1.5 0 0 1 1.5 1.5v6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M1 13.5h14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    swap: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 5.5h10M9.5 2.5l3 3-3 3M13.5 10.5h-10M6.5 7.5l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stack: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 8h13" stroke="currentColor" stroke-width="1.3"/></svg>',
    sideBySide: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg>',
    browser: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  };

  /** @typedef {{ kind: "page", id: string } | { kind: "url", href: string }} Target */

  /** Space and host tab → its peek stack. */
  const peeks = new Map();
  /**
   * Space id → its split. A split is a temporary view, not board data. `other` is the pane without
   * focus, `side` the place (0 first, 1 second) of the focused one, and `seen` the active tab the
   * split was last laid out with, which takes the other pane when focus lands there by another route.
   */
  /** @type {Map<string, { other: Target, ratio: number, dir: "row" | "col", side: 0 | 1, seen: string | null }>} */
  const splits = loadSplits();
  /** Pages on their way into the strip for a split. */
  const opening = new Set();
  let lastRatio = clampStoredRatio(Number(readStorage(SPLIT_RATIO_KEY)));
  /** Where a link-opened tab came from; closing it returns there while it's still the tab you're on. */
  const openedFrom = new Map();
  /** href → reason, for sites that refuse to be framed. */
  const blocked = new Map();
  /** The desktop app drops framing headers from embedded sites (desktop/src/embeds.rs), so nothing is refused there. */
  const framingAllowed = Boolean(window.__TAURI__);
  const checking = new Set();
  /** @type {null | { frameId: string, anchor: string }} */
  let pendingAnchor = null;
  let hoverTimer = 0;
  let resizing = null;
  let pageDrag = null;

  /* ---------- DOM ---------- */

  const scrim = el("div", "peek-scrim");
  const card = el("div", "peek-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "false");
  const peekHead = el("div", "view-head");
  const peekBody = el("div", "view-body");
  card.append(peekHead, peekBody);
  /** Pane → its header and the area under its frame. */
  const paneEls = Object.fromEntries(
    PANES.map((pane) => {
      const head = el("div", "view-head pane-head");
      const body = el("div", "view-body pane-body");
      head.dataset.pane = pane;
      body.dataset.pane = pane;
      return [pane, { head, body, drawn: "" }];
    })
  );
  const divider = el("div", "split-divider");
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-label", "Resize split");
  divider.setAttribute("aria-valuemin", String(SPLIT_MIN_RATIO * 100));
  divider.setAttribute("aria-valuemax", String(SPLIT_MAX_RATIO * 100));
  divider.tabIndex = 0;
  const tools = el("div", "split-tools");
  for (const node of [scrim, card, paneEls.a.head, paneEls.a.body, paneEls.b.head, paneEls.b.body, divider]) {
    node.hidden = true;
    mainEl.appendChild(node);
  }
  const flashEl = el("div", "view-flash");
  flashEl.addEventListener("animationend", () => flashEl.classList.remove("on"));
  mainEl.appendChild(flashEl);
  const dropOverlay = el("div", "pane-drop-overlay");
  const dropPreview = el("div", "pane-drop-preview");
  dropOverlay.appendChild(dropPreview);
  dropOverlay.hidden = true;
  mainEl.appendChild(dropOverlay);
  for (const pane of PANES) {
    paneEls[pane].head.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && !event.target.closest("button")) {
        host.startPaneDrag?.(event, pane, paneEls[pane].head);
      }
    });
  }

  scrim.addEventListener("mousedown", (event) => {
    event.preventDefault();
    closePeek();
  });

  function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function iconButton(icon, label, onClick, tooltip = true) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "view-btn";
    btn.innerHTML = icon;
    if (tooltip) btn.dataset.tooltip = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  const swapBtn = iconButton(ICONS.swap, "Swap panes", () => swapPanes());
  const dirBtn = iconButton(ICONS.stack, "Stack panes", () => toggleDir());
  tools.append(swapBtn, dirBtn);
  // A press or a key on a button must not resize the split.
  for (const type of ["pointerdown", "dblclick", "keydown"]) {
    tools.addEventListener(type, (event) => event.stopPropagation());
  }
  divider.appendChild(tools);

  /* ---------- storage ---------- */

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* the view just won't survive a reload */
    }
  }

  function clampStoredRatio(value) {
    return Number.isFinite(value) && value > 0 ? Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, value)) : 0.5;
  }

  function loadSplits() {
    const map = new Map();
    try {
      const raw = JSON.parse(readStorage(SPLITS_KEY) || "{}");
      for (const [spaceId, value] of Object.entries(raw || {})) {
        const other = value?.page ? { kind: "page", id: String(value.page) } : value?.url ? { kind: "url", href: String(value.url) } : null;
        if (other) {
          map.set(spaceId, {
            other,
            ratio: clampStoredRatio(Number(value.ratio)),
            dir: value.dir === "col" ? "col" : "row",
            side: value.side === 1 ? 1 : 0,
            seen: typeof value.seen === "string" ? value.seen : null,
          });
        }
      }
    } catch {
      /* ignore a damaged entry */
    }
    return map;
  }

  function saveSplits() {
    const out = {};
    for (const [spaceId, split] of splits) {
      out[spaceId] = {
        ...(split.other.kind === "page" ? { page: split.other.id } : { url: split.other.href }),
        ratio: split.ratio,
        dir: split.dir,
        side: split.side,
        seen: split.seen,
      };
    }
    writeStorage(SPLITS_KEY, JSON.stringify(out));
  }

  /* ---------- targets ---------- */

  function frameIdOf(target) {
    return target.kind === "page" ? target.id : "url:" + target.href;
  }

  function sameTarget(a, b) {
    return Boolean(a && b) && frameIdOf(a) === frameIdOf(b);
  }

  function hostnameOf(href) {
    try {
      return new URL(href).host;
    } catch {
      return href;
    }
  }

  /** An http(s) URL outside the board, or null. */
  function externalUrl(raw) {
    const text = String(raw || "").trim();
    if (!/^https?:/i.test(text)) {
      return null;
    }
    try {
      const url = new URL(text);
      if (url.origin === location.origin || url.origin === host.contentOrigin()) {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  /**
   * A page by id or key. Keys can repeat (an agent can't see hidden pages and may reuse the key),
   * so prefer an open tab, then a page the agent can see, then the most recently updated.
   */
  function pageKeyOf(value) {
    const slug = String(value || "")
      .trim()
      .replace(/\|auto$/i, "")
      .replace(/^(scribe:)+/i, "");
    return slug ? `scribe:${slug}` : "";
  }

  function findPage(raw) {
    const text = String(raw || "").trim().replace(/\|auto$/i, "");
    if (!text) {
      return null;
    }
    const byId = host.findAnyTab(text);
    if (byId) {
      return byId;
    }
    const want = pageKeyOf(text);
    if (!want) {
      return null;
    }
    const matches = [...host.tabs().map((tab) => ({ tab, open: true })), ...host.closed().map((tab) => ({ tab, open: false }))].filter(
      (item) => item.tab.key === text || pageKeyOf(item.tab.key) === want
    );
    matches.sort((a, b) => Number(b.open) - Number(a.open) || Number(!b.tab.agentHidden) - Number(!a.tab.agentHidden) || (b.tab.updatedAt || 0) - (a.tab.updatedAt || 0));
    return matches[0]?.tab || null;
  }

  function metaFor(target) {
    if (target.kind === "page") {
      return host.findAnyTab(target.id);
    }
    return { id: frameIdOf(target), title: hostnameOf(target.href), revision: 0, embedUrl: target.href, url: true };
  }

  function titleOf(target) {
    return target.kind === "page" ? host.findAnyTab(target.id)?.title || "Page" : hostnameOf(target.href);
  }

  async function inTrash(raw) {
    const res = await fetch("/api/trash").catch(() => null);
    if (!res?.ok) {
      return null;
    }
    const data = await res.json().catch(() => null);
    for (const batch of data?.batches || []) {
      const page = (batch.tabs || []).find((tab) => tab.id === raw || tab.key === raw);
      if (page) {
        return page;
      }
    }
    return null;
  }

  /* ---------- state queries ---------- */

  function peekKey() {
    return JSON.stringify([host.spaceId(), host.activeId()]);
  }

  function activePeek() {
    return peeks.get(peekKey()) || null;
  }

  function setPeek(value) {
    if (value) peeks.set(peekKey(), value);
    else peeks.delete(peekKey());
  }

  function peekTarget() {
    const peek = activePeek();
    return peek ? peek.stack[peek.stack.length - 1] : null;
  }

  /** A page that can fill a pane: it has a tab in the strip (or is about to), or is the New page. */
  function showable(id) {
    return host.tabs().some((tab) => tab.id === id) || host.draftId() === id || opening.has(id);
  }

  /**
   * The split around the active tab. When the active tab became the page of the other pane (Back,
   * an agent's focus request, a closed tab's neighbor), focus moved there: the tab that was active
   * takes the other pane, or the split ends when that tab is gone.
   */
  function activeSplit() {
    const active = host.activeId();
    const spaceId = host.spaceId();
    const split = active ? splits.get(spaceId) || null : null;
    if (!split) {
      return null;
    }
    if (split.other.kind === "page" && split.other.id === active) {
      const prev = split.seen;
      if (!prev || prev === active || !showable(prev)) {
        splits.delete(spaceId);
        saveSplits();
        return null;
      }
      split.other = { kind: "page", id: prev };
      split.side = split.side ? 0 : 1;
    }
    if (split.seen !== active) {
      split.seen = active;
      saveSplits();
    }
    return split;
  }

  /** Which pane ("a" first, "b" second) a frame is in, or "" outside a split. */
  function paneOf(frameId) {
    const split = activeSplit();
    if (!split) {
      return "";
    }
    if (frameId === host.activeId()) {
      return PANES[split.side];
    }
    return frameId === frameIdOf(split.other) ? PANES[1 - split.side] : "";
  }

  /** The page in the pane without focus, or null. */
  function otherPage() {
    const split = activeSplit();
    return split?.other.kind === "page" ? host.findAnyTab(split.other.id) : null;
  }

  /** Every frame the current view puts on screen, so the pool never evicts one of them. */
  function shownIds() {
    const ids = new Set();
    const active = host.activeId();
    if (active) {
      ids.add(active);
    }
    const split = activeSplit();
    if (split) {
      ids.add(frameIdOf(split.other));
    }
    const top = peekTarget();
    if (top) {
      ids.add(frameIdOf(top));
    }
    return ids;
  }

  function isShown(id) {
    return shownIds().has(id);
  }

  function mainTooNarrow() {
    return mainEl.clientWidth < SPLIT_MIN_MAIN;
  }

  /* ---------- frames ---------- */

  function frameFor(target) {
    if (target.kind === "url" && blocked.has(target.href)) {
      host.discardFrame(frameIdOf(target));
      return null;
    }
    const meta = metaFor(target);
    if (!meta) {
      return null;
    }
    const entry = host.ensureFrame(meta);
    if (target.kind === "url") {
      if (!entry.el.dataset.urlHooked) {
        entry.el.dataset.urlHooked = "1";
        entry.el.classList.add("url-loading");
        entry.el.addEventListener("load", () => entry.el.classList.remove("url-loading"));
      }
      checkUrl(target.href);
    }
    return entry;
  }

  async function checkUrl(href) {
    if (framingAllowed || checking.has(href) || blocked.has(href)) {
      return;
    }
    checking.add(href);
    const res = await fetch(`/api/frame-check?url=${encodeURIComponent(href)}`).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (data?.framable === false) {
      blocked.set(href, data.reason || "");
      host.render();
    }
  }

  /** URL frames are not pages; keep them while a view still references them. */
  function dropUnusedUrlFrames() {
    const keep = shownIds();
    for (const peek of peeks.values()) {
      for (const target of peek.stack) keep.add(frameIdOf(target));
    }
    for (const split of splits.values()) keep.add(frameIdOf(split.other));
    for (const id of host.frameIds()) {
      if (id.startsWith("url:") && !keep.has(id)) {
        host.discardFrame(id);
      }
    }
  }

  /** Outline a frame that is already on screen. The outline sits over the frame, which covers its own box. */
  function flash(frameId) {
    const entry = host.frame(frameId);
    if (!entry) {
      return;
    }
    const frame = entry.el;
    const left = frame.offsetLeft;
    const top = frame.offsetTop;
    const right = left + frame.offsetWidth;
    const bottom = top + frame.offsetHeight;
    flashEl.style.left = left + "px";
    flashEl.style.top = top + "px";
    flashEl.style.width = frame.offsetWidth + "px";
    flashEl.style.height = frame.offsetHeight + "px";
    // A corner of the frame that sits in a corner of the page area is rounded by it, so follow that curve.
    const own = getComputedStyle(frame);
    const outer = getComputedStyle(mainEl);
    const atLeft = left <= 1;
    const atTop = top <= 1;
    const atRight = right >= mainEl.clientWidth - 1;
    const atBottom = bottom >= mainEl.clientHeight - 1;
    flashEl.style.borderTopLeftRadius = atLeft && atTop ? outer.borderTopLeftRadius : own.borderTopLeftRadius;
    flashEl.style.borderTopRightRadius = atRight && atTop ? outer.borderTopRightRadius : own.borderTopRightRadius;
    flashEl.style.borderBottomLeftRadius = atLeft && atBottom ? outer.borderBottomLeftRadius : own.borderBottomLeftRadius;
    flashEl.style.borderBottomRightRadius = atRight && atBottom ? outer.borderBottomRightRadius : own.borderBottomRightRadius;
    flashEl.classList.remove("on");
    void flashEl.offsetWidth;
    flashEl.classList.add("on");
  }

  function deliverAnchor() {
    if (!pendingAnchor) {
      return;
    }
    const { frameId, anchor } = pendingAnchor;
    const entry = host.frame(frameId);
    if (!entry) {
      return;
    }
    pendingAnchor = null;
    const send = () => entry.el.contentWindow?.postMessage({ type: "scribe-scroll", id: frameId, anchor }, "*");
    if (entry.el.dataset.loaded) {
      send();
    } else {
      entry.el.addEventListener("load", send, { once: true });
    }
  }

  /* ---------- layout ---------- */

  function ratioFor(split) {
    const col = split.dir === "col";
    const size = (col ? mainEl.clientHeight : mainEl.clientWidth) || 1;
    const min = col ? SPLIT_MIN_PANE_HEIGHT : SPLIT_MIN_PANE;
    const lo = Math.max(SPLIT_MIN_RATIO, Math.min(0.5, min / size));
    const hi = Math.min(SPLIT_MAX_RATIO, Math.max(0.5, 1 - min / size));
    return Math.min(hi, Math.max(lo, split.ratio));
  }

  /** Put every pooled frame where the view wants it. Called from app.js's render. */
  function layout() {
    const active = host.activeTab();
    const split = active ? activeSplit() : null;
    if (split && sameTarget(peekTarget(), split.other)) {
      setPeek(null);
    }
    const top = peekTarget();
    const roles = new Map();
    const panes = new Map();
    // A New page has no frame: the New page screen stands in for it.
    if (active && !host.isBlank(active)) {
      host.ensureFrame(active);
      roles.set(active.id, "primary");
    }
    if (split) {
      const other = split.other.kind === "page" ? metaFor(split.other) : null;
      if (!host.isBlank(other) && frameFor(split.other)) {
        roles.set(frameIdOf(split.other), "secondary");
      }
      panes.set(active.id, PANES[split.side]);
      panes.set(frameIdOf(split.other), PANES[1 - split.side]);
      if (split.other.kind === "page") {
        host.markSeen(split.other.id);
        if (host.tabs().some((tab) => tab.id === split.other.id)) {
          opening.delete(split.other.id);
        }
      }
    }
    if (top) {
      if (frameFor(top)) {
        roles.set(frameIdOf(top), "peek");
      }
      if (top.kind === "page") {
        host.markSeen(top.id);
      }
    }
    for (const id of host.frameIds()) {
      const entry = host.frame(id);
      const role = roles.get(id) || "";
      const pane = role === "peek" ? "" : panes.get(id) || "";
      entry.el.classList.toggle("inactive", !role);
      if (entry.el.dataset.role !== role) {
        entry.el.dataset.role = role;
      }
      if ((entry.el.dataset.pane || "") !== pane) {
        if (pane) entry.el.dataset.pane = pane;
        else delete entry.el.dataset.pane;
      }
    }
    mainEl.classList.toggle("has-split", Boolean(split));
    mainEl.classList.toggle("split-col", split?.dir === "col");
    mainEl.classList.toggle("has-peek", Boolean(top));
    if (split) {
      const ratio = ratioFor(split);
      mainEl.style.setProperty("--split", String(ratio));
      divider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    }
    renderSplitChrome(split, active);
    renderPeekChrome(top);
    dropUnusedUrlFrames();
    deliverAnchor();
  }

  function renderSplitChrome(split, active) {
    const show = Boolean(split);
    divider.hidden = !show;
    for (const pane of PANES) {
      paneEls[pane].head.hidden = !show;
      paneEls[pane].body.hidden = !show;
    }
    if (!show) {
      return;
    }
    const col = split.dir === "col";
    divider.setAttribute("aria-orientation", col ? "horizontal" : "vertical");
    const dirLabel = col ? "Show side by side" : "Stack panes";
    if (dirBtn.getAttribute("aria-label") !== dirLabel) {
      dirBtn.innerHTML = col ? ICONS.sideBySide : ICONS.stack;
      dirBtn.dataset.tooltip = dirLabel;
      dirBtn.setAttribute("aria-label", dirLabel);
    }
    const focused = PANES[split.side];
    for (const pane of PANES) {
      const target = pane === focused ? { kind: "page", id: active.id } : split.other;
      renderPaneHead(pane, target, pane === focused, split);
    }
  }

  /** A pane's header. Redrawn only when what it shows changes, so a button under the pointer stays put. */
  function renderPaneHead(pane, target, focused, split) {
    const { head, body } = paneEls[pane];
    head.classList.toggle("focused", focused);
    // A site has no tab to fall back to, so the page beside it can't be closed out of the split.
    const closable = target.kind === "url" || split.other.kind === "page";
    const key = JSON.stringify([frameIdOf(target), titleOf(target), closable, target.kind === "url" && blocked.has(target.href)]);
    if (paneEls[pane].drawn === key) {
      return;
    }
    paneEls[pane].drawn = key;
    const parts = [headTitle(target)];
    if (target.kind === "url") {
      parts.push(iconButton(ICONS.browser, "Open in browser", () => openBrowser(target.href)));
    }
    if (closable) {
      parts.push(
        iconButton(ICONS.peek, "Show as peek", () => paneToPeek(pane)),
        iconButton(ICONS.close, "Close pane", () => closePane(pane), false)
      );
    }
    head.replaceChildren(...parts);
    renderBody(body, target);
  }

  function renderPeekChrome(top) {
    const show = Boolean(top);
    scrim.hidden = !show;
    card.hidden = !show;
    if (!show) {
      return;
    }
    const parts = [];
    if (activePeek().stack.length > 1) {
      parts.push(iconButton(ICONS.back, "Back", () => peekBack(), false));
    }
    parts.push(
      headTitle(top),
      top.kind === "url"
        ? iconButton(ICONS.browser, "Open in browser", () => openBrowser(top.href))
        : iconButton(ICONS.tab, "Open as tab", () => promote(top)),
      iconButton(ICONS.split, "Show in split", () => peekToSplit()),
      iconButton(ICONS.close, "Close", () => closePeek(), false)
    );
    peekHead.replaceChildren(...parts);
    card.setAttribute("aria-label", titleOf(top));
    renderBody(peekBody, top);
  }

  function headTitle(target) {
    const wrap = el("div", "view-title");
    const title = el("span", "view-title-text");
    title.textContent = titleOf(target);
    wrap.appendChild(title);
    if (target.kind === "url") {
      wrap.dataset.tooltip = target.href;
      const path = el("span", "view-title-sub");
      try {
        const url = new URL(target.href);
        path.textContent = url.pathname === "/" && !url.search ? "" : url.pathname + url.search;
      } catch {
        path.textContent = "";
      }
      if (path.textContent) {
        wrap.appendChild(path);
      }
    } else {
      wrap.dataset.tooltip = titleOf(target);
    }
    return wrap;
  }

  /** The area under a peek or split frame: a loading line for sites, or why a site can't be shown. */
  function renderBody(body, target) {
    if (target.kind !== "url") {
      body.replaceChildren();
      return;
    }
    const hostname = hostnameOf(target.href);
    if (!blocked.has(target.href)) {
      const loading = el("p", "view-loading");
      loading.textContent = `Loading ${hostname}…`;
      body.replaceChildren(loading);
      return;
    }
    const box = el("div", "view-blocked");
    const text = el("p", "");
    const strong = document.createElement("strong");
    strong.textContent = hostname;
    text.append(strong, " doesn't allow being shown inside other pages.");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = ICONS.browser + "<span>Open in browser</span>";
    btn.addEventListener("click", () => openBrowser(target.href));
    box.append(text, btn);
    body.replaceChildren(box);
  }

  /* ---------- actions ---------- */

  function openBrowser(href) {
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function closePeek({ refocus = true } = {}) {
    if (!activePeek()) {
      return false;
    }
    setPeek(null);
    host.render();
    if (refocus) {
      host.frame(host.activeId())?.el.focus();
    }
    return true;
  }

  function peekBack() {
    const peek = activePeek();
    if (!peek || peek.stack.length < 2) {
      return;
    }
    peek.stack.pop();
    host.render();
    focusPeek();
  }

  function focusPeek() {
    const top = peekTarget();
    if (top) {
      host.frame(frameIdOf(top))?.el.focus();
    }
  }

  function focusActiveFrame() {
    host.frame(host.activeId())?.el.focus();
  }

  /** Give a page pane a tab in the strip when it has none: both panes of a split are tabs. */
  function ensureTab(target) {
    if (target.kind !== "page" || showable(target.id)) {
      return;
    }
    opening.add(target.id);
    Promise.resolve(host.openPage(target.id, { activate: false })).finally(() => {
      // The tab arrives over the socket; give it a moment before the split may be pruned without it.
      setTimeout(() => opening.delete(target.id), 2000);
    });
  }

  /** Show `target` in the pane without focus, starting a split (side by side) when there is none. */
  function setSplit(target) {
    const spaceId = host.spaceId();
    const prev = activeSplit();
    ensureTab(target);
    splits.set(spaceId, {
      other: target,
      ratio: prev?.ratio || lastRatio,
      dir: prev?.dir || "row",
      side: prev?.side || 0,
      seen: host.activeId(),
    });
    saveSplits();
  }

  /** End the split, keeping the page of the other pane. Closing the focused pane moves focus there. */
  function closePane(pane) {
    const split = activeSplit();
    if (!split) {
      return false;
    }
    const focused = pane === PANES[split.side];
    splits.delete(host.spaceId());
    saveSplits();
    if (focused && split.other.kind === "page" && showable(split.other.id)) {
      host.activate(split.other.id);
    } else {
      host.render();
    }
    focusActiveFrame();
    return true;
  }

  function closeSplit() {
    const split = activeSplit();
    return split ? closePane(PANES[1 - split.side]) : false;
  }

  /** Move focus to a pane; the tab strip and the chat follow, as they do for a tab switch. */
  function focusPane(pane) {
    const split = activeSplit();
    if (!split || pane === PANES[split.side] || split.other.kind !== "page" || !showable(split.other.id)) {
      return false;
    }
    host.activate(split.other.id);
    return true;
  }

  function swapPanes() {
    const split = activeSplit();
    if (!split) {
      return;
    }
    split.side = split.side ? 0 : 1;
    split.ratio = 1 - ratioFor(split);
    saveSplits();
    host.render();
  }

  function toggleDir() {
    const split = activeSplit();
    if (!split) {
      return;
    }
    split.dir = split.dir === "col" ? "row" : "col";
    saveSplits();
    host.render();
  }

  /* ---------- pointer drops from the strip and pane headers ---------- */

  function beginPageDrag(source) {
    pageDrag = source;
    dropOverlay.hidden = false;
    dropPreview.hidden = true;
    document.body.classList.add("dragging-pane");
  }

  function pageDropAt(x, y) {
    if (!pageDrag || !host.activeId()) return null;
    const box = mainEl.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
    const dx = x - box.left, dy = y - box.top;
    const edges = [
      ["left", dx / Math.min(90, box.width * 0.2)],
      ["right", (box.width - dx) / Math.min(90, box.width * 0.2)],
      ["top", dy / Math.min(90, box.height * 0.2)],
      ["bottom", (box.height - dy) / Math.min(90, box.height * 0.2)],
    ].sort((a, b) => a[1] - b[1]);
    const split = activeSplit();
    if (edges[0][1] <= 1) {
      const edge = edges[0][0];
      const col = edge === "top" || edge === "bottom";
      if ((col ? box.height < SPLIT_MIN_PANE_HEIGHT * 2 : mainTooNarrow())) return null;
      return { edge };
    }
    if (pageDrag.pane) return null;
    const second = split && (split.dir === "col" ? dy / box.height : dx / box.width) > ratioFor(split);
    return { pane: second ? "b" : "a" };
  }

  function updatePageDrag(x, y) {
    const drop = pageDropAt(x, y);
    dropPreview.hidden = !drop;
    if (!drop) return null;
    const split = activeSplit();
    let left = 0, top = 0, width = 1, height = 1;
    if (drop.edge) {
      if (drop.edge === "left" || drop.edge === "right") {
        width = 0.5; left = drop.edge === "right" ? 0.5 : 0;
      } else {
        height = 0.5; top = drop.edge === "bottom" ? 0.5 : 0;
      }
    } else if (split) {
      const ratio = ratioFor(split), second = drop.pane === "b";
      if (split.dir === "col") { top = second ? ratio : 0; height = second ? 1 - ratio : ratio; }
      else { left = second ? ratio : 0; width = second ? 1 - ratio : ratio; }
    }
    Object.assign(dropPreview.style, { left: left * 100 + "%", top: top * 100 + "%", width: width * 100 + "%", height: height * 100 + "%" });
    dropPreview.textContent = drop.edge ? "Place " + drop.edge : "Replace pane";
    return drop;
  }

  function endPageDrag() {
    pageDrag = null;
    dropOverlay.hidden = true;
    document.body.classList.remove("dragging-pane");
  }

  function canCloseDraggedPane(pane) {
    const split = activeSplit();
    return Boolean(split && (pane !== PANES[split.side] || split.other.kind === "page"));
  }

  async function dropPage(source, drop) {
    if (!drop) return;
    if (drop.strip) {
      if (source.pane && canCloseDraggedPane(source.pane)) closePane(source.pane);
      return;
    }
    let split = activeSplit();
    if (drop.edge) {
      let pane = source.pane || paneOf(source.id);
      if (!pane) {
        if (source.id === host.activeId()) {
          await open(source.id, "split");
        } else {
          setSplit({ kind: "page", id: source.id });
        }
        split = activeSplit();
        pane = paneOf(source.id);
      }
      if (!split || !pane) return;
      const side = drop.edge === "right" || drop.edge === "bottom" ? 1 : 0;
      split.side = pane === PANES[split.side] ? side : 1 - side;
      split.dir = drop.edge === "top" || drop.edge === "bottom" ? "col" : "row";
      split.ratio = 0.5;
      saveSplits();
      host.render();
    } else if (source.id) {
      const existing = paneOf(source.id);
      if (existing) {
        if (existing !== drop.pane) swapPanes();
      } else if (!split || drop.pane === PANES[split.side]) {
        host.selectTab(source.id);
      } else {
        setSplit({ kind: "page", id: source.id });
        host.render();
      }
    }
  }

  /** Take a pane out of the split and show its page as a peek over the other one. */
  function paneToPeek(pane) {
    const split = activeSplit();
    if (!split) {
      return;
    }
    const focused = pane === PANES[split.side];
    const target = focused ? { kind: "page", id: host.activeId() } : split.other;
    if (host.isBlank(metaFor(target))) {
      host.showNotice("A New page can't be shown as a peek");
      return;
    }
    if (focused && (split.other.kind !== "page" || !showable(split.other.id))) {
      return;
    }
    splits.delete(host.spaceId());
    saveSplits();
    if (focused) {
      host.activate(split.other.id);
    }
    setPeek({ stack: [target] });
    host.render();
    focusPeek();
  }

  function peekToSplit() {
    const top = peekTarget();
    const active = host.activeId();
    if (!top) {
      return;
    }
    if (!active || mainTooNarrow() || (top.kind === "page" && top.id === active)) {
      host.showNotice(active ? "The window is too narrow for a split" : "Open a tab first to split beside it");
      return;
    }
    setPeek(null);
    setSplit(top);
    host.render();
  }

  /** "Open as tab" from a peek. The frame stays in the pool, so the page doesn't reload. */
  function promote(target) {
    if (target.kind !== "page") {
      return;
    }
    setPeek(null);
    navigate(target.id, {});
  }

  function navigate(id, { background = false } = {}) {
    const from = host.activeId();
    if (host.tabs().some((tab) => tab.id === id)) {
      if (!background) {
        if (from && from !== id) {
          openedFrom.set(id, from);
        }
        host.selectTab(id);
      }
      host.render();
      return;
    }
    const idx = host.tabs().findIndex((tab) => tab.id === from);
    const before = idx === -1 ? undefined : host.tabs()[idx + 1]?.id ?? null;
    if (!background && from) {
      openedFrom.set(id, from);
    }
    host.openPage(id, { activate: !background, before });
  }

  /**
   * Open a link target. `source.role` says where the link was clicked: "primary", "secondary",
   * "peek", or "chrome" (Library, palette). A null mode means the Settings default for pages,
   * and the browser for URLs.
   */
  async function open(raw, mode, { source = { role: "chrome" }, anchor = "", background = false } = {}) {
    const href = externalUrl(raw);
    /** @type {Target | null} */
    let target = null;
    if (href) {
      target = { kind: "url", href };
      if (!mode || mode === "tab") {
        openBrowser(href);
        return { ok: true, mode: "browser", url: href };
      }
    } else {
      const page = findPage(String(raw || "").replace(/\|auto$/, "").trim());
      if (!page) {
        const trashed = await inTrash(String(raw || "").trim());
        if (trashed) {
          host.showNotice(`“${trashed.title}” is in the Trash`, {
            action: { label: "Restore", run: () => restoreFromTrash(trashed.id) },
          });
          return { ok: false, error: "in_trash" };
        }
        host.showNotice(`No page called “${String(raw || "").trim()}”`);
        return { ok: false, error: "not_found" };
      }
      target = { kind: "page", id: page.id };
      mode = mode || host.linkMode();
    }

    const active = host.activeId();
    const frameId = frameIdOf(target);
    if (mode === "split" && (!active || mainTooNarrow())) {
      mode = !active && target.kind === "page" ? "tab" : "peek";
    }
    if (anchor && target.kind === "page") {
      pendingAnchor = { frameId, anchor };
    }

    if (mode === "tab") {
      if (source.role === "peek") {
        setPeek(null);
      }
      if (target.id === active) {
        host.render();
        flash(frameId);
        return { ok: true, mode, id: target.id, alreadyVisible: true };
      }
      navigate(target.id, { background });
      return { ok: true, mode, id: target.id };
    }

    const split = activeSplit();
    const visibleAsPrimary = target.kind === "page" && target.id === active;
    const visibleInSplit = split && sameTarget(split.other, target);

    if (mode === "peek") {
      if (visibleAsPrimary || visibleInSplit) {
        if (source.role === "peek") setPeek(null);
        host.render();
        flash(frameId);
        return { ok: true, mode, alreadyVisible: true, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
      }
      const peek = activePeek();
      if (source.role === "peek" && peek) {
        if (!sameTarget(peekTarget(), target)) {
          peek.stack.push(target);
          if (peek.stack.length > PEEK_STACK_MAX) {
            peek.stack.shift();
          }
        }
      } else {
        setPeek({ stack: [target] });
      }
      host.render();
      focusPeek();
      return { ok: true, mode, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
    }

    // split
    if (visibleInSplit) {
      if (source.role === "peek") setPeek(null);
      host.render();
      flash(frameId);
      return { ok: true, mode, alreadyVisible: true, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
    }
    if (visibleAsPrimary) {
      // Splitting the tab you are on: it keeps its place and a New page opens beside it, with focus.
      if (split || host.draftId() === active) {
        host.render();
        flash(frameId);
        return { ok: true, mode, id: target.id, alreadyVisible: true };
      }
      if (!(await host.newPage()) || host.activeId() === active) {
        return { ok: false, error: "no_new_page" };
      }
      splits.set(host.spaceId(), { other: target, ratio: lastRatio, dir: "row", side: 1, seen: host.activeId() });
      saveSplits();
      host.render();
      return { ok: true, mode, id: target.id };
    }
    if (source.role === "peek" || sameTarget(peekTarget(), target)) {
      setPeek(null);
    }
    setSplit(target);
    host.render();
    return { ok: true, mode, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
  }

  async function restoreFromTrash(id) {
    const res = await fetch(`/api/trash/${encodeURIComponent(id)}/restore`, { method: "POST" }).catch(() => null);
    host.showNotice(res?.ok ? "Restored to the Library" : "Could not restore");
  }

  /** Look pages up for a page's link labels: { [target]: { id, title, open } | null }. */
  function resolve(targets) {
    const pages = {};
    for (const raw of Array.isArray(targets) ? targets.slice(0, 500) : []) {
      const key = String(raw || "").trim();
      if (!key) {
        continue;
      }
      const page = findPage(key);
      pages[key] = page ? { id: page.id, title: page.title, open: host.tabs().some((tab) => tab.id === page.id) } : null;
    }
    return pages;
  }

  /* ---------- hooks from app.js ---------- */

  /**
   * The user picked a tab: it shows in the focused pane. Picking the page of the other pane moves
   * focus there instead, so the two trade places in the split's bookkeeping, not on screen.
   */
  function onSelect(nextId) {
    const split = activeSplit();
    const from = host.activeId();
    if (split?.other.kind === "page" && split.other.id === nextId && from) {
      split.other = { kind: "page", id: from };
      split.side = split.side ? 0 : 1;
      split.seen = nextId;
      saveSplits();
    }
    const top = peekTarget();
    if (top?.kind === "page" && top.id === nextId) {
      setPeek(null);
    }
    for (const id of [...openedFrom.keys()]) {
      if (id !== nextId) {
        openedFrom.delete(id);
      }
    }
  }

  /** The tab to return to when `id` leaves the strip, if a link opened it and you haven't moved on. */
  function returnTarget(id) {
    // Closing the focused pane's tab leaves the other pane, not a neighbor from the strip.
    const split = id === host.activeId() ? activeSplit() : null;
    if (split?.other.kind === "page" && host.tabs().some((tab) => tab.id === split.other.id)) {
      openedFrom.delete(id);
      return split.other.id;
    }
    const from = openedFrom.get(id);
    openedFrom.delete(id);
    return from && from !== id && host.tabs().some((tab) => tab.id === from) ? from : null;
  }

  function onDeleted(id) {
    let changed = false;
    for (const [key, peek] of peeks) {
      peek.stack = peek.stack.filter((target) => !(target.kind === "page" && target.id === id));
      if (JSON.parse(key)[1] === id || !peek.stack.length) {
        peeks.delete(key);
      }
    }
    for (const [spaceId, split] of [...splits]) {
      if (split.other.kind === "page" && split.other.id === id) {
        splits.delete(spaceId);
        changed = true;
      }
    }
    openedFrom.delete(id);
    if (changed) {
      saveSplits();
    }
  }

  /** A tab left the strip. A pane is always a tab, so the split it was in ends. */
  function onClosed(id) {
    const split = splits.get(host.spaceId());
    if (split?.other.kind === "page" && split.other.id === id) {
      splits.delete(host.spaceId());
      saveSplits();
    }
  }

  /** Something was pressed or typed in a page: the pane showing it takes focus. */
  function onFrameActive(frameId) {
    const split = activeSplit();
    if (split && frameId && frameId === frameIdOf(split.other)) {
      focusPane(PANES[1 - split.side]);
    }
  }

  /** After a snapshot: forget splits whose pages are gone. */
  function prune() {
    let changed = false;
    const spaceIds = host.spaceIds();
    // Spaces are created lazily. The first space inherits the original tab strip's views.
    if (!spaceIds.includes("default") && spaceIds.length) {
      const firstSpace = spaceIds[0];
      if (splits.has("default")) {
        if (!splits.has(firstSpace)) splits.set(firstSpace, splits.get("default"));
        splits.delete("default");
        changed = true;
      }
      for (const [key, peek] of peeks) {
        const [spaceId, tabId] = JSON.parse(key);
        if (spaceId === "default") {
          peeks.set(JSON.stringify([firstSpace, tabId]), peek);
          peeks.delete(key);
        }
      }
    }
    for (const [spaceId, split] of [...splits]) {
      const gone = split.other.kind === "page" && (spaceId === host.spaceId() ? !showable(split.other.id) : !host.findAnyTab(split.other.id));
      if (!spaceIds.includes(spaceId) || gone) {
        splits.delete(spaceId);
        changed = true;
      }
    }
    for (const [key, peek] of peeks) {
      const [spaceId, tabId] = JSON.parse(key);
      peek.stack = peek.stack.filter((target) => target.kind === "url" || host.findAnyTab(target.id));
      if (!spaceIds.includes(spaceId) || (tabId && !host.findAnyTab(tabId)) || !peek.stack.length) {
        peeks.delete(key);
      }
    }
    if (changed) {
      saveSplits();
    }
  }

  /** Esc, Ctrl+W: close a peek first. True when consumed. */
  function escape() {
    return closePeek();
  }

  /** Ctrl/Cmd navigates, Shift splits, Alt peeks. */
  function modeFromEvent(event) {
    if (!event) {
      return null;
    }
    if (event.ctrlKey || event.metaKey) {
      return "tab";
    }
    if (event.shiftKey) {
      return "split";
    }
    if (event.altKey) {
      return "peek";
    }
    return null;
  }

  /** Which view a frame is in, for links clicked inside it. */
  function roleOf(frameId) {
    const role = host.frame(frameId)?.el.dataset.role;
    return role || "primary";
  }

  /* ---------- pane focus ---------- */

  // A press on a pane's header or its New page screen. Pages report their own (onFrameActive).
  mainEl.addEventListener(
    "pointerdown",
    (event) => {
      const paneEl = event.target instanceof Element ? event.target.closest("[data-pane]") : null;
      if (paneEl && !event.target.closest(".pane-head button")) {
        focusPane(paneEl.dataset.pane);
      }
    },
    true
  );
  // Sites and embedded pages have no bridge to report a press: the frame taking focus says it.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      const el = document.activeElement;
      const split = el?.tagName === "IFRAME" ? activeSplit() : null;
      if (split && host.frame(frameIdOf(split.other))?.el === el) {
        focusPane(PANES[1 - split.side]);
      }
    }, 0);
  });

  /* ---------- split divider ---------- */

  function applyRatio(ratio, snap) {
    const split = activeSplit();
    if (!split) {
      return;
    }
    let next = Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio));
    if (snap && Math.abs(next - 0.5) <= SPLIT_SNAP) {
      next = 0.5;
    }
    split.ratio = next;
    const shown = ratioFor(split);
    mainEl.style.setProperty("--split", String(shown));
    divider.setAttribute("aria-valuenow", String(Math.round(shown * 100)));
  }

  function commitRatio() {
    const split = activeSplit();
    if (!split) {
      return;
    }
    split.ratio = ratioFor(split);
    lastRatio = split.ratio;
    writeStorage(SPLIT_RATIO_KEY, String(lastRatio));
    saveSplits();
  }

  divider.addEventListener("pointerenter", () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => divider.classList.add("hot"), HOVER_DELAY);
  });
  divider.addEventListener("pointerleave", () => {
    clearTimeout(hoverTimer);
    divider.classList.remove("hot");
  });
  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-split");
    document.body.classList.toggle("resizing-col", activeSplit()?.dir === "col");
    const rect = mainEl.getBoundingClientRect();
    const col = activeSplit()?.dir === "col";
    let raf = 0;
    let latest = 0;
    resizing = { pointerId: event.pointerId };
    function onMove(move) {
      if (move.pointerId !== event.pointerId) {
        return;
      }
      latest = col ? (move.clientY - rect.top) / rect.height : (move.clientX - rect.left) / rect.width;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          applyRatio(latest, true);
        });
      }
    }
    function onUp(up) {
      if (up.pointerId !== event.pointerId) {
        return;
      }
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      divider.removeEventListener("pointercancel", onUp);
      if (divider.hasPointerCapture(event.pointerId)) {
        divider.releasePointerCapture(event.pointerId);
      }
      cancelAnimationFrame(raf);
      if (latest) {
        applyRatio(latest, true);
      }
      document.body.classList.remove("resizing-split");
      resizing = null;
      commitRatio();
    }
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
    divider.addEventListener("pointercancel", onUp);
  });
  divider.addEventListener("dblclick", () => {
    applyRatio(0.5, false);
    commitRatio();
  });
  divider.addEventListener("keydown", (event) => {
    const split = activeSplit();
    if (!split) {
      return;
    }
    const step = event.shiftKey ? 0.1 : 0.02;
    const current = ratioFor(split);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      applyRatio(current - step, false);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      applyRatio(current + step, false);
    } else if (event.key === "Home") {
      applyRatio(0, false);
    } else if (event.key === "End") {
      applyRatio(1, false);
    } else {
      return;
    }
    event.preventDefault();
    commitRatio();
  });

  window.addEventListener("resize", () => {
    const split = activeSplit();
    if (split && !resizing) {
      mainEl.style.setProperty("--split", String(ratioFor(split)));
    }
  });

  return {
    layout,
    open,
    resolve,
    escape,
    closePeek,
    shownIds,
    isShown,
    onSelect,
    onDeleted,
    onClosed,
    onFrameActive,
    paneOf,
    otherPage,
    closeSplit,
    focusPane,
    returnTarget,
    prune,
    modeFromEvent,
    roleOf,
    beginPageDrag,
    updatePageDrag,
    endPageDrag,
    canCloseDraggedPane,
    dropPage,
    peekOpen: () => Boolean(activePeek()),
  };
};
