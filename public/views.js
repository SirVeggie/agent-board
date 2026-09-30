/**
 * Page links and the views they open: a peek (a fixed card over the page area) and a split
 * (a second pane tied to the tab that opened it). app.js owns the frame pool; this decides
 * which pooled iframe sits where. Frames are only ever restyled, never moved in the DOM,
 * because moving an iframe reloads it.
 */
window.createViews = function createViews(host) {
  const mainEl = host.mainEl;
  const SPLITS_KEY = "agent-board.splits";
  const SPLIT_RATIO_KEY = "agent-board.splitRatio";
  /** Below this page-area width a split opens as a peek instead. */
  const SPLIT_MIN_MAIN = 720;
  const SPLIT_MIN_PANE = 280;
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
    browser: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  };

  /** @typedef {{ kind: "page", id: string } | { kind: "url", href: string }} Target */

  /** @type {null | { stack: Target[] }} */
  let peek = null;
  /** Host tab id → its split. Kept per window: a split is a temporary view, not board data. */
  /** @type {Map<string, { target: Target, ratio: number }>} */
  const splits = loadSplits();
  let lastRatio = clampStoredRatio(Number(readStorage(SPLIT_RATIO_KEY)));
  /** Where a link-opened tab came from; closing it returns there while it's still the tab you're on. */
  const openedFrom = new Map();
  /** href → reason, for sites that refuse to be framed. */
  const blocked = new Map();
  const checking = new Set();
  /** @type {null | { frameId: string, anchor: string }} */
  let pendingAnchor = null;
  let hoverTimer = 0;
  let resizing = null;

  /* ---------- DOM ---------- */

  const scrim = el("div", "peek-scrim");
  const card = el("div", "peek-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "false");
  const peekHead = el("div", "view-head");
  const peekBody = el("div", "view-body");
  card.append(peekHead, peekBody);
  const splitHead = el("div", "view-head split-head");
  const splitBody = el("div", "view-body split-body");
  const divider = el("div", "split-divider");
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-label", "Resize split");
  divider.setAttribute("aria-valuemin", String(SPLIT_MIN_RATIO * 100));
  divider.setAttribute("aria-valuemax", String(SPLIT_MAX_RATIO * 100));
  divider.tabIndex = 0;
  for (const node of [scrim, card, splitHead, splitBody, divider]) {
    node.hidden = true;
    mainEl.appendChild(node);
  }
  const flashEl = el("div", "view-flash");
  flashEl.addEventListener("animationend", () => flashEl.classList.remove("on"));
  mainEl.appendChild(flashEl);

  scrim.addEventListener("mousedown", (event) => {
    event.preventDefault();
    closePeek();
  });

  function el(tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function iconButton(icon, label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "view-btn";
    btn.innerHTML = icon;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

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
      for (const [hostId, value] of Object.entries(raw || {})) {
        const target = value?.page ? { kind: "page", id: String(value.page) } : value?.url ? { kind: "url", href: String(value.url) } : null;
        if (target) {
          map.set(hostId, { target, ratio: clampStoredRatio(Number(value.ratio)) });
        }
      }
    } catch {
      /* ignore a damaged entry */
    }
    return map;
  }

  function saveSplits() {
    const out = {};
    for (const [hostId, split] of splits) {
      out[hostId] = split.target.kind === "page" ? { page: split.target.id, ratio: split.ratio } : { url: split.target.href, ratio: split.ratio };
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
  function findPage(raw) {
    const text = String(raw || "").trim();
    if (!text) {
      return null;
    }
    const byId = host.findAnyTab(text);
    if (byId) {
      return byId;
    }
    const matches = [...host.tabs().map((tab) => ({ tab, open: true })), ...host.closed().map((tab) => ({ tab, open: false }))].filter(
      (item) => item.tab.key === text
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

  function peekTarget() {
    return peek ? peek.stack[peek.stack.length - 1] : null;
  }

  function activeSplit() {
    const active = host.activeId();
    return active ? splits.get(active) || null : null;
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
      ids.add(frameIdOf(split.target));
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
    if (checking.has(href) || blocked.has(href)) {
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

  /** URL frames are not pages; drop them once nothing shows them. */
  function dropUnusedUrlFrames() {
    const keep = shownIds();
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
    flashEl.style.left = frame.offsetLeft + "px";
    flashEl.style.top = frame.offsetTop + "px";
    flashEl.style.width = frame.offsetWidth + "px";
    flashEl.style.height = frame.offsetHeight + "px";
    flashEl.style.borderRadius = getComputedStyle(frame).borderRadius;
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
    const send = () => entry.el.contentWindow?.postMessage({ type: "agent-board-scroll", id: frameId, anchor }, "*");
    if (entry.el.dataset.loaded) {
      send();
    } else {
      entry.el.addEventListener("load", send, { once: true });
    }
  }

  /* ---------- layout ---------- */

  function ratioFor(split) {
    const width = mainEl.clientWidth || 1;
    const lo = Math.max(SPLIT_MIN_RATIO, Math.min(0.5, SPLIT_MIN_PANE / width));
    const hi = Math.min(SPLIT_MAX_RATIO, Math.max(0.5, 1 - SPLIT_MIN_PANE / width));
    return Math.min(hi, Math.max(lo, split.ratio));
  }

  /** Put every pooled frame where the view wants it. Called from app.js's render. */
  function layout() {
    const primary = host.activeTab();
    const split = primary ? splits.get(primary.id) || null : null;
    const top = peekTarget();
    const roles = new Map();
    if (primary) {
      host.ensureFrame(primary);
      roles.set(primary.id, "primary");
    }
    if (split) {
      if (frameFor(split.target)) {
        roles.set(frameIdOf(split.target), "secondary");
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
    if (split?.target.kind === "page") {
      host.markSeen(split.target.id);
    }
    for (const id of host.frameIds()) {
      const entry = host.frame(id);
      const role = roles.get(id) || "";
      entry.el.classList.toggle("inactive", !role);
      if (entry.el.dataset.role !== role) {
        entry.el.dataset.role = role;
      }
    }
    mainEl.classList.toggle("has-split", Boolean(split));
    mainEl.classList.toggle("has-peek", Boolean(top));
    if (split) {
      const ratio = ratioFor(split);
      mainEl.style.setProperty("--split", String(ratio));
      divider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    }
    renderSplitChrome(primary, split);
    renderPeekChrome(top);
    dropUnusedUrlFrames();
    deliverAnchor();
  }

  function renderSplitChrome(primary, split) {
    const show = Boolean(split);
    splitHead.hidden = !show;
    splitBody.hidden = !show;
    divider.hidden = !show;
    if (!show) {
      return;
    }
    const target = split.target;
    splitHead.replaceChildren(
      headTitle(target),
      openOutButton(target, () => promote(target, { fromSplit: primary.id })),
      iconButton(ICONS.peek, "Show as peek", () => splitToPeek()),
      iconButton(ICONS.close, "Close split", () => closeSplit())
    );
    renderBody(splitBody, target);
  }

  function renderPeekChrome(top) {
    const show = Boolean(top);
    scrim.hidden = !show;
    card.hidden = !show;
    if (!show) {
      return;
    }
    const parts = [];
    if (peek.stack.length > 1) {
      parts.push(iconButton(ICONS.back, "Back", () => peekBack()));
    }
    parts.push(
      headTitle(top),
      openOutButton(top, () => promote(top, { fromPeek: true })),
      iconButton(ICONS.split, "Show in split", () => peekToSplit()),
      iconButton(ICONS.close, "Close (Esc)", () => closePeek())
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
      wrap.title = target.href;
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
      wrap.title = titleOf(target);
    }
    return wrap;
  }

  function openOutButton(target, onClick) {
    return target.kind === "url"
      ? iconButton(ICONS.browser, "Open in browser", () => openBrowser(target.href))
      : iconButton(ICONS.tab, "Open as tab", onClick);
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
    if (!peek) {
      return false;
    }
    peek = null;
    host.render();
    if (refocus) {
      host.frame(host.activeId())?.el.focus();
    }
    return true;
  }

  function peekBack() {
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

  function closeSplit(hostId = host.activeId()) {
    if (!hostId || !splits.delete(hostId)) {
      return false;
    }
    saveSplits();
    host.render();
    return true;
  }

  function setSplit(hostId, target) {
    splits.set(hostId, { target, ratio: splits.get(hostId)?.ratio || lastRatio });
    saveSplits();
  }

  function splitToPeek() {
    const split = activeSplit();
    if (!split) {
      return;
    }
    splits.delete(host.activeId());
    saveSplits();
    peek = { stack: [split.target] };
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
    setSplit(active, top);
    peek = null;
    host.render();
  }

  /** "Open as tab" from a peek or split. The frame stays in the pool, so the page doesn't reload. */
  function promote(target, { fromPeek = false, fromSplit = null } = {}) {
    if (target.kind !== "page") {
      return;
    }
    if (fromPeek) {
      peek = null;
    }
    if (fromSplit) {
      splits.delete(fromSplit);
      saveSplits();
    }
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
      const page = findPage(raw);
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
        peek = null;
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
    const visibleInSplit = split && sameTarget(split.target, target);

    if (mode === "peek") {
      if (visibleAsPrimary || visibleInSplit) {
        peek = source.role === "peek" ? null : peek;
        host.render();
        flash(frameId);
        return { ok: true, mode, alreadyVisible: true, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
      }
      if (source.role === "peek" && peek) {
        if (!sameTarget(peekTarget(), target)) {
          peek.stack.push(target);
          if (peek.stack.length > PEEK_STACK_MAX) {
            peek.stack.shift();
          }
        }
      } else {
        peek = { stack: [target] };
      }
      host.render();
      focusPeek();
      return { ok: true, mode, ...(target.kind === "page" ? { id: target.id } : { url: target.href }) };
    }

    // split
    if (visibleAsPrimary) {
      flash(frameId);
      return { ok: true, mode, id: target.id, alreadyVisible: true };
    }
    if (source.role === "peek" || sameTarget(peekTarget(), target)) {
      peek = null;
    }
    setSplit(active, target);
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

  /** The user picked a tab. Picking the page shown beside it in a split takes it out of the split. */
  function onSelect(nextId) {
    const prev = host.activeId();
    const split = prev ? splits.get(prev) : null;
    if (split?.target.kind === "page" && split.target.id === nextId) {
      splits.delete(prev);
      saveSplits();
    }
    const top = peekTarget();
    if (top?.kind === "page" && top.id === nextId) {
      peek = null;
    }
    for (const id of [...openedFrom.keys()]) {
      if (id !== nextId) {
        openedFrom.delete(id);
      }
    }
  }

  /** The tab to return to when `id` leaves the strip, if a link opened it and you haven't moved on. */
  function returnTarget(id) {
    const from = openedFrom.get(id);
    openedFrom.delete(id);
    return from && from !== id && host.tabs().some((tab) => tab.id === from) ? from : null;
  }

  function onDeleted(id) {
    let changed = false;
    if (peek) {
      const before = peek.stack.length;
      peek.stack = peek.stack.filter((target) => !(target.kind === "page" && target.id === id));
      if (!peek.stack.length) {
        peek = null;
      }
      changed = changed || before !== (peek?.stack.length ?? 0);
    }
    for (const [hostId, split] of [...splits]) {
      if (hostId === id || (split.target.kind === "page" && split.target.id === id)) {
        splits.delete(hostId);
        changed = true;
      }
    }
    openedFrom.delete(id);
    if (changed) {
      saveSplits();
    }
  }

  /** After a snapshot: forget splits whose pages are gone. */
  function prune() {
    let changed = false;
    for (const [hostId, split] of [...splits]) {
      if (!host.findAnyTab(hostId) || (split.target.kind === "page" && !host.findAnyTab(split.target.id))) {
        splits.delete(hostId);
        changed = true;
      }
    }
    if (peek) {
      peek.stack = peek.stack.filter((target) => target.kind === "url" || host.findAnyTab(target.id));
      if (!peek.stack.length) {
        peek = null;
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
    const rect = mainEl.getBoundingClientRect();
    let raf = 0;
    let latest = 0;
    resizing = { pointerId: event.pointerId };
    function onMove(move) {
      if (move.pointerId !== event.pointerId) {
        return;
      }
      latest = (move.clientX - rect.left) / rect.width;
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
    if (event.key === "ArrowLeft") {
      applyRatio(current - step, false);
    } else if (event.key === "ArrowRight") {
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
    returnTarget,
    prune,
    modeFromEvent,
    roleOf,
    peekOpen: () => Boolean(peek),
  };
};
