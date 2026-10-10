(() => {
  const tabsEl = document.getElementById("tabs");
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
  const paletteEl = document.getElementById("palette");
  const paletteBackdrop = document.getElementById("palette-backdrop");
  const paletteInput = document.getElementById("palette-input");
  const paletteList = document.getElementById("palette-list");
  const paletteEmpty = document.getElementById("palette-empty");
  const paletteEnterHint = document.getElementById("palette-enter-hint");
  const palettePrefixHint = document.getElementById("palette-prefix-hint");
  const palettePrefixListEl = document.getElementById("palette-prefix-list");
  const settingsEl = document.getElementById("settings");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  const settingsToggle = document.getElementById("settings-toggle");
  const themeList = document.getElementById("theme-list");
  const smoothScrollToggle = document.getElementById("smooth-scroll");
  const showClearToggle = document.getElementById("show-clear");
  const tightSmallToggle = document.getElementById("tight-small");
  const uiFxToggle = document.getElementById("ui-fx");
  const auroraEdgeToggle = document.getElementById("aurora-edge");
  const auroraIdleToggle = document.getElementById("aurora-idle");
  const chromeFxTrack = document.getElementById("chrome-fx");
  const chromeFxWhenTrack = document.getElementById("chrome-fx-when");
  const agentSideTrack = document.getElementById("agent-side");
  const librarySideTrack = document.getElementById("library-side");
  const agentSideLabel = document.getElementById("agent-side-label");
  const librarySideLabel = document.getElementById("library-side-label");
  const importPageBtn = document.getElementById("import-page");
  const exportPageBtn = document.getElementById("export-page");
  const exportAllBtn = document.getElementById("export-all");
  const importFileInput = document.getElementById("import-file");
  const noticeEl = document.getElementById("notice");
  const noticeText = document.getElementById("notice-text");
  const noticeUndo = document.getElementById("notice-undo");
  const persistBanner = document.getElementById("persist-banner");
  const persistBannerDetail = document.getElementById("persist-banner-detail");
  const newTabBtn = document.getElementById("new-tab");
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
  const BOARD_VERSION = "3.0.2";
  const BUILTIN_OPEN_KEY = "scribe.builtinTemplatesOpen";
  const TAB_CARD_DELAY = 450;
  const TEMPLATE_CARD_DELAY = 700;
  const TOGGLE_HOVER_OPEN_MS = 500;
  const THEME_KEY = "scribe.theme";
  const SMOOTH_SCROLL_KEY = "scribe.smoothScroll";
  /** Also read by the inline script in index.html so the first paint already hides Clear. */
  const SHOW_CLEAR_KEY = "scribe.showClear";
  /** What a page link without a mode or modifier does: "tab", "peek", or "split". */
  const LINK_MODE_KEY = "scribe.linkMode";
  const VIEWER_ID_KEY = "scribe.viewerId";
  const LINK_MODES = [
    { id: "tab", name: "Navigate" },
    { id: "peek", name: "Peek" },
    { id: "split", name: "Split" },
  ];
  /** Keep in sync with src/palettePrefixes.ts. Add a row when a new prefix ships. */
  const PALETTE_PREFIX_KEY = "scribe.palettePrefixes";
  const PALETTE_PREFIXES = [
    { id: "threads", label: "Threads", default: "=" },
    { id: "ai", label: "Ask AI", default: "?" },
    { id: "semantic", label: "By meaning", default: "~" },
  ];
  const PREFIX_MAX = 8;
  /** Answered `?` questions (#245), newest first, so asking again costs nothing. */
  const AI_RECENT_KEY = "scribe.aiSearchRecent";
  const AI_RECENT_MAX = 8;
  /** Shorter queries get no "Related" rows: a letter or two says too little to match by meaning. */
  const SEMANTIC_MIN_QUERY = 3;
  /** Also read by the inline script in index.html so the first paint already has the right spacing. */
  const TIGHT_SMALL_KEY = "scribe.tightSmall";
  const UI_FX_KEY = "scribe.uiEffects";
  /** Also read by aurora.js, which draws the title bar edge. */
  const AURORA_EDGE_KEY = "scribe.auroraEdge";
  const AURORA_IDLE_KEY = "scribe.auroraIdle";
  /** Also read by newpage.js, which draws them. Stored as the chosen ids, comma-separated; nothing stored means all. */
  const NEWPAGE_BG_KEY = "scribe.newPageBackgrounds";
  const NEWPAGE_PROVIDER_KEY = "scribe.newPageProviderColors";
  const newPageProviderToggle = document.getElementById("newpage-provider-colors");
  const NEWPAGE_BGS = [
    { id: "nebula", name: "Nebula" },
    { id: "stardust", name: "Stardust" },
    { id: "aurora", name: "Aurora curtains" },
    { id: "caustics", name: "Caustics" },
    { id: "contours", name: "Contour map" },
    { id: "halftone", name: "Halftone" },
    { id: "bokeh", name: "Bokeh" },
  ];
  /** Also read by chromefx.js, which draws the title bar background. The first entry is the default. */
  const CHROME_FX_KEY = "scribe.chromeFx";
  const CHROME_FX_WHEN_KEY = "scribe.chromeFxWhen";
  const CHROME_FX_STYLES = [
    { id: "wash", name: "Aurora" },
    { id: "motes", name: "Motes" },
    { id: "rise", name: "Rising motes" },
    { id: "off", name: "Off" },
  ];
  const CHROME_FX_WHEN = [
    { id: "idle-still", name: "While working" },
    { id: "always", name: "Always" },
    { id: "busy", name: "Hidden when idle" },
  ];
  /** Also read by the inline script in index.html so the first paint already places the panes. */
  const AGENT_SIDE_KEY = "scribe.agentSide";
  const LIBRARY_SIDE_KEY = "scribe.librarySide";
  const PANE_SIDES = [
    { id: "left", name: "Left" },
    { id: "right", name: "Right" },
  ];
  const DEFAULT_THEME = "neutral";
  const THEMES = [
    { id: "neutral", name: "Neutral", swatch: "#c9c9d0", icon: "./favicon.svg?v=4" },
    { id: "ember", name: "Ember", swatch: "#d0a578", icon: "./favicon-ember.svg?v=4" },
    { id: "spectrum", name: "Spectrum", swatch: "#9db8a4", icon: "./favicon-spectrum.svg?v=4" },
    { id: "garnet", name: "Garnet", swatch: "#d56f6c", icon: "./favicon-garnet.svg?v=5" },
    { id: "dusk", name: "Dusk", swatch: "#b7a2dc", icon: "./favicon-dusk.svg?v=5" },
    { id: "cream", name: "Cream", swatch: "#f3ede1", icon: "./favicon-cream.svg?v=5" },
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
  const FOLDER_INSTRUCTIONS_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 2.5h7.2L13 5.3V13.5H3z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.2 8h5.6M5.2 10.2h3.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const FOLDER_INSTRUCTIONS_TITLE = "Folder instructions for the agent";
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
    /** This window's New page while it is not a page yet: active, but with no tab in the strip. */
    draft: null,
    /** The tab that was in front when the draft opened, to go back to when it is closed. */
    draftFrom: null,
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
  /** "pages" or a prefix id from PALETTE_PREFIXES. */
  let paletteKind = "pages";
  /** Search by meaning (#372): the pack's state from /api/search/status, read when the palette opens. Null until known. */
  let semanticStatus = null;
  let semanticStatusReq = null;
  let relatedTimer = 0;
  /** "indexing 40 of 116 pages" while the index is building, else "". */
  let semanticProgress = "";
  /** The image pasted or dropped into the palette as the query: { url } of its preview. */
  let paletteImage = null;
  /** @type {Array<any>} */
  let paletteHits = [];
  let paletteIndex = 0;
  /** The palette's `?` question: { query, status: "busy" | "done" | "error", hits?, model?, ms?, error?, abort? }. */
  let aiAsk = null;
  /** The model the last answer came from, named on the Ask row. */
  let aiModel = "";
  /** The `?` query last shown, so a new one selects the Ask row again. */
  let aiShownQuery = null;
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

  const hoverCard = window.createHoverCard({
    describe: describeForCard,
    openThread: (id) => window.scribeChat?.openThread?.(id),
  });
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
    setFolderInstructions,
    managePermissions: (id) => window.scribePermissions?.manage(id),
    copyTabKey,
    downloadExport,
    downloadFolderExport: (id) => downloadHref(`/api/export/folder/${encodeURIComponent(id)}`),
    downloadAll: () => downloadExport(),
    showNotice,
    choose,
    confirm: (message, confirmLabel) => confirmDelete(message, confirmLabel),
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
    canSplit: (id) => {
      if (!state.activeId) return false;
      if (state.activeId !== id) return true;
      const idx = state.tabs.findIndex((tab) => tab.id === id);
      return Boolean((idx >= 0 ? state.tabs[idx + 1] ?? state.tabs[idx - 1] : null)?.id);
    },
    hoverCard,
    stripSlot,
    clearStripSlot,
    openThread: (id) => window.scribeChat?.openThread?.(id),
    pageStatus: (id) => window.scribeChat?.pageStatus?.(id) || null,
    icons: { file: FILE_SVG, pin: PIN_SVG, agentHidden: AGENT_HIDDEN_SVG, agentHiddenTitle: AGENT_HIDDEN_TITLE, folderInstructions: FOLDER_INSTRUCTIONS_SVG, folderInstructionsTitle: FOLDER_INSTRUCTIONS_TITLE },
  });
  const views = window.createViews({
    mainEl,
    contentOrigin,
    tabs: () => state.tabs,
    closed: () => state.closed,
    findAnyTab,
    activeId: () => state.activeId,
    spaceId: () => spaces.activeId() || "default",
    spaceIds: () => spaces.ids().length ? spaces.ids() : ["default"],
    // A blank page has no frame: the New page screen stands in for it.
    activeTab: () => (isBlank(activeTab()) ? null : activeTab()),
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
  const spaces = window.createSpaces({
    chipSlot: settingsToggle,
    findAnyTab,
    folderPath: (id) => library.pathOf(id),
    showNotice,
    beforeOpen: () => {
      closePalette();
      closeSettings();
      library.closeMenu();
      hoverCard.hide?.();
    },
  });
  const newPageView = window.createNewPage({
    templates: () => state.templates,
    builtins: () => state.builtinTemplates,
    pick: fillFromTemplate,
    threads: (id) => window.scribeChat?.pageThreads?.(id) || 0,
    working: (id) => window.scribeChat?.pageStatus?.(id) || null,
    openChat: () => window.scribeChat?.shortcut("dock"),
    provider: () => window.scribeChat?.dockProvider?.(),
  });
  const trash = window.createTrash({
    showNotice,
    confirm: (message, confirmLabel) => confirmDelete(message, confirmLabel),
    openMenu: library.openMenu,
    closeMenu: library.closeMenu,
    icons: { file: FILE_SVG, ...library.icons },
  });

  applySideWidth(Number(localStorage.getItem(SIDE_WIDTH_KEY)) || 280);
  applyTheme(loadTheme());
  applyFlag(smoothScrollToggle, SMOOTH_SCROLL_KEY, true);
  applyFlag(showClearToggle, SHOW_CLEAR_KEY, true);
  applyFlag(tightSmallToggle, TIGHT_SMALL_KEY, true);
  document.documentElement.classList.toggle("hide-clear", !flagOn(showClearToggle));
  document.documentElement.classList.toggle("tight-small", flagOn(tightSmallToggle));
  applyFlag(uiFxToggle, UI_FX_KEY, true);
  document.documentElement.classList.toggle("no-ui-fx", !flagOn(uiFxToggle));
  applyFlag(auroraEdgeToggle, AURORA_EDGE_KEY, true);
  applyFlag(auroraIdleToggle, AURORA_IDLE_KEY, true);
  applyPaneSideAttr("agentSide", paneSide(AGENT_SIDE_KEY));
  applyPaneSideAttr("librarySide", paneSide(LIBRARY_SIDE_KEY));
  renderThemeList();
  renderLinkModes();
  renderPaneSides();
  renderChromeFx();
  renderNewPageBgs();
  applyFlag(newPageProviderToggle, NEWPAGE_PROVIDER_KEY, true);
  renderPalettePrefixSettings();
  bindSettingHint(agentSideLabel, "When both panes are on the same side, this one sits next to the page.");
  bindSettingHint(
    document.getElementById("ui-fx-label"),
    "Shader motion on controls like the floating chat orb whenever it is visible. Off, they hold a still frame. The New page background still moves."
  );
  bindSettingHint(
    document.getElementById("newpage-bgs-label"),
    "Each new blank page shows one of the backgrounds turned on here. They take turns in random order, so each comes up equally often."
  );
  bindSettingHint(
    document.getElementById("newpage-provider-colors-label"),
    "Use the selected floating chat provider's shape colours for the New page background, including your custom palette. Off restores the default background colours."
  );
  bindSettingHint(
    document.getElementById("chrome-fx-label"),
    "A faint moving texture behind the tabs, in the theme's colours. It gets livelier while any agent chat runs."
  );
  bindSettingHint(
    document.getElementById("chrome-fx-when-label"),
    "While working: a still frame when idle, moving while an agent chat runs. Always: it also drifts slowly when idle, which keeps the GPU drawing. Hidden when idle: a plain bar until an agent chat runs. It pauses while the window is in the background."
  );
  bindSettingHint(
    document.getElementById("aurora-edge-label"),
    "A thin glow in the theme's colours drifts along the bottom of the title bar while any agent chat runs, and fades out when they're done. It pauses while the window is in the background."
  );
  bindSettingHint(
    document.getElementById("aurora-idle-label"),
    "A faint, still line in the theme's colours under the title bar when no agent is working. It doesn't move, so it costs nothing."
  );
  bindSettingHint(librarySideLabel, "When both panes are on the same side, this one sits at the window edge.");

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
      spaces.apply(msg.spaces);
      views.prune();
      // After a space switch the address still names the old space's tab: don't reopen it here.
      const hash = msg.reset ? "" : location.hash.replace(/^#/, "");
      const fromOpen = hash ? state.tabs.find((tab) => tab.id === hash || tab.key === hash) : null;
      const fromClosed = hash ? state.closed.find((tab) => tab.id === hash || tab.key === hash) : null;
      if (state.draft && findAnyTab(state.draft.id)) {
        state.draft = null;
      }
      const keepDraft = !msg.reset && draftActive() && !fromOpen && !fromClosed;
      state.activeId = fromOpen ? fromOpen.id : keepDraft ? state.draft.id : msg.activeId;
      if (keepDraft) {
        // After a daemon restart the draft is gone there; bring it back under the same id.
        fetch("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: state.draft.id }) }).catch(() => undefined);
      }
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
    if (msg.type === "spaces") {
      spaces.apply(msg.spaces);
      views.prune();
      render();
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
      if (state.draft?.id === msg.tab.id) {
        state.draft = null;
        state.draftFrom = null;
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
      if (msg.thread) {
        window.scribeChat?.followThread?.(msg.thread, msg.id);
      }
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
    const wasOpen = state.tabs.some((item) => item.id === tab.id);
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
      // New Library-only page (agent background create). Closing an open tab is not unread.
      if (!shown && !wasOpen && structural !== false) {
        unreadLibrary.add(tab.id);
      }
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
    return state.tabs.find((tab) => tab.id === state.activeId) || (state.draft?.id === state.activeId ? state.draft : null);
  }

  /** A New page, as a draft or a saved page that nothing has filled yet. */
  function isBlank(tab) {
    return Boolean(tab && (tab.draft || tab.blank));
  }

  function draftActive() {
    return Boolean(state.draft && state.activeId === state.draft.id);
  }

  /** Ctrl+T: a New page in front, with no tab until a thread or a template makes it a page. */
  async function newPage() {
    if (draftActive()) {
      newPageView.focus();
      return;
    }
    const res = await fetch("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (!data?.tab) {
      showNotice("Could not open a new page");
      return;
    }
    const from = draftActive() ? state.draftFrom : state.activeId;
    state.draft = data.tab;
    state.draftFrom = from;
    state.activeId = data.tab.id;
    pendingFocus = null;
    lastInteractedAt = Date.now();
    syncHash();
    render();
    reportViewer();
    newPageView.focus();
  }

  /**
   * Leaving a draft throws it away. The request waits a moment: a chat that keeps its unsent text
   * as a thread when you leave makes the draft a page, and that has to reach the daemon first.
   */
  function dropLeftDraft() {
    if (!state.draft || state.activeId === state.draft.id) {
      return;
    }
    const id = state.draft.id;
    state.draft = null;
    state.draftFrom = null;
    setTimeout(() => {
      fetch(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    }, 3000);
  }

  function closeDraft() {
    const back = state.tabs.some((tab) => tab.id === state.draftFrom) ? state.draftFrom : state.tabs[state.tabs.length - 1]?.id ?? null;
    state.activeId = back;
    syncHash();
    render();
    reportViewer();
  }

  /** A template picked on the New page screen fills this page; one with fields asks for them first. */
  function fillFromTemplate(template) {
    const tab = activeTab();
    if (!isBlank(tab)) {
      return;
    }
    if (template.fields?.length) {
      openTemplateModal(template, "fill", null, tab.id);
      return;
    }
    void openTemplate(template, {}, { into: tab.id }).then((error) => error && showNotice(error));
  }

  /** POST a template open; resolves to an error message, or null when it went through. */
  async function openTemplate(template, values, extra) {
    const res = await fetch(`/api/templates/${encodeURIComponent(template.id)}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, ...extra }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      return data.error || "Could not apply template";
    }
    if (!extra.into && data.tab?.id) {
      pendingFocus = { id: data.tab.id, key: data.tab.key };
    }
    if (data.copiedBuiltin) {
      showNotice(`Added “${template.title}” to your templates`);
    }
    return null;
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

  function paneSide(key) {
    return localStorage.getItem(key) === "left" ? "left" : "right";
  }

  function applyPaneSideAttr(attr, side) {
    if (side === "left") {
      document.documentElement.dataset[attr] = "left";
    } else {
      delete document.documentElement.dataset[attr];
    }
  }

  function setPaneSide(attr, key, side) {
    const value = side === "left" ? "left" : "right";
    localStorage.setItem(key, value);
    applyPaneSideAttr(attr, value);
  }

  function renderPaneSide(track, attr, key) {
    if (!track) {
      return;
    }
    const current = paneSide(key);
    track.replaceChildren();
    for (const item of PANE_SIDES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.name;
      btn.setAttribute("aria-pressed", String(item.id === current));
      btn.addEventListener("click", () => {
        setPaneSide(attr, key, item.id);
        renderPaneSide(track, attr, key);
      });
      track.appendChild(btn);
    }
  }

  function renderPaneSides() {
    renderPaneSide(agentSideTrack, "agentSide", AGENT_SIDE_KEY);
    renderPaneSide(librarySideTrack, "librarySide", LIBRARY_SIDE_KEY);
  }

  /** A track of exclusive choices kept in localStorage; the first option is the default. */
  function renderChoiceTrack(track, options, key, event) {
    if (!track) {
      return;
    }
    const stored = localStorage.getItem(key);
    const current = options.some((item) => item.id === stored) ? stored : options[0].id;
    track.replaceChildren();
    for (const item of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.name;
      btn.setAttribute("aria-pressed", String(item.id === current));
      btn.addEventListener("click", () => {
        localStorage.setItem(key, item.id);
        renderChoiceTrack(track, options, key, event);
        window.dispatchEvent(new Event(event));
      });
      track.appendChild(btn);
    }
  }

  /** A track where any number of options can be on, but never none. */
  function renderNewPageBgs() {
    const track = document.getElementById("newpage-bgs");
    const stored = (localStorage.getItem(NEWPAGE_BG_KEY) || "").split(",");
    let on = NEWPAGE_BGS.map((item) => item.id).filter((id) => stored.includes(id));
    if (!on.length) on = NEWPAGE_BGS.map((item) => item.id);
    track.replaceChildren();
    for (const item of NEWPAGE_BGS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.name;
      btn.setAttribute("aria-pressed", String(on.includes(item.id)));
      btn.addEventListener("click", () => {
        const next = on.includes(item.id) ? on.filter((id) => id !== item.id) : [...on, item.id];
        if (!next.length) return;
        localStorage.setItem(NEWPAGE_BG_KEY, next.join(","));
        renderNewPageBgs();
        window.dispatchEvent(new Event("scribe:newpage-bg"));
      });
      track.appendChild(btn);
    }
  }

  function renderChromeFx() {
    renderChoiceTrack(chromeFxTrack, CHROME_FX_STYLES, CHROME_FX_KEY, "scribe:chrome-fx");
    renderChoiceTrack(chromeFxWhenTrack, CHROME_FX_WHEN, CHROME_FX_WHEN_KEY, "scribe:chrome-fx");
  }

  function bindSettingHint(el, description) {
    if (!el) {
      return;
    }
    el.dataset.hint = description;
    el.setAttribute("aria-description", description);
    hoverCard.bind(el, 700);
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
    if (el === showClearToggle) {
      document.documentElement.classList.toggle("hide-clear", !on);
    }
    if (el === tightSmallToggle) {
      document.documentElement.classList.toggle("tight-small", on);
    }
    if (el === uiFxToggle) {
      document.documentElement.classList.toggle("no-ui-fx", !on);
      window.dispatchEvent(new Event("scribe:ui-fx"));
    }
    if (el === auroraEdgeToggle || el === auroraIdleToggle) {
      window.dispatchEvent(new Event("scribe:aurora"));
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

  let releaseSettingsTrap = null;
  const searchSwitch = document.getElementById("search-enabled");
  const searchPackStatus = document.getElementById("search-pack-status");
  function renderSearchSettings(result) {
    semanticStatus = result;
    searchPackStatus.textContent = result.message;
    document.getElementById("search-pack-folder").textContent = result.folder;
    searchSwitch.disabled = result.status !== "ready";
    searchSwitch.setAttribute("aria-checked", String(result.enabled));
  }
  async function searchSettingsRequest(endpoint, body) {
    const response = await fetch(`/api/search/${endpoint}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Cannot update search settings");
    return result;
  }
  searchSwitch.addEventListener("click", async () => {
    const enabled = searchSwitch.getAttribute("aria-checked") !== "true";
    searchSwitch.disabled = true;
    try { renderSearchSettings(await searchSettingsRequest("settings", { enabled })); }
    catch (err) { searchPackStatus.textContent = err.message; searchSwitch.disabled = false; }
  });
  document.getElementById("search-open-folder").addEventListener("click", async () => {
    try { await searchSettingsRequest("open-folder", {}); }
    catch (err) { searchPackStatus.textContent = err.message; }
  });
  function openSettings() {
    if (isPaletteOpen()) {
      closePalette();
    }
    settingsEl.hidden = false;
    searchSwitch.disabled = true;
    searchSettingsRequest("status").then(renderSearchSettings).catch(err => { searchPackStatus.textContent = err.message; });
    settingsToggle.setAttribute("aria-expanded", "true");
    releaseSettingsTrap?.();
    releaseSettingsTrap = window.scribeFocusTrap?.bind(document.getElementById("settings-panel"));
  }

  function closeSettings() {
    if (!isSettingsOpen()) {
      return;
    }
    releaseSettingsTrap?.();
    releaseSettingsTrap = null;
    settingsEl.hidden = true;
    settingsToggle.setAttribute("aria-expanded", "false");
    settingsToggle.focus({ preventScroll: true });
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
    exportPageBtn.disabled = !state.activeId || draftActive();
    newTabBtn.classList.toggle("on", draftActive());
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
    tabsEl.classList.toggle("fade-right", overflow && moreToTheRight);
    tabsEl.classList.toggle("fade-left", overflow && moreToTheLeft);
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
    let instr = el.querySelector(".tab-folder-instructions");
    if (tab.folderInstructions || (tab.title || "").trim().toLowerCase() === "instructions") {
      if (!instr) {
        instr = document.createElement("span");
        instr.className = "tab-folder-instructions";
        instr.setAttribute("aria-label", FOLDER_INSTRUCTIONS_TITLE);
        instr.innerHTML = FOLDER_INSTRUCTIONS_SVG;
        el.insertBefore(instr, el.querySelector(".tab-title"));
      }
    } else if (instr) {
      instr.remove();
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
    const active = activeTab();
    if (isBlank(active)) {
      newPageView.render(active);
    }
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
      hoverCard.bind(update, 240);
      line.appendChild(update);
    }
    if (builtin || template.builtinSource) {
      const version = document.createElement("span");
      version.className = "template-version";
      version.textContent = `v${template.stateVersion}`;
      version.dataset.tooltip = builtin ? "Built-in template version" : "Copied from a built-in template";
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
      close.setAttribute("aria-label", "Delete template");
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

  let releaseTemplateTrap = null;
  function isTemplateModalOpen() {
    return !templateModal.hidden;
  }

  /** mode: create (a new page), edit (the active page's values), or fill (the blank page `into`). */
  function openTemplateModal(template, mode, values, into) {
    templateModal.dataset.templateId = template.id;
    templateModal.dataset.mode = mode;
    if (into) {
      templateModal.dataset.into = into;
    } else {
      delete templateModal.dataset.into;
    }
    templateModalTitle.textContent = template.title;
    const desc = template.description || "";
    templateModalDesc.hidden = !desc;
    templateModalDesc.textContent = desc;
    templateModalError.hidden = true;
    templateModalError.textContent = "";
    templateModalSubmit.textContent = mode === "edit" ? "Apply" : mode === "fill" ? "Create" : "Open";
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
    releaseTemplateTrap?.();
    releaseTemplateTrap = window.scribeFocusTrap?.bind(templateModal.querySelector(".settings-panel"));
  }

  function closeTemplateModal() {
    if (templateModal.hidden) {
      return;
    }
    releaseTemplateTrap?.();
    releaseTemplateTrap = null;
    templateModal.hidden = true;
    delete templateModal.dataset.templateId;
    delete templateModal.dataset.mode;
    delete templateModal.dataset.into;
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
    if (!editing) {
      const into = mode === "fill" ? templateModal.dataset.into : undefined;
      const error = await openTemplate(template, values, { agentHidden, ...(into ? { into } : {}) });
      if (error) {
        templateModalError.textContent = error;
        templateModalError.hidden = false;
        return;
      }
      closeTemplateModal();
      return;
    }
    try {
      const res = await fetch(`/api/tabs/${encodeURIComponent(editing.id)}/template-values`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        templateModalError.textContent = data.error || "Could not apply template";
        templateModalError.hidden = false;
        return;
      }
      if (Boolean(editing.agentHidden) !== agentHidden) {
        await setAgentHidden(editing.id, agentHidden);
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
    const blank = isBlank(tab);
    mainEl.classList.toggle("blank-page", blank);
    views.layout();
    if (tab && !blank) newPageView.replace(tab, frames.get(tab.id)?.el);
    else newPageView.render(blank ? tab : null);
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

  /** Keep in sync with src/palettePrefixes.ts. */
  function normalizePrefix(raw, fallback) {
    const value = String(raw ?? "").trim();
    if (!value || value.length > PREFIX_MAX || /\s/.test(value)) {
      return fallback;
    }
    return value;
  }

  function palettePrefixList(storedJson) {
    let parsed = {};
    if (storedJson) {
      try {
        const value = JSON.parse(storedJson);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value;
        }
      } catch {
        parsed = {};
      }
    }
    return PALETTE_PREFIXES.map((def) => {
      const raw = parsed[def.id];
      return {
        ...def,
        prefix: normalizePrefix(typeof raw === "string" ? raw : "", def.default),
      };
    });
  }

  function serializePalettePrefixes(prefixes) {
    const out = {};
    for (const item of prefixes) {
      const value = normalizePrefix(item.prefix, item.default);
      if (value !== item.default) {
        out[item.id] = value;
      }
    }
    return JSON.stringify(out);
  }

  function prefixTakes(text, prefix) {
    if (!prefix || !text.startsWith(prefix)) {
      return false;
    }
    const next = text[prefix.length];
    if (next === undefined || /\s/.test(next)) {
      return true;
    }
    return !/[0-9A-Za-z]/.test(prefix[prefix.length - 1]);
  }

  function parsePaletteQuery(input, prefixes) {
    const trimmed = String(input ?? "").trim();
    if (!trimmed) {
      return { id: "pages", query: "" };
    }
    const ranked = prefixes
      .filter((item) => item.prefix)
      .slice()
      .sort((a, b) => b.prefix.length - a.prefix.length);
    for (const item of ranked) {
      if (prefixTakes(trimmed, item.prefix)) {
        return { id: item.id, query: trimmed.slice(item.prefix.length).trim(), prefix: item.prefix };
      }
    }
    return { id: "pages", query: trimmed };
  }

  function duplicatePrefixIds(prefixes) {
    const byPrefix = new Map();
    for (const item of prefixes) {
      if (!item.prefix) {
        continue;
      }
      const list = byPrefix.get(item.prefix) || [];
      list.push(item.id);
      byPrefix.set(item.prefix, list);
    }
    const dups = new Set();
    for (const ids of byPrefix.values()) {
      if (ids.length > 1) {
        for (const id of ids) {
          dups.add(id);
        }
      }
    }
    return dups;
  }

  function currentPalettePrefixes() {
    return palettePrefixList(localStorage.getItem(PALETTE_PREFIX_KEY));
  }

  function savePalettePrefixes(prefixes) {
    const json = serializePalettePrefixes(prefixes);
    if (json === "{}") {
      localStorage.removeItem(PALETTE_PREFIX_KEY);
    } else {
      localStorage.setItem(PALETTE_PREFIX_KEY, json);
    }
  }

  function renderPalettePrefixSettings() {
    if (!palettePrefixListEl) {
      return;
    }
    const prefixes = currentPalettePrefixes();
    const dups = duplicatePrefixIds(prefixes);
    palettePrefixListEl.replaceChildren();
    for (const def of prefixes) {
      const row = document.createElement("div");
      row.className = "setting-row";
      const label = document.createElement("span");
      label.id = "palette-prefix-" + def.id + "-label";
      label.textContent = def.label;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "palette-prefix-input" + (dups.has(def.id) ? " dup" : "");
      input.maxLength = PREFIX_MAX;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.value = def.prefix;
      input.setAttribute("aria-labelledby", label.id);
      if (dups.has(def.id)) {
        input.dataset.tooltip = "Same as another prefix; the longer one wins, then list order.";
      }
      const commit = (raw) => {
        const next = currentPalettePrefixes().map((item) =>
          item.id === def.id ? { ...item, prefix: normalizePrefix(raw, item.default) } : item
        );
        savePalettePrefixes(next);
        renderPalettePrefixSettings();
        if (isPaletteOpen()) {
          runPaletteSearch();
        }
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        }
      });
      input.addEventListener("change", () => commit(input.value));
      input.addEventListener("blur", () => commit(input.value));
      row.append(label, input);
      palettePrefixListEl.appendChild(row);
    }
  }

  function render() {
    dropLeftDraft();
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

  async function confirmDelete(message, confirmLabel = "Delete") {
    confirmMessage.textContent = message;
    const okBtn = confirmDlg.querySelector('button[value="ok"]');
    if (okBtn) okBtn.textContent = confirmLabel || "Delete";
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
    if (state.draft?.id === id) {
      closeDraft();
      return;
    }
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
    if (el.dataset.hint) {
      return { title: el.textContent.trim(), description: el.dataset.hint, note: true };
    }
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
    const madeBy = pageActorView(tab.provenance?.created);
    const changedBy = pageActorView(tab.provenance?.changed);
    return {
      title: tab.title,
      id: tab.key,
      createdAt: tab.createdAt,
      updatedAt: Math.max(tab.updatedAt || 0, tab.stateUpdatedAt || 0),
      folder: tab.folderId ? library.pathOf(tab.folderId) : "",
      ...(madeBy ? { madeBy } : {}),
      ...(changedBy ? { changedBy } : {}),
    };
  }

  function pageActorView(actor) {
    if (!actor) {
      return null;
    }
    if (!actor.thread) {
      return { text: "external agent", at: actor.at };
    }
    const name = window.scribeChat?.threadTitle?.(actor.thread) || actor.title || "thread";
    return { text: `agent · ${name}`, threadId: actor.thread, at: actor.at };
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

  async function setFolderInstructions(id, on) {
    await fetch(`/api/tabs/${encodeURIComponent(id)}/folder-instructions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
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
    const html = await fetch("./welcome.html").then((res) => res.text());
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
    if (!tab || isBlank(tab)) {
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
    if (document.querySelector("dialog[open]")) {
      return;
    }
    if (action === "palette") {
      togglePalette();
    } else if (action === "download") {
      downloadActive();
    } else if (action === "help") {
      openWelcome();
    } else if (action === "library") {
      setSideOpen(!state.sideOpen);
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
    } else if (action === "new-page") {
      void newPage();
    } else if (action === "spaces") {
      spaces.toggle();
    } else if (action === "next-space" || action === "prev-space") {
      void spaces.cycle(action === "next-space" ? 1 : -1);
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
    if (document.querySelector("dialog[open]")) {
      return;
    }
    if (spaces.onKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (spaces.isOpen() && event.key !== "Escape") {
      // The board is out of sight: its own shortcuts wait until the overview closes.
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const spaceAction =
        event.key.toLowerCase() === "e" && !event.shiftKey
          ? "spaces"
          : event.shiftKey && event.key === "PageUp"
            ? "prev-space"
            : event.shiftKey && event.key === "PageDown"
              ? "next-space"
              : "";
      if (spaceAction) {
        event.preventDefault();
        runShortcut(spaceAction);
        return;
      }
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
    if (key === "b" && !event.shiftKey) {
      event.preventDefault();
      runShortcut("library");
      return;
    }
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
    if ((key === "t" || key === "n") && !event.shiftKey) {
      event.preventDefault();
      runShortcut("new-page");
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
   * Whether a click or key press just went to this page's frame. A page's activation also activates
   * the board, so a script cannot fake it; and the frame must have focus, so a click in one page does
   * not count for another page that asks at the same moment.
   */
  function frameActivated(frameId) {
    const active = !navigator.userActivation || navigator.userActivation.isActive;
    return active && Boolean(frameId) && document.activeElement === frames.get(frameId)?.el;
  }

  /**
   * scribe.agent from a page: threads of that page only, as found from the frame that asked (not from
   * anything the page says). Whether the click or key press reached the board is checked here: a
   * page's own activation also activates the board, so a script cannot fake it. agent.js decides
   * what the page may do with or without one (scribePermissions).
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
    const activated = frameActivated(frameId);
    chat.pageRequest(tab, data, { activated }).then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
  }

  /**
   * scribe.reply from a page (#320): sends the form's answers to the page its agent wired it to
   * (replyTo), e.g. a comment on a Kanban card that goes on to the card's chat. Only after the
   * user's click reached the page's frame, and only to that target: the daemon looks it up.
   */
  function onPageReply(event) {
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
    if (!frameActivated(frameId)) {
      reply({ ok: false, error: "no_gesture" });
      return;
    }
    fetch(`/api/tabs/${encodeURIComponent(tab.id)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: data.data, summary: data.summary }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          reply({ ok: false, error: String(body.error || `HTTP ${res.status}`) });
          return;
        }
        const num = Number(body.result?.num);
        showNotice(`Reply sent to ${body.target?.title || "its page"}${num ? ` #${num}` : ""}`);
        reply({ ok: true, target: body.target, delivered: body.delivered || null });
      })
      .catch((err) => reply({ ok: false, error: String(err?.message || err) }));
  }

  /** scribe.permissions from a page: read its own, or ask the user for one (after a click). */
  function onPagePermissions(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    const frameId = frameIdByWindow(event.source);
    const tab = frameId ? findAnyTab(frameId) : null;
    const perms = window.scribePermissions;
    if (!tab || tab.embedUrl || !perms) {
      reply({ ok: false, error: "not_a_page" });
      return;
    }
    if (data.op === "query") {
      perms.query(tab).then(reply);
      return;
    }
    if (data.op !== "request") {
      reply({ ok: false, error: "unknown_op" });
      return;
    }
    if (!frameActivated(frameId)) {
      reply({ ok: false, error: "no_gesture" });
      return;
    }
    const need = { perm: String(data.perm || "") };
    if (typeof data.folder === "string" && data.folder) need.folder = data.folder;
    if (typeof data.approval === "string" && data.approval) need.approval = data.approval;
    perms.ensure(tab, need, { explicit: true }).then(
      (result) => reply(result.ok ? { ok: true, granted: true } : { ok: true, granted: false }),
      (err) => reply({ ok: false, error: String(err?.message || err) })
    );
  }

  /**
   * scribe.preview from a page: the page sends the files' bytes, shown here in the shared viewer.
   * Like scribe.agent, it needs the click or key press to have reached the board.
   */
  /** The page's right-click menu: the frame sends where, and what text or link is under it. */
  function onPageContextMenu(event) {
    const id = frameIdByWindow(event.source);
    const frame = id ? frames.get(id) : null;
    const tab = id ? findAnyTab(id) : null;
    if (!frame || !tab) {
      return;
    }
    const data = event.data;
    const box = frame.el.getBoundingClientRect();
    const scale = frame.el.offsetWidth ? box.width / frame.el.offsetWidth : 1;
    const point = { x: box.left + (Number(data.x) || 0) * scale, y: box.top + (Number(data.y) || 0) * scale };
    const selection = typeof data.selection === "string" ? data.selection : "";
    const link = typeof data.link === "string" && /^https?:/i.test(data.link) ? data.link : "";
    // What the page marked under the cursor (data-scribe-context), for actions' own placeholders (#161).
    const context = data.context && typeof data.context === "object" && !Array.isArray(data.context) ? data.context : {};
    // The template's own agent actions (#152), for this selection or the whole page.
    const actions = (window.scribeChat?.pageActions?.(tab, "menu", context) || [])
      .filter((action) => (selection ? action.selection !== "none" : action.selection !== "required"))
      .map((action) => ({ label: action.label, action: () => window.scribeChat?.runAction(tab, action, { selection, context }) }));
    library.openMenu(point, [
      selection && { label: "Ask agent", action: () => window.scribeChat?.ask(selection, tab) },
      selection && { label: "Copy", action: () => copyText(selection, "Copied selection") },
      link && { label: "Copy link address", action: () => copyText(link, "Copied link") },
      {
        label: "Select all",
        action: () => {
          frame.el.focus();
          frame.el.contentWindow?.postMessage({ type: "scribe-select-all" }, contentOrigin());
        },
      },
      "sep",
      ...actions,
      "sep",
      !selection && { label: "Ask agent about this page", action: () => window.scribeChat?.ask("", tab) },
      { label: "Copy page key", action: () => copyTabKey(id) },
    ]);
  }

  /** The agent actions declared by a page's template (template metadata resolves a built-in copy's). */
  function templateActions(tab) {
    if (!tab?.templateId) {
      return [];
    }
    const template =
      state.templates.find((item) => item.id === tab.templateId) || state.builtinTemplates.find((item) => item.id === tab.templateId);
    return Array.isArray(template?.agentActions) ? template.agentActions : [];
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      showNotice(done);
    } catch {
      showNotice("Could not copy to clipboard");
    }
  }

  function onPagePreview(event) {
    const data = event.data;
    const reply = (result) => {
      event.source?.postMessage({ type: "scribe-open-result", id: data.id, reqId: data.reqId, result }, "*");
    };
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      reply({ ok: false, error: "no_gesture" });
      return;
    }
    const files = (Array.isArray(data.files) ? data.files : [])
      .filter((f) => f && f.blob instanceof Blob)
      .map((f) => ({ name: String(f.name || "file"), mimeType: String(f.mimeType || f.blob.type || ""), size: f.blob.size, url: URL.createObjectURL(f.blob) }));
    const revoke = () => files.forEach((f) => URL.revokeObjectURL(f.url));
    if (!files.length || !window.scribePreview?.open(files, Number(data.index) || 0, { onClose: revoke })) {
      revoke();
      reply({ ok: false, error: "nothing_to_preview" });
      return;
    }
    reply({ ok: true });
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

  let releasePaletteTrap = null;
  function openPalette() {
    closeSettings();
    paletteEl.hidden = false;
    paletteInput.value = "";
    paletteIndex = 0;
    loadSemanticStatus();
    showLocalPaletteRows();
    paletteInput.focus();
    paletteInput.select();
    releasePaletteTrap?.();
    releasePaletteTrap = window.scribeFocusTrap?.bind(paletteEl.querySelector(".palette-panel"));
  }

  function closePalette() {
    releasePaletteTrap?.();
    releasePaletteTrap = null;
    paletteEl.hidden = true;
    clearPaletteImage();
    clearTimeout(paletteTimer);
    clearTimeout(relatedTimer);
    paletteReq += 1;
    aiShownQuery = null;
    if (aiAsk?.status === "busy") {
      aiAsk.abort?.abort();
    }
  }

  function updatePaletteChrome(parsed) {
    const threads = parsed.id === "threads";
    const ai = parsed.id === "ai";
    paletteKind = parsed.id;
    const semantic = parsed.id === "semantic";
    paletteInput.placeholder = threads ? "Search threads" : "Search every page";
    paletteEl
      .querySelector(".palette-panel")
      ?.setAttribute("aria-label", threads ? "Search threads" : ai ? "Ask AI about your pages" : semantic ? "Search pages by meaning" : "Search pages");
    if (paletteEnterHint) {
      paletteEnterHint.textContent = threads ? "open in chat" : ai ? "ask or open" : "open";
    }
    for (const el of paletteEl.querySelectorAll("[data-palette-page]")) {
      el.hidden = threads;
    }
    if (palettePrefixHint) {
      const parts = currentPalettePrefixes().map((item) => `${item.prefix} ${item.label.toLowerCase()}`);
      palettePrefixHint.textContent = parsed.id === "pages" && parts.length ? parts.join(" · ") : "";
      palettePrefixHint.hidden = !palettePrefixHint.textContent;
    }
  }

  function showLocalPaletteRows() {
    updatePaletteChrome({ id: "pages", query: "" });
    const recentClosed = [...state.closed].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 15);
    paletteHits = [
      ...(window.scribeChat?.pendingAsks?.() || []),
      ...paletteActionRows(""),
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

  function applyPaletteHits(hits) {
    paletteHits = hits;
    if (paletteIndex >= paletteHits.length) {
      paletteIndex = 0;
    }
    renderPalette();
  }

  function runThreadPaletteSearch(query) {
    const req = ++paletteReq;
    const hits = window.scribeChat?.searchThreads?.(query) || [];
    if (req !== paletteReq || !isPaletteOpen()) {
      return;
    }
    applyPaletteHits(hits);
  }

  async function runPaletteSearch() {
    const parsed = parsePaletteQuery(paletteInput.value, currentPalettePrefixes());
    updatePaletteChrome(parsed);
    clearTimeout(relatedTimer);
    if (parsed.id === "pages" && !parsed.query) {
      paletteReq += 1;
      showLocalPaletteRows();
      return;
    }
    if (parsed.id === "semantic") {
      void runSemanticPaletteSearch(parsed.query);
      return;
    }
    if (parsed.id === "threads") {
      runThreadPaletteSearch(parsed.query);
      return;
    }
    if (parsed.id === "ai") {
      void runAiPaletteSearch(parsed.query);
      return;
    }
    const req = ++paletteReq;
    const res = await fetch(`/api/search?query=${encodeURIComponent(parsed.query)}&limit=40`);
    if (req !== paletteReq || !isPaletteOpen()) {
      return;
    }
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    applyPaletteHits([...spaces.search(parsed.query), ...paletteActionRows(parsed.query), ...(data.tabs || [])]);
    if (semanticStatus?.enabled && parsed.query.length >= SEMANTIC_MIN_QUERY) {
      relatedTimer = setTimeout(() => void addRelatedRows(parsed.query, req), 120);
    }
  }

  function loadSemanticStatus() {
    semanticStatusReq = fetch("/api/search/status")
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((status) => {
        semanticStatus = status;
      });
    return semanticStatusReq;
  }

  async function fetchSemantic(query, scope, limit = 8) {
    try {
      const res = await fetch(`/api/search/semantic?q=${encodeURIComponent(query.slice(0, 500))}&scope=${scope}&limit=${limit}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return data;
      }
      if (data.status) {
        // 503 with the pack's state: search was switched off or the pack went away since the palette opened.
        semanticStatus = data;
      }
      return { error: data.error || `HTTP ${res.status}` };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  function indexProgress(index) {
    return index && (index.indexing || index.pendingPages > 0) && index.indexedPages < index.totalPages
      ? `indexing ${index.indexedPages} of ${index.totalPages} pages`
      : "";
  }

  /**
   * Palette rows for semantic hits: the page, with what matched (section heading or "#335 Card title") and a snippet.
   * An image hit shows its thumbnail and the card, item or section it sits on.
   */
  function semanticRows(hits) {
    return hits.map((hit) => {
      const tab = findAnyTab(hit.id) || { id: hit.id, title: hit.title, folderPath: hit.folder };
      // A section opens at its heading: by id when it has one, else by its place among the page's h1 to h4.
      const at = hit.kind === "image" ? hit.owner || {} : hit;
      const anchor =
        at.kind === "section" ? at.headingId || (Number(at.anchor) > 0 ? `scribe-section:${at.anchor}` : "") : "";
      return {
        ...tab,
        open: state.tabs.some((item) => item.id === hit.id),
        section: undefined,
        matchLabel: hit.label && hit.label !== tab.title ? hit.label : "",
        snippet: hit.snippet,
        anchor,
        // Page assets are served from the content origin only.
        thumb: hit.kind === "image" ? contentOrigin() + hit.image : "",
      };
    });
  }

  /**
   * Normal search (#372): pages found by meaning that the word search did not list, under a
   * "Related" divider. They are appended, so the rows above and the selection stay where they are.
   */
  async function addRelatedRows(query, req) {
    const data = await fetchSemantic(query, "pages");
    if (req !== paletteReq || !isPaletteOpen() || !data.hits) {
      return;
    }
    const listed = new Set(paletteHits.map((hit) => hit.id));
    const rows = semanticRows(data.hits.filter((hit) => !listed.has(hit.id)));
    if (!rows.length) {
      return;
    }
    const progress = indexProgress(data.index);
    rows[0].section = progress ? `Related · ${progress}` : "Related";
    paletteHits = [...paletteHits, ...rows];
    const top = paletteList.scrollTop;
    renderPalette();
    paletteList.scrollTop = top;
  }

  function semanticInfoRow(title, snippet, settings = false) {
    return { kind: "semantic-info", id: "semantic:info", title, snippet, settings };
  }

  function semanticOffRow() {
    const status = semanticStatus?.status;
    const how =
      status === "ready"
        ? "Switch it on in Settings → Search."
        : status === "wrong-version" || status === "invalid"
          ? `The search pack can't be used: ${semanticStatus.message}.`
          : "It needs the optional search pack: unzip it into the folder shown in Settings → Search, then switch it on there.";
    return semanticInfoRow("Search by meaning is off", `${how} Enter opens Settings.`, true);
  }

  /** The semantic prefix (#372): pages by meaning, then the sections and cards that matched. No word search. */
  async function runSemanticPaletteSearch(query) {
    const req = ++paletteReq;
    const stale = () => req !== paletteReq || !isPaletteOpen();
    if (!semanticStatus) {
      await (semanticStatusReq || loadSemanticStatus());
      if (stale()) {
        return;
      }
    }
    if (!semanticStatus?.enabled) {
      paletteIndex = 0;
      applyPaletteHits([semanticOffRow()]);
      return;
    }
    if (!query) {
      applyPaletteHits([]);
      const res = await fetch("/api/search/index/status").catch(() => null);
      const index = res?.ok ? await res.json() : null;
      if (!stale()) {
        semanticProgress = indexProgress(index);
        renderPalette();
      }
      return;
    }
    // Wait out fast typing: each query costs the model about 150 ms.
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (stale()) {
      return;
    }
    // The first search after a while loads the model (several seconds), so say that something is happening.
    const busy = setTimeout(() => {
      if (!stale()) {
        paletteIndex = 0;
        applyPaletteHits([{ ...semanticInfoRow("Searching by meaning…", "The first search loads the model, which takes a few seconds."), busy: true }]);
      }
    }, 400);
    const [pages, chunks, images] = await Promise.all([
      fetchSemantic(query, "pages"),
      fetchSemantic(query, "chunks"),
      fetchSemantic(query, "images", 4),
    ]);
    clearTimeout(busy);
    if (stale()) {
      return;
    }
    paletteIndex = 0;
    if (!pages.hits) {
      applyPaletteHits([semanticStatus?.enabled ? semanticInfoRow("Search by meaning failed", pages.error) : semanticOffRow()]);
      return;
    }
    semanticProgress = indexProgress(pages.index);
    // A page row already shows its best chunk; list the other matching sections and cards below.
    const key = (hit) => `${hit.id}|${hit.kind}|${hit.anchor}`;
    const reasons = new Set(pages.hits.map(key));
    const pageRows = semanticRows(pages.hits);
    const chunkRows = semanticRows((chunks.hits || []).filter((hit) => hit.kind !== "page" && !reasons.has(key(hit))));
    if (pageRows.length && semanticProgress) {
      pageRows[0].section = `Pages · ${semanticProgress}`;
    }
    if (chunkRows.length) {
      chunkRows[0].section = "Sections and cards";
    }
    const imageRows = semanticRows(images.hits || []);
    if (imageRows.length) {
      imageRows[0].section = "Images";
    }
    applyPaletteHits([...pageRows, ...chunkRows, ...imageRows]);
  }

  function clearPaletteImage() {
    if (paletteImage) {
      URL.revokeObjectURL(paletteImage.url);
      paletteImage = null;
    }
  }

  /** The first image file of a paste or drop, if it carries one. */
  function imageFileOf(transfer) {
    return [...(transfer?.files || [])].find((file) => /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type)) || null;
  }

  /**
   * An image as the query (#373): pasted or dropped into the palette, it lists the indexed images that
   * look most like it, each with the card, item or section it sits on. Typing goes back to text search.
   */
  async function runImagePaletteSearch(file) {
    const req = ++paletteReq;
    const stale = () => req !== paletteReq || !isPaletteOpen();
    clearTimeout(paletteTimer);
    clearTimeout(relatedTimer);
    clearPaletteImage();
    paletteImage = { url: URL.createObjectURL(file) };
    paletteInput.value = "";
    updatePaletteChrome({ id: "semantic", query: "" });
    paletteInput.placeholder = "Similar images. Type to search by text";
    const queryRow = (title, snippet, extra = {}) => ({ ...semanticInfoRow(title, snippet), thumb: paletteImage?.url, ...extra });
    paletteIndex = 0;
    if (!semanticStatus) {
      await (semanticStatusReq || loadSemanticStatus());
      if (stale()) {
        return;
      }
    }
    if (!semanticStatus?.enabled) {
      applyPaletteHits([semanticOffRow()]);
      return;
    }
    applyPaletteHits([queryRow("Looking for similar images…", "The first image search loads the vision model, which takes a few seconds.", { busy: true })]);
    let data;
    try {
      const res = await fetch("/api/search/semantic/image?limit=8", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.status) {
          semanticStatus = data;
        }
        data = { error: data.error || `HTTP ${res.status}` };
      }
    } catch (err) {
      data = { error: err.message || String(err) };
    }
    if (stale()) {
      return;
    }
    if (!data.hits) {
      applyPaletteHits([semanticStatus?.enabled ? queryRow("Image search failed", data.error) : semanticOffRow()]);
      return;
    }
    const rows = semanticRows(data.hits);
    const pending = data.index?.pendingImagePages > 0 ? " Images are still being indexed." : "";
    if (!rows.length) {
      applyPaletteHits([queryRow("No similar images", `No indexed image looks like this one.${pending}`)]);
      return;
    }
    rows[0].section = "Similar images";
    // The query's own row leads; the selection starts on the best match.
    paletteIndex = 1;
    applyPaletteHits([queryRow("Images like this one", `${file.name || "Pasted image"}.${pending}`), ...rows]);
  }

  /**
   * `?` (#245): the Ask AI row (or its answer) on top, the free text matches below. Nothing is
   * spent until Enter on the Ask row; an empty `?` lists recent questions with their saved answers.
   */
  async function runAiPaletteSearch(query) {
    const req = ++paletteReq;
    if (aiShownQuery !== query) {
      paletteIndex = 0;
      aiShownQuery = query;
    }
    if (!query) {
      applyPaletteHits(aiRecentRows());
      return;
    }
    const ask = aiAsk?.query === query ? aiAsk : null;
    const head = ask?.status === "done" ? aiResultRows(ask) : [aiAskRow(query, ask)];
    applyPaletteHits(head);
    const res = await fetch(`/api/search?query=${encodeURIComponent(query)}&limit=40`);
    if (req !== paletteReq || !isPaletteOpen() || !res.ok) {
      return;
    }
    const data = await res.json();
    const shown = new Set(head.map((hit) => hit.id));
    const text = (data.tabs || []).filter((tab) => !shown.has(tab.id));
    if (text.length) {
      text[0] = { ...text[0], section: "Text matches" };
    }
    applyPaletteHits([...head, ...text]);
  }

  function aiAskRow(query, ask) {
    const row = { kind: "ai-ask", id: "ai:ask", query, title: `Ask AI: “${query}”`, locationLabel: "AI", location: "ai" };
    if (ask?.status === "busy") {
      return { ...row, busy: true, title: aiModel ? `Searching your pages with ${aiModel}…` : "Searching your pages…", snippet: "Esc to stop" };
    }
    if (ask?.status === "error") {
      return { ...row, snippet: `That failed: ${ask.error}. Enter to try again.` };
    }
    return { ...row, snippet: aiModel ? `Enter to ask. One call to ${aiModel} over all your pages.` : "Enter to ask. One model call over all your pages." };
  }

  function aiResultRows(ask) {
    const rows = [];
    for (const hit of ask.hits || []) {
      const tab = findAnyTab(hit.id);
      if (tab) {
        rows.push({ ...tab, open: state.tabs.some((item) => item.id === tab.id), snippet: hit.reason });
      }
    }
    const took = ask.ms ? ` · ${(ask.ms / 1000).toFixed(1)} s` : "";
    const section = `${rows.length ? "AI results" : "No pages fit"} · ${ask.model || "AI"}${took}`;
    if (rows.length) {
      rows[0] = { ...rows[0], section };
    }
    const chat = {
      kind: "ai-chat",
      id: "ai:chat",
      query: ask.query,
      title: "Ask in chat for a deeper search",
      snippet: "Opens a new thread with this question, ready to send",
      locationLabel: "Chat",
      location: "ai",
    };
    return [...rows, rows.length ? chat : { ...chat, section }];
  }

  function readAiRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(AI_RECENT_KEY) || "[]");
      return Array.isArray(list) ? list.filter((item) => item && typeof item.query === "string" && Array.isArray(item.hits)) : [];
    } catch {
      return [];
    }
  }

  function saveAiRecent(ask) {
    const item = { query: ask.query, at: Date.now(), model: ask.model, ms: ask.ms, hits: ask.hits };
    const list = [item, ...readAiRecent().filter((old) => old.query !== ask.query)].slice(0, AI_RECENT_MAX);
    localStorage.setItem(AI_RECENT_KEY, JSON.stringify(list));
  }

  function aiRecentRows() {
    return readAiRecent().map((item, index) => ({
      kind: "ai-recent",
      id: `ai:recent:${index}`,
      title: item.query,
      snippet: `${item.hits.length === 1 ? "1 result" : `${item.hits.length} results`} · ${new Date(item.at).toLocaleString()}`,
      section: index === 0 ? "Recent questions" : undefined,
      item,
    }));
  }

  async function startAiAsk(query) {
    aiAsk?.abort?.abort();
    const abort = new AbortController();
    const ask = { query, status: "busy", abort };
    aiAsk = ask;
    runPaletteSearch();
    try {
      const res = await fetch("/api/agent/palette-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: abort.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      Object.assign(ask, { status: "done", hits: data.hits || [], model: data.model || "", ms: data.ms || 0 });
      aiModel = ask.model || aiModel;
      saveAiRecent(ask);
    } catch (err) {
      if (abort.signal.aborted) {
        if (aiAsk === ask) {
          aiAsk = null;
        }
      } else {
        Object.assign(ask, { status: "error", error: err.message || String(err) });
      }
    }
    ask.abort = null;
    if (aiAsk === ask || !aiAsk) {
      if (isPaletteOpen() && paletteKind === "ai") {
        paletteIndex = 0;
        runPaletteSearch();
      }
    }
  }

  /** The open page's template agent actions (#152) matching the query, listed above the pages. */
  function paletteActionRows(query) {
    const tab = activeTab();
    const q = query.trim().toLowerCase();
    return (window.scribeChat?.pageActions?.(tab, "palette") || [])
      .filter((action) => action.selection !== "required")
      .filter((action) => !q || `${action.label} ${action.description || ""}`.toLowerCase().includes(q))
      .map((action) => ({
        kind: "action",
        id: `action:${action.id}`,
        title: action.label,
        snippet: action.description || "",
        locationLabel: "Agent action",
        location: "action",
        tab,
        action,
      }));
  }

  function renderPalette() {
    paletteList.replaceChildren();
    const empty = paletteHits.length === 0;
    paletteEmpty.hidden = !empty;
    const parsed = parsePaletteQuery(paletteInput.value, currentPalettePrefixes());
    const threads = paletteKind === "threads";
    const semantic = paletteKind === "semantic";
    paletteEmpty.textContent = parsed.query
      ? threads
        ? "No matching threads"
        : semantic
          ? "Nothing close to that"
          : "No matching pages"
      : threads
        ? "No threads yet"
        : paletteKind === "ai"
          ? "Type a question about your pages and press Enter"
          : semantic
            ? "Describe what you are looking for. Pages, sections, cards and images are matched by meaning, not by their words. Paste or drop an image to find similar ones."
            : "No pages yet";
    if (semantic && semanticProgress) {
      paletteEmpty.textContent += ` Still ${semanticProgress}.`;
    }
    for (let index = 0; index < paletteHits.length; index += 1) {
      const tab = paletteHits[index];
      if (tab.section) {
        const head = document.createElement("div");
        head.className = "palette-section";
        head.textContent = tab.section;
        paletteList.appendChild(head);
      }
      const el = document.createElement("div");
      el.className = "palette-row" + (index === paletteIndex ? " active" : "") + (tab.busy ? " busy" : "");
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

      // A row with a thumbnail keeps its text in a column beside it.
      let body = el;
      if (tab.thumb) {
        el.classList.add("with-thumb");
        const thumb = document.createElement("img");
        thumb.className = "palette-thumb";
        thumb.src = tab.thumb;
        thumb.alt = "";
        thumb.loading = "lazy";
        body = document.createElement("div");
        body.className = "palette-row-text";
        el.append(thumb, body);
      }
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
      if (tab.kind === "space") {
        if (tab.open) {
          chips.appendChild(paletteChip("Current"));
        }
      } else if (tab.kind === "thread" || tab.kind === "action" || tab.kind === "ask" || tab.kind?.startsWith("ai-") || tab.kind === "semantic-info") {
        if (tab.open) {
          chips.appendChild(paletteChip("Open"));
        }
      } else if (!tab.open) {
        chips.appendChild(paletteChip("Closed"));
      }
      const folder = tab.folderId ? library.pathOf(tab.folderId) : tab.folderPath || "";
      if (folder) {
        chips.appendChild(paletteChip(folder, "folder"));
      }
      if (chips.childElementCount) {
        main.appendChild(chips);
      }
      body.appendChild(main);

      if (tab.snippet || tab.matchLabel) {
        const snippet = document.createElement("div");
        snippet.className = "palette-snippet";
        if (tab.matchLabel) {
          const label = document.createElement("span");
          label.className = "palette-match";
          label.textContent = tab.matchLabel;
          snippet.appendChild(label);
        }
        snippet.append(tab.snippet || "");
        body.appendChild(snippet);
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
    const rows = paletteList.querySelectorAll(".palette-row");
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

  /** Enter or a click navigates; Ctrl also navigates, Shift splits, Alt peeks. Threads open in chat. */
  function activatePaletteHit(tab, mode = null) {
    if (!tab) {
      return;
    }
    if (tab.kind === "ask") {
      closePalette();
      if (tab.page?.id) {
        if (mode === "peek" || mode === "split") {
          views.open(tab.page.id, mode);
        } else if (state.tabs.some((item) => item.id === tab.page.id)) {
          selectTab(tab.page.id, { fromUser: true });
        } else {
          openPage(tab.page.id);
        }
      }
      if (!window.scribeChat?.openAsk?.(tab.threadId, tab.itemId)) {
        showNotice("Could not open that thread");
      }
      return;
    }
    if (tab.kind === "ai-ask") {
      if (aiAsk?.query !== tab.query || aiAsk.status !== "busy") {
        void startAiAsk(tab.query);
      }
      return;
    }
    if (tab.kind === "ai-chat") {
      closePalette();
      if (!window.scribeChat?.askInChat) {
        showNotice("The agent chat is not ready");
        return;
      }
      window.scribeChat.askInChat(tab.query);
      return;
    }
    if (tab.kind === "ai-recent") {
      aiAsk = { ...tab.item, status: "done" };
      const prefix = currentPalettePrefixes().find((item) => item.id === "ai")?.prefix || "?";
      paletteInput.value = `${prefix} ${tab.item.query}`;
      runPaletteSearch();
      return;
    }
    if (tab.kind === "semantic-info") {
      if (tab.settings) {
        closePalette();
        openSettings();
      }
      return;
    }
    if (tab.kind === "action") {
      closePalette();
      void window.scribeChat?.runAction(tab.tab, tab.action);
      return;
    }
    if (tab.kind === "space") {
      closePalette();
      void spaces.switchTo(tab.spaceId);
      return;
    }
    if (tab.kind === "thread") {
      closePalette();
      if (!window.scribeChat?.openThread?.(tab.id)) {
        showNotice("Could not open that thread");
      }
      return;
    }
    closePalette();
    if (tab.anchor) {
      // A section found by meaning: open the page scrolled to it.
      views.open(tab.id, mode === "peek" || mode === "split" ? mode : "tab", { anchor: tab.anchor });
      return;
    }
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
  // Keep the empty palette's pending questions current while it is open.
  window.addEventListener("scribe:agent-status", () => {
    if (isPaletteOpen() && paletteKind === "pages" && !parsePaletteQuery(paletteInput.value, currentPalettePrefixes()).query) {
      const current = paletteHits[paletteIndex]?.id;
      showLocalPaletteRows();
      const index = paletteHits.findIndex((hit) => hit.id === current);
      if (index > 0) {
        paletteIndex = index;
        highlightPaletteRows();
      }
    }
  });
  window.scribeShortcut = runShortcut;
  /** What the agent chat (agent.js) needs from the shell. */
  window.scribeApp = {
    templateActions,
    activeTab,
    findAnyTab: (id) => findAnyTab(id) || (state.draft?.id === id ? state.draft : null),
    tabs: () => state.tabs,
    closed: () => state.closed,
    folders: () => state.folders,
    connected: () => state.connected,
    openLink: (target, event, { anchor = "", mode = null } = {}) => views.open(target, views.modeFromEvent(event) || mode, { anchor }),
    resolvePages: (targets) => views.resolve(targets),
    showNotice,
    confirm: confirmDelete,
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
    } else if (event.data?.type === "scribe-shortcut") {
      if (["spaces", "next-space", "prev-space", "library", "new-page"].includes(event.data.action)) {
        runShortcut(event.data.action);
      }
    } else if (event.data?.type === "scribe-activity") {
      noteEdit();
    } else if (event.data?.type === "scribe-open" || event.data?.type === "scribe-resolve") {
      onPageLink(event);
    } else if (event.data?.type === "scribe-escape") {
      if (window.scribePreview?.close()) {
        return;
      }
      if (!window.scribeChat?.escape()) {
        views.escape();
      }
    } else if (event.data?.type === "scribe-agent") {
      onPageAgent(event);
    } else if (event.data?.type === "scribe-permissions") {
      onPagePermissions(event);
    } else if (event.data?.type === "scribe-reply") {
      onPageReply(event);
    } else if (event.data?.type === "scribe-preview") {
      onPagePreview(event);
    } else if (event.data?.type === "scribe-chat-key") {
      const action = String(event.data.action || "");
      const selection = typeof event.data.selection === "string" ? event.data.selection : "";
      const tab = selection ? findAnyTab(frameIdByWindow(event.source)) : null;
      if (tab && (action === "dock" || action === "side")) {
        window.scribeChat?.ask(selection, tab, action);
      } else {
        window.scribeChat?.shortcut(action);
      }
    } else if (event.data?.type === "scribe-context-menu") {
      onPageContextMenu(event);
    } else if (event.data?.type === "scribe-context-menu-close") {
      library.closeMenu();
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
  showClearToggle.addEventListener("click", () => toggleFlag(showClearToggle, SHOW_CLEAR_KEY));
  tightSmallToggle.addEventListener("click", () => toggleFlag(tightSmallToggle, TIGHT_SMALL_KEY));
  uiFxToggle.addEventListener("click", () => toggleFlag(uiFxToggle, UI_FX_KEY));
  newPageProviderToggle.addEventListener("click", () => {
    toggleFlag(newPageProviderToggle, NEWPAGE_PROVIDER_KEY);
    window.dispatchEvent(new Event("scribe:newpage-bg"));
  });
  auroraEdgeToggle.addEventListener("click", () => toggleFlag(auroraEdgeToggle, AURORA_EDGE_KEY));
  auroraIdleToggle.addEventListener("click", () => toggleFlag(auroraIdleToggle, AURORA_IDLE_KEY));
  clearBtn.addEventListener("click", async () => {
    await fetch("/api/tabs?filter=unpinned", { method: "DELETE" });
  });
  libraryToggle.addEventListener("click", () => setSideOpen(!state.sideOpen));
  newTabBtn.addEventListener("click", () => runShortcut("new-page"));
  // The New page screen hides its templates once the page has a thread, and says when the agent works.
  window.addEventListener("scribe:agent-threads", () => {
    const tab = activeTab();
    if (isBlank(tab)) {
      newPageView.render(tab);
    }
  });
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
  paletteInput.addEventListener("paste", (event) => {
    const file = imageFileOf(event.clipboardData);
    if (file) {
      event.preventDefault();
      void runImagePaletteSearch(file);
    }
  });
  paletteEl.addEventListener("drop", (event) => {
    const file = imageFileOf(event.dataTransfer);
    if (file) {
      event.preventDefault();
      void runImagePaletteSearch(file);
    }
  });
  paletteInput.addEventListener("input", () => {
    clearPaletteImage();
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
      if (paletteKind === "ai" && aiAsk?.status === "busy") {
        aiAsk.abort?.abort();
        return;
      }
      closePalette();
    }
  });
  window.addEventListener("scribe:threads-ready", () => {
    if (isPaletteOpen() && paletteKind === "threads") {
      runPaletteSearch();
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
      const dir = document.documentElement.dataset.librarySide === "left" ? 1 : -1;
      applySideWidth(startWidth + dir * (move.clientX - startX));
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

  window.addEventListener("scribe:threads-ready", () => library.render());

  setSideOpen(state.sideOpen);
  connect();
  render();
})();
