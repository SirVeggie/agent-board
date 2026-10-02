(() => {
  const tabsEl = document.getElementById("tabs");
  const fadeEl = document.getElementById("tabs-fade");
  const fadeLeftEl = document.getElementById("tabs-fade-left");
  const emptyEl = document.getElementById("empty");
  const framesEl = document.getElementById("frames");
  const clearBtn = document.getElementById("clear");
  const libraryToggle = document.getElementById("library-toggle");
  const libraryBadge = document.getElementById("library-badge");
  const sidePane = document.getElementById("side-pane");
  const sideResizer = document.getElementById("side-resizer");
  const sidebarTabLibrary = document.getElementById("sidebar-tab-library");
  const sidebarTabTemplates = document.getElementById("sidebar-tab-templates");
  const sidebarPanelLibrary = document.getElementById("sidebar-panel-library");
  const sidebarPanelTemplates = document.getElementById("sidebar-panel-templates");
  const sidebarPanelTrash = document.getElementById("sidebar-panel-trash");
  const sidebarTabs = document.getElementById("sidebar-tabs");
  const sidebarBack = document.getElementById("sidebar-back");
  const trashBack = document.getElementById("trash-back");
  const templateCountEl = document.getElementById("template-count");
  const templateList = document.getElementById("template-list");
  const templateNone = document.getElementById("template-none");
  const builtinGroup = document.getElementById("builtin-group");
  const builtinHead = document.getElementById("builtin-head");
  const builtinCountEl = document.getElementById("builtin-count");
  const builtinList = document.getElementById("builtin-list");
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
  const choiceDlg = document.getElementById("choice");
  const choiceMessage = document.getElementById("choice-message");
  const choiceActions = document.getElementById("choice-actions");
  const cleanupDlg = document.getElementById("cleanup");
  const paletteEl = document.getElementById("palette");
  const paletteBackdrop = document.getElementById("palette-backdrop");
  const paletteInput = document.getElementById("palette-input");
  const paletteList = document.getElementById("palette-list");
  const paletteEmpty = document.getElementById("palette-empty");
  const settingsEl = document.getElementById("settings");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  const settingsToggle = document.getElementById("settings-toggle");
  const themeList = document.getElementById("theme-list");
  const smoothScrollToggle = document.getElementById("smooth-scroll");
  const tightSmallToggle = document.getElementById("tight-small");
  const importPageBtn = document.getElementById("import-page");
  const exportPageBtn = document.getElementById("export-page");
  const exportAllBtn = document.getElementById("export-all");
  const importFileInput = document.getElementById("import-file");
  const noticeEl = document.getElementById("notice");
  const noticeText = document.getElementById("notice-text");
  const noticeUndo = document.getElementById("notice-undo");
  const persistBanner = document.getElementById("persist-banner");
  const persistBannerDetail = document.getElementById("persist-banner-detail");
  const tabsWrap = tabsEl.parentElement;
  const mainEl = document.querySelector("main");
  const linkModeTrack = document.getElementById("link-mode");

  const SANDBOX =
    "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
  const EMBED_ALLOW = "fullscreen; clipboard-read; clipboard-write";
  const LIVE_FRAME_CAP = 5;
  const SIDE_OPEN_KEY = "scribe.archiveOpen";
  const SIDEBAR_TAB_KEY = "scribe.sidebarTab";
  const SIDE_WIDTH_KEY = "scribe.archiveWidth";
  /** Must match VERSION in src/config.ts. */
  const BOARD_VERSION = "3.0.0";
  const BUILTIN_OPEN_KEY = "scribe.builtinTemplatesOpen";
  const TAB_CARD_DELAY = 450;
  const TEMPLATE_CARD_DELAY = 700;
  const TOGGLE_HOVER_OPEN_MS = 500;
  const THEME_KEY = "scribe.theme";
  const SMOOTH_SCROLL_KEY = "scribe.smoothScroll";
  /** What a page link without a mode or modifier does: "tab", "peek", or "split". */
  const LINK_MODE_KEY = "scribe.linkMode";
  const VIEWER_ID_KEY = "scribe.viewerId";
  const LINK_MODES = [
    { id: "tab", name: "Navigate" },
    { id: "peek", name: "Peek" },
    { id: "split", name: "Split" },
  ];
  /** Also read by the inline script in index.html so the first paint already has the right spacing. */
  const TIGHT_SMALL_KEY = "scribe.tightSmall";
  const DEFAULT_THEME = "neutral";
  const THEMES = [
    { id: "neutral", name: "Neutral", swatch: "#c9c9d0", icon: "/favicon.svg?v=4" },
    { id: "ember", name: "Ember", swatch: "#d0a578", icon: "/favicon-ember.svg?v=4" },
    { id: "spectrum", name: "Spectrum", swatch: "#9db8a4", icon: "/favicon-spectrum.svg?v=4" },
    { id: "garnet", name: "Garnet", swatch: "#d56f6c", icon: "/favicon-garnet.svg?v=5" },
    { id: "dusk", name: "Dusk", swatch: "#b7a2dc", icon: "/favicon-dusk.svg?v=5" },
    { id: "cream", name: "Cream", swatch: "#f3ede1", icon: "/favicon-cream.svg?v=5" },
  ];
  const PIN_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M9.6 1.4l5 5-1.4 1.4-.9-.2-2.3 2.3.2 2.5-1.5 1.5-2.4-2.4-3.1 3.1-.8-.8 3.1-3.1-2.4-2.4 1.5-1.5 2.5.2 2.3-2.3-.2-.9z" fill="currentColor"/></svg>';
  const FILE_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2h7.5l3.5 3.5V14h-11z" fill="currentColor"/></svg>';
  const BUILTIN_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M2.5 2h7.5l3.5 3.5V14h-11zM8 7.2l.9 1.8 2 .3-1.45 1.4.35 2L8 11.75l-1.8.95.35-2L5.1 9.3l2-.3z" fill="currentColor"/></svg>';
  const AGENT_HIDDEN_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const AGENT_HIDDEN_TITLE = "Hidden from the agent";
  const UPDATE_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm-.8 3.2v4.1h1.6V4.7zm0 5.3v1.6h1.6V10z" fill="currentColor" fill-rule="evenodd"/></svg>';
  const UPDATE_TITLE = "Built-in template updated";
  const UPDATE_NOTE =
    "This copy wasn't updated automatically because it was edited or its page data format changed. Ask an agent to update it.";

  /** @type {{ tabs: Array<any>, closed: Array<any>, folders: Array<any>, templates: Array<any>, activeId: string | null, connected: boolean, sideOpen: boolean, sidebarTab: string, trashOpen: boolean }} */
  const state = {
    tabs: [],
    closed: [],
    folders: [],
    templates: [],
    /** Read-only templates shipped with the app. Opening one opens its local copy. */
    builtinTemplates: [],
    builtinOpen: localStorage.getItem(BUILTIN_OPEN_KEY) !== "0",
    activeId: null,
    connected: false,
    sideOpen: localStorage.getItem(SIDE_OPEN_KEY) === "1",
    sidebarTab: localStorage.getItem(SIDEBAR_TAB_KEY) === "templates" ? "templates" : "library",
    /** The Trash view replaces the sidebar tabs until Back. */
    trashOpen: false,
  };

  /** @type {Map<string, { el: HTMLIFrameElement, revision: number }>} */
  const frames = new Map();
  /** @type {Set<string>} */
  const unread = new Set();
  /** Closed pages changed in the background; the blip shows on the Library button. */
  const unreadLibrary = new Set();

  /** @type {WebSocket | null} */
  let socket = null;
  let lastInteractedAt = 0;
  let lastEditAt = 0;
  let viewerHidden = false;
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
  let toggleHoverTimer = 0;
  let noticeTimer = 0;
  /** @type {null | { label: string, run: () => void }} */
  let noticeAction = null;
  /** @type {HTMLElement | null} */
  let stripSlotEl = null;

  const hoverCard = window.createHoverCard({ describe: describeForCard });
  const library = window.createLibrary({
    pages: libraryPages,
    folders: () => state.folders,
    addFolder: (folder) => {
      if (!state.folders.some((item) => item.id === folder.id)) {
        state.folders = [...state.folders, folder];
      }
    },
    activeId: () => state.activeId,
    isOpen: (id) => state.tabs.some((tab) => tab.id === id),
    isUnread: (id) => unreadLibrary.has(id),
    findAny: findAnyTab,
    selectTab: (id) => selectTab(id, { fromUser: true }),
    openPage,
    focusWhenOpened,
    closeTab: (id) => closeTab(id),
    setPinned,
    setAgentHidden,
    copyTabKey,
    downloadExport,
    downloadFolderExport: (id) => downloadHref(`/api/export/folder/${encodeURIComponent(id)}`),
    downloadAll: () => downloadExport(),
    showNotice,
    choose,
    confirm: (message) => confirmDelete(message),
    openTrash,
    setPaneOpen: (open) => {
      if (state.sidebarTab !== "library" || state.trashOpen) {
        setSidebarTab("library");
      }
      if (state.sideOpen !== open) {
        setSideOpen(open);
      }
    },
    paneOpen: libraryShown,
    rerender: () => render(),
    modeFromEvent: (event) => views.modeFromEvent(event),
    openIn: (id, mode) => views.open(id, mode),
    canSplit: (id) => Boolean(state.activeId) && state.activeId !== id,
    hoverCard,
    stripSlot,
    clearStripSlot,
    icons: { file: FILE_SVG, pin: PIN_SVG, agentHidden: AGENT_HIDDEN_SVG, agentHiddenTitle: AGENT_HIDDEN_TITLE },
  });
  const views = window.createViews({
    mainEl,
    contentOrigin,
    tabs: () => state.tabs,
    closed: () => state.closed,
    findAnyTab,
    activeId: () => state.activeId,
    activeTab,
    frame: (id) => frames.get(id) || null,
    frameIds: () => [...frames.keys()],
    ensureFrame,
    discardFrame,
    selectTab: (id) => selectTab(id, { fromUser: true }),
    openPage,
    showNotice,
    linkMode,
    markSeen,
    render: () => render(),
  });
  const trash = window.createTrash({
    showNotice,
    confirm: (message) => confirmDelete(message),
    openMenu: library.openMenu,
    closeMenu: library.closeMenu,
    icons: { file: FILE_SVG, ...library.icons },
  });

  applySideWidth(Number(localStorage.getItem(SIDE_WIDTH_KEY)) || 280);
  applyTheme(loadTheme());
  applyFlag(smoothScrollToggle, SMOOTH_SCROLL_KEY, true);
  applyFlag(tightSmallToggle, TIGHT_SMALL_KEY, true);
  document.documentElement.classList.toggle("tight-small", flagOn(tightSmallToggle));
  renderThemeList();
  renderLinkModes();

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    socket = ws;
    ws.addEventListener("open", () => {
      state.connected = true;
      renderChrome();
      reportViewer();
      dispatchEvent(new CustomEvent("scribe:connection", { detail: { connected: true } }));
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
      dispatchEvent(new CustomEvent("scribe:connection", { detail: { connected: false } }));
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
        hidden: viewerHidden,
      })
    );
  }

  /** The desktop app reports its window hidden in the tray, so agents open it instead of assuming it is seen. */
  window.scribeSetHidden = (hidden) => {
    viewerHidden = Boolean(hidden);
    reportViewer();
  };

  function noteEdit() {
    const now = Date.now();
    lastEditAt = now;
    lastInteractedAt = now;
    reportViewer();
  }

  function isClosedMeta(tab) {
    return Boolean(tab?.closedAt);
  }

  function applyEvent(msg) {
    if (typeof msg.type === "string" && msg.type.startsWith("agent_")) {
      dispatchEvent(new CustomEvent("scribe:agent-event", { detail: msg }));
      return;
    }
    if (msg.type === "snapshot") {
      showVersionMismatch(msg.version);
      abortDrag(false);
      state.tabs = msg.tabs;
      state.closed = Array.isArray(msg.closed) ? msg.closed : [];
      state.folders = Array.isArray(msg.folders) ? msg.folders : [];
      state.templates = Array.isArray(msg.templates) ? msg.templates : [];
      state.builtinTemplates = Array.isArray(msg.builtinTemplates) ? msg.builtinTemplates : [];
      views.prune();
      const hash = location.hash.replace(/^#/, "");
      const fromOpen = state.tabs.find((tab) => tab.id === hash || tab.key === hash);
      const fromClosed = state.closed.find((tab) => tab.id === hash || tab.key === hash);
      state.activeId = fromOpen ? fromOpen.id : msg.activeId;
      unread.clear();
      unreadLibrary.clear();
      syncHash();
      render();
      reportViewer();
      showPersistError(msg.persistError);
      if (fromClosed && !fromOpen) {
        openPage(fromClosed.id);
      }
      return;
    }
    if (msg.type === "folders") {
      state.folders = Array.isArray(msg.folders) ? msg.folders : [];
      renderChrome();
      library.render();
      return;
    }
    if (msg.type === "trash") {
      trash.refresh();
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
    if (msg.type === "page_asset_warning") {
      warnPageAssets(msg);
      return;
    }
    if (msg.type === "tab_upserted") {
      if (!findAnyTab(msg.tab.id)) {
        notePagesChanged();
      }
      if (isClosedMeta(msg.tab)) {
        upsertClosed(msg.tab, msg.structural);
        if (drag && drag.id === msg.tab.id) {
          abortDrag(false);
        }
        render();
        library.refreshSearch();
        return;
      }
      const idx = state.tabs.findIndex((tab) => tab.id === msg.tab.id);
      const prev = idx === -1 ? null : state.tabs[idx];
      const structural = !prev || (msg.structural !== false && prev.revision !== msg.tab.revision);
      state.closed = state.closed.filter((tab) => tab.id !== msg.tab.id);
      unreadLibrary.delete(msg.tab.id);
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
      if (structural && !views.isShown(msg.tab.id)) {
        unread.add(msg.tab.id);
      }
      if (structural) {
        refreshFrame(msg.tab);
        library.refreshSearch();
      } else {
        syncFrameMeta(msg.tab);
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
        library.render();
      } else {
        render();
      }
      if (focusedHere) {
        reportViewer();
      }
      return;
    }
    if (msg.type === "tab_deleted") {
      notePagesChanged();
      if (drag && drag.id === msg.id) {
        abortDrag(false);
      }
      const neighbor = neighborTabId(msg.id);
      views.onDeleted(msg.id);
      state.tabs = state.tabs.filter((tab) => tab.id !== msg.id);
      state.closed = state.closed.filter((tab) => tab.id !== msg.id);
      unread.delete(msg.id);
      unreadLibrary.delete(msg.id);
      discardFrame(msg.id);
      if (state.activeId === msg.id) {
        state.activeId = neighbor;
        if (state.activeId) {
          unread.delete(state.activeId);
        }
        syncHash();
      }
      library.refreshSearch();
      render();
      reportViewer();
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
      const closed = state.closed.find((item) => item.id === msg.id);
      for (const item of [tab, closed]) {
        if (item) {
          item.stateRevision = msg.stateRevision;
          item.stateUpdatedAt = Date.now();
        }
      }
      if (closed && !views.isShown(msg.id)) {
        unreadLibrary.add(msg.id);
        renderChrome();
        library.render();
      }
      const entry = frames.get(msg.id);
      if (entry?.el.contentWindow) {
        entry.el.contentWindow.postMessage(
          {
            type: "scribe-state",
            id: msg.id,
            fromRevision: msg.fromRevision,
            stateRevision: msg.stateRevision,
            ops: msg.ops,
            client: msg.client,
            writeId: msg.writeId,
          },
          "*"
        );
      }
      if (tab && !views.isShown(msg.id)) {
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
      return;
    }
    if (msg.type === "builtin_templates") {
      state.builtinTemplates = Array.isArray(msg.templates) ? msg.templates : [];
      renderTemplates();
    }
  }

  /** A page was created, deleted, or restored: live pages recheck their links (struck-through when missing). */
  let pagesChangedTimer = 0;
  function notePagesChanged() {
    clearTimeout(pagesChangedTimer);
    pagesChangedTimer = setTimeout(() => {
      for (const [id, entry] of frames) {
        if (id.startsWith("url:") || findAnyTab(id)?.embedUrl) {
          continue;
        }
        entry.el.contentWindow?.postMessage({ type: "scribe-pages-changed", id }, "*");
      }
    }, 150);
  }

  /** The tab to focus when `id` leaves the strip: its right neighbor, or its left one when it is rightmost. */
  function neighborTabId(id) {
    const back = views.returnTarget(id);
    if (back) {
      return back;
    }
    const idx = state.tabs.findIndex((tab) => tab.id === id);
    if (idx === -1) {
      return state.tabs.length ? state.tabs[state.tabs.length - 1].id : null;
    }
    return (state.tabs[idx + 1] ?? state.tabs[idx - 1])?.id ?? null;
  }

  /** A page whose tab is closed. Blips the Library only when its content or state changed, not on moves or pins. */
  function upsertClosed(tab, structural) {
    const neighbor = neighborTabId(tab.id);
    state.tabs = state.tabs.filter((item) => item.id !== tab.id);
    unread.delete(tab.id);
    const shown = views.isShown(tab.id) && state.activeId !== tab.id;
    if (shown) {
      refreshFrame(tab);
    } else {
      discardFrame(tab.id);
    }
    const idx = state.closed.findIndex((item) => item.id === tab.id);
    if (idx === -1) {
      state.closed.push(tab);
    } else {
      const prev = state.closed[idx];
      if (!shown && ((structural !== false && prev.revision !== tab.revision) || prev.stateRevision !== tab.stateRevision)) {
        unreadLibrary.add(tab.id);
      }
      state.closed[idx] = tab;
    }
    if (state.activeId === tab.id) {
      state.activeId = neighbor;
      if (state.activeId) {
        unread.delete(state.activeId);
      }
      syncHash();
    }
  }

  /** Every Library page: open tabs and closed pages, without the help page. */
  function libraryPages() {
    return [...state.tabs, ...state.closed].filter((tab) => tab.key !== "scribe:welcome");
  }

  /** Position of the current history entry among the board's own entries; see onHistoryStep. */
  let historyIndex = typeof history.state?.boardIndex === "number" ? history.state.boardIndex : 0;

  function syncHash() {
    if (!state.activeId) {
      if (location.hash) {
        history.replaceState({ boardIndex: historyIndex }, "", location.pathname + location.search);
      }
      return;
    }
    const wanted = "#" + state.activeId;
    if (location.hash === wanted) {
      return;
    }
    // Focus moving between open tabs adds a history entry, so the browser's Back and Forward step
    // through the tabs you were on. On first load, or when the previous tab has left the strip,
    // the entry is replaced instead.
    const prev = location.hash.replace(/^#/, "");
    if (prev && state.tabs.some((tab) => tab.id === prev)) {
      historyIndex += 1;
      history.pushState({ boardIndex: historyIndex }, "", wanted);
    } else {
      history.replaceState({ boardIndex: historyIndex }, "", wanted);
    }
  }

  /**
   * Back or Forward onto one of the board's entries: focus that tab. An entry for the tab already in
   * front, or for a page that is closed or gone, is skipped in the same direction, so every press
   * lands on a different open tab. Entries the board did not make (a hash typed into the address
   * bar) are left to hashchange.
   */
  function onHistoryStep(event) {
    const index = event.state?.boardIndex;
    if (typeof index !== "number") {
      return;
    }
    const step = index < historyIndex ? -1 : 1;
    historyIndex = index;
    const id = location.hash.replace(/^#/, "");
    const open = state.tabs.find((tab) => tab.id === id);
    if (open && open.id !== state.activeId) {
      selectTab(open.id, { fromUser: true });
      return;
    }
    history.go(step);
    // At either end of the history there is nothing to skip to: point the URL back at the tab in front.
    setTimeout(() => {
      if (historyIndex === index) {
        syncHash();
      }
    }, 150);
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeId) || null;
  }

  function viewUrl(tab) {
    if (tab.embedUrl) {
      return tab.embedUrl;
    }
    return `${contentOrigin()}/view/${encodeURIComponent(tab.id)}?r=${tab.revision}&viewer=${viewerId()}`;
  }

  /** Names this app or browser to pages, so scribe.local keeps one copy per place you view them from. */
  function viewerId() {
    let id = localStorage.getItem(VIEWER_ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
      id = (window.__TAURI__ ? "desktop_" : "browser_") + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(VIEWER_ID_KEY, id);
    }
    return id;
  }

  function contentOrigin() {
    const port = location.port ? `:${location.port}` : "";
    return `${location.protocol}//127.0.0.2${port}`;
  }

  function setSideOpen(open) {
    state.sideOpen = Boolean(open);
    localStorage.setItem(SIDE_OPEN_KEY, state.sideOpen ? "1" : "0");
    if (state.sideOpen) {
      library.refreshSearch();
    }
    renderChrome();
    library.render();
    renderTemplates();
  }

  function applySideWidth(px) {
    const width = Math.max(220, Math.min(480, px));
    document.documentElement.style.setProperty("--side-width", width + "px");
    localStorage.setItem(SIDE_WIDTH_KEY, String(width));
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
    if (el === smoothScrollToggle && !on) {
      stopTabScroll();
    }
    if (el === tightSmallToggle) {
      document.documentElement.classList.toggle("tight-small", on);
    }
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
    exportAllBtn.disabled = libraryPages().length === 0;
    const blips = unreadLibrary.size;
    libraryBadge.hidden = blips === 0;
    libraryBadge.textContent = blips > 99 ? "99+" : String(blips);
    libraryToggle.setAttribute("aria-expanded", state.sideOpen ? "true" : "false");
    libraryToggle.classList.toggle("on", state.sideOpen);
    sidePane.classList.toggle("closed", !state.sideOpen);
    sidePane.setAttribute("aria-hidden", state.sideOpen ? "false" : "true");
    sidePane.toggleAttribute("inert", !state.sideOpen);
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
      (unread.has(tab.id) && tab.id !== state.activeId ? " updated" : "") +
      (window.scribeChat?.pageStatus(tab.id) ? ` agent-${window.scribeChat.pageStatus(tab.id)}` : "");
    if (drag?.moved && drag.id === tab.id) {
      el.classList.add("dragging");
    }
    el.setAttribute("aria-label", tab.title);
    let pin = el.querySelector(".tab-pin");
    if (tab.pinned) {
      if (!pin) {
        pin = document.createElement("span");
        pin.className = "tab-pin";
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
        hidden.setAttribute("aria-label", AGENT_HIDDEN_TITLE);
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
        dot.setAttribute("aria-label", "Updated in the background");
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
        copyTabKey(current.id);
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
        library.pageMenu(event, current.id);
      }
    });
    hoverCard.bind(el, TAB_CARD_DELAY);
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
    if (event.button !== 0 || drag) {
      return;
    }
    if (event.target.closest(".tab-close")) {
      return;
    }
    const tab = lookupTab(el);
    if (!tab) {
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
    trackToggleHover(event.clientX, event.clientY);
    const tab = state.tabs.find((item) => item.id === drag.id);
    const overLibrary = Boolean(tab && tab.key !== "scribe:welcome" && library.stripDragMove(tab, event.clientX, event.clientY));
    drag.el.classList.toggle("to-library", overLibrary);
    if (overLibrary) {
      updateDragScroll(Number.NaN);
      return;
    }
    updateDragScroll(event.clientX);
    moveDropSlot();
  }

  /** Hovering the Library button mid-drag opens the Library so the tab can be filed. */
  function trackToggleHover(x, y) {
    const box = libraryToggle.getBoundingClientRect();
    const over = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    if (!over) {
      clearTimeout(toggleHoverTimer);
      toggleHoverTimer = 0;
      libraryToggle.classList.remove("drag-hover");
      return;
    }
    if (toggleHoverTimer || libraryShown()) {
      return;
    }
    libraryToggle.classList.add("drag-hover");
    toggleHoverTimer = window.setTimeout(() => {
      libraryToggle.classList.remove("drag-hover");
      if (drag?.moved) {
        setSidebarTab("library");
        setSideOpen(true);
      }
    }, TOGGLE_HOVER_OPEN_MS);
  }

  function beginTabDrag(event) {
    if (!drag) {
      return;
    }
    const el = drag.el;
    const rect = el.getBoundingClientRect();
    drag.moved = true;
    stopTabScroll();
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;
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
    hoverCard.suspend();
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
    clearTimeout(toggleHoverTimer);
    toggleHoverTimer = 0;
    libraryToggle.classList.remove("drag-hover");
    hoverCard.resume();
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
    el.classList.remove("dragging", "to-library");
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
    library.stripDragCancel();
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
    const draggedTab = state.tabs.find((tab) => tab.id === id);
    const filed = Boolean(draggedTab && library.stripDragDrop(draggedTab));
    stopDragVisual();
    drag = null;
    dragSuppressClick = true;
    window.setTimeout(() => {
      dragSuppressClick = false;
    }, 0);
    if (filed) {
      restoreTabOrder(origin);
    }
    renderTabs();
    if (filed) {
      tabEls.get(id)?.classList.add("filing");
      return;
    }
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

  /**
   * Library row dragged over the strip: shows a drop slot in the page's pin group.
   * Returns where it would open, or null when the pointer is not over the strip.
   */
  function stripSlot(x, y, page) {
    const box = tabsWrap.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top - 10 || y > box.bottom + 10) {
      clearStripSlot();
      return null;
    }
    const pinned = Boolean(page.pinned);
    const group = state.tabs.filter((tab) => Boolean(tab.pinned) === pinned && tab.id !== page.id);
    const before =
      group.find((tab) => {
        const el = tabEls.get(tab.id);
        if (!el) {
          return false;
        }
        const r = layoutBox(el);
        return x < (r.left + r.right) / 2;
      }) || null;
    let anchor = before ? tabEls.get(before.id) : null;
    let after = null;
    if (!anchor) {
      const last = group[group.length - 1];
      after = last ? tabEls.get(last.id) : null;
      if (!after && pinned) {
        anchor = tabsEl.firstElementChild;
      }
    }
    if (!stripSlotEl) {
      stripSlotEl = document.createElement("div");
      stripSlotEl.className = "tab-drop-slot strip-open-slot";
    }
    const slot = stripSlotEl;
    const inPlace = after ? after.nextElementSibling === slot : anchor ? anchor.previousElementSibling === slot : slot.parentNode === tabsEl && !slot.nextElementSibling;
    if (!inPlace) {
      flipStrip(() => {
        if (after) {
          after.after(slot);
        } else if (anchor && anchor !== slot) {
          anchor.before(slot);
        } else {
          tabsEl.appendChild(slot);
        }
      });
    }
    tabsWrap.classList.add("strip-drop-over");
    return { before: before ? before.id : null };
  }

  function clearStripSlot() {
    tabsWrap.classList.remove("strip-drop-over");
    const slot = stripSlotEl;
    if (slot?.isConnected) {
      flipStrip(() => slot.remove());
    }
  }

  function libraryShown() {
    return state.sideOpen && state.sidebarTab === "library" && !state.trashOpen;
  }

  function syncSidebarTab() {
    const templates = state.sidebarTab === "templates";
    const inTrash = state.trashOpen;
    sidebarTabs.hidden = inTrash;
    sidebarBack.hidden = !inTrash;
    sidebarPanelTrash.hidden = !inTrash;
    sidebarTabLibrary.classList.toggle("on", !templates);
    sidebarTabTemplates.classList.toggle("on", templates);
    sidebarTabLibrary.setAttribute("aria-selected", templates ? "false" : "true");
    sidebarTabTemplates.setAttribute("aria-selected", templates ? "true" : "false");
    sidebarPanelLibrary.hidden = templates || inTrash;
    sidebarPanelTemplates.hidden = !templates || inTrash;
  }

  function openTrash() {
    library.closeMenu();
    state.trashOpen = true;
    syncSidebarTab();
    trash.setVisible(true);
    if (!state.sideOpen) {
      setSideOpen(true);
    }
    trash.focus();
  }

  function closeTrash() {
    if (!state.trashOpen) {
      return;
    }
    state.trashOpen = false;
    trash.setVisible(false);
    syncSidebarTab();
    if (state.sidebarTab === "library") {
      library.refreshSearch();
    }
  }

  function setSidebarTab(tab) {
    if (state.trashOpen) {
      state.trashOpen = false;
      trash.setVisible(false);
    }
    state.sidebarTab = tab === "templates" ? "templates" : "library";
    localStorage.setItem(SIDEBAR_TAB_KEY, state.sidebarTab);
    syncSidebarTab();
    if (state.sidebarTab === "library") {
      library.refreshSearch();
    }
    renderTemplates();
  }

  function renderTemplates() {
    const rows = state.templates;
    templateCountEl.textContent = String(rows.length);
    templateList.replaceChildren(...rows.map((template) => templateRow(template, false)));
    templateNone.hidden = rows.length > 0;
    if (freshTemplateId) {
      flashTemplateRow(freshTemplateId);
    }
    const builtins = state.builtinTemplates;
    builtinGroup.hidden = builtins.length === 0;
    builtinGroup.classList.toggle("open", state.builtinOpen);
    builtinHead.setAttribute("aria-expanded", state.builtinOpen ? "true" : "false");
    builtinCountEl.textContent = String(builtins.length);
    builtinList.replaceChildren(...builtins.map((template) => templateRow(template, true)));
  }

  function templateRow(template, builtin) {
    const el = document.createElement("div");
    el.className = builtin ? "side-row template-row builtin" : "side-row template-row";
    el.role = "button";
    el.tabIndex = builtin && !state.builtinOpen ? -1 : 0;
    el.dataset.id = template.id;
    el.dataset.kind = "template";
    el.ariaLabel = template.title;
    el.addEventListener("click", () => openTemplateModal(template, "create"));
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTemplateModal(template, "create");
      }
    });

    const icon = document.createElement("span");
    icon.className = "fileicon";
    icon.innerHTML = builtin ? BUILTIN_SVG : FILE_SVG;
    el.appendChild(icon);

    const text = document.createElement("span");
    text.className = "tab-title";
    const name = document.createElement("span");
    name.className = "template-name";
    name.textContent = template.title;
    const line = document.createElement("span");
    line.className = "template-line";
    line.appendChild(name);
    if (template.builtinUpdate) {
      const update = document.createElement("span");
      update.className = "template-update";
      update.innerHTML = UPDATE_SVG;
      update.ariaLabel = `${UPDATE_TITLE}. ${UPDATE_NOTE}`;
      update.dataset.kind = "template-update";
      update.dataset.id = template.id;
      hoverCard.bind(update, 120);
      line.appendChild(update);
    }
    if (builtin || template.builtinSource) {
      const version = document.createElement("span");
      version.className = "template-version";
      version.textContent = `v${template.stateVersion}`;
      version.title = builtin ? "Built-in template version" : "Copied from a built-in template";
      line.appendChild(version);
    }
    text.appendChild(line);
    if (template.description) {
      const desc = document.createElement("span");
      desc.className = "template-desc";
      desc.textContent = template.description;
      text.appendChild(desc);
    }
    el.appendChild(text);

    if (builtin) {
      el.addEventListener("contextmenu", (event) => builtinMenu(event, template, el));
    } else {
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
    }
    hoverCard.bind(el, TEMPLATE_CARD_DELAY);
    return el;
  }

  function builtinMenu(event, template, el) {
    event.preventDefault();
    event.stopPropagation();
    el.classList.add("menu-on");
    library.openMenu({ x: event.clientX, y: event.clientY }, [
      { label: "Open…", action: () => openTemplateModal(template, "create") },
      template.localId
        ? { label: "Show my copy", action: () => flashTemplateRow(template.localId, true) }
        : { label: "Add to my templates", action: () => copyBuiltinTemplate(template) },
      "sep",
      { label: "Copy template ID", action: () => copyTemplateId(template.id) },
    ]);
    // The shared menu has no close hook; drop the highlight on the next interaction.
    const clear = () => el.classList.remove("menu-on");
    setTimeout(() => {
      document.addEventListener("pointerdown", clear, { once: true, capture: true });
      document.addEventListener("keydown", clear, { once: true, capture: true });
    });
  }

  function toggleBuiltinGroup() {
    state.builtinOpen = !state.builtinOpen;
    try {
      localStorage.setItem(BUILTIN_OPEN_KEY, state.builtinOpen ? "1" : "0");
    } catch {
      /* private mode */
    }
    renderTemplates();
  }

  /** A template row that should flash once it exists (the upsert event and the fetch response race). */
  let freshTemplateId = null;

  function flashTemplateRow(id, scroll = false) {
    const row = templateList.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) {
      freshTemplateId = id;
      return;
    }
    freshTemplateId = null;
    row.classList.remove("fresh");
    void row.offsetWidth;
    row.classList.add("fresh");
    if (scroll) {
      row.scrollIntoView({ block: "nearest" });
    }
  }

  async function copyBuiltinTemplate(template) {
    const res = await fetch(`/api/templates/${encodeURIComponent(template.id)}/copy`, { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok || !data.template) {
      showNotice(data.error || "Could not copy the template");
      return;
    }
    flashTemplateRow(data.template.id, true);
    showNotice(`Added “${data.template.title}” to your templates`);
  }

  async function copyTemplateId(id) {
    try {
      await navigator.clipboard.writeText(id);
      showNotice(`Copied ${id}`);
    } catch {
      showNotice("Could not copy to clipboard");
    }
  }

  function findTemplateMeta(id) {
    return state.templates.find((item) => item.id === id) || state.builtinTemplates.find((item) => item.id === id) || null;
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
    const first = templateModalFields.querySelector("input, textarea, .select-button");
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
      if (field.type === "select") {
        wrap.appendChild(window.createSelect(input));
        label.htmlFor = `${id}-button`;
      } else {
        wrap.appendChild(input);
      }
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
    const template = findTemplateMeta(id);
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
      if (data.copiedBuiltin) {
        showNotice(`Added “${template.title}” to your templates`);
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
    const keep = views.shownIds();
    keep.add(keepId);
    while (unpinnedLiveCount() > LIVE_FRAME_CAP) {
      const victim = [...frames.keys()].find((id) => !keep.has(id) && !isPinned(id));
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
      el.addEventListener("load", () => {
        el.dataset.loaded = "1";
      });
      framesEl.appendChild(el);
      loadFrame(el, tab);
      entry = { el, revision: tab.revision };
      frames.set(tab.id, entry);
    } else {
      if (entry.el.title !== tab.title) {
        entry.el.title = tab.title;
      }
      if (entry.revision !== tab.revision) {
        loadFrame(entry.el, tab);
        entry.revision = tab.revision;
      }
      touchFrame(tab.id);
      entry = frames.get(tab.id);
    }
    evictOverflow(tab.id);
    return entry;
  }

  /** Keep the iframe's title and stored revision in sync without reloading (pin, rename, Library move). */
  function syncFrameMeta(tab) {
    const entry = frames.get(tab.id);
    if (!entry) {
      return;
    }
    entry.revision = tab.revision;
    if (entry.el.title !== tab.title) {
      entry.el.title = tab.title;
    }
  }

  function refreshFrame(tab) {
    const entry = frames.get(tab.id);
    if (!entry) {
      return;
    }
    if (entry.revision !== tab.revision) {
      loadFrame(entry.el, tab);
      entry.revision = tab.revision;
    }
    if (entry.el.title !== tab.title) {
      entry.el.title = tab.title;
    }
  }

  /**
   * `allow` only applies to the next navigation, so it has to be set before src. A frame that has
   * loaded already reloads in place: changing src would add a history entry, and Back would then
   * step the frame through old revisions instead of going to the previous tab.
   */
  function loadFrame(el, tab) {
    delete el.dataset.loaded;
    el.allow = tab.embedUrl ? EMBED_ALLOW : "";
    const url = viewUrl(tab);
    if (el.dataset.src && el.contentWindow) {
      try {
        el.contentWindow.location.replace(url);
        el.dataset.src = url;
        return;
      } catch {
        // Fall back to src below.
      }
    }
    el.dataset.src = url;
    el.src = url;
  }

  function discardFrame(id) {
    const entry = frames.get(id);
    if (!entry) {
      return;
    }
    entry.el.remove();
    frames.delete(id);
  }

  /** The active tab, plus any split beside it and a peek over it; views.js decides where each frame sits. */
  function renderFrames() {
    const tab = activeTab();
    emptyEl.hidden = Boolean(tab);
    document.title = tab ? tab.title + " · Scribe" : "Scribe";
    views.layout();
  }

  /** Clear the unread blips of a page that is on screen in a peek or split. */
  function markSeen(id) {
    unread.delete(id);
    unreadLibrary.delete(id);
  }

  function linkMode() {
    const mode = localStorage.getItem(LINK_MODE_KEY);
    return LINK_MODES.some((item) => item.id === mode) ? mode : "tab";
  }

  function renderLinkModes() {
    const current = linkMode();
    linkModeTrack.replaceChildren();
    for (const item of LINK_MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.name;
      btn.setAttribute("aria-pressed", String(item.id === current));
      btn.addEventListener("click", () => {
        localStorage.setItem(LINK_MODE_KEY, item.id);
        renderLinkModes();
      });
      linkModeTrack.appendChild(btn);
    }
  }

  function render() {
    renderFrames();
    renderChrome();
    renderTabs();
    library.render();
    renderTemplates();
    dispatchEvent(new CustomEvent("scribe:render"));
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
    if (fromUser) {
      views.onSelect(id);
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

  /** Closing keeps the page in the Library; `permanent` deletes it (Ctrl+Z or the notice undoes it). */
  async function closeTab(id, { permanent = false } = {}) {
    const tab = findAnyTab(id);
    if (tab?.key === "scribe:welcome" || !permanent) {
      await fetch(`/api/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    }
    const res = await fetch(`/api/tabs/${encodeURIComponent(id)}?permanent=true`, { method: "DELETE" });
    if (res.ok) {
      showNotice(`Deleted “${tab?.title || "page"}”`, { undo: true });
    }
  }

  /** Gives a Library page a tab (or focuses it). `before` places it in the strip; null means the end of its group. */
  async function openPage(id, { activate = true, before } = {}) {
    unreadLibrary.delete(id);
    if (activate) {
      pendingFocus = { id };
    }
    const body = { activate };
    if (before !== undefined) {
      body.before = before;
    }
    const res = await fetch(`/api/tabs/${encodeURIComponent(id)}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      if (pendingFocus?.id === id) {
        pendingFocus = null;
      }
      return;
    }
    if (activate && pendingFocus?.id === id && state.tabs.some((tab) => tab.id === id)) {
      pendingFocus = null;
      selectTab(id, { fromUser: true });
    }
    renderChrome();
    library.render();
  }

  function findAnyTab(id) {
    return state.tabs.find((tab) => tab.id === id) || state.closed.find((tab) => tab.id === id) || null;
  }

  function describeForCard(el) {
    if (el.dataset.kind === "template-update") {
      return { title: UPDATE_TITLE, description: UPDATE_NOTE, note: true };
    }
    if (el.dataset.kind === "template") {
      const template = findTemplateMeta(el.dataset.id);
      return template
        ? {
            title: template.title,
            id: template.id,
            description: template.description || "",
            createdAt: template.createdAt,
            updatedAt: template.updatedAt,
          }
        : null;
    }
    const tab = findAnyTab(el.dataset.id);
    if (!tab) {
      return null;
    }
    return {
      title: tab.title,
      id: tab.key,
      createdAt: tab.createdAt,
      updatedAt: Math.max(tab.updatedAt || 0, tab.stateUpdatedAt || 0),
      folder: tab.folderId ? library.pathOf(tab.folderId) : "",
    };
  }

  function choose(message, buttons) {
    choiceMessage.textContent = message;
    choiceActions.replaceChildren();
    const cancel = document.createElement("button");
    cancel.type = "submit";
    cancel.value = "cancel";
    cancel.textContent = "Cancel";
    choiceActions.appendChild(cancel);
    for (const item of buttons) {
      const btn = document.createElement("button");
      btn.type = "submit";
      btn.value = item.value;
      btn.textContent = item.label;
      if (item.danger) {
        btn.className = "danger";
      }
      choiceActions.appendChild(btn);
    }
    choiceDlg.returnValue = "cancel";
    choiceDlg.showModal();
    cancel.focus();
    return new Promise((resolve) => {
      choiceDlg.addEventListener(
        "close",
        () => resolve(choiceDlg.returnValue && choiceDlg.returnValue !== "cancel" ? choiceDlg.returnValue : null),
        { once: true }
      );
    });
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

  /** Copies the key ("scribe:…"), not the id: keys survive export and import, and agents recognize them when pasted. */
  async function copyTabKey(id) {
    const key = findAnyTab(id)?.key;
    if (!key) {
      return;
    }
    try {
      await navigator.clipboard.writeText(key);
      showNotice(`Copied ${key}`);
    } catch {
      showNotice("Could not copy to clipboard");
    }
  }

  async function openWelcome() {
    const html = await fetch("/welcome.html").then((res) => res.text());
    pendingFocus = { key: "scribe:welcome" };
    const res = await fetch("/api/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "scribe:welcome",
        title: "Welcome",
        html,
        activate: true,
      }),
    });
    if (!res.ok) {
      if (pendingFocus?.key === "scribe:welcome") {
        pendingFocus = null;
      }
      return;
    }
    const data = await res.json();
    const id = data?.tab?.id;
    if (id && pendingFocus?.key === "scribe:welcome" && state.tabs.some((tab) => tab.id === id)) {
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

  function importNotice(opened, closed, templates) {
    const parts = [];
    if (opened) {
      parts.push(opened === 1 ? "1 open tab" : `${opened} open tabs`);
    }
    if (closed) {
      parts.push(closed === 1 ? "1 page into the Library" : `${closed} pages into the Library`);
    }
    if (templates) {
      parts.push(templates === 1 ? "1 template" : `${templates} templates`);
    }
    const last = parts.pop();
    return "Imported " + (parts.length ? `${parts.join(", ")} and ${last}` : last);
  }

  /** `action` swaps the Undo button for another one, e.g. { label: "Restore", run }. */
  function showNotice(text, { undo = false, action = null } = {}) {
    noticeText.textContent = text;
    noticeAction = action;
    noticeUndo.textContent = action ? action.label : "Undo";
    noticeUndo.hidden = !undo && !action;
    noticeEl.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(
      () => {
        noticeEl.hidden = true;
      },
      undo || action ? 7000 : 4000
    );
  }

  /** A page nearing its asset storage limit. Once per page per 10 minutes; the page sees it on every save. */
  const assetWarnedAt = new Map();
  function warnPageAssets(msg) {
    const now = Date.now();
    if (!msg.usage || now - (assetWarnedAt.get(msg.id) || 0) < 10 * 60 * 1000) {
      return;
    }
    assetWarnedAt.set(msg.id, now);
    showNotice(`“${msg.title || "Page"}” is nearly out of asset storage: ${msg.usage.warning}.`);
  }

  function showVersionMismatch(version) {
    const banner = document.getElementById("version-banner");
    banner.hidden = version === BOARD_VERSION;
    document.getElementById("version-banner-detail").textContent =
      `Daemon: ${version || "1.9.0 or older"}. This page: ${BOARD_VERSION}.`;
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
    let closed = 0;
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
        closed += data.closed || 0;
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
    if (opened || closed || templates) {
      showNotice(importNotice(opened, closed, templates));
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

  async function undoClose() {
    const res = await fetch("/api/undo", { method: "POST" });
    if (!res.ok) {
      return;
    }
    noticeEl.hidden = true;
    const data = await res.json();
    if (data?.tab && !data.tab.closedAt) {
      focusWhenOpened(data.tab.id);
    }
  }

  /** The HTTP reply and the WebSocket upsert race; select now if the tab already arrived, else when it does. */
  function focusWhenOpened(id) {
    if (state.tabs.some((tab) => tab.id === id)) {
      pendingFocus = null;
      selectTab(id, { fromUser: true });
      return;
    }
    pendingFocus = { id };
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

  /** Shortcuts the desktop app catches natively, so they also work while an embedded site has focus. */
  function runShortcut(action) {
    if (confirmDlg.open || choiceDlg.open || cleanupDlg.open) {
      return;
    }
    if (action === "palette") {
      togglePalette();
    } else if (action === "download") {
      downloadActive();
    } else if (action === "help") {
      openWelcome();
    } else if (action === "next-tab" || action === "prev-tab") {
      cycleTab(action === "next-tab" ? 1 : -1);
    } else if (action === "close-tab") {
      if (views.closePeek()) {
        return;
      }
      const tab = activeTab();
      if (tab) {
        closeTab(tab.id);
      }
    } else if (action === "reopen") {
      undoClose();
    } else if (action.startsWith("agent-")) {
      window.scribeChat?.shortcut(action.slice("agent-".length));
    }
  }

  function cycleTab(step) {
    const count = state.tabs.length;
    if (count === 0) {
      return;
    }
    const at = state.tabs.findIndex((tab) => tab.id === state.activeId);
    const next = at < 0 ? state.tabs[step > 0 ? 0 : count - 1] : state.tabs[(at + step + count) % count];
    selectTab(next.id, { fromUser: true });
  }

  function onBoardShortcut(event) {
    if (confirmDlg.open || choiceDlg.open || cleanupDlg.open) {
      return;
    }
    if (event.key === "Escape") {
      if (window.scribeChat?.escape()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (library.onEscape()) {
        event.preventDefault();
        event.stopPropagation();
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
      if (views.escape()) {
        event.preventDefault();
        return;
      }
      if (state.sideOpen && state.trashOpen) {
        event.preventDefault();
        closeTrash();
        return;
      }
      if (state.sideOpen && library.searchFocused()) {
        event.preventDefault();
        library.clearSearch();
        return;
      }
      if (state.sideOpen) {
        event.preventDefault();
        setSideOpen(false);
      }
      return;
    }
    if (isFindKey(event) && libraryShown() && !isTypingTarget(event.target)) {
      event.preventDefault();
      library.focusSearch();
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
    const id = frameIdByWindow(win);
    return id ? frames.get(id) : null;
  }

  function frameIdByWindow(win) {
    for (const [id, entry] of frames) {
      if (entry.el.contentWindow === win) {
        return id;
      }
    }
    return null;
  }

  /**
   * board.agent from a page: threads of that page only, as found from the frame that asked (not from
   * anything the page says). Starting or sending needs the click or key press to have reached the
   * board too: a page's own activation also activates the board, so a script cannot fake it.
   */
  function onPageAgent(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    const frameId = frameIdByWindow(event.source);
    const tab = frameId ? findAnyTab(frameId) : null;
    if (!tab || tab.embedUrl) {
      reply({ ok: false, error: "not_a_page" });
      return;
    }
    const chat = window.scribeChat;
    if (!chat?.pageRequest) {
      reply({ ok: false, error: "no_agent" });
      return;
    }
    if ((data.op === "start" || data.op === "send") && navigator.userActivation && !navigator.userActivation.isActive) {
      reply({ ok: false, error: "no_gesture" });
      return;
    }
    chat.pageRequest(tab, data).then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
  }

  /** A link clicked inside a page: open it and tell the page how it went. */
  function onPageLink(event) {
    const data = event.data;
    const frameId = frameIdByWindow(event.source);
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    if (data.type === "scribe-resolve") {
      reply({ ok: true, pages: views.resolve(data.targets) });
      return;
    }
    const mode = ["tab", "peek", "split"].includes(data.mode) ? data.mode : null;
    lastInteractedAt = Date.now();
    views
      .open(data.target, mode, {
        source: { role: views.roleOf(frameId), id: frameId },
        anchor: typeof data.anchor === "string" ? data.anchor : "",
        background: data.background === true,
      })
      .then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
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
    const recentClosed = [...state.closed].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 15);
    paletteHits = [
      ...state.tabs.map((tab) => ({ ...tab, open: true })),
      ...recentClosed.map((tab) => ({ ...tab, open: false })),
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
        activatePaletteHit(tab, views.modeFromEvent(event));
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
      if (!tab.open) {
        chips.appendChild(paletteChip("Closed"));
      }
      const folder = tab.folderId ? library.pathOf(tab.folderId) : "";
      if (folder) {
        chips.appendChild(paletteChip(folder, "folder"));
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

  /** Enter or a click navigates; Ctrl also navigates, Shift splits, Alt peeks. */
  function activatePaletteHit(tab, mode = null) {
    if (!tab) {
      return;
    }
    closePalette();
    if (mode === "peek" || mode === "split") {
      views.open(tab.id, mode);
      return;
    }
    if (!state.tabs.some((item) => item.id === tab.id)) {
      openPage(tab.id);
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
  window.scribeShortcut = runShortcut;
  /** What the agent chat (agent.js) needs from the shell. */
  window.scribeApp = {
    activeTab,
    findAnyTab,
    tabs: () => state.tabs,
    closed: () => state.closed,
    folders: () => state.folders,
    connected: () => state.connected,
    openLink: (target, event, { anchor = "" } = {}) => views.open(target, views.modeFromEvent(event), { anchor }),
    resolvePages: (targets) => views.resolve(targets),
    showNotice,
    closeSettings,
    /** Tell a page's frame (when it has one) about something, e.g. one of its agent threads changing. */
    postToPage: (id, message) => {
      frames.get(id)?.el.contentWindow?.postMessage({ ...message, id }, contentOrigin());
    },
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== contentOrigin() || !frameByWindow(event.source)) {
      return;
    }
    if (event.data?.type === "scribe-download") {
      downloadActive();
    } else if (event.data?.type === "scribe-undo") {
      undoClose();
    } else if (event.data?.type === "scribe-help") {
      openWelcome();
    } else if (event.data?.type === "scribe-palette") {
      togglePalette();
    } else if (event.data?.type === "scribe-activity") {
      noteEdit();
    } else if (event.data?.type === "scribe-open" || event.data?.type === "scribe-resolve") {
      onPageLink(event);
    } else if (event.data?.type === "scribe-escape") {
      if (!window.scribeChat?.escape()) {
        views.escape();
      }
    } else if (event.data?.type === "scribe-agent") {
      onPageAgent(event);
    } else if (event.data?.type === "scribe-chat-key") {
      window.scribeChat?.shortcut(String(event.data.action || ""));
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
  noticeUndo.addEventListener("click", () => {
    const action = noticeAction;
    if (action) {
      noticeEl.hidden = true;
      noticeAction = null;
      action.run();
      return;
    }
    undoClose();
  });
  bindFileDrop(settingsEl, "meta");
  bindFileDrop(tabsWrap, "meta");
  bindFileDrop(sidePane, "closed");
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
  smoothScrollToggle.addEventListener("click", () => toggleFlag(smoothScrollToggle, SMOOTH_SCROLL_KEY));
  tightSmallToggle.addEventListener("click", () => toggleFlag(tightSmallToggle, TIGHT_SMALL_KEY));
  clearBtn.addEventListener("click", async () => {
    await fetch("/api/tabs?filter=unpinned", { method: "DELETE" });
  });
  libraryToggle.addEventListener("click", () => setSideOpen(!state.sideOpen));
  sidebarTabLibrary.addEventListener("click", () => setSidebarTab("library"));
  sidebarTabTemplates.addEventListener("click", () => setSidebarTab("templates"));
  builtinHead.addEventListener("click", toggleBuiltinGroup);
  trashBack.addEventListener("click", () => {
    closeTrash();
    document.getElementById("library-more")?.focus({ preventScroll: true });
  });
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
      activatePaletteHit(paletteHits[paletteIndex], views.modeFromEvent(event));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    }
  });

  sideResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidePane.getBoundingClientRect().width;
    sideResizer.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-side");

    function onMove(move) {
      if (move.pointerId !== event.pointerId) {
        return;
      }
      applySideWidth(startWidth - (move.clientX - startX));
    }
    function onUp(up) {
      if (up.pointerId !== event.pointerId) {
        return;
      }
      sideResizer.removeEventListener("pointermove", onMove);
      sideResizer.removeEventListener("pointerup", onUp);
      sideResizer.removeEventListener("pointercancel", onUp);
      if (sideResizer.hasPointerCapture(event.pointerId)) {
        sideResizer.releasePointerCapture(event.pointerId);
      }
      document.body.classList.remove("resizing-side");
    }
    sideResizer.addEventListener("pointermove", onMove);
    sideResizer.addEventListener("pointerup", onUp);
    sideResizer.addEventListener("pointercancel", onUp);
  });

  window.addEventListener("popstate", onHistoryStep);

  window.addEventListener("hashchange", () => {
    // Steps onto the board's own entries were handled by popstate.
    if (typeof history.state?.boardIndex === "number") {
      return;
    }
    const id = location.hash.replace(/^#/, "");
    if (!id) {
      return;
    }
    const open = state.tabs.find((item) => item.id === id || item.key === id);
    if (open && open.id !== state.activeId) {
      selectTab(open.id, { fromUser: true });
      return;
    }
    const closed = state.closed.find((item) => item.id === id || item.key === id);
    if (closed) {
      openPage(closed.id);
    }
  });

  setSideOpen(state.sideOpen);
  connect();
  render();
})();
