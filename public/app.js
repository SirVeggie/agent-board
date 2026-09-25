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
  const sidebarTabArchive = document.getElementById("sidebar-tab-archive");
  const sidebarTabTemplates = document.getElementById("sidebar-tab-templates");
  const sidebarPanelArchive = document.getElementById("sidebar-panel-archive");
  const sidebarPanelTemplates = document.getElementById("sidebar-panel-templates");
  const templateCountEl = document.getElementById("template-count");
  const templateList = document.getElementById("template-list");
  const templateNone = document.getElementById("template-none");
  const templateEditBtn = document.getElementById("template-edit");
  const templateBlock = document.getElementById("template-block");
  const templateBlockReason = document.getElementById("template-block-reason");
  const templateModal = document.getElementById("template-modal");
  const templateModalBackdrop = document.getElementById("template-modal-backdrop");
  const templateModalTitle = document.getElementById("template-modal-title");
  const templateModalDesc = document.getElementById("template-modal-desc");
  const templateModalForm = document.getElementById("template-modal-form");
  const templateModalFields = document.getElementById("template-modal-fields");
  const templateModalError = document.getElementById("template-modal-error");
  const templateModalCancel = document.getElementById("template-modal-cancel");
  const templateModalSubmit = document.getElementById("template-modal-submit");
  const templateModalAgentHidden = document.getElementById("template-modal-agent-hidden");
  const confirmDlg = document.getElementById("confirm");
  const confirmMessage = document.getElementById("confirm-message");
  const paletteEl = document.getElementById("palette");
  const paletteBackdrop = document.getElementById("palette-backdrop");
  const paletteInput = document.getElementById("palette-input");
  const paletteList = document.getElementById("palette-list");
  const paletteEmpty = document.getElementById("palette-empty");
  const settingsEl = document.getElementById("settings");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  const settingsToggle = document.getElementById("settings-toggle");
  const themeList = document.getElementById("theme-list");
  const tabReorderToggle = document.getElementById("tab-reorder");
  const smoothScrollToggle = document.getElementById("smooth-scroll");
  const importPageBtn = document.getElementById("import-page");
  const exportPageBtn = document.getElementById("export-page");
  const exportAllBtn = document.getElementById("export-all");
  const importFileInput = document.getElementById("import-file");
  const tabMenu = document.getElementById("tab-menu");
  const tabMenuExport = document.getElementById("tab-menu-export");
  const tabMenuAgent = document.getElementById("tab-menu-agent");
  const noticeEl = document.getElementById("notice");
  const persistBanner = document.getElementById("persist-banner");
  const persistBannerDetail = document.getElementById("persist-banner-detail");
  const tabsWrap = tabsEl.parentElement;

  const SANDBOX =
    "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
  const LIVE_FRAME_CAP = 5;
  const ARCHIVE_OPEN_KEY = "agent-board.archiveOpen";
  const SIDEBAR_TAB_KEY = "agent-board.sidebarTab";
  const ARCHIVE_WIDTH_KEY = "agent-board.archiveWidth";
  const THEME_KEY = "agent-board.theme";
  const TAB_REORDER_KEY = "agent-board.tabReorder";
  const SMOOTH_SCROLL_KEY = "agent-board.smoothScroll";
  const DEFAULT_THEME = "neutral";
  const THEMES = [
    { id: "neutral", name: "Neutral", swatch: "#c9c9d0", icon: "/favicon.svg?v=4" },
    { id: "ember", name: "Ember", swatch: "#d0a578", icon: "/favicon-ember.svg?v=4" },
    { id: "spectrum", name: "Spectrum", swatch: "#9db8a4", icon: "/favicon-spectrum.svg?v=4" },
  ];
  const PIN_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M9.6 1.4l5 5-1.4 1.4-.9-.2-2.3 2.3.2 2.5-1.5 1.5-2.4-2.4-3.1 3.1-.8-.8 3.1-3.1-2.4-2.4 1.5-1.5 2.5.2 2.3-2.3-.2-.9z" fill="currentColor"/></svg>';
  const FILE_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2h7.5l3.5 3.5V14h-11z" fill="currentColor"/></svg>';
  const AGENT_HIDDEN_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const AGENT_HIDDEN_TITLE = "Hidden from the agent";

  /** @type {{ tabs: Array<any>, archive: Array<any>, templates: Array<any>, activeId: string | null, connected: boolean, archiveOpen: boolean, sidebarTab: string }} */
  const state = {
    tabs: [],
    archive: [],
    templates: [],
    activeId: null,
    connected: false,
    archiveOpen: localStorage.getItem(ARCHIVE_OPEN_KEY) === "1",
    sidebarTab: localStorage.getItem(SIDEBAR_TAB_KEY) === "templates" ? "templates" : "archive",
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
  /** User action in this window that should focus the resulting tab. Agent activate can still decline. */
  let pendingFocus = null;
  /** @type {number | null} */
  let tabScrollTarget = null;
  let tabScrollRaf = 0;
  /** @type {string | null} */
  let revealedTabId = null;
  /** @type {Map<string, HTMLElement>} */
  const tabEls = new Map();
  /** @type {null | {
   *   id: string,
   *   pointerId: number,
   *   startX: number,
   *   startY: number,
   *   moved: boolean,
   *   originOrder: string[],
   *   groupPinned: boolean,
   *   offsetX: number,
   *   offsetY: number,
   *   width: number,
   *   el: HTMLElement,
   *   placeholder: HTMLElement,
   *   scrollDir: number
   * }} */
  let drag = null;
  let dragSuppressClick = false;
  let dragScrollTimer = 0;
  let menuTabId = null;
  let noticeTimer = 0;

  applyArchiveWidth(Number(localStorage.getItem(ARCHIVE_WIDTH_KEY)) || 280);
  applyTheme(loadTheme());
  applyFlag(tabReorderToggle, TAB_REORDER_KEY, true);
  applyFlag(smoothScrollToggle, SMOOTH_SCROLL_KEY, true);
  syncReorderClass();
  renderThemeList();

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
      abortDrag(false);
      state.tabs = msg.tabs;
      state.archive = Array.isArray(msg.archive) ? msg.archive : [];
      state.templates = Array.isArray(msg.templates) ? msg.templates : [];
      const hash = location.hash.replace(/^#/, "");
      const fromOpen = state.tabs.find((tab) => tab.id === hash || tab.key === hash);
      const fromArchive = state.archive.find((tab) => tab.id === hash || tab.key === hash);
      state.activeId = fromOpen ? fromOpen.id : msg.activeId;
      unread.clear();
      unreadArchive.clear();
      syncHash();
      render();
      reportViewer();
      showPersistError(msg.persistError);
      if (fromArchive && !fromOpen) {
        restoreTab(fromArchive.id);
      }
      return;
    }
    if (msg.type === "persist_error") {
      showPersistError(msg.error);
      return;
    }
    if (msg.type === "persist_ok") {
      showPersistError(null);
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
      } else if (Number.isInteger(msg.index) && !drag?.moved) {
        state.tabs.splice(idx, 1);
        const at = Math.max(0, Math.min(msg.index, state.tabs.length));
        state.tabs.splice(at, 0, msg.tab);
      } else {
        state.tabs[idx] = msg.tab;
      }
      const focusedHere = claimPendingFocus(msg.tab);
      if (focusedHere) {
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
      if (drag?.moved) {
        const el = tabEls.get(msg.tab.id);
        if (el) {
          syncTabEl(el, msg.tab);
        }
        renderChrome();
        renderFrames();
        renderArchive();
      } else {
        render();
      }
      if (focusedHere) {
        reportViewer();
      }
      return;
    }
    if (msg.type === "tab_closed") {
      if (drag && drag.id === msg.id) {
        abortDrag(false);
      }
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
      return;
    }
    if (msg.type === "template_upserted") {
      const idx = state.templates.findIndex((item) => item.id === msg.template.id);
      if (idx === -1) {
        state.templates.push(msg.template);
      } else {
        state.templates[idx] = msg.template;
      }
      state.templates.sort((a, b) => String(a.title).localeCompare(String(b.title)));
      renderChrome();
      renderTemplates();
      return;
    }
    if (msg.type === "template_deleted") {
      state.templates = state.templates.filter((item) => item.id !== msg.id);
      if (templateModal.dataset.templateId === msg.id) {
        closeTemplateModal();
      }
      renderChrome();
      renderTemplates();
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
    archiveToggle.classList.toggle("on", state.archiveOpen);
    archivePane.classList.toggle("closed", !state.archiveOpen);
    archivePane.setAttribute("aria-hidden", state.archiveOpen ? "false" : "true");
    archivePane.toggleAttribute("inert", !state.archiveOpen);
    if (state.archiveOpen && archiveSearch.value.trim()) {
      scheduleSearch(0);
    }
    renderChrome();
    renderArchive();
    renderTemplates();
  }

  function applyArchiveWidth(px) {
    const width = Math.max(220, Math.min(480, px));
    document.documentElement.style.setProperty("--archive-width", width + "px");
    localStorage.setItem(ARCHIVE_WIDTH_KEY, String(width));
  }

  function loadTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (THEMES.some((theme) => theme.id === stored)) {
      return stored;
    }
    return DEFAULT_THEME;
  }

  function applyFavicon(href) {
    const prev = document.querySelector('link[rel="icon"]');
    if (prev && prev.getAttribute("href") === href) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.setAttribute("sizes", "any");
    link.href = href;
    prev?.remove();
    document.head.appendChild(link);
  }

  function applyTheme(id) {
    const theme = THEMES.find((item) => item.id === id) || THEMES[0];
    document.documentElement.dataset.theme = theme.id;
    localStorage.setItem(THEME_KEY, theme.id);
    applyFavicon(theme.icon);
    highlightThemeOptions();
  }

  function renderThemeList() {
    themeList.replaceChildren();
    const current = loadTheme();
    for (const theme of THEMES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-option";
      btn.role = "option";
      btn.dataset.theme = theme.id;
      btn.setAttribute("aria-selected", theme.id === current ? "true" : "false");
      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      swatch.style.setProperty("--swatch", theme.swatch);
      const label = document.createElement("span");
      label.textContent = theme.name;
      btn.append(swatch, label);
      btn.addEventListener("click", () => applyTheme(theme.id));
      themeList.appendChild(btn);
    }
  }

  function highlightThemeOptions() {
    const current = document.documentElement.dataset.theme || DEFAULT_THEME;
    for (const btn of themeList.querySelectorAll(".theme-option")) {
      btn.setAttribute("aria-selected", btn.dataset.theme === current ? "true" : "false");
    }
  }

  function applyFlag(el, key, fallback = false) {
    const stored = localStorage.getItem(key);
    const on = stored == null ? fallback : stored === "1";
    el.setAttribute("aria-checked", on ? "true" : "false");
  }

  function flagOn(el) {
    return el.getAttribute("aria-checked") === "true";
  }

  function toggleFlag(el, key) {
    const on = !flagOn(el);
    el.setAttribute("aria-checked", on ? "true" : "false");
    localStorage.setItem(key, on ? "1" : "0");
    if (el === tabReorderToggle) {
      if (!on) {
        abortDrag();
      }
      syncReorderClass();
    }
    if (el === smoothScrollToggle && !on) {
      stopTabScroll();
    }
  }

  function syncReorderClass() {
    tabsEl.classList.toggle("reorder-on", flagOn(tabReorderToggle));
  }

  function smoothTabScroll() {
    return flagOn(smoothScrollToggle) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function stopTabScroll() {
    if (tabScrollRaf) {
      cancelAnimationFrame(tabScrollRaf);
      tabScrollRaf = 0;
    }
    tabScrollTarget = null;
  }

  function clampTabScroll(left) {
    return Math.max(0, Math.min(Math.max(0, tabsEl.scrollWidth - tabsEl.clientWidth), left));
  }

  function scrollTabsTo(left, smooth) {
    const target = clampTabScroll(left);
    if (!smooth) {
      stopTabScroll();
      tabsEl.scrollLeft = target;
      return;
    }
    tabScrollTarget = target;
    if (!tabScrollRaf) {
      tabScrollRaf = requestAnimationFrame(stepTabScroll);
    }
  }

  function stepTabScroll() {
    tabScrollRaf = 0;
    if (tabScrollTarget == null) {
      return;
    }
    const target = clampTabScroll(tabScrollTarget);
    tabScrollTarget = target;
    const current = tabsEl.scrollLeft;
    const delta = target - current;
    if (Math.abs(delta) < 1) {
      tabsEl.scrollLeft = target;
      tabScrollTarget = null;
      updateTabFade();
      return;
    }
    const step = Math.sign(delta) * Math.max(1, Math.abs(delta) * 0.22);
    tabsEl.scrollLeft = current + step;
    if (tabsEl.scrollLeft === current) {
      tabsEl.scrollLeft = target;
      tabScrollTarget = null;
      updateTabFade();
      return;
    }
    tabScrollRaf = requestAnimationFrame(stepTabScroll);
  }

  function isSettingsOpen() {
    return !settingsEl.hidden;
  }

  function openSettings() {
    if (isPaletteOpen()) {
      closePalette();
    }
    settingsEl.hidden = false;
    settingsToggle.setAttribute("aria-expanded", "true");
  }

  function closeSettings() {
    if (!isSettingsOpen()) {
      return;
    }
    settingsEl.hidden = true;
    settingsToggle.setAttribute("aria-expanded", "false");
  }

  function toggleSettings() {
    if (isSettingsOpen()) {
      closeSettings();
      return;
    }
    openSettings();
  }

  function renderChrome() {
    clearBtn.disabled = !state.tabs.some((tab) => !tab.pinned);
    exportPageBtn.disabled = !state.activeId;
    exportAllBtn.disabled = !state.tabs.some((tab) => tab.key !== "welcome") && state.archive.length === 0;
    const count = state.archive.length;
    archiveCountEl.textContent = String(count);
    archiveEmptyBtn.disabled = count === 0;
    const unread = unreadArchive.size;
    archiveBadge.hidden = unread === 0;
    archiveBadge.textContent = unread > 99 ? "99+" : String(unread);
    archiveToggle.setAttribute("aria-expanded", state.archiveOpen ? "true" : "false");
    archiveToggle.classList.toggle("on", state.archiveOpen);
    archivePane.classList.toggle("closed", !state.archiveOpen);
    archivePane.setAttribute("aria-hidden", state.archiveOpen ? "false" : "true");
    archivePane.toggleAttribute("inert", !state.archiveOpen);
    syncSidebarTab();
    const active = activeTab();
    const bound = Boolean(active?.templateId);
    templateEditBtn.hidden = !bound;
    const blocked = bound && active.templateCompatible === false;
    const mainEl = document.querySelector("main");
    mainEl.classList.toggle("template-locked", blocked);
    templateBlock.hidden = !blocked;
    if (blocked) {
      templateBlockReason.textContent =
        active.templateIncompatibleReason ||
        "The template changed and this page's data no longer matches. Ask the agent to fix the data.";
    }
  }

  function revealTab(el, smooth) {
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    const viewLeft = tabsEl.scrollLeft;
    const viewRight = viewLeft + tabsEl.clientWidth;
    if (left < viewLeft) {
      scrollTabsTo(left, smooth);
    } else if (right > viewRight) {
      scrollTabsTo(right - tabsEl.clientWidth, smooth);
    }
  }

  function updateTabFade() {
    const overflow = tabsEl.scrollWidth - tabsEl.clientWidth > 1;
    const moreToTheRight = tabsEl.scrollLeft + tabsEl.clientWidth < tabsEl.scrollWidth - 1;
    const moreToTheLeft = tabsEl.scrollLeft > 1;
    fadeEl.hidden = !(overflow && moreToTheRight);
    fadeLeftEl.hidden = !(overflow && moreToTheLeft);
  }

  function lookupTab(el) {
    const id = el?.dataset?.id;
    return id ? state.tabs.find((tab) => tab.id === id) || null : null;
  }

  function syncTabEl(el, tab) {
    el.dataset.id = tab.id;
    el.className =
      "tab" +
      (tab.id === state.activeId ? " active" : "") +
      (tab.pinned ? " pinned" : "") +
      (unread.has(tab.id) && tab.id !== state.activeId ? " updated" : "");
    if (drag?.moved && drag.id === tab.id) {
      el.classList.add("dragging");
    }
    el.title =
      unread.has(tab.id) && tab.id !== state.activeId
        ? tab.title + " (updated)"
        : tab.pinned
          ? tab.title + " (pinned)"
          : tab.title;
    let pin = el.querySelector(".tab-pin");
    if (tab.pinned) {
      if (!pin) {
        pin = document.createElement("span");
        pin.className = "tab-pin";
        pin.title = "Pinned";
        pin.innerHTML = PIN_SVG;
        el.insertBefore(pin, el.firstChild);
      }
    } else if (pin) {
      pin.remove();
    }
    let hidden = el.querySelector(".tab-agent-hidden");
    if (tab.agentHidden) {
      if (!hidden) {
        hidden = document.createElement("span");
        hidden.className = "tab-agent-hidden";
        hidden.title = AGENT_HIDDEN_TITLE;
        hidden.innerHTML = AGENT_HIDDEN_SVG;
        el.insertBefore(hidden, el.querySelector(".tab-title"));
      }
    } else if (hidden) {
      hidden.remove();
    }
    let dot = el.querySelector(".tab-updated");
    if (unread.has(tab.id) && tab.id !== state.activeId) {
      if (!dot) {
        dot = document.createElement("span");
        dot.className = "tab-updated";
        dot.title = "Updated in the background";
        const titleEl = el.querySelector(".tab-title");
        el.insertBefore(dot, titleEl);
      }
    } else if (dot) {
      dot.remove();
    }
    const title = el.querySelector(".tab-title");
    if (title) {
      title.textContent = tab.title;
    }
  }

  function createTabEl(tab) {
    const el = document.createElement("div");
    el.role = "tab";
    el.dataset.id = tab.id;
    const title = document.createElement("span");
    title.className = "tab-title";
    el.appendChild(title);
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      const current = lookupTab(el);
      if (current) {
        closeTab(current.id, { permanent: event.shiftKey });
      }
    });
    el.appendChild(close);
    el.addEventListener("click", (event) => {
      if (dragSuppressClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const current = lookupTab(el);
      if (!current) {
        return;
      }
      if (event.detail > 1) {
        setPinned(current.id, !current.pinned);
        return;
      }
      selectTab(current.id, { fromUser: true });
    });
    el.addEventListener("auxclick", (event) => {
      if (event.button !== 1) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const current = lookupTab(el);
      if (!current) {
        return;
      }
      if (event.shiftKey) {
        closeTab(current.id, { permanent: true });
        return;
      }
      if (!current.pinned) {
        closeTab(current.id);
      }
    });
    el.addEventListener("mousedown", (event) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    });
    el.addEventListener("pointerdown", (event) => onTabPointerDown(event, el));
    el.addEventListener("contextmenu", (event) => {
      const current = lookupTab(el);
      if (current) {
        openTabMenu(event, current.id);
      }
    });
    syncTabEl(el, tab);
    return el;
  }

  function flipStrip(mutate) {
    const nodes = [...tabsEl.children];
    const first = new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
    mutate();
    for (const node of nodes) {
      if (node.classList.contains("dragging") || node === drag?.placeholder) {
        continue;
      }
      const prev = first.get(node);
      if (!prev || !node.isConnected) {
        continue;
      }
      const last = node.getBoundingClientRect();
      const dx = prev.left - last.left;
      if (Math.abs(dx) < 1) {
        continue;
      }
      node.style.transition = "none";
      node.style.transform = `translateX(${dx}px)`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          node.style.transition = "";
          node.style.transform = "";
        });
      });
    }
  }

  function renderTabs() {
    if (drag?.moved) {
      for (const tab of state.tabs) {
        const el = tabEls.get(tab.id);
        if (el) {
          syncTabEl(el, tab);
        }
      }
      requestAnimationFrame(updateTabFade);
      return;
    }
    const seen = new Set();
    for (const tab of state.tabs) {
      let el = tabEls.get(tab.id);
      if (!el) {
        el = createTabEl(tab);
        tabEls.set(tab.id, el);
      } else {
        syncTabEl(el, tab);
      }
      seen.add(tab.id);
      tabsEl.appendChild(el);
    }
    for (const [id, el] of tabEls) {
      if (seen.has(id)) {
        continue;
      }
      el.remove();
      tabEls.delete(id);
    }
    const active = tabsEl.querySelector(".tab.active");
    if (active && !drag) {
      const smooth = smoothTabScroll() && revealedTabId != null && revealedTabId !== state.activeId;
      revealTab(active, smooth);
      revealedTabId = state.activeId;
    } else if (!active) {
      revealedTabId = null;
    }
    requestAnimationFrame(updateTabFade);
  }

  function onTabPointerDown(event, el) {
    if (event.button !== 0 || !flagOn(tabReorderToggle) || drag) {
      return;
    }
    if (event.target.closest(".tab-close")) {
      return;
    }
    const tab = lookupTab(el);
    if (!tab) {
      return;
    }
    const groupCount = state.tabs.filter((item) => item.pinned === tab.pinned).length;
    if (groupCount < 2) {
      return;
    }
    drag = {
      id: tab.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      originOrder: state.tabs.map((item) => item.id),
      groupPinned: tab.pinned,
      offsetX: 0,
      offsetY: 0,
      width: 0,
      el,
      placeholder: null,
      scrollDir: 0,
    };
    window.addEventListener("pointermove", onTabPointerMove);
    window.addEventListener("pointerup", onTabPointerUp);
    window.addEventListener("pointercancel", onTabPointerUp);
  }

  function onTabPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 6) {
        return;
      }
      beginTabDrag(event);
    }
    if (!drag?.moved) {
      return;
    }
    event.preventDefault();
    positionDraggedTab(event.clientX, event.clientY);
    updateDragScroll(event.clientX);
    moveDropSlot();
  }

  function beginTabDrag(event) {
    if (!drag) {
      return;
    }
    const el = drag.el;
    const rect = el.getBoundingClientRect();
    drag.moved = true;
    stopTabScroll();
    drag.offsetX = event.clientX - rect.left;
    drag.offsetY = event.clientY - rect.top;
    drag.width = rect.width;
    const placeholder = document.createElement("div");
    placeholder.className = "tab-drop-slot";
    placeholder.style.width = rect.width + "px";
    placeholder.style.height = rect.height + "px";
    el.replaceWith(placeholder);
    drag.placeholder = placeholder;
    el.classList.add("dragging");
    document.body.appendChild(el);
    el.style.position = "fixed";
    el.style.left = rect.left + "px";
    el.style.top = rect.top + "px";
    el.style.width = rect.width + "px";
    el.style.height = rect.height + "px";
    el.style.zIndex = "30";
    el.style.pointerEvents = "none";
    el.style.margin = "0";
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort */
    }
    tabsEl.classList.add("reordering");
    document.body.classList.add("dragging-tab");
    positionDraggedTab(event.clientX, event.clientY);
    moveDropSlot();
  }

  function positionDraggedTab(clientX, clientY) {
    if (!drag?.el) {
      return;
    }
    drag.el.style.left = clientX - drag.offsetX + "px";
    drag.el.style.top = clientY - drag.offsetY + "px";
  }

  function groupLocalIndex(id) {
    let index = 0;
    for (const tab of state.tabs) {
      if (tab.pinned !== drag.groupPinned) {
        continue;
      }
      if (tab.id === id) {
        return index;
      }
      index += 1;
    }
    return -1;
  }

  /** Layout box, ignoring FLIP translate so hit-testing stays stable while siblings animate. */
  function layoutBox(el) {
    const rect = el.getBoundingClientRect();
    const transform = getComputedStyle(el).transform;
    const left = !transform || transform === "none" ? rect.left : rect.left - new DOMMatrix(transform).m41;
    const width = el.offsetWidth;
    return { left, right: left + width };
  }

  function groupOthers() {
    const others = [];
    for (const child of tabsEl.children) {
      if (child === drag.placeholder) {
        continue;
      }
      const tab = lookupTab(child);
      if (tab && tab.pinned === drag.groupPinned) {
        others.push(child);
      }
    }
    return others;
  }

  /**
   * Adjacent hole index. Right: midpoint from gap left to next tab right.
   * Left: midpoint from prev tab left to gap right. Compare the lifted tab's center.
   */
  function nextGapTarget(ghostMid) {
    const from = groupLocalIndex(drag.id);
    if (from < 0 || !drag.placeholder) {
      return from;
    }
    const others = groupOthers();
    const gap = layoutBox(drag.placeholder);
    const next = others[from];
    const prev = others[from - 1];
    if (next) {
      const mid = (gap.left + layoutBox(next).right) / 2;
      if (ghostMid > mid) {
        return from + 1;
      }
    }
    if (prev) {
      const mid = (layoutBox(prev).left + gap.right) / 2;
      if (ghostMid < mid) {
        return from - 1;
      }
    }
    return from;
  }

  function absIndexForGroupTarget(target) {
    let seen = 0;
    let insertAbs = state.tabs.length;
    for (let i = 0; i < state.tabs.length; i += 1) {
      if (state.tabs[i].pinned !== drag.groupPinned) {
        continue;
      }
      if (seen === target) {
        return i;
      }
      seen += 1;
      insertAbs = i + 1;
    }
    return insertAbs;
  }

  function syncPlaceholder() {
    const placeholder = drag?.placeholder;
    if (!placeholder) {
      return;
    }
    const idx = state.tabs.findIndex((tab) => tab.id === drag.id);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const el = tabEls.get(state.tabs[i].id);
      if (el && el.parentNode === tabsEl) {
        el.after(placeholder);
        return;
      }
    }
    for (let i = idx + 1; i < state.tabs.length; i += 1) {
      const el = tabEls.get(state.tabs[i].id);
      if (el && el.parentNode === tabsEl) {
        el.before(placeholder);
        return;
      }
    }
    tabsEl.appendChild(placeholder);
  }

  function moveDropSlot() {
    if (!drag?.placeholder || !drag.el) {
      return;
    }
    const ghost = drag.el.getBoundingClientRect();
    const ghostMid = ghost.left + ghost.width / 2;
    if (nextGapTarget(ghostMid) === groupLocalIndex(drag.id)) {
      return;
    }
    flipStrip(() => {
      for (let n = 0; n < 12; n += 1) {
        const from = groupLocalIndex(drag.id);
        const target = nextGapTarget(ghostMid);
        if (from === -1 || target === from) {
          break;
        }
        const fromAbs = state.tabs.findIndex((tab) => tab.id === drag.id);
        const moving = state.tabs.splice(fromAbs, 1)[0];
        state.tabs.splice(absIndexForGroupTarget(target), 0, moving);
        syncPlaceholder();
      }
    });
  }

  function updateDragScroll(clientX) {
    if (!drag) {
      return;
    }
    const rect = tabsEl.getBoundingClientRect();
    const edge = 36;
    let dir = 0;
    if (clientX < rect.left + edge) {
      dir = -1;
    } else if (clientX > rect.right - edge) {
      dir = 1;
    }
    drag.scrollDir = dir;
    if (dir && !dragScrollTimer) {
      dragScrollTimer = window.setInterval(() => {
        if (!drag?.moved || !drag.scrollDir) {
          clearInterval(dragScrollTimer);
          dragScrollTimer = 0;
          return;
        }
        tabsEl.scrollLeft += drag.scrollDir * 14;
        updateTabFade();
        moveDropSlot();
      }, 16);
    }
    if (!dir && dragScrollTimer) {
      clearInterval(dragScrollTimer);
      dragScrollTimer = 0;
    }
  }

  function neighborBeforeId() {
    if (!drag) {
      return null;
    }
    const idx = state.tabs.findIndex((tab) => tab.id === drag.id);
    const next = state.tabs[idx + 1];
    if (next && next.pinned === drag.groupPinned) {
      return next.id;
    }
    return null;
  }

  function restoreTabOrder(order) {
    const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
    const next = [];
    for (const id of order) {
      const tab = byId.get(id);
      if (tab) {
        next.push(tab);
        byId.delete(id);
      }
    }
    for (const tab of byId.values()) {
      next.push(tab);
    }
    state.tabs = next;
  }

  function stopDragVisual() {
    if (dragScrollTimer) {
      clearInterval(dragScrollTimer);
      dragScrollTimer = 0;
    }
    window.removeEventListener("pointermove", onTabPointerMove);
    window.removeEventListener("pointerup", onTabPointerUp);
    window.removeEventListener("pointercancel", onTabPointerUp);
    tabsEl.classList.remove("reordering");
    document.body.classList.remove("dragging-tab");
    if (!drag) {
      return;
    }
    const el = drag.el;
    try {
      if (el.hasPointerCapture(drag.pointerId)) {
        el.releasePointerCapture(drag.pointerId);
      }
    } catch {
      /* already released */
    }
    el.classList.remove("dragging");
    el.style.position = "";
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    el.style.height = "";
    el.style.zIndex = "";
    el.style.pointerEvents = "";
    el.style.margin = "";
    el.style.transform = "";
    el.style.transition = "";
    if (drag.placeholder && drag.placeholder.isConnected) {
      drag.placeholder.replaceWith(el);
    } else if (!el.isConnected) {
      tabsEl.appendChild(el);
    }
  }

  function abortDrag(restore = true) {
    if (!drag) {
      return;
    }
    const origin = drag.originOrder;
    const moved = drag.moved;
    stopDragVisual();
    drag = null;
    if (restore && moved) {
      restoreTabOrder(origin);
    }
    if (restore) {
      renderTabs();
    }
  }

  async function onTabPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const moved = drag.moved;
    const id = drag.id;
    const origin = drag.originOrder;
    const before = moved ? neighborBeforeId() : null;
    const changed = moved && state.tabs.map((tab) => tab.id).join("\0") !== origin.join("\0");
    if (!moved) {
      window.removeEventListener("pointermove", onTabPointerMove);
      window.removeEventListener("pointerup", onTabPointerUp);
      window.removeEventListener("pointercancel", onTabPointerUp);
      drag = null;
      return;
    }
    stopDragVisual();
    drag = null;
    dragSuppressClick = true;
    window.setTimeout(() => {
      dragSuppressClick = false;
    }, 0);
    renderTabs();
    if (!changed) {
      return;
    }
    try {
      const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ before }),
      });
      if (!res.ok) {
        restoreTabOrder(origin);
        renderTabs();
      }
    } catch {
      restoreTabOrder(origin);
      renderTabs();
    }
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
      el.dataset.id = tab.id;
      el.title = tab.title;
      el.addEventListener("click", () => restoreTab(tab.id));
      el.addEventListener("contextmenu", (event) => openTabMenu(event, tab.id));
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

      const icon = document.createElement("span");
      icon.className = "fileicon";
      icon.innerHTML = tab.agentHidden ? AGENT_HIDDEN_SVG : FILE_SVG;
      if (tab.agentHidden) {
        icon.title = AGENT_HIDDEN_TITLE;
      }
      el.appendChild(icon);

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

  function syncSidebarTab() {
    const templates = state.sidebarTab === "templates";
    sidebarTabArchive.classList.toggle("on", !templates);
    sidebarTabTemplates.classList.toggle("on", templates);
    sidebarTabArchive.setAttribute("aria-selected", templates ? "false" : "true");
    sidebarTabTemplates.setAttribute("aria-selected", templates ? "true" : "false");
    sidebarPanelArchive.hidden = templates;
    sidebarPanelTemplates.hidden = !templates;
  }

  function setSidebarTab(tab) {
    state.sidebarTab = tab === "templates" ? "templates" : "archive";
    localStorage.setItem(SIDEBAR_TAB_KEY, state.sidebarTab);
    syncSidebarTab();
    if (state.sidebarTab === "archive" && archiveSearch.value.trim()) {
      scheduleSearch(0);
    }
    renderTemplates();
  }

  function renderTemplates() {
    const rows = state.templates;
    templateCountEl.textContent = String(rows.length);
    templateList.replaceChildren();
    templateNone.hidden = rows.length > 0;
    for (const template of rows) {
      const el = document.createElement("div");
      el.className = "archive-row";
      el.role = "button";
      el.tabIndex = 0;
      el.dataset.id = template.id;
      el.title = template.title;
      el.addEventListener("click", () => openTemplateModal(template, "create"));
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openTemplateModal(template, "create");
        }
      });

      const icon = document.createElement("span");
      icon.className = "fileicon";
      icon.innerHTML = FILE_SVG;
      el.appendChild(icon);

      const text = document.createElement("span");
      text.className = "tab-title";
      const name = document.createElement("span");
      name.textContent = template.title;
      text.appendChild(name);
      if (template.description) {
        const desc = document.createElement("span");
        desc.className = "template-desc";
        desc.textContent = template.description;
        text.appendChild(desc);
      }
      el.appendChild(text);

      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.textContent = "×";
      close.title = "Delete template";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteTemplate(template);
      });
      el.appendChild(close);
      templateList.appendChild(el);
    }
  }

  function isTemplateModalOpen() {
    return !templateModal.hidden;
  }

  function openTemplateModal(template, mode, values) {
    templateModal.dataset.templateId = template.id;
    templateModal.dataset.mode = mode;
    templateModalTitle.textContent = template.title;
    const desc = template.description || "";
    templateModalDesc.hidden = !desc;
    templateModalDesc.textContent = desc;
    templateModalError.hidden = true;
    templateModalError.textContent = "";
    templateModalSubmit.textContent = mode === "edit" ? "Apply" : "Open";
    templateModalFields.replaceChildren();
    const current = values || {};
    for (const field of template.fields || []) {
      templateModalFields.appendChild(buildTemplateField(field, current[field.key]));
    }
    if (!template.fields?.length) {
      const empty = document.createElement("p");
      empty.className = "settings-hint";
      empty.textContent = "This template has no fields.";
      templateModalFields.appendChild(empty);
    }
    templateModalAgentHidden.checked = mode === "edit" && Boolean(activeTab()?.agentHidden);
    templateModal.hidden = false;
    const first = templateModalFields.querySelector("input, textarea, select");
    first?.focus();
  }

  function closeTemplateModal() {
    if (templateModal.hidden) {
      return;
    }
    templateModal.hidden = true;
    delete templateModal.dataset.templateId;
    delete templateModal.dataset.mode;
    templateModalFields.replaceChildren();
  }

  function buildTemplateField(field, value) {
    const wrap = document.createElement("div");
    wrap.className = "template-field";
    const id = "tpl-field-" + field.key;
    if (field.type === "checkbox") {
      const row = document.createElement("label");
      row.className = "template-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.name = field.key;
      input.checked = value === true || value === "true" || (value == null && field.default === true);
      const label = document.createElement("span");
      label.textContent = field.label;
      row.append(input, label);
      wrap.appendChild(row);
    } else {
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = field.label + (field.required ? " *" : "");
      wrap.appendChild(label);
      let input;
      if (field.type === "textarea") {
        input = document.createElement("textarea");
      } else if (field.type === "select") {
        input = document.createElement("select");
        for (const option of field.options || []) {
          const opt = document.createElement("option");
          const item = typeof option === "string" ? { value: option, label: option } : option;
          opt.value = item.value;
          opt.textContent = item.label || item.value;
          input.appendChild(opt);
        }
      } else {
        input = document.createElement("input");
        input.type = field.type === "number" ? "number" : "text";
        if (field.type === "number") {
          if (field.min != null) input.min = String(field.min);
          if (field.max != null) input.max = String(field.max);
        }
      }
      input.id = id;
      input.name = field.key;
      if (field.placeholder) {
        input.placeholder = field.placeholder;
      }
      if (field.required && field.type !== "checkbox") {
        input.required = true;
      }
      const fallback = value == null ? field.default : value;
      if (fallback != null && field.type !== "checkbox") {
        input.value = String(fallback);
      }
      wrap.appendChild(input);
    }
    if (field.help) {
      const help = document.createElement("p");
      help.className = "help";
      help.textContent = field.help;
      wrap.appendChild(help);
    }
    return wrap;
  }

  function readTemplateForm(template) {
    const values = {};
    for (const field of template.fields || []) {
      const el = templateModalForm.elements.namedItem(field.key);
      if (!el) {
        continue;
      }
      if (field.type === "checkbox") {
        values[field.key] = Boolean(el.checked);
      } else if (field.type === "number") {
        values[field.key] = el.value === "" ? "" : Number(el.value);
      } else {
        values[field.key] = el.value;
      }
    }
    return values;
  }

  async function submitTemplateModal(event) {
    event.preventDefault();
    const id = templateModal.dataset.templateId;
    const mode = templateModal.dataset.mode;
    const template = state.templates.find((item) => item.id === id);
    if (!template) {
      return;
    }
    templateModalError.hidden = true;
    const values = readTemplateForm(template);
    const agentHidden = templateModalAgentHidden.checked;
    const editing = mode === "edit" ? activeTab() : null;
    if (mode === "edit" && !editing) {
      return;
    }
    const url = editing
      ? `/api/tabs/${encodeURIComponent(editing.id)}/template-values`
      : `/api/templates/${encodeURIComponent(id)}/open`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { values } : { values, agentHidden }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        templateModalError.textContent = data.error || "Could not apply template";
        templateModalError.hidden = false;
        return;
      }
      if (editing && Boolean(editing.agentHidden) !== agentHidden) {
        await setAgentHidden(editing.id, agentHidden);
      }
      if (mode !== "edit" && data.tab?.id) {
        pendingFocus = { id: data.tab.id, key: data.tab.key };
      }
      closeTemplateModal();
    } catch {
      templateModalError.textContent = "Could not apply template";
      templateModalError.hidden = false;
    }
  }

  async function deleteTemplate(template) {
    const ok = await confirmDelete(
      `Delete template “${template.title}”? Pages created from it stay and become ordinary pages.`
    );
    if (!ok) {
      return;
    }
    await fetch(`/api/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
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
    renderTemplates();
  }

  function matchesPendingFocus(tab) {
    if (!pendingFocus || !tab) {
      return false;
    }
    return (pendingFocus.id && pendingFocus.id === tab.id) || (pendingFocus.key && pendingFocus.key === tab.key);
  }

  function claimPendingFocus(tab) {
    if (!matchesPendingFocus(tab)) {
      return false;
    }
    pendingFocus = null;
    return true;
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
      if (pendingFocus && !matchesPendingFocus({ id, key: state.tabs.find((tab) => tab.id === id)?.key })) {
        pendingFocus = null;
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
    if (tab?.key === "welcome") {
      await fetch(`/api/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    }
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
    pendingFocus = { id };
    const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/restore`, { method: "POST" });
    if (!res.ok) {
      if (pendingFocus?.id === id) {
        pendingFocus = null;
      }
      return;
    }
    if (pendingFocus?.id === id && state.tabs.some((tab) => tab.id === id)) {
      pendingFocus = null;
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

  function findAnyTab(id) {
    return state.tabs.find((tab) => tab.id === id) || state.archive.find((tab) => tab.id === id) || null;
  }

  async function setAgentHidden(id, hidden) {
    await fetch(`/api/tabs/${encodeURIComponent(id)}/agent-hidden`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden }),
    });
  }

  async function setPinned(id, pin) {
    await fetch(`/api/tabs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, activate: false }),
    });
  }

  async function openWelcome() {
    const html = await fetch("/welcome.html").then((res) => res.text());
    pendingFocus = { key: "welcome" };
    const res = await fetch("/api/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "welcome",
        title: "Welcome",
        html,
        activate: true,
      }),
    });
    if (!res.ok) {
      if (pendingFocus?.key === "welcome") {
        pendingFocus = null;
      }
      return;
    }
    const data = await res.json();
    const id = data?.tab?.id;
    if (id && pendingFocus?.key === "welcome" && state.tabs.some((tab) => tab.id === id)) {
      pendingFocus = null;
      selectTab(id, { fromUser: true });
    }
  }

  function downloadHref(href) {
    const link = document.createElement("a");
    link.href = href;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadActive() {
    const tab = activeTab();
    if (!tab) {
      return;
    }
    downloadHref(`/download/${encodeURIComponent(tab.id)}`);
  }

  function downloadExport(id) {
    if (id) {
      downloadHref(`/api/export/${encodeURIComponent(id)}`);
      return;
    }
    downloadHref("/api/export");
  }

  function importNotice(opened, archived, templates) {
    const parts = [];
    if (opened) {
      parts.push(opened === 1 ? "1 open tab" : `${opened} open tabs`);
    }
    if (archived) {
      parts.push(archived === 1 ? "1 archived tab" : `${archived} archived tabs`);
    }
    if (templates) {
      parts.push(templates === 1 ? "1 template" : `${templates} templates`);
    }
    const last = parts.pop();
    return "Imported " + (parts.length ? `${parts.join(", ")} and ${last}` : last);
  }

  function showNotice(text) {
    noticeEl.textContent = text;
    noticeEl.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      noticeEl.hidden = true;
    }, 4000);
  }

  function showPersistError(error) {
    const message = typeof error === "string" ? error.trim() : "";
    persistBanner.hidden = !message;
    persistBannerDetail.textContent = message;
  }

  async function importFiles(fileList, destination) {
    const files = [...fileList].filter((file) => file && file.size);
    if (!files.length) {
      return;
    }
    let opened = 0;
    let archived = 0;
    let templates = 0;
    let focusedId = null;
    let error = null;
    for (const file of files) {
      try {
        const res = await fetch("/api/import?destination=" + encodeURIComponent(destination), {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Filename": file.name || "import",
          },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          error = data.error || "Import failed";
          continue;
        }
        opened += data.opened || 0;
        archived += data.archived || 0;
        templates += data.templatesCreated || 0;
        if (data.focusedId) {
          focusedId = data.focusedId;
        }
      } catch {
        error = "Import failed";
      }
    }
    if (focusedId) {
      pendingFocus = { id: focusedId };
      if (state.tabs.some((tab) => tab.id === focusedId)) {
        pendingFocus = null;
        selectTab(focusedId, { fromUser: true });
      }
    }
    if (opened || archived || templates) {
      showNotice(importNotice(opened, archived, templates));
    } else if (error) {
      showNotice(error);
    }
  }

  function pickImportFile() {
    importFileInput.value = "";
    importFileInput.click();
  }

  function hasFiles(event) {
    const types = event.dataTransfer?.types;
    if (!types) {
      return false;
    }
    return [...types].includes("Files");
  }

  function bindFileDrop(el, destination) {
    el.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      el.classList.add("file-drop-over");
    });
    el.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("dragleave", (event) => {
      if (el.contains(event.relatedTarget)) {
        return;
      }
      el.classList.remove("file-drop-over");
    });
    el.addEventListener("drop", (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      el.classList.remove("file-drop-over");
      importFiles(event.dataTransfer.files, destination);
    });
  }

  function closeTabMenu() {
    if (tabMenu.hidden) {
      return;
    }
    tabMenu.hidden = true;
    menuTabId = null;
  }

  function openTabMenu(event, id) {
    event.preventDefault();
    event.stopPropagation();
    menuTabId = id;
    tabMenuAgent.textContent = findAnyTab(id)?.agentHidden ? "Show to agent" : "Hide from agent";
    tabMenu.hidden = false;
    tabMenu.style.left = event.clientX + "px";
    tabMenu.style.top = event.clientY + "px";
    const rect = tabMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      tabMenu.style.left = Math.max(8, window.innerWidth - rect.width - 8) + "px";
    }
    if (rect.bottom > window.innerHeight - 8) {
      tabMenu.style.top = Math.max(8, window.innerHeight - rect.height - 8) + "px";
    }
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
      if (!tabMenu.hidden) {
        event.preventDefault();
        closeTabMenu();
        return;
      }
      if (drag) {
        event.preventDefault();
        abortDrag();
        return;
      }
      if (isTemplateModalOpen()) {
        event.preventDefault();
        closeTemplateModal();
        return;
      }
      if (isSettingsOpen()) {
        event.preventDefault();
        closeSettings();
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
    if (drag?.moved) {
      return;
    }
    if (event.deltaY === 0 && event.deltaX === 0) {
      return;
    }
    event.preventDefault();
    const smooth = smoothTabScroll();
    const from = tabScrollTarget == null ? tabsEl.scrollLeft : tabScrollTarget;
    scrollTabsTo(from + event.deltaY + event.deltaX, smooth);
    if (!smooth) {
      updateTabFade();
    }
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
    closeSettings();
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
  window.addEventListener("resize", () => {
    if (tabScrollTarget != null) {
      tabScrollTarget = clampTabScroll(tabScrollTarget);
    }
    updateTabFade();
  });

  document.addEventListener(
    "pointerdown",
    () => {
      lastInteractedAt = Date.now();
      reportViewer();
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!dragSuppressClick) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragSuppressClick = false;
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

  settingsToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSettings();
  });
  settingsBackdrop.addEventListener("mousedown", (event) => {
    event.preventDefault();
    closeSettings();
  });
  importPageBtn.addEventListener("click", pickImportFile);
  exportPageBtn.addEventListener("click", () => {
    const tab = activeTab();
    if (tab) {
      downloadExport(tab.id);
    }
  });
  exportAllBtn.addEventListener("click", () => downloadExport());
  importFileInput.addEventListener("change", () => {
    importFiles(importFileInput.files, "meta");
    importFileInput.value = "";
  });
  tabMenuExport.addEventListener("click", () => {
    if (menuTabId) {
      downloadExport(menuTabId);
    }
    closeTabMenu();
  });
  tabMenuAgent.addEventListener("click", () => {
    const tab = menuTabId ? findAnyTab(menuTabId) : null;
    if (tab) {
      setAgentHidden(tab.id, !tab.agentHidden);
    }
    closeTabMenu();
  });
  tabMenu.addEventListener("contextmenu", (event) => event.preventDefault());
  bindFileDrop(settingsEl, "meta");
  bindFileDrop(tabsWrap, "meta");
  bindFileDrop(archivePane, "archive");
  document.addEventListener("dragover", (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  });
  document.addEventListener("drop", (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!tabMenu.hidden && !tabMenu.contains(event.target)) {
      closeTabMenu();
    }
  });
  window.addEventListener("scroll", closeTabMenu, true);
  tabReorderToggle.addEventListener("click", () => toggleFlag(tabReorderToggle, TAB_REORDER_KEY));
  smoothScrollToggle.addEventListener("click", () => toggleFlag(smoothScrollToggle, SMOOTH_SCROLL_KEY));
  clearBtn.addEventListener("click", async () => {
    await fetch("/api/tabs?filter=unpinned", { method: "DELETE" });
  });
  archiveToggle.addEventListener("click", () => setArchiveOpen(!state.archiveOpen));
  sidebarTabArchive.addEventListener("click", () => setSidebarTab("archive"));
  sidebarTabTemplates.addEventListener("click", () => setSidebarTab("templates"));
  templateEditBtn.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab?.templateId) {
      return;
    }
    const template = state.templates.find((item) => item.id === tab.templateId);
    if (!template) {
      return;
    }
    openTemplateModal(template, "edit", tab.templateValues || {});
  });
  templateModalBackdrop.addEventListener("click", closeTemplateModal);
  templateModalCancel.addEventListener("click", closeTemplateModal);
  templateModalForm.addEventListener("submit", submitTemplateModal);
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
