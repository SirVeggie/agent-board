(() => {
  const tabsEl = document.getElementById("tabs");
  const fadeEl = document.getElementById("tabs-fade");
  const fadeLeftEl = document.getElementById("tabs-fade-left");
  const emptyEl = document.getElementById("empty");
  const framesEl = document.getElementById("frames");
  const clearBtn = document.getElementById("clear");
  const archiveToggle = document.getElementById("archive-toggle");
  const archiveBadge = document.getElementById("archive-badge");
  const archivePane = document.getElementById("archive-pane");
  const archiveCountEl = document.getElementById("archive-count");
  const archiveSearch = document.getElementById("archive-search");
  const archiveList = document.getElementById("archive-list");
  const archiveNone = document.getElementById("archive-none");
  const archiveEmptyBtn = document.getElementById("archive-empty");
  const archiveResizer = document.getElementById("archive-resizer");
  const confirmDlg = document.getElementById("confirm");
  const confirmMessage = document.getElementById("confirm-message");
  const paletteEl = document.getElementById("palette");
  const paletteBackdrop = document.getElementById("palette-backdrop");
  const paletteInput = document.getElementById("palette-input");
  const paletteList = document.getElementById("palette-list");
  const paletteEmpty = document.getElementById("palette-empty");

  const SANDBOX =
    "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
  const LIVE_FRAME_CAP = 5;
  const ARCHIVE_OPEN_KEY = "agent-board.archiveOpen";
  const ARCHIVE_WIDTH_KEY = "agent-board.archiveWidth";

  /** @type {{ tabs: Array<any>, archive: Array<any>, activeId: string | null, connected: boolean, archiveOpen: boolean }} */
  const state = {
    tabs: [],
    archive: [],
    activeId: null,
    connected: false,
    archiveOpen: localStorage.getItem(ARCHIVE_OPEN_KEY) === "1",
  };

  /** @type {Map<string, { el: HTMLIFrameElement, revision: number }>} */
  const frames = new Map();
  /** @type {Set<string>} */
  const unread = new Set();
  /** @type {Set<string>} */
  const unreadArchive = new Set();

  /** @type {WebSocket | null} */
  let socket = null;
  let lastInteractedAt = 0;
  let lastEditAt = 0;
  let searchTimer = 0;
  /** @type {Array<any> | null} */
  let searchHits = null;
  let searchMeta = null;
  let paletteTimer = 0;
  let paletteReq = 0;
  /** @type {Array<any>} */
  let paletteHits = [];
  let paletteIndex = 0;
  /** Archive row this window is opening. Focus it here; agent activate can decline. */
  let pendingRestoreId = null;

  applyArchiveWidth(Number(localStorage.getItem(ARCHIVE_WIDTH_KEY)) || 280);

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    socket = ws;
    ws.addEventListener("open", () => {
      state.connected = true;
      renderChrome();
      reportViewer();
    });
    ws.addEventListener("message", (event) => {
      applyEvent(JSON.parse(event.data));
    });
    ws.addEventListener("close", () => {
      if (socket === ws) {
        socket = null;
      }
      state.connected = false;
      renderChrome();
      setTimeout(connect, 1000);
    });
  }

  function reportViewer() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "viewer_state",
        selectedId: state.activeId,
        lastInteractedAt,
        lastEditAt,
      })
    );
  }

  function noteEdit() {
    const now = Date.now();
    lastEditAt = now;
    lastInteractedAt = now;
    reportViewer();
  }

  function isArchivedMeta(tab) {
    return Boolean(tab?.archivedAt);
  }

  function applyEvent(msg) {
    if (msg.type === "snapshot") {
      state.tabs = msg.tabs;
      state.archive = Array.isArray(msg.archive) ? msg.archive : [];
      const hash = location.hash.replace(/^#/, "");
      const fromOpen = state.tabs.find((tab) => tab.id === hash || tab.key === hash);
      const fromArchive = state.archive.find((tab) => tab.id === hash || tab.key === hash);
      state.activeId = fromOpen ? fromOpen.id : msg.activeId;
      unread.clear();
      unreadArchive.clear();
      syncHash();
      render();
      reportViewer();
      if (fromArchive && !fromOpen) {
        restoreTab(fromArchive.id);
      }
      return;
    }
    if (msg.type === "tab_upserted") {
      if (isArchivedMeta(msg.tab)) {
        const existed = state.archive.some((item) => item.id === msg.tab.id);
        upsertArchive(msg.tab, existed);
        render();
        return;
      }
      const idx = state.tabs.findIndex((tab) => tab.id === msg.tab.id);
      const prev = idx === -1 ? null : state.tabs[idx];
      const structural = !prev || prev.revision !== msg.tab.revision;
      state.archive = state.archive.filter((tab) => tab.id !== msg.tab.id);
      unreadArchive.delete(msg.tab.id);
      if (idx === -1) {
        const at = Number.isInteger(msg.index) ? Math.max(0, Math.min(msg.index, state.tabs.length)) : state.tabs.length;
        state.tabs.splice(at, 0, msg.tab);
      } else if (Number.isInteger(msg.index)) {
        state.tabs.splice(idx, 1);
        const at = Math.max(0, Math.min(msg.index, state.tabs.length));
        state.tabs.splice(at, 0, msg.tab);
      } else {
        state.tabs[idx] = msg.tab;
      }
      const restoredHere = pendingRestoreId === msg.tab.id;
      if (restoredHere) {
        pendingRestoreId = null;
        state.activeId = msg.tab.id;
        lastInteractedAt = Date.now();
        syncHash();
      }
      if (structural && state.activeId !== msg.tab.id) {
        unread.add(msg.tab.id);
      }
      if (structural) {
        refreshFrame(msg.tab);
      }
      if (!state.activeId && state.tabs.length) {
        state.activeId = msg.tab.id;
        unread.delete(msg.tab.id);
        syncHash();
      }
      if (state.activeId === msg.tab.id) {
        unread.delete(msg.tab.id);
      }
      render();
      if (restoredHere) {
        reportViewer();
      }
      return;
    }
    if (msg.type === "tab_closed") {
      state.tabs = state.tabs.filter((tab) => tab.id !== msg.id);
      state.archive = state.archive.filter((tab) => tab.id !== msg.id);
      unread.delete(msg.id);
      unreadArchive.delete(msg.id);
      discardFrame(msg.id);
      if (state.activeId === msg.id) {
        state.activeId = state.tabs.length ? state.tabs[state.tabs.length - 1].id : null;
        if (state.activeId) {
          unread.delete(state.activeId);
        }
        syncHash();
      }
      if (archiveSearch.value.trim()) {
        scheduleSearch(0);
      }
      render();
      reportViewer();
      return;
    }
    if (msg.type === "archive_cleared") {
      for (const tab of state.archive) {
        unreadArchive.delete(tab.id);
      }
      state.archive = [];
      searchHits = null;
      searchMeta = null;
      render();
      return;
    }
    if (msg.type === "tab_focus_request") {
      if (state.tabs.some((tab) => tab.id === msg.id)) {
        selectTab(msg.id, { fromUser: false });
      }
      return;
    }
    if (msg.type === "tab_state") {
      const tab = state.tabs.find((item) => item.id === msg.id);
      if (tab) {
        tab.stateRevision = msg.stateRevision;
      }
      const archived = state.archive.find((item) => item.id === msg.id);
      if (archived) {
        archived.stateRevision = msg.stateRevision;
      }
      const entry = frames.get(msg.id);
      if (entry?.el.contentWindow) {
        entry.el.contentWindow.postMessage(
          {
            type: "agent-board-state",
            id: msg.id,
            state: msg.state,
            stateRevision: msg.stateRevision,
            client: msg.client,
          },
          "*"
        );
      }
      if (tab && state.activeId !== msg.id) {
        unread.add(msg.id);
        render();
      }
    }
  }

  function upsertArchive(tab, markUnread) {
    state.tabs = state.tabs.filter((item) => item.id !== tab.id);
    unread.delete(tab.id);
    discardFrame(tab.id);
    const idx = state.archive.findIndex((item) => item.id === tab.id);
    if (idx === -1) {
      state.archive.unshift(tab);
    } else {
      state.archive[idx] = tab;
    }
    state.archive.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    if (markUnread) {
      unreadArchive.add(tab.id);
    }
    if (state.activeId === tab.id) {
      state.activeId = state.tabs.length ? state.tabs[state.tabs.length - 1].id : null;
      if (state.activeId) {
        unread.delete(state.activeId);
      }
      syncHash();
    }
    if (archiveSearch.value.trim()) {
      scheduleSearch(0);
    }
  }

  function syncHash() {
    if (!state.activeId) {
      if (location.hash) {
        history.replaceState(null, "", location.pathname + location.search);
      }
      return;
    }
    const wanted = "#" + state.activeId;
    if (location.hash !== wanted) {
      history.replaceState(null, "", wanted);
    }
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeId) || null;
  }

  function viewUrl(tab) {
    const port = location.port ? `:${location.port}` : "";
    return `${location.protocol}//127.0.0.2${port}/view/${encodeURIComponent(tab.id)}?r=${tab.revision}`;
  }

  function setArchiveOpen(open) {
    state.archiveOpen = Boolean(open);
    localStorage.setItem(ARCHIVE_OPEN_KEY, state.archiveOpen ? "1" : "0");
    archiveToggle.setAttribute("aria-expanded", state.archiveOpen ? "true" : "false");
    archivePane.hidden = !state.archiveOpen;
    if (state.archiveOpen && archiveSearch.value.trim()) {
      scheduleSearch(0);
    }
    renderChrome();
    renderArchive();
  }

  function applyArchiveWidth(px) {
    const width = Math.max(220, Math.min(480, px));
    document.documentElement.style.setProperty("--archive-width", width + "px");
    localStorage.setItem(ARCHIVE_WIDTH_KEY, String(width));
  }

  function renderChrome() {
    clearBtn.disabled = !state.tabs.some((tab) => !tab.pinned);
    const count = state.archive.length;
    archiveCountEl.textContent = String(count);
    archiveEmptyBtn.disabled = count === 0;
    const unread = unreadArchive.size;
    archiveBadge.hidden = unread === 0;
    archiveBadge.textContent = unread > 99 ? "99+" : String(unread);
    archiveToggle.setAttribute("aria-expanded", state.archiveOpen ? "true" : "false");
    archivePane.hidden = !state.archiveOpen;
  }

  function revealTab(el) {
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < tabsEl.scrollLeft) {
      tabsEl.scrollLeft = left;
    } else if (right > tabsEl.scrollLeft + tabsEl.clientWidth) {
      tabsEl.scrollLeft = right - tabsEl.clientWidth;
    }
  }

  function updateTabFade() {
    const overflow = tabsEl.scrollWidth - tabsEl.clientWidth > 1;
    const moreToTheRight = tabsEl.scrollLeft + tabsEl.clientWidth < tabsEl.scrollWidth - 1;
    const moreToTheLeft = tabsEl.scrollLeft > 1;
    fadeEl.hidden = !(overflow && moreToTheRight);
    fadeLeftEl.hidden = !(overflow && moreToTheLeft);
  }

  function renderTabs() {
    tabsEl.replaceChildren();
    for (const tab of state.tabs) {
      const el = document.createElement("div");
      el.className =
        "tab" +
        (tab.id === state.activeId ? " active" : "") +
        (tab.pinned ? " pinned" : "") +
        (unread.has(tab.id) && tab.id !== state.activeId ? " updated" : "");
      el.role = "tab";
      el.title =
        unread.has(tab.id) && tab.id !== state.activeId
          ? tab.title + " (updated)"
          : tab.pinned
            ? tab.title + " (pinned)"
            : tab.title;
      el.addEventListener("click", (event) => {
        if (event.detail > 1) {
          setPinned(tab.id, !tab.pinned);
          return;
        }
        selectTab(tab.id, { fromUser: true });
      });
      el.addEventListener("auxclick", (event) => {
        if (event.button !== 1) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          closeTab(tab.id, { permanent: true });
          return;
        }
        if (!tab.pinned) {
          closeTab(tab.id);
        }
      });
      el.addEventListener("mousedown", (event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      });

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.title;
      el.appendChild(title);

      if (unread.has(tab.id) && tab.id !== state.activeId) {
        const dot = document.createElement("span");
        dot.className = "tab-updated";
        dot.title = "Updated in the background";
        el.appendChild(dot);
      }

      if (tab.pinned) {
        const pin = document.createElement("span");
        pin.className = "tab-pin";
        pin.textContent = "pinned";
        el.appendChild(pin);
      }

      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(tab.id, { permanent: event.shiftKey });
      });
      el.appendChild(close);
      tabsEl.appendChild(el);
    }
    const active = tabsEl.querySelector(".tab.active");
    if (active) {
      revealTab(active);
    }
    requestAnimationFrame(updateTabFade);
  }

  function visibleArchive() {
    if (state.archive.length === 0) {
      return [];
    }
    if (searchHits) {
      return searchHits;
    }
    return state.archive;
  }

  function renderArchive() {
    if (state.archive.length === 0) {
      searchHits = null;
      searchMeta = null;
    }
    const rows = visibleArchive();
    archiveList.replaceChildren();
    const querying = Boolean(archiveSearch.value.trim()) && searchHits;
    const empty = state.archive.length === 0;
    const noMatch = Boolean(querying) && rows.length === 0;
    archiveNone.hidden = !(empty || noMatch);
    archiveNone.textContent = empty ? "No archived tabs" : "No matching tabs";
    if (searchMeta && archiveSearch.value.trim()) {
      const meta = document.createElement("div");
      meta.className = "archive-meta";
      meta.textContent =
        searchMeta.remaining > 0
          ? `${searchMeta.returned} of ${searchMeta.matchCount} matches · ${searchMeta.archiveCount} in archive`
          : `${searchMeta.matchCount} of ${searchMeta.archiveCount} in archive`;
      archiveList.appendChild(meta);
    }
    for (const tab of rows) {
      const el = document.createElement("div");
      el.className = "archive-row";
      el.role = "button";
      el.tabIndex = 0;
      el.title = tab.title;
      el.addEventListener("click", () => restoreTab(tab.id));
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          restoreTab(tab.id);
        }
      });
      el.addEventListener("auxclick", (event) => {
        if (event.button !== 1) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeTab(tab.id, { permanent: true, fromArchive: true });
      });
      el.addEventListener("mousedown", (event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      });

      if (unreadArchive.has(tab.id)) {
        const dot = document.createElement("span");
        dot.className = "tab-updated";
        dot.title = "Updated in the archive";
        el.appendChild(dot);
      }

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.title;
      el.appendChild(title);

      const when = document.createElement("span");
      when.className = "archive-when";
      when.textContent = relativeTime(tab.archivedAt);
      when.title = tab.archivedAt ? new Date(tab.archivedAt).toLocaleString() : "";
      el.appendChild(when);

      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.textContent = "×";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(tab.id, { permanent: true, fromArchive: true });
      });
      el.appendChild(close);
      archiveList.appendChild(el);

      if (tab.snippet) {
        const snippet = document.createElement("div");
        snippet.className = "archive-snippet";
        snippet.textContent = tab.snippet;
        archiveList.appendChild(snippet);
      }
    }
  }

  function relativeTime(ms) {
    if (!ms) {
      return "";
    }
    const delta = Date.now() - ms;
    const sec = Math.round(delta / 1000);
    if (sec < 45) {
      return "just now";
    }
    const min = Math.round(sec / 60);
    if (min < 60) {
      return min + "m ago";
    }
    const hr = Math.round(min / 60);
    if (hr < 24) {
      return hr + "h ago";
    }
    const day = Math.round(hr / 24);
    if (day < 14) {
      return day + "d ago";
    }
    return new Date(ms).toLocaleDateString();
  }

  function isPinned(id) {
    return Boolean(state.tabs.find((tab) => tab.id === id)?.pinned);
  }

  function touchFrame(id) {
    const entry = frames.get(id);
    if (!entry) {
      return;
    }
    frames.delete(id);
    frames.set(id, entry);
  }

  function unpinnedLiveCount() {
    let count = 0;
    for (const id of frames.keys()) {
      if (!isPinned(id)) {
        count += 1;
      }
    }
    return count;
  }

  function evictOverflow(keepId) {
    while (unpinnedLiveCount() > LIVE_FRAME_CAP) {
      const victim = [...frames.keys()].find((id) => id !== keepId && !isPinned(id));
      if (!victim) {
        break;
      }
      discardFrame(victim);
    }
  }

  function ensureFrame(tab) {
    let entry = frames.get(tab.id);
    if (!entry) {
      const el = document.createElement("iframe");
      el.title = tab.title;
      el.sandbox = SANDBOX;
      framesEl.appendChild(el);
      el.src = viewUrl(tab);
      entry = { el, revision: tab.revision };
      frames.set(tab.id, entry);
    } else {
      if (entry.el.title !== tab.title) {
        entry.el.title = tab.title;
      }
      if (entry.revision !== tab.revision) {
        entry.el.src = viewUrl(tab);
        entry.revision = tab.revision;
      }
      touchFrame(tab.id);
      entry = frames.get(tab.id);
    }
    evictOverflow(tab.id);
    return entry;
  }

  function refreshFrame(tab) {
    const entry = frames.get(tab.id);
    if (!entry) {
      return;
    }
    if (entry.revision !== tab.revision) {
      entry.el.src = viewUrl(tab);
      entry.revision = tab.revision;
    }
    if (entry.el.title !== tab.title) {
      entry.el.title = tab.title;
    }
  }

  function discardFrame(id) {
    const entry = frames.get(id);
    if (!entry) {
      return;
    }
    entry.el.remove();
    frames.delete(id);
  }

  function renderFrames() {
    const tab = activeTab();
    if (!tab) {
      emptyEl.hidden = false;
      for (const entry of frames.values()) {
        entry.el.classList.add("inactive");
      }
      document.title = "Agent Board";
      return;
    }
    emptyEl.hidden = true;
    document.title = tab.title + " · Agent Board";
    ensureFrame(tab);
    for (const [id, entry] of frames) {
      entry.el.classList.toggle("inactive", id !== tab.id);
    }
  }

  function render() {
    renderChrome();
    renderTabs();
    renderFrames();
    renderArchive();
  }

  function selectTab(id, { fromUser } = {}) {
    if (!state.tabs.some((tab) => tab.id === id)) {
      return;
    }
    if (state.activeId !== id) {
      state.activeId = id;
      unread.delete(id);
      syncHash();
      render();
    } else {
      unread.delete(id);
    }
    if (fromUser) {
      if (pendingRestoreId && pendingRestoreId !== id) {
        pendingRestoreId = null;
      }
      lastInteractedAt = Date.now();
    }
    reportViewer();
  }

  async function confirmDelete(message) {
    confirmMessage.textContent = message;
    confirmDlg.returnValue = "cancel";
    confirmDlg.showModal();
    const cancelBtn = confirmDlg.querySelector('button[value="cancel"]');
    cancelBtn?.focus();
    return new Promise((resolve) => {
      confirmDlg.addEventListener(
        "close",
        () => {
          resolve(confirmDlg.returnValue === "ok");
        },
        { once: true }
      );
    });
  }

  async function closeTab(id, { permanent = false, fromArchive = false } = {}) {
    const open = state.tabs.find((tab) => tab.id === id);
    const archived = state.archive.find((tab) => tab.id === id);
    const tab = open || archived;
    if (permanent || fromArchive) {
      const title = tab?.title || "this tab";
      const ok = await confirmDelete(
        fromArchive
          ? `Delete “${title}” permanently? This cannot be undone.`
          : `Delete “${title}” permanently? Ctrl+Z can restore it if it was still open (last 5).`
      );
      if (!ok) {
        return;
      }
      await fetch(`/api/tabs/${encodeURIComponent(id)}?permanent=true`, { method: "DELETE" });
      return;
    }
    await fetch(`/api/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async function restoreTab(id) {
    unreadArchive.delete(id);
    pendingRestoreId = id;
    const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/restore`, { method: "POST" });
    if (!res.ok) {
      if (pendingRestoreId === id) {
        pendingRestoreId = null;
      }
      return;
    }
    if (pendingRestoreId === id && state.tabs.some((tab) => tab.id === id)) {
      pendingRestoreId = null;
      selectTab(id, { fromUser: true });
    }
  }

  async function emptyArchive() {
    const n = state.archive.length;
    if (!n) {
      return;
    }
    const ok = await confirmDelete(
      `Delete all ${n} archived tab${n === 1 ? "" : "s"} permanently? This cannot be undone.`
    );
    if (!ok) {
      return;
    }
    await fetch("/api/archive", { method: "DELETE" });
  }

  function pinBoundary() {
    let i = 0;
    while (i < state.tabs.length && state.tabs[i].pinned) {
      i += 1;
    }
    return i;
  }

  async function setPinned(id, pin) {
    const idx = state.tabs.findIndex((item) => item.id === id);
    if (idx !== -1) {
      const [tab] = state.tabs.splice(idx, 1);
      tab.pinned = pin;
      state.tabs.splice(pinBoundary(), 0, tab);
      render();
    }
    await fetch(`/api/tabs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, activate: false }),
    });
  }

  async function openWelcome() {
    const html = await fetch("/welcome.html").then((res) => res.text());
    await fetch("/api/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "welcome",
        title: "Welcome",
        html,
        activate: true,
      }),
    });
  }

  function downloadActive() {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    const link = document.createElement("a");
    link.href = `/download/${encodeURIComponent(tab.id)}`;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function undoClose() {
    const res = await fetch("/api/undo", { method: "POST" });
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    const id = data?.tab?.id;
    if (id) {
      selectTab(id, { fromUser: true });
    }
  }

  function isTypingTarget(el) {
    if (!el || el === document.body) {
      return false;
    }
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return true;
    }
    return Boolean(el.isContentEditable);
  }

  function isFindKey(event) {
    if (event.key === "/") {
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      return true;
    }
    return false;
  }

  function onBoardShortcut(event) {
    if (confirmDlg.open) {
      return;
    }
    if (event.key === "Escape") {
      if (confirmDlg.open) {
        return;
      }
      if (isPaletteOpen()) {
        event.preventDefault();
        closePalette();
        return;
      }
      if (state.archiveOpen && document.activeElement === archiveSearch && archiveSearch.value) {
        event.preventDefault();
        archiveSearch.value = "";
        searchHits = null;
        searchMeta = null;
        renderArchive();
        return;
      }
      if (state.archiveOpen) {
        event.preventDefault();
        setArchiveOpen(false);
      }
      return;
    }
    if (isFindKey(event) && state.archiveOpen && !isTypingTarget(event.target)) {
      event.preventDefault();
      archiveSearch.focus();
      archiveSearch.select();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "d" && !event.shiftKey) {
      event.preventDefault();
      togglePalette();
      return;
    }
    if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      downloadActive();
      return;
    }
    if (key === "h" && !event.shiftKey) {
      event.preventDefault();
      openWelcome();
      return;
    }
    if (key === "z" && !event.shiftKey && !isTypingTarget(event.target)) {
      event.preventDefault();
      undoClose();
    }
  }

  function onTabsWheel(event) {
    if (event.deltaY === 0 && event.deltaX === 0) {
      return;
    }
    event.preventDefault();
    tabsEl.scrollLeft += event.deltaY + event.deltaX;
    updateTabFade();
  }

  function frameByWindow(win) {
    for (const entry of frames.values()) {
      if (entry.el.contentWindow === win) {
        return entry;
      }
    }
    return null;
  }

  function scheduleSearch(delay = 250) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, delay);
  }

  async function runSearch() {
    const query = archiveSearch.value.trim();
    if (!query) {
      searchHits = null;
      searchMeta = null;
      renderArchive();
      return;
    }
    const res = await fetch(`/api/archive?query=${encodeURIComponent(query)}&limit=200`);
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    searchHits = data.tabs || [];
    searchMeta = data;
    renderArchive();
  }

  function isPaletteOpen() {
    return !paletteEl.hidden;
  }

  function togglePalette() {
    if (isPaletteOpen()) {
      closePalette();
      return;
    }
    openPalette();
  }

  function openPalette() {
    paletteEl.hidden = false;
    paletteInput.value = "";
    paletteIndex = 0;
    showLocalPaletteRows();
    paletteInput.focus();
    paletteInput.select();
  }

  function closePalette() {
    paletteEl.hidden = true;
    clearTimeout(paletteTimer);
    paletteReq += 1;
  }

  function showLocalPaletteRows() {
    paletteHits = [
      ...state.tabs.map((tab) => ({ ...tab, archived: false })),
      ...state.archive.slice(0, 15).map((tab) => ({ ...tab, archived: true })),
    ];
    paletteIndex = 0;
    renderPalette();
  }

  function schedulePaletteSearch(delay = 80) {
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(runPaletteSearch, delay);
  }

  async function runPaletteSearch() {
    const query = paletteInput.value.trim();
    if (!query) {
      showLocalPaletteRows();
      return;
    }
    const req = ++paletteReq;
    const res = await fetch(`/api/search?query=${encodeURIComponent(query)}&limit=40`);
    if (req !== paletteReq || !isPaletteOpen()) {
      return;
    }
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    paletteHits = data.tabs || [];
    if (paletteIndex >= paletteHits.length) {
      paletteIndex = 0;
    }
    renderPalette();
  }

  function renderPalette() {
    paletteList.replaceChildren();
    const empty = paletteHits.length === 0;
    paletteEmpty.hidden = !empty;
    paletteEmpty.textContent = paletteInput.value.trim() ? "No matching pages" : "No pages yet";
    for (let index = 0; index < paletteHits.length; index += 1) {
      const tab = paletteHits[index];
      const el = document.createElement("div");
      el.className = "palette-row" + (index === paletteIndex ? " active" : "");
      el.role = "option";
      el.setAttribute("aria-selected", index === paletteIndex ? "true" : "false");
      el.addEventListener("mouseenter", () => {
        paletteIndex = index;
        highlightPaletteRows();
      });
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        activatePaletteHit(tab);
      });

      const main = document.createElement("div");
      main.className = "palette-row-main";
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.title;
      main.appendChild(title);

      const chips = document.createElement("div");
      chips.className = "palette-chips";
      if (tab.locationLabel) {
        chips.appendChild(paletteChip(tab.locationLabel, "location-" + tab.location));
      }
      if (tab.qualityLabel) {
        chips.appendChild(paletteChip(tab.qualityLabel));
      }
      if (tab.archived) {
        chips.appendChild(paletteChip("Archived"));
      }
      if (chips.childElementCount) {
        main.appendChild(chips);
      }
      el.appendChild(main);

      if (tab.snippet) {
        const snippet = document.createElement("div");
        snippet.className = "palette-snippet";
        snippet.textContent = tab.snippet;
        el.appendChild(snippet);
      }
      paletteList.appendChild(el);
    }
    const active = paletteList.querySelector(".palette-row.active");
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function paletteChip(label, extraClass) {
    const chip = document.createElement("span");
    chip.className = "palette-chip" + (extraClass ? " " + extraClass : "");
    chip.textContent = label;
    return chip;
  }

  function highlightPaletteRows() {
    const rows = paletteList.children;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const on = i === paletteIndex;
      row.classList.toggle("active", on);
      row.setAttribute("aria-selected", on ? "true" : "false");
    }
    const active = paletteList.querySelector(".palette-row.active");
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function movePalette(delta) {
    if (!paletteHits.length) {
      return;
    }
    paletteIndex = (paletteIndex + delta + paletteHits.length) % paletteHits.length;
    highlightPaletteRows();
  }

  function activatePaletteHit(tab) {
    if (!tab) {
      return;
    }
    closePalette();
    if (tab.archived || tab.archivedAt) {
      restoreTab(tab.id);
      return;
    }
    selectTab(tab.id, { fromUser: true });
  }

  tabsEl.parentElement.addEventListener("wheel", onTabsWheel, { passive: false });
  tabsEl.addEventListener("scroll", updateTabFade);
  window.addEventListener("resize", updateTabFade);

  document.addEventListener(
    "pointerdown",
    () => {
      lastInteractedAt = Date.now();
      reportViewer();
    },
    true
  );

  window.addEventListener("keydown", onBoardShortcut, true);
  window.addEventListener("message", (event) => {
    if (!frameByWindow(event.source)) {
      return;
    }
    if (event.data?.type === "agent-board-download") {
      downloadActive();
    } else if (event.data?.type === "agent-board-undo") {
      undoClose();
    } else if (event.data?.type === "agent-board-help") {
      openWelcome();
    } else if (event.data?.type === "agent-board-palette") {
      togglePalette();
    } else if (event.data?.type === "agent-board-activity") {
      noteEdit();
    }
  });

  clearBtn.addEventListener("click", async () => {
    await fetch("/api/tabs?filter=unpinned", { method: "DELETE" });
  });
  archiveToggle.addEventListener("click", () => setArchiveOpen(!state.archiveOpen));
  archiveEmptyBtn.addEventListener("click", () => emptyArchive());
  archiveSearch.addEventListener("input", () => scheduleSearch());
  paletteBackdrop.addEventListener("mousedown", (event) => {
    event.preventDefault();
    closePalette();
  });
  paletteInput.addEventListener("input", () => {
    const query = paletteInput.value.trim();
    if (!query) {
      showLocalPaletteRows();
      return;
    }
    schedulePaletteSearch();
  });
  paletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      movePalette(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      movePalette(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activatePaletteHit(paletteHits[paletteIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    }
  });

  archiveResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = archivePane.getBoundingClientRect().width;
    archiveResizer.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-archive");

    function onMove(move) {
      if (move.pointerId !== event.pointerId) {
        return;
      }
      applyArchiveWidth(startWidth - (move.clientX - startX));
    }
    function onUp(up) {
      if (up.pointerId !== event.pointerId) {
        return;
      }
      archiveResizer.removeEventListener("pointermove", onMove);
      archiveResizer.removeEventListener("pointerup", onUp);
      archiveResizer.removeEventListener("pointercancel", onUp);
      if (archiveResizer.hasPointerCapture(event.pointerId)) {
        archiveResizer.releasePointerCapture(event.pointerId);
      }
      document.body.classList.remove("resizing-archive");
    }
    archiveResizer.addEventListener("pointermove", onMove);
    archiveResizer.addEventListener("pointerup", onUp);
    archiveResizer.addEventListener("pointercancel", onUp);
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.replace(/^#/, "");
    if (!id) {
      return;
    }
    const open = state.tabs.find((item) => item.id === id || item.key === id);
    if (open && open.id !== state.activeId) {
      selectTab(open.id, { fromUser: true });
      return;
    }
    const archived = state.archive.find((item) => item.id === id || item.key === id);
    if (archived) {
      restoreTab(archived.id);
    }
  });

  setArchiveOpen(state.archiveOpen);
  connect();
  render();
})();
