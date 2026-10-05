/* Agent chat: sidebar pane, floating dock, and full-window views over one set of threads. */
(() => {
  const R = window.AgentRender;
  const { el, icon, button } = R;
  const app = () => window.scribeApp;

  const LS = {
    side: "scribe.agent.sideOpen",
    width: "scribe.agent.width",
    current: "scribe.agent.current",
    dock: "scribe.agent.dockShown",
    filter: "scribe.agent.filter",
    reasoning: "scribe.agent.reasoningOpen",
    button: "scribe.agent.showButton",
    dockStyle: "scribe.agent.dockStyle",
    emptyEnter: "scribe.agent.emptyEnter",
    tips: "scribe.agent.showTips",
    hidePage: "scribe.agent.hidePageThreads",
    compact: "scribe.agent.compactThreads",
  };
  const DOCK_STYLES = [
    { id: "bar", label: "Bar" },
    { id: "island", label: "Island" },
  ];

  function dockStyle() {
    const v = localStorage.getItem(LS.dockStyle);
    return DOCK_STYLES.some((s) => s.id === v) ? v : "bar";
  }

  /** What Enter on an empty composer does with a queued message while a turn runs. */
  const EMPTY_ENTER = [
    { id: "steer", label: "Steer, then send" },
    { id: "send", label: "Send now" },
  ];

  /** The thread list shows only each thread's title and status dot (Agent settings). */
  function compactThreads() {
    return localStorage.getItem(LS.compact) === "1";
  }

  function emptyEnter() {
    return localStorage.getItem(LS.emptyEnter) === "send" ? "send" : "steer";
  }

  function approvalFor(provider, p = prefs()) {
    return p.approvals?.[provider] || p.approval || "ask";
  }

  const MODES = [
    { id: "code", label: "Code", detail: "Read, edit files and run commands in the workspace" },
    { id: "ask", label: "Ask", detail: "Read-only: answer, read and search, no edits" },
    { id: "plan", label: "Plan", detail: "Investigate and propose a plan before changing anything" },
    { id: "board", label: "Pages", detail: "Scribe pages and web only, no shell or file edits" },
  ];
  const APPROVALS = [
    { id: "ask", label: "Ask first", detail: "Ask before edits and commands that are not allowlisted" },
    { id: "edits", label: "Auto-edit", detail: "Accept file edits, ask before commands" },
    { id: "auto", label: "Auto review", detail: "A classifier approves safe calls and asks for the rest (Claude)" },
    { id: "full", label: "Full access", detail: "Approve everything automatically" },
  ];
  const WEB_MODES = [
    { id: "on", label: "Web", detail: "Web search and fetch on any site" },
    { id: "limited", label: "Web: limited", detail: "The web allowlist's domains without asking; the agent asks for others" },
    { id: "off", label: "Web off", detail: "The agent asks before each web search or fetch" },
  ];
  /** Providers that actually apply Limited and Off. */
  function webEnforced(provider) {
    return provider === "claude" || provider === "cursor" || provider === "pi";
  }
  const WEB_UNENFORCED = "Not enforced on this provider: its own web tools stay on.";
  /** Cursor and Pi have no Limited search: the allowlist covers a fetch tool only. */
  const CURSOR_LIMITED = "Fetch from the web allowlist's domains; the agent asks for others; no web search";
  /** The Cursor SDK has no approval callback: every mode but Full access runs Cursor's Auto-review, which denies instead of asking. */
  const CURSOR_REVIEW = "Cursor: Auto-review approves safe calls and denies the rest; it can't ask you yet";
  /** With the experimental host shell (Agent settings), Scribe runs Cursor's shell commands and asks first. */
  const CURSOR_HOST_SHELL = "Cursor: asks before each shell command (Scribe runs it); other tools go through Auto-review";
  function approvalDetail(a, provider) {
    if (provider === "cursor" && (a.id === "ask" || a.id === "edits") && prefs().cursorHostShell) return CURSOR_HOST_SHELL;
    if (provider === "cursor" && a.id !== "full") return CURSOR_REVIEW;
    if (a.id === "auto" && provider === "pi") return "Like Edits, plus read-only commands and tests without asking";
    if (a.id === "auto" && provider !== "claude") return "Claude only";
    return a.detail;
  }
  const EXPLORE = new Set(["read", "search", "think"]);
  const SCOPE_KIND = { page: "Page", folder: "Folder", workspace: "Workspace", global: "Global" };
  const SCOPE_SLASH = [
    { name: "here", description: "This thread belongs to the current page" },
    { name: "folder", description: "This thread belongs to the current page's folder" },
    { name: "workspace", description: "Set the workspace folder" },
    { name: "global", description: "Not tied to a page or folder" },
  ];
  const PROVIDER_LABEL = { claude: "Claude", cursor: "Cursor", pi: "Pi" };
  const PROVIDER_GLYPH = { claude: "C", cursor: "⌘", pi: "π" };
  const PROVIDERS = ["cursor", "claude", "pi"];

  /* ---------- state ---------- */

  const S = {
    config: { providers: [], prefs: null, models: { claude: [], cursor: [], pi: [] } },
    threads: new Map(),
    details: new Map(),
    loading: new Map(),
    commands: new Map(),
    current: localStorage.getItem(LS.current) || null,
    sideOpen: localStorage.getItem(LS.side) === "1",
    fullOpen: false,
    dockShown: localStorage.getItem(LS.dock) === "1",
    dockExpanded: false,
    /** Thread the dock uses per page id, when the user picked one. */
    dockPicks: new Map(),
    filter: ["here", "workspaces", "all", "archived"].includes(localStorage.getItem(LS.filter)) ? localStorage.getItem(LS.filter) : "here",
    search: "",
    hidePageThreads: localStorage.getItem(LS.hidePage) !== "0",
    /** Extra rows revealed per grouping key via "Show 10 more". */
    groupExtra: new Map(),
    lastActiveId: null,
    ready: false,
    /** Forks whose offer to archive the thread they came from was answered or dismissed. */
    forkArchiveSeen: new Set(),
    /** threadId -> the thread's open agent browser: { threadId, tabs: [{ tab, url, title, current }] }. */
    browsers: new Map(),
  };

  async function api(method, path, body) {
    const write = method !== "GET";
    const res = await fetch(`/api/agent${path}`, {
      method,
      headers: write ? { "Content-Type": "application/json" } : {},
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error(data?.error || `${method} ${path} failed (${res.status})`);
    }
    return data;
  }

  function notice(text) {
    // The toast sits on the floating chat. Skip it when that chat is the one in use.
    if (S.dockShown && !S.fullOpen && (dockFocused() || !S.sideOpen)) return;
    app()?.showNotice?.(text);
  }

  /** "working" / "in background" / "done" / "failed" / "stopped" for a task badge. */
  function taskStatusLabel(task) {
    if (task.status === "running") return task.background ? "in background" : "working";
    if (task.status === "error") return "failed";
    return task.status;
  }

  /* ----- attached files ----- */

  /** Same limits as src/agent/attachments.ts, checked here first so a file is refused before it is read. */
  const FILE_LIMITS = { count: 10, image: 8 * 1024 * 1024, file: 20 * 1024 * 1024, total: 50 * 1024 * 1024 };
  const MENTION_LIMIT = 20;

  /** The @token around the caret. Keep in sync with src/agent/mention.ts. query is the typed prefix; start/end cover the whole token. */
  function mentionAt(value, cursor) {
    const before = value.slice(0, cursor);
    const m = /(^|[\s])@([^\s@]*)$/.exec(before);
    if (!m) return null;
    const start = before.length - 1 - m[2].length;
    const rest = /^[^\s@]*/.exec(value.slice(cursor))?.[0] || "";
    return { start, end: cursor + rest.length, query: m[2] };
  }

  function chipKey(chip) {
    if (chip.kind === "page") return `page:${chip.id}`;
    if (chip.kind === "folder") return `folder:${chip.id}`;
    if (chip.kind === "file") return `file:${chip.path}`;
    return null;
  }

  function chipIcon(chip) {
    if (chip.kind === "page") return "page";
    if (chip.kind === "folder") return "folder";
    if (chip.kind === "selection") return "quote";
    return "read";
  }

  function chipLabel(chip) {
    if (chip.kind === "page") return chip.title || chip.key || "Page";
    if (chip.kind === "folder") return chip.path || "Folder";
    if (chip.kind === "file") return R.basename(chip.path) || chip.path;
    if (chip.kind === "selection") {
      const text = String(chip.text || "").replace(/\s+/g, " ");
      return text ? `“${text.slice(0, 40)}${text.length > 40 ? "…" : ""}”` : "Selection";
    }
    return chip.kind;
  }

  function chipTitle(chip) {
    if (chip.kind === "selection") return chip.text.length > 600 ? `${chip.text.slice(0, 600)}…` : chip.text;
    return chip.path || chip.key || "";
  }

  function sentFileUrl(threadId, fileId) {
    return `/api/agent/threads/${encodeURIComponent(threadId)}/files/${encodeURIComponent(fileId)}`;
  }

  function base64Url(data, mimeType) {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
  }

  /** A file as a chip: a thumbnail for images, an icon and size for the rest. Click previews it. */
  function fileChip(file, onOpen) {
    const isImage = (file.mimeType || "").startsWith("image/");
    // A span, not a button: the composer puts a remove button inside it.
    const chip = el("span", `ag-chip small file${isImage ? " img" : ""}`);
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.title = `Preview ${file.name}`;
    chip.addEventListener("click", onOpen);
    chip.addEventListener("keydown", (event) => {
      if (event.target !== chip || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      onOpen();
    });
    if (isImage) {
      const thumb = el("img");
      thumb.src = file.url;
      thumb.alt = "";
      thumb.addEventListener("error", () => thumb.replaceWith(icon("image")));
      chip.append(thumb);
    } else {
      chip.append(icon("read"));
    }
    chip.append(el("span", "ag-chip-name", file.name));
    const size = window.scribePreview?.sizeLabel(file.size);
    if (!isImage && size) chip.append(el("span", "ag-chip-size", size));
    return chip;
  }

  function prefs() {
    return S.config.prefs || { provider: "cursor", models: {}, efforts: {}, modelParams: {}, mode: "code", approval: "ask", approvals: {}, web: "on", recentWorkspaces: [], scopeWorkspaces: {} };
  }

  /** "on" | "limited" | "off". Older threads and prefs, and pages, may pass a boolean. */
  function webMode(value, fallback = "on") {
    if (value === true || value === "on") return "on";
    if (value === false || value === "off") return "off";
    if (value === "limited") return "limited";
    return fallback;
  }

  function providerAvailable(id) {
    return S.config.providers.some((p) => p.id === id && p.available);
  }

  function modelsOf(provider) {
    return S.config.models[provider] || [];
  }

  function modelInfo(provider, id) {
    return modelsOf(provider).find((m) => m.id === id) || null;
  }

  async function loadConfig() {
    try {
      S.config = await api("GET", "/config");
    } catch {
      return;
    }
    armUsageTick();
    for (const provider of PROVIDERS) {
      if (!providerAvailable(provider)) continue;
      api("GET", `/models?provider=${provider}`)
        .then((data) => {
          if (data.models?.length) {
            S.config.models[provider] = data.models;
            renderAll();
          }
        })
        .catch(() => undefined);
    }
  }

  async function loadThreads() {
    try {
      const data = await api("GET", "/threads");
      S.threads = new Map(data.threads.map((t) => [t.id, t]));
    } catch {
      return;
    }
    S.ready = true;
    for (const id of [...S.details.keys()]) {
      if (!S.threads.has(id)) S.details.delete(id);
    }
    // A reconnect may have missed events: refresh the details we show.
    const shown = new Set(views().map((view) => view.threadId).filter(Boolean));
    for (const id of shown) S.details.delete(id);
    renderAll();
    for (const id of shown) {
      if (!S.threads.has(id)) continue;
      ensureDetail(id).then(() => {
        for (const view of views()) if (view.threadId === id) view.renderAll();
        if (dock.view.threadId === id) dock.bindFeed(true);
      });
    }
  }

  async function ensureDetail(id) {
    if (!id) return null;
    if (S.details.has(id)) return S.details.get(id);
    if (S.loading.has(id)) return S.loading.get(id);
    const load = api("GET", `/threads/${encodeURIComponent(id)}`)
      .then((data) => {
        const detail = { items: data.items, byId: new Map(data.items.map((it) => [it.id, it])), turns: new Map(data.turns.map((t) => [t.id, t])) };
        S.details.set(id, detail);
        S.threads.set(id, data.thread);
        return detail;
      })
      .catch(() => null)
      .finally(() => S.loading.delete(id));
    S.loading.set(id, load);
    return load;
  }

  /* ---------- events ---------- */

  window.addEventListener("scribe:agent-event", (event) => onEvent(event.detail));
  window.addEventListener("scribe:connection", (event) => {
    if (event.detail?.connected) {
      loadConfig();
      loadThreads();
      loadBrowsers();
    }
  });
  window.addEventListener("scribe:render", () => {
    const active = app()?.activeTab?.()?.id || null;
    if (active !== S.lastActiveId) {
      S.lastActiveId = active;
      dock.syncThread();
      renderLists();
      for (const view of views()) view.renderContext();
    }
  });

  function onEvent(msg) {
    switch (msg.type) {
      case "agent_thread": {
        const prev = S.threads.get(msg.thread.id);
        S.threads.set(msg.thread.id, msg.thread);
        for (const view of views()) {
          if (view.threadId === msg.thread.id) view.onThread(msg.thread, prev);
        }
        if (!prev && dock.draftMatches(msg.thread)) dock.syncThread();
        renderLists();
        renderBadge();
        pageThreadChanged(msg.thread, prev);
        return;
      }
      case "agent_thread_deleted": {
        S.threads.delete(msg.id);
        S.details.delete(msg.id);
        for (const view of views()) {
          if (view.threadId === msg.id) view.setThread(null);
        }
        if (S.current === msg.id) setCurrent(null);
        renderLists();
        renderBadge();
        return;
      }
      case "agent_item": {
        const detail = S.details.get(msg.item.threadId);
        if (!detail) return;
        const prev = detail.byId.get(msg.item.id);
        if (prev) {
          const moved = prev.seq !== msg.item.seq;
          Object.assign(prev, msg.item);
          for (const key of Object.keys(prev)) {
            if (!(key in msg.item)) delete prev[key];
          }
          // A steered message moves to the point in the turn where the agent read it.
          if (moved) detail.items.sort((a, b) => a.seq - b.seq);
        } else {
          detail.items.push(msg.item);
          detail.byId.set(msg.item.id, msg.item);
          detail.items.sort((a, b) => a.seq - b.seq);
        }
        for (const view of views()) {
          if (view.threadId === msg.item.threadId) view.onItem(detail.byId.get(msg.item.id), !prev);
        }
        dock.onItem(msg.item);
        return;
      }
      case "agent_limits": {
        S.config.limits = msg.limits || {};
        for (const view of views()) view.renderComposerBar();
        agentSettings.renderUsage();
        armUsageTick();
        return;
      }
      case "agent_item_deleted": {
        const detail = S.details.get(msg.threadId);
        const item = detail?.byId.get(msg.id);
        if (!item) return;
        detail.byId.delete(msg.id);
        detail.items.splice(detail.items.indexOf(item), 1);
        for (const view of views()) {
          if (view.threadId === msg.threadId) view.onItem(item, false);
        }
        return;
      }
      case "agent_delta": {
        const detail = S.details.get(msg.threadId);
        const item = detail?.byId.get(msg.itemId);
        if (!item) return;
        item.text = (item.text || "") + msg.append;
        for (const view of views()) {
          if (view.threadId === msg.threadId) view.onDelta(item);
        }
        dock.onDelta(item);
        return;
      }
      case "agent_browser": {
        if (msg.view) S.browsers.set(msg.threadId, msg.view);
        else S.browsers.delete(msg.threadId);
        for (const view of views()) {
          if (view.threadId === msg.threadId) view.renderHeader();
        }
        return;
      }
      case "agent_turn_deleted": {
        const detail = S.details.get(msg.threadId);
        if (!detail) return;
        detail.turns.delete(msg.id);
        for (const view of views()) {
          if (view.threadId === msg.threadId) view.onTurn({ id: msg.id, threadId: msg.threadId, status: "deleted" });
        }
        return;
      }
      case "agent_turn": {
        const detail = S.details.get(msg.turn.threadId);
        if (!detail) return;
        detail.turns.set(msg.turn.id, msg.turn);
        for (const view of views()) {
          if (view.threadId === msg.turn.threadId) view.onTurn(msg.turn);
        }
        dock.onTurn(msg.turn);
        return;
      }
      default:
        return;
    }
  }

  /* ---------- scope helpers ---------- */

  function activeTab() {
    return app()?.activeTab?.() || null;
  }

  function folderPath(folderId) {
    if (!folderId) return null;
    const folders = app()?.folders?.() || [];
    const byId = new Map(folders.map((f) => [f.id, f]));
    const parts = [];
    let cur = byId.get(folderId);
    let guard = 0;
    while (cur && guard++ < 50) {
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return parts.length ? parts.join("/") : null;
  }

  function scopeLabel(scope) {
    if (!scope || scope.kind === "global") return { icon: "globe", text: "Global" };
    if (scope.kind === "page") {
      const tab = app()?.findAnyTab?.(scope.ref);
      return { icon: "page", text: tab ? tab.title : "Missing page" };
    }
    if (scope.kind === "folder") return { icon: "folder", text: folderPath(scope.ref) || "Missing folder" };
    return { icon: "box", text: R.basename(scope.ref) || scope.ref };
  }

  function dirKey(dir) {
    return String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  /** The thread's worktree while it is open. */
  function openWorktree(t) {
    return t?.worktree && !t.worktree.closed ? t.worktree : null;
  }

  /** The folder a thread works on in the main checkout, also while it runs in a worktree. */
  function homeDir(t) {
    return openWorktree(t)?.home || t?.cwd || null;
  }

  function deletePrompt(t) {
    const wt = openWorktree(t);
    const extra = wt ? ` Its worktree folder is removed too; the work stays on branch ${wt.branch}, with uncommitted changes committed there first.` : "";
    return `Delete “${t.title}”? This removes its transcript from Scribe.${extra}`;
  }

  function archiveThread(t) {
    api("PATCH", `/threads/${t.id}`, { archived: !t.archived }).catch((e) => notice(e.message));
  }

  /** A new thread that goes on from this one; `open` shows it. */
  async function forkThread(t, open, patch = {}) {
    try {
      const { thread } = await api("POST", `/threads/${encodeURIComponent(t.id)}/fork`, patch);
      S.threads.set(thread.id, thread);
      S.details.set(thread.id, { items: [], byId: new Map(), turns: new Map() });
      open(thread.id);
    } catch (err) {
      notice(err.message);
    }
  }

  async function deleteThread(t) {
    if (!(await app().confirm(deletePrompt(t)))) return;
    await api("DELETE", `/threads/${t.id}`).catch((e) => notice(e.message));
  }

  /** Last used folders, with `prefer` first when it is not already among them. */
  function recentWorkspaceDirs(prefer) {
    const out = [];
    const seen = new Set();
    const add = (dir) => {
      if (!dir) return;
      const key = dirKey(dir);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(dir);
    };
    add(prefer);
    for (const dir of prefs().recentWorkspaces || []) add(dir);
    return out.slice(0, 3);
  }

  /** Disk folder a thread belongs to: workspace scope, else its working directory. */
  function workspaceDir(t) {
    return t.scope?.kind === "workspace" && t.scope.ref ? t.scope.ref : homeDir(t);
  }

  /** Unique disk folders that existing (non-archived) threads are attached to. */
  function threadWorkspaces() {
    const byKey = new Map();
    for (const t of S.threads.values()) {
      if (t.archived) continue;
      const dir = workspaceDir(t);
      if (!dir) continue;
      const key = dirKey(dir);
      const cur = byKey.get(key);
      if (cur) cur.n++;
      else byKey.set(key, { path: dir, n: 1 });
    }
    return [...byKey.values()].sort((a, b) => b.n - a.n || a.path.localeCompare(b.path));
  }

  function sameScope(a, b) {
    return a && b && a.kind === b.kind && (a.ref || null) === (b.ref || null);
  }

  /** Threads relevant to what the user is looking at: this page, its folders, and global. */
  function hereMatch(thread) {
    const tab = activeTab();
    const scope = thread.scope;
    if (scope.kind === "global") return true;
    if (!tab) return scope.kind === "workspace";
    if (scope.kind === "page") return scope.ref === tab.id;
    if (scope.kind === "folder") {
      const folders = app()?.folders?.() || [];
      const byId = new Map(folders.map((f) => [f.id, f]));
      let cur = tab.folderId ? byId.get(tab.folderId) : null;
      while (cur) {
        if (cur.id === scope.ref) return true;
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      return false;
    }
    return true;
  }

  function threadRank(t) {
    return (t.pinned ? 1e15 : 0) + t.activityAt;
  }

  /** Title, scope label, and workspace path — same haystack the thread list search uses. */
  function threadSearchHaystack(t) {
    return `${t.title} ${scopeLabel(t.scope).text} ${workspaceDir(t) || ""}`.toLowerCase();
  }

  function threadMatchesQuery(t, q) {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return true;
    return threadSearchHaystack(t).includes(needle);
  }

  /** Keep in sync with src/agent/threadList.ts */
  const LIST_PAGE = 10;
  const LIST_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

  function windowGroup(threads, { extra = 0, now, currentId, searching, hidePage }) {
    const hide = Boolean(hidePage) && !searching;
    const pool = hide ? threads.filter((t) => !t.fromPage || t.pinned || t.id === currentId) : threads;
    if (searching) return { visible: pool, hidden: 0 };
    const keep = new Set();
    for (const t of pool) {
      if (t.pinned || t.id === currentId) keep.add(t.id);
    }
    const recent = [];
    const older = [];
    for (const t of pool) {
      if (now - threadWhenMs(t) <= LIST_RECENT_MS) recent.push(t);
      else older.push(t);
    }
    const base = recent.slice(0, LIST_PAGE);
    const seen = new Set(base.map((t) => t.id));
    const rest = [];
    for (const t of [...recent, ...older]) {
      if (!seen.has(t.id)) rest.push(t);
    }
    for (const t of [...base, ...rest.slice(0, extra)]) keep.add(t.id);
    const visible = pool.filter((t) => keep.has(t.id));
    return { visible, hidden: pool.length - visible.length };
  }

  function setCurrent(id) {
    S.current = id;
    if (id) localStorage.setItem(LS.current, id);
    else localStorage.removeItem(LS.current);
  }

  /* ---------- generic popover menu ---------- */

  let openMenuEl = null;
  let openMenuAnchor = null;

  function closeMenu() {
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
      openMenuAnchor = null;
      document.removeEventListener("mousedown", onMenuOutside, true);
    }
  }

  function onMenuOutside(event) {
    if (!openMenuEl || openMenuEl.contains(event.target)) return;
    // A left press on the menu's own button is left to its click, which toggles the menu shut.
    if (event.button === 0 && openMenuAnchor?.contains(event.target)) return;
    closeMenu();
  }
  // Clicks inside a page iframe never reach this document; they do take focus, so blur closes the menu.
  window.addEventListener("blur", () => {
    closeMenu();
    for (const view of views()) {
      if (view.hidePicker) view.hidePicker();
      else if (view.slash) view.slash.hidden = true;
    }
  });

  /**
   * items: { label, detail?, checked?, icon?, danger?, disabled?, run?, header?, separator? }
   * Opening again from the anchor whose menu is already open closes it instead.
   */
  function openMenu(anchor, items, { search = false, width = 260, placeholder = "Search" } = {}) {
    if (openMenuEl && openMenuAnchor === anchor) {
      closeMenu();
      return null;
    }
    closeMenu();
    const menu = el("div", `ag-menu${search ? " ag-menu-keyed" : ""}`);
    menu.style.width = `${width}px`;
    const list = el("div", "ag-menu-list");
    let filter = "";
    let active = 0;
    let lastPointer = { x: -1, y: -1 };
    const rows = () => [...list.querySelectorAll(".ag-menu-item:not(:disabled)")];
    const highlight = (scroll = true) => {
      const items = rows();
      if (!items.length) return;
      active = ((active % items.length) + items.length) % items.length;
      items.forEach((row, i) => row.classList.toggle("ag-menu-active", i === active));
      if (scroll) items[active]?.scrollIntoView({ block: "nearest" });
    };
    const renderItems = () => {
      list.replaceChildren();
      const q = filter.trim().toLowerCase();
      let lastHeader = null;
      for (const item of items) {
        if (item.header) {
          lastHeader = el("div", "ag-menu-head", item.header);
          if (!q) list.append(lastHeader);
          continue;
        }
        if (item.separator) {
          if (!q) list.append(el("div", "ag-menu-sep"));
          continue;
        }
        if (q && !`${item.label} ${item.detail || ""} ${item.search || ""}`.toLowerCase().includes(q)) continue;
        if (q && lastHeader && !lastHeader.isConnected) list.append(lastHeader);
        const row = el("button", `ag-menu-item${item.checked ? " on" : ""}${item.danger ? " danger" : ""}`);
        row.type = "button";
        row.disabled = Boolean(item.disabled);
        if (search) row.tabIndex = -1;
        if (item.icon) row.append(icon(item.icon));
        const text = el("span", "ag-menu-text");
        text.append(el("span", "ag-menu-label", item.label));
        if (item.detail) text.append(el("span", "ag-menu-detail", item.detail));
        row.append(text);
        if (item.checked) row.append(icon("check", "ag-ico ag-menu-check"));
        if (item.star) {
          const star = el("span", `ag-star${item.star.on ? " on" : ""}`, item.star.on ? "★" : "☆");
          star.title = item.star.on ? "Remove from favourites" : "Add to favourites (Ctrl+' cycles them)";
          star.addEventListener("click", (event) => {
            // Starring keeps the menu open.
            event.stopPropagation();
            event.preventDefault();
            item.star.on = !item.star.on;
            star.classList.toggle("on", item.star.on);
            star.textContent = item.star.on ? "★" : "☆";
            item.star.toggle(item.star.on);
          });
          row.append(star);
        }
        row.addEventListener("click", () => {
          closeMenu();
          item.run?.();
        });
        if (search) {
          // The pointer moves the one highlight; a list scrolling under a still pointer doesn't.
          row.addEventListener("pointermove", (event) => {
            if (event.clientX === lastPointer.x && event.clientY === lastPointer.y) return;
            lastPointer = { x: event.clientX, y: event.clientY };
            const at = rows().indexOf(row);
            if (at < 0 || at === active) return;
            active = at;
            highlight(false);
          });
        }
        list.append(row);
      }
      if (!list.childElementCount) list.append(el("div", "ag-menu-empty", "Nothing matches"));
      if (search) {
        active = 0;
        highlight();
      }
    };
    if (search) {
      const input = el("input", "ag-menu-search");
      input.type = "search";
      input.placeholder = placeholder;
      input.addEventListener("input", () => {
        filter = input.value;
        renderItems();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = rows();
          if (!items.length) return;
          active += event.key === "ArrowDown" ? 1 : -1;
          highlight();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const items = rows();
          (items[active] || items[0])?.click();
        }
      });
      menu.append(input);
      setTimeout(() => input.focus(), 0);
    }
    menu.append(list);
    renderItems();
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const mh = Math.min(menu.offsetHeight, window.innerHeight - 24);
    let top = rect.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
    let left = Math.min(rect.left, window.innerWidth - width - 8);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.maxHeight = `${window.innerHeight - 24}px`;
    openMenuEl = menu;
    openMenuAnchor = anchor;
    setTimeout(() => document.addEventListener("mousedown", onMenuOutside, true), 0);
    return menu;
  }

  /* ---------- modal helper ---------- */

  function modal(cls, onClose) {
    const root = el("div", `ag-modal ${cls}`);
    const backdrop = el("div", "ag-modal-backdrop");
    const panel = el("div", "ag-modal-panel");
    root.append(backdrop, panel);
    const close = () => {
      root.remove();
      modalStack.splice(modalStack.indexOf(close), 1);
      onClose?.();
    };
    backdrop.addEventListener("mousedown", (event) => {
      event.preventDefault();
      close();
    });
    modalStack.push(close);
    document.body.append(root);
    return { root, panel, close };
  }
  const modalStack = [];

  /* ---------- rewind confirmation ---------- */

  /** Resolves { keepChanges } to go ahead, or null. Only asked when the rewind would drop more than the one turn. */
  function confirmRewind({ turns, files, page, resend }) {
    return new Promise((resolve) => {
      const { panel, close } = modal("ag-confirm");
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        close();
        resolve(value);
      };
      modalStack[modalStack.length - 1] = () => finish(null);
      const later = turns - 1;
      panel.append(
        el("h2", "ag-modal-title", resend ? "Retry this message?" : "Edit this message?"),
        el("p", "ag-modal-hint", `The chat goes back to just before it${later ? `: this turn and the ${later} after it are removed` : ": its reply is removed"}.`)
      );
      let undo = null;
      if (files || page) {
        const what = [files ? `${files} file${files === 1 ? "" : "s"}` : "", page ? "the page" : ""].filter(Boolean).join(" and ");
        const label = el("label", "ag-check");
        undo = el("input");
        undo.type = "checkbox";
        undo.checked = true;
        label.append(undo, el("span", null, `Also undo their changes to ${what}`));
        panel.append(label);
      }
      const actions = el("div", "ag-modal-actions");
      actions.append(
        el("span", "ag-grow"),
        button("Cancel", "ag-btn small", () => finish(null)),
        button(resend ? "Retry" : "Edit", "ag-btn small primary", () => finish({ keepChanges: undo ? !undo.checked : false }))
      );
      panel.append(actions);
      actions.lastElementChild.focus();
    });
  }

  /* ---------- workspace picker ---------- */

  function pickWorkspace(initial) {
    return new Promise((resolve) => {
      const { panel, close: closeModal } = modal("ag-ws");
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        closeModal();
        resolve(value);
      };
      const title = el("h2", "ag-modal-title", "Workspace folder");
      const hint = el("p", "ag-modal-hint", "Where the agent reads, edits, and runs commands for this thread.");
      const row = el("div", "ag-ws-row");
      const input = el("input", "ag-input");
      input.type = "text";
      input.placeholder = "C:\\path\\to\\project";
      input.value = initial || prefs().recentWorkspaces[0] || "";
      const use = button("Use folder", "ag-btn primary", () => finish(input.value.trim() || null));
      row.append(input, use);
      const used = el("div", "ag-ws-used");
      const withThreads = threadWorkspaces();
      if (withThreads.length) {
        used.append(el("div", "ag-ws-used-label", "Workspaces with threads"));
        for (const { path: dir, n } of withThreads) {
          const item = button("", "ag-ws-used-item", () => finish(dir), dir);
          item.append(icon("box"), el("span", "ag-ws-used-name", R.basename(dir)), el("span", "ag-ws-used-count", n === 1 ? "1 thread" : `${n} threads`));
          used.append(item);
        }
      }
      const browser = el("div", "ag-ws-browser");
      const crumbs = el("div", "ag-ws-path");
      const list = el("div", "ag-ws-list");
      browser.append(crumbs, list);
      const load = async (dir) => {
        list.replaceChildren(el("div", "ag-muted ag-ws-loading", "Loading…"));
        try {
          const data = await api("GET", `/fs?path=${encodeURIComponent(dir || "")}`);
          crumbs.replaceChildren();
          if (data.parent !== null && data.parent !== undefined) {
            crumbs.append(button("↑", "ag-btn ghost small", () => load(data.parent), "Up"));
          }
          crumbs.append(el("span", "ag-ws-cur", data.path || "This PC"));
          if (data.repo) crumbs.append(el("span", "ag-tag", "git"));
          if (data.path) input.value = data.path;
          list.replaceChildren();
          for (const d of data.dirs) {
            const item = button(d.name, "ag-ws-dir", () => load(d.path));
            item.prepend(icon("folder"));
            item.addEventListener("dblclick", () => finish(d.path));
            list.append(item);
          }
          if (!data.dirs.length) list.append(el("div", "ag-muted ag-ws-loading", data.exists === false ? "Folder not found" : "No subfolders"));
        } catch (err) {
          list.replaceChildren(el("div", "ag-muted", err.message));
        }
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") finish(input.value.trim() || null);
        if (event.key === "Escape") finish(null);
      });
      const actions = el("div", "ag-modal-actions");
      actions.append(button("Browse here", "ag-btn ghost", () => load(input.value.trim())), el("span", "ag-grow"), button("Cancel", "ag-btn", () => finish(null)));
      panel.append(title, hint, row);
      if (used.childElementCount) panel.append(used);
      panel.append(browser, actions);
      load(input.value.trim());
      setTimeout(() => input.focus(), 0);
      // Esc from the modal stack resolves as cancel.
      modalStack[modalStack.length - 1] = () => finish(null);
    });
  }

  /* ---------- Pi's model sources ---------- */

  /** Add (source null) or edit an endpoint. The API key field only sends a new key; it never shows the old one. */
  function editSource(source) {
    const { panel, close } = modal("ag-source");
    const field = (label, input, hint) => {
      const wrap = el("label", "ag-field");
      wrap.append(el("span", "ag-field-label", label), input);
      if (hint) wrap.append(el("span", "ag-muted ag-field-hint", hint));
      return wrap;
    };
    const input = (value, placeholder, type = "text") => {
      const node = el("input", "ag-input");
      node.type = type;
      node.value = value || "";
      node.placeholder = placeholder;
      node.spellcheck = false;
      return node;
    };
    const name = input(source?.name, "e.g. OpenRouter");
    const baseUrl = input(source?.baseUrl, "https://api.openai.com/v1");
    const key = input("", source?.hasKey ? "Saved (type to replace)" : "sk-…", "password");
    key.autocomplete = "off";
    const models = el("textarea", "ag-input ag-source-models");
    models.value = (source?.models || []).join("\n");
    models.placeholder = "One model id per line. Leave empty to list the endpoint's models.";
    const reasoningBox = el("input");
    reasoningBox.type = "checkbox";
    reasoningBox.checked = Boolean(source?.reasoning);
    const reasoning = el("label", "ag-check");
    reasoning.append(reasoningBox, el("span", null, "Offer reasoning levels (sent as reasoning_effort)"));
    const error = el("p", "ag-source-error");
    error.hidden = true;
    const save = async () => {
      const body = { name: name.value, baseUrl: baseUrl.value, models: models.value, reasoning: reasoningBox.checked };
      if (key.value.trim()) body.apiKey = key.value.trim();
      try {
        if (source) await api("PUT", `/model-sources/${encodeURIComponent(source.id)}`, body);
        else await api("POST", "/model-sources", body);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        return;
      }
      close();
      await sourcesChanged();
    };
    const actions = el("div", "ag-modal-actions");
    if (source) {
      actions.append(
        button("Remove", "ag-btn ghost danger", async () => {
          if (!(await app()?.confirm?.(`Remove “${source.name}”? Threads that use its models can't continue until you add it again.`, "Remove"))) return;
          await api("DELETE", `/model-sources/${encodeURIComponent(source.id)}`).catch((err) => notice(err.message));
          close();
          await sourcesChanged();
        })
      );
      if (source.hasKey) actions.append(button("Clear key", "ag-btn ghost", async () => {
        await api("PUT", `/model-sources/${encodeURIComponent(source.id)}`, { apiKey: "" }).catch((err) => notice(err.message));
        close();
        await sourcesChanged();
      }));
    }
    actions.append(el("span", "ag-grow"), button("Cancel", "ag-btn", close), button(source ? "Save" : "Add", "ag-btn primary", save));
    panel.append(
      el("h2", "ag-modal-title", source ? `Edit ${source.name}` : "Add a model source"),
      el("p", "ag-modal-hint", "Any endpoint that speaks the OpenAI Chat Completions API. Its models run through Pi. The key is stored on this PC and never shown again."),
      field("Name", name),
      field("Base URL", baseUrl, "Up to the version, e.g. …/v1. Pi calls /chat/completions under it, and Scribe /models when the list below is empty."),
      field("API key", key, source?.hasKey ? "Leave empty to keep the saved key." : "Leave empty for local servers that need none."),
      field("Models", models),
      reasoning,
      error,
      actions
    );
    setTimeout(() => (source ? baseUrl : name).focus(), 0);
  }

  /** Sources changed: the provider's status and model list follow them. */
  async function sourcesChanged() {
    await loadConfig();
    const data = await api("GET", "/models?provider=pi&refresh=1").catch(() => null);
    S.config.models.pi = data?.models || [];
    agentSettings.renderStatus();
    void agentSettings.renderSources();
    renderAll();
  }

  /* ---------- agent browser ---------- */

  async function loadBrowsers() {
    try {
      const data = await api("GET", "/browsers");
      S.browsers = new Map(data.browsers.map((view) => [view.threadId, view]));
    } catch {
      return;
    }
    for (const view of views()) view.renderHeader();
  }

  /** A KeyboardEvent as a Playwright key, or null for a lone modifier. */
  function browserKey(event) {
    if (["Shift", "Control", "Alt", "Meta", "Dead", "Unidentified", "Process"].includes(event.key)) return null;
    const printable = event.key.length === 1;
    const mods = [];
    if (event.ctrlKey) mods.push("Control");
    if (event.altKey) mods.push("Alt");
    if (event.metaKey) mods.push("Meta");
    // A printable key already carries Shift ("A", "!"); named keys need it spelled out.
    if (event.shiftKey && (!printable || mods.length)) mods.push("Shift");
    return [...mods, printable && mods.length ? event.key.toLowerCase() : event.key].join("+");
  }

  /**
   * The thread's headless agent browser, live: screencast frames of its current tab, with the
   * user's clicks, scrolls, and keys sent back to it. The agent keeps driving it meanwhile.
   */
  function openBrowser(threadId) {
    const base = `/threads/${encodeURIComponent(threadId)}/browser`;
    const source = new EventSource(`/api/agent${base}/live`);
    const { panel, close } = modal("ag-browserview", () => source.close());
    const thread = S.threads.get(threadId);
    const title = el("h2", "ag-modal-title", thread ? `Browser · ${thread.title}` : "Agent browser");
    const address = el("span", "ag-browser-url");
    const head = el("div", "ag-browser-head");
    head.append(
      title,
      address,
      el("span", "ag-grow"),
      button("Close browser", "ag-btn ghost", () => api("POST", `${base}/close`).catch((err) => notice(err.message)), "Close the agent's browser and its tabs"),
      button(icon("close"), "ag-icon-btn", () => close(), "Close this view (Esc)")
    );
    const stage = el("div", "ag-browser-stage");
    const screen = el("img", "ag-browser-screen");
    screen.alt = "";
    screen.tabIndex = 0;
    screen.draggable = false;
    screen.hidden = true;
    const empty = el("div", "ag-muted ag-pad", "Waiting for the page…");
    stage.append(screen, empty);
    panel.append(head, stage, el("div", "ag-modal-hint", "Click, scroll, and type to use the page; Ctrl+V pastes into it. The agent drives it too. Esc closes this view."));

    let frame = null;
    source.addEventListener("frame", (event) => {
      frame = JSON.parse(event.data);
      screen.src = `data:image/jpeg;base64,${frame.data}`;
      screen.hidden = false;
      empty.hidden = true;
    });
    source.addEventListener("view", (event) => {
      const view = JSON.parse(event.data);
      const tab = view?.tabs.find((t) => t.current);
      address.textContent = tab ? tab.url : "";
      address.title = tab ? `${tab.title}\n${tab.url}` : "";
      if (!tab) {
        frame = null;
        screen.hidden = true;
        empty.hidden = false;
        empty.textContent = "The agent has no browser open. It shows here when the agent opens a page.";
      }
    });

    // Inputs go one at a time, in order; a mouse move is dropped while another is on its way.
    let queue = Promise.resolve();
    let movePending = false;
    const send = (input) => {
      if (!frame) return;
      if (input.kind === "move") {
        if (movePending) return;
        movePending = true;
      }
      const body = { tab: frame.tab, ...input };
      queue = queue
        .then(() => api("POST", `${base}/input`, body))
        .catch(() => undefined)
        .finally(() => {
          if (input.kind === "move") movePending = false;
        });
    };
    const at = (event) => {
      const rect = screen.getBoundingClientRect();
      const x = Math.min(rect.right, Math.max(rect.left, event.clientX));
      const y = Math.min(rect.bottom, Math.max(rect.top, event.clientY));
      return {
        x: Math.round(((x - rect.left) * frame.width) / rect.width),
        y: Math.round(((y - rect.top) * frame.height) / rect.height),
      };
    };
    const BUTTONS = ["left", "middle", "right"];
    let pressed = false;
    screen.addEventListener("mousedown", (event) => {
      event.preventDefault();
      screen.focus();
      if (!frame) return;
      pressed = true;
      send({ kind: "down", ...at(event), button: BUTTONS[event.button] || "left", clickCount: event.detail || 1 });
    });
    screen.addEventListener("mousemove", (event) => {
      if (frame) send({ kind: "move", ...at(event) });
    });
    const onUp = (event) => {
      if (!screen.isConnected) {
        window.removeEventListener("mouseup", onUp);
        return;
      }
      if (!pressed || !frame) return;
      pressed = false;
      send({ kind: "up", ...at(event), button: BUTTONS[event.button] || "left", clickCount: event.detail || 1 });
    };
    window.addEventListener("mouseup", onUp);
    screen.addEventListener("contextmenu", (event) => event.preventDefault());
    screen.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (!frame) return;
        const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
        send({ kind: "wheel", ...at(event), dx: event.deltaX * scale, dy: event.deltaY * scale });
      },
      { passive: false }
    );
    screen.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return;
      // Ctrl+V: the paste event brings the text across, since the headless page can't read our clipboard.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
      event.preventDefault();
      event.stopPropagation();
      const key = browserKey(event);
      if (key) send({ kind: "key", key });
    });
    screen.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain");
      if (text) send({ kind: "text", text });
    });
  }

  /* ---------- diff viewer ---------- */

  /** source: { kind: "turn"|"thread"|"git", threadId?, turnId?, cwd?, path? } */
  async function openDiff(source) {
    const { panel, close } = modal("ag-diffview");
    const head = el("div", "ag-diff-head");
    const title = el("h2", "ag-modal-title", "Changes");
    const tabs = el("div", "ag-seg");
    const actions = el("div", "ag-diff-actions");
    head.append(title, el("span", "ag-grow"), tabs, actions, button(icon("close"), "ag-icon-btn", () => close(), "Close (Esc)"));
    const body = el("div", "ag-diff-body");
    const side = el("div", "ag-diff-files");
    const main = el("div", "ag-diff-main");
    body.append(side, main);
    panel.append(head, body);

    const thread = source.threadId ? S.threads.get(source.threadId) : null;
    const cwd = source.cwd || thread?.cwd || null;
    const kinds = [];
    if (source.turnId) kinds.push({ id: "turn", label: "This turn" });
    if (source.threadId) kinds.push({ id: "thread", label: "Thread" });
    if (cwd) kinds.push({ id: "git", label: openWorktree(thread) && !source.cwd ? "Branch" : "Git working tree" });
    let current = source.kind;

    const renderTabs = () => {
      tabs.replaceChildren();
      for (const k of kinds) {
        const b = button(k.label, `ag-seg-btn${k.id === current ? " on" : ""}`, () => {
          current = k.id;
          renderTabs();
          load();
        });
        tabs.append(b);
      }
    };

    const load = async () => {
      side.replaceChildren(el("div", "ag-muted ag-pad", "Loading…"));
      main.replaceChildren();
      actions.replaceChildren();
      let files = [];
      let patch = "";
      let truncated = false;
      try {
        if (current === "git") {
          // A worktree thread shows everything on its branch: commits and uncommitted changes since it started.
          const wt = openWorktree(thread);
          const base = wt && !source.cwd ? `&base=${wt.baseCommit}` : "";
          const info = await api("GET", `/git?cwd=${encodeURIComponent(cwd)}${base}`);
          if (!info.repo) {
            side.replaceChildren(el("div", "ag-muted ag-pad", "Not a git repository"));
            return;
          }
          title.textContent = `Changes · ${info.branch || R.basename(info.repo)}${base ? ` since ${wt.base || "it started"}` : ""}`;
          files = info.files || [];
          if (files.length) {
            const p = await api("GET", `/git/patch?repo=${encodeURIComponent(info.repo)}&from=${info.head}&to=${info.tree}`);
            patch = p.patch;
            truncated = p.truncated;
          }
          actions.append(button("Refresh", "ag-btn small", () => load()));
        } else {
          const turnQ = current === "turn" ? `?turn=${encodeURIComponent(source.turnId)}` : "";
          const info = await api("GET", `/threads/${encodeURIComponent(source.threadId)}/changes${turnQ}`);
          files = info.files || [];
          const p = await api("GET", `/threads/${encodeURIComponent(source.threadId)}/patch${turnQ}`);
          patch = p.patch;
          truncated = p.truncated;
          title.textContent = current === "turn" ? "Changes in this turn" : `Changes in “${thread?.title || "thread"}”`;
          if (current === "turn") {
            const turn = S.details.get(source.threadId)?.turns.get(source.turnId);
            if (turn?.beforeTree && !turn.reverted) {
              actions.append(
                button("Revert turn", "ag-btn small danger", async () => {
                  if (!(await app().confirm("Undo this turn's file changes in the working copy?", "Revert"))) return;
                  try {
                    const res = await api("POST", `/threads/${encodeURIComponent(source.threadId)}/turns/${encodeURIComponent(source.turnId)}/revert`);
                    if (res.ok) {
                      notice("Reverted the turn's changes");
                      close();
                    } else notice(res.error || "Could not revert");
                  } catch (err) {
                    notice(err.message);
                  }
                })
              );
            }
          }
        }
      } catch (err) {
        side.replaceChildren(el("div", "ag-muted ag-pad", err.message));
        return;
      }
      const parsed = R.parsePatch(patch);
      side.replaceChildren();
      const totals = files.reduce((acc, f) => ({ a: acc.a + (f.added || 0), r: acc.r + (f.removed || 0) }), { a: 0, r: 0 });
      const sum = el("div", "ag-diff-sum");
      sum.append(el("span", null, `${files.length} file${files.length === 1 ? "" : "s"}`), R.counts(totals.a, totals.r));
      side.append(sum);
      if (!files.length) {
        main.append(el("div", "ag-empty-diff", "No changes"));
        return;
      }
      const sections = new Map();
      for (const f of files) {
        const row = button("", "ag-diff-filebtn", () => {
          const target = sections.get(f.path);
          target?.scrollIntoView({ block: "start" });
          for (const b of side.querySelectorAll(".ag-diff-filebtn")) b.classList.toggle("on", b === row);
        });
        row.append(el("span", `ag-fstat s-${f.status || "M"}`, f.status || "M"), el("span", "ag-fname", R.basename(f.path)), el("span", "ag-fdir", R.dirname(f.path)), R.counts(f.added, f.removed));
        row.title = f.path;
        side.append(row);
      }
      for (const f of files) {
        const pf = parsed.find((p) => p.path === f.path) || parsed.find((p) => p.path.endsWith(f.path));
        const section = el("section", "ag-diff-section");
        const sh = el("div", "ag-diff-section-head");
        sh.append(el("span", `ag-fstat s-${f.status || "M"}`, f.status || "M"), el("span", "ag-fpath", f.oldPath ? `${f.oldPath} → ${f.path}` : f.path), R.counts(f.added, f.removed));
        section.append(sh);
        if (pf) section.append(R.renderDiffFile(pf));
        else section.append(el("div", "ag-muted ag-pad", f.binary ? "Binary file" : "No text diff"));
        sections.set(f.path, section);
        main.append(section);
      }
      if (truncated) main.append(el("div", "ag-muted ag-pad", "The diff was cut off because it is very large."));
      if (source.path) sections.get(source.path)?.scrollIntoView({ block: "start" });
    };
    renderTabs();
    load();
  }

  /* ---------- chat view ---------- */

  class ChatView {
    /** variant: "side" | "full" | "dock" */
    constructor(variant) {
      this.variant = variant;
      this.threadId = null;
      /** A thread that does not exist yet: { scope, settings }. */
      this.draft = null;
      this.expanded = new Set();
      this.dirtyTurns = new Set();
      this.dirtyAll = false;
      this.raf = 0;
      this.mdTimers = new Map();
      /** Files waiting in the composer: { name, mimeType, size, data (base64), url (blob: for previews) }. */
      this.attachments = [];
      this.drafts = new Map();
      this.mentions = [];
      this.mentionGen = 0;
      this.mentionTimer = 0;
      this.mentionLoading = false;
      this.contextOn = variant === "dock";

      this.root = el("div", `ag-view ag-view-${variant}`);
      this.header = el("div", "ag-thead");
      this.scroll = el("div", "ag-scroll");
      this.transcript = el("div", "ag-transcript");
      this.scroll.append(this.transcript);
      this.composer = this.buildComposer();
      if (variant !== "dock") this.root.append(this.header);
      this.root.append(this.scroll, this.composer);
      this.scroll.addEventListener("scroll", () => {
        this.stick = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80;
      });
      this.stick = true;
      this.root.addEventListener("click", (event) => onLinkClick(event));
    }

    thread() {
      return this.threadId ? S.threads.get(this.threadId) || null : null;
    }

    /** Settings shown in the composer: the thread's, or the draft's. */
    settings() {
      const t = this.thread();
      if (t) return t;
      const p = prefs();
      const d = this.draft || { scope: { kind: "global", ref: null }, settings: {} };
      const provider = d.settings.provider || (providerAvailable(p.provider) ? p.provider : S.config.providers.find((x) => x.available)?.id || "cursor");
      const scopeKey = d.scope.kind === "global" ? "global" : `${d.scope.kind}:${d.scope.ref}`;
      const cwd = d.settings.cwd !== undefined ? d.settings.cwd : d.scope.kind === "workspace" ? d.scope.ref : p.scopeWorkspaces?.[scopeKey] || p.recentWorkspaces?.[0] || null;
      return {
        id: null,
        provider,
        model: d.settings.model || p.models?.[provider] || "default",
        effort: d.settings.effort !== undefined ? d.settings.effort : p.efforts?.[provider] ?? null,
        modelParams: d.settings.modelParams || p.modelParams?.[provider] || {},
        mode: d.settings.mode || (d.scope.kind === "page" || d.scope.kind === "folder" ? "board" : p.mode || "code"),
        approval: d.settings.approval || approvalFor(provider),
        web: webMode(d.settings.web, webMode(p.web)),
        cwd,
        // Last choice made in this workspace.
        useWorktree: d.settings.useWorktree !== undefined ? d.settings.useWorktree : Boolean(cwd && p.worktrees?.[dirKey(cwd)]),
        scope: d.scope,
        title: "New thread",
        status: "idle",
        stats: { turns: 0, files: 0, added: 0, removed: 0 },
      };
    }

    async updateSettings(patch) {
      const t = this.thread();
      if (!t) {
        this.draft = this.draft || { scope: { kind: "global", ref: null }, settings: {} };
        Object.assign(this.draft.settings, patch);
        if (patch.provider) {
          const p = prefs();
          this.draft.settings.model = patch.model || p.models?.[patch.provider] || modelsOf(patch.provider)[0]?.id || "default";
          this.draft.settings.effort = p.efforts?.[patch.provider] ?? null;
          this.draft.settings.modelParams = p.modelParams?.[patch.provider] || {};
          if (patch.approval === undefined) this.draft.settings.approval = approvalFor(patch.provider, p);
        }
        await this.rememberDraftPrefs();
        this.renderComposerBar();
        this.renderHeader();
        return;
      }
      if (patch.provider && patch.provider !== t.provider && t.stats.turns > 0) {
        // A thread keeps its provider; it goes on in a fork, which carries the conversation over.
        await forkThread(t, (id) => this.openThread(id), { provider: patch.provider, model: patch.model, ...(patch.mode ? { mode: patch.mode } : {}) });
        notice(`Forked into a new ${PROVIDER_LABEL[patch.provider]} thread`);
        return;
      }
      try {
        const { thread } = await api("PATCH", `/threads/${encodeURIComponent(t.id)}`, patch);
        S.threads.set(thread.id, thread);
        this.renderComposerBar();
        this.renderHeader();
        loadConfig();
      } catch (err) {
        notice(err.message);
      }
    }

    /** Write this draft's visible settings so the next new thread starts with them. */
    async rememberDraftPrefs() {
      const cur = this.settings();
      try {
        const data = await api("POST", "/prefs/remember", {
          provider: cur.provider,
          model: cur.model,
          effort: cur.effort,
          modelParams: cur.modelParams,
          mode: cur.mode,
          approval: cur.approval,
          web: cur.web,
          cwd: cur.cwd,
          useWorktree: Boolean(cur.useWorktree),
          scope: cur.scope,
        });
        if (data.prefs) S.config.prefs = data.prefs;
      } catch {
        /* the composer still shows the draft's settings */
      }
    }

    setThread(id) {
      if (this.threadId === id && id) return;
      this.saveDraftText();
      this.threadId = id;
      if (id) this.draft = null;
      this.expanded.clear();
      this.restoreDraftText();
      if (this.variant === "dock") dock.invalidateFeed();
      this.renderAll();
      if (id) {
        ensureDetail(id).then(() => {
          if (this.threadId === id) {
            this.stick = true;
            this.renderAll();
            if (this.variant === "dock") dock.bindFeed();
            const t = S.threads.get(id);
            if (t?.unread && this.visible()) api("POST", `/threads/${encodeURIComponent(id)}/read`).catch(() => undefined);
          }
        });
      }
    }

    /** Show a thread here, and make it the one this view comes back to. */
    openThread(id) {
      if (this.variant !== "dock") setCurrent(id);
      else dock.remember(id);
      this.setThread(id);
    }

    startDraft(scope, settings = {}) {
      this.saveDraftText();
      this.threadId = null;
      this.draft = { scope, settings };
      this.restoreDraftText();
      this.renderAll();
      if (this.variant === "dock") dock.bindFeed();
      setTimeout(() => this.focus(), 0);
    }

    draftKey() {
      return this.threadId || `draft:${this.draft?.scope?.kind}:${this.draft?.scope?.ref}`;
    }

    saveDraftText() {
      if (!this.input) return;
      this.drafts.set(this.draftKey(), { text: this.input.value, mentions: this.mentions.map((c) => ({ ...c })) });
    }

    restoreDraftText() {
      if (!this.input) return;
      const d = this.drafts.get(this.draftKey());
      this.mentions = d?.mentions ? d.mentions.map((c) => ({ ...c })) : [];
      this.input.value = d?.text || "";
      this.autosize();
    }

    visible() {
      return this.root.isConnected && this.root.offsetParent !== null;
    }

    focus() {
      this.input?.focus();
    }

    /* ----- rendering ----- */

    renderAll() {
      this.renderHeader();
      this.renderTranscript();
      this.renderComposerBar();
      this.renderContext();
    }

    renderHeader() {
      if (this.variant === "dock") return;
      const t = this.thread();
      const s = this.settings();
      this.header.replaceChildren();
      if (this.variant === "side") {
        this.header.append(
          button(icon("list"), `ag-icon-btn${sidebar.listOpen ? " on" : ""}`, () => sidebar.toggleList(), "Threads")
        );
      }
      const titleWrap = el("div", "ag-thead-title");
      const title = el("div", "ag-title", t ? t.title : "New thread");
      title.title = t ? "Double-click to rename" : "";
      if (t) title.addEventListener("dblclick", () => this.rename(title));
      const sc = scopeLabel(s.scope);
      const needsFolder = s.mode !== "board" && s.mode !== "ask" && !s.cwd;
      const scope = button("", `ag-scope-chip${needsFolder ? " warn" : ""}`, (event) => this.scopeMenu(event.currentTarget), "Page, folder, or workspace this thread belongs to");
      scope.append(icon(sc.icon), el("span", null, sc.text));
      titleWrap.append(title, scope);
      if (t && t.stats.files) {
        const ch = button("", "ag-stat-chip", () => openDiff({ kind: "thread", threadId: t.id }), "Files changed in this thread");
        ch.append(icon("diff"), el("span", null, `${t.stats.files} file${t.stats.files === 1 ? "" : "s"}`), R.counts(t.stats.added, t.stats.removed));
        titleWrap.append(ch);
      }
      this.header.append(titleWrap);
      const acts = el("div", "ag-thead-actions");
      if (s.cwd && s.mode !== "board") {
        const onBranch = openWorktree(t);
        acts.append(button(icon("git"), "ag-icon-btn", () => openDiff({ kind: "git", threadId: t?.id, ...(onBranch ? {} : { cwd: s.cwd }) }), onBranch ? `Changes on ${onBranch.branch}` : "Git working tree changes"));
      }
      if (t && S.browsers.has(t.id)) acts.append(button(icon("browser"), "ag-icon-btn", () => openBrowser(t.id), "Agent browser: watch it, click and type into it"));
      if (t) acts.append(button(icon("more"), "ag-icon-btn", (event) => this.threadMenu(event.currentTarget), "Thread actions"));
      acts.append(button(icon("gear"), "ag-icon-btn", () => agentSettings.open(), "Agent settings"));
      acts.append(button(icon("plus"), "ag-icon-btn", (event) => newThreadMenu(event.currentTarget, this), "New thread"));
      if (this.variant === "side") {
        acts.append(button(icon("expand"), "ag-icon-btn", () => enterFull("side"), "Full window (Ctrl+Shift+L, or Ctrl+Up from the chat)"));
        acts.append(button(icon("close"), "ag-icon-btn", () => sidebar.setOpen(false), "Close (Ctrl+L)"));
      } else if (this.variant === "full") {
        acts.append(button(icon("collapse"), "ag-icon-btn", () => full.close(), "Back to Scribe (Esc)"));
      }
      this.header.append(acts);
    }

    rename(titleEl) {
      const t = this.thread();
      if (!t) return;
      const input = el("input", "ag-rename");
      input.value = t.title;
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        if (save && input.value.trim() && input.value.trim() !== t.title) {
          await api("PATCH", `/threads/${encodeURIComponent(t.id)}`, { title: input.value.trim() }).catch((err) => notice(err.message));
        }
        this.renderHeader();
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") finish(true);
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
    }

    scopeMenu(anchor) {
      const s = this.settings();
      const tab = activeTab();
      const items = [{ header: "Belongs to" }];
      if (tab) items.push({ label: tab.title, detail: "This page", icon: "page", checked: s.scope.kind === "page" && s.scope.ref === tab.id, run: () => this.setScope({ kind: "page", ref: tab.id }) });
      if (tab?.folderId) items.push({ label: folderPath(tab.folderId), detail: "This page's folder", icon: "folder", checked: s.scope.kind === "folder" && s.scope.ref === tab.folderId, run: () => this.setScope({ kind: "folder", ref: tab.folderId }) });
      items.push({ label: "Global", detail: "Not tied to a page or folder", icon: "globe", checked: s.scope.kind === "global", run: () => this.setScope({ kind: "global", ref: null }) });
      items.push({ separator: true });
      const currentWs = s.scope.kind === "workspace" ? s.scope.ref : null;
      for (const dir of recentWorkspaceDirs(currentWs)) {
        items.push({
          label: R.basename(dir),
          detail: dir,
          icon: "box",
          checked: Boolean(currentWs && dirKey(dir) === dirKey(currentWs)),
          run: () => this.setWorkspace(dir),
        });
      }
      items.push({
        label: "Another workspace…",
        detail: "Browse or pick a folder with threads",
        icon: "folder",
        run: () => this.pickOtherWorkspace(),
      });
      if (s.scope.kind === "page" && s.scope.ref !== tab?.id && s.scope.ref) {
        items.push({ separator: true }, { label: "Open its page", icon: "page", run: () => app()?.openLink(s.scope.ref) });
      }
      openMenu(anchor, items, { width: 280 });
    }

    async setScope(scope) {
      const t = this.thread();
      if (!t) {
        this.draft = { scope, settings: this.draft?.settings || {} };
        this.renderAll();
        return;
      }
      await this.updateSettings({ scope });
    }

    async applyScopeSlash(name) {
      const tab = activeTab();
      if (name === "here") {
        if (!tab) {
          notice("Open a page first");
          return;
        }
        await this.setScope({ kind: "page", ref: tab.id });
        return;
      }
      if (name === "folder") {
        if (!tab?.folderId) {
          notice(tab ? "This page is not in a folder" : "Open a page first");
          return;
        }
        await this.setScope({ kind: "folder", ref: tab.folderId });
        return;
      }
      if (name === "workspace") {
        await this.pickOtherWorkspace();
        return;
      }
      if (name === "global") {
        await this.setScope({ kind: "global", ref: null });
      }
    }

    async setWorkspace(dir) {
      if (!dir) return;
      const scope = { kind: "workspace", ref: dir };
      const t = this.thread();
      if (!t) {
        this.draft = { scope, settings: { ...(this.draft?.settings || {}), cwd: dir } };
        this.renderAll();
        await this.rememberDraftPrefs();
        return;
      }
      await this.updateSettings({ scope, cwd: dir });
    }

    async pickOtherWorkspace() {
      const dir = await pickWorkspace(homeDir(this.settings()));
      if (dir) await this.setWorkspace(dir);
      this.focus();
    }

    /** Turn a new git worktree on or off for this thread, before its first message. Remembered per workspace. */
    async setWorktree(on) {
      const s = this.settings();
      if (s.cwd && !this.thread()) {
        // Existing threads remember it on the server when patched.
        const p = prefs();
        p.worktrees = { ...(p.worktrees || {}), [dirKey(s.cwd)]: on };
        api("PUT", "/prefs", { worktrees: p.worktrees }).catch(() => undefined);
      }
      await this.updateSettings({ useWorktree: on });
    }

    worktreeMenu(anchor) {
      const t = this.thread();
      const wt = openWorktree(t);
      if (!wt) return;
      const state = [wt.ahead ? `${wt.ahead} commit${wt.ahead === 1 ? "" : "s"}` : "No commits yet", wt.dirty ? "uncommitted changes" : ""].filter(Boolean).join(", ");
      openMenu(
        anchor,
        [
          { header: wt.branch },
          { label: "Changes on this branch", detail: state, icon: "diff", run: () => openDiff({ kind: "git", threadId: t.id }) },
          { label: "Copy worktree path", detail: wt.path, icon: "folder", run: () => navigator.clipboard?.writeText(wt.path) },
          { separator: true },
          {
            label: wt.base ? `Merge into ${wt.base}` : "Merge",
            detail: wt.base ? "In the main checkout, then remove the worktree" : "Made from a detached HEAD; nothing to merge into",
            icon: "git",
            disabled: !wt.base || t.status !== "idle",
            run: () => this.finishWorktree("merge"),
          },
          { label: "Leave branch", detail: "Keep the work on the branch, remove the folder", disabled: t.status !== "idle", run: () => this.finishWorktree("leave") },
        ],
        { width: 300 }
      );
    }

    async finishWorktree(how) {
      const t = this.thread();
      const wt = openWorktree(t);
      if (!wt) return;
      let st = null;
      try {
        ({ status: st } = await api("GET", `/threads/${encodeURIComponent(t.id)}/worktree`));
      } catch (err) {
        notice(err.message);
        return;
      }
      if (how === "merge" && st) {
        if (st.dirty.length) {
          notice(`The worktree has ${st.dirty.length} uncommitted file${st.dirty.length === 1 ? "" : "s"}. Ask the agent to commit them, or use Leave branch.`);
          return;
        }
        if (st.mainBranch !== wt.base) {
          notice(`The main checkout is on ${st.mainBranch || "a detached HEAD"}. Switch it to ${wt.base} to merge.`);
          return;
        }
      }
      const question =
        how === "merge"
          ? st?.ahead
            ? `Merge ${st.ahead} commit${st.ahead === 1 ? "" : "s"} from ${wt.branch} into ${wt.base} in the main checkout, and remove the worktree folder?`
            : `${wt.branch} has no new commits. Remove the worktree folder and the branch?`
          : `Remove the worktree folder and keep the work on ${wt.branch}?${st?.dirty.length ? ` Its ${st.dirty.length} uncommitted file${st.dirty.length === 1 ? " is" : "s are"} committed there first.` : ""}`;
      const after =
        how === "merge"
          ? `A new message to the thread then opens a worktree again from ${wt.base} as it is then, and goes on in the same agent session.`
          : "The thread then continues in the main checkout, in a fresh agent session.";
      if (!(await app().confirm(`${question}\n\n${after}`, how === "merge" ? "Merge" : "Leave"))) return;
      try {
        const res = await api("POST", `/threads/${encodeURIComponent(t.id)}/worktree`, { action: how });
        notice(res.message);
      } catch (err) {
        notice(err.message);
      }
    }

    threadMenu(anchor) {
      const t = this.thread();
      if (!t) return;
      openMenu(anchor, [
        { label: "Rename", run: () => { const ti = this.header.querySelector(".ag-title"); if (ti) this.rename(ti); } },
        { label: t.pinned ? "Unpin" : "Pin", run: () => api("PATCH", `/threads/${t.id}`, { pinned: !t.pinned }).catch((e) => notice(e.message)) },
        { label: t.archived ? "Unarchive" : "Archive", run: () => archiveThread(t) },
        ...(t.stats.turns ? [{ label: "Fork thread", detail: "Continue in a new thread", run: () => forkThread(t, (id) => this.openThread(id)) }] : []),
        { label: "Changes in this thread", icon: "diff", run: () => openDiff({ kind: "thread", threadId: t.id }) },
        ...(openWorktree(t) ? [{ label: "Worktree…", detail: openWorktree(t).branch, icon: "git", run: () => this.worktreeMenu(anchor) }] : []),
        ...(t.nativeId ? [{ label: "Copy session id", detail: t.nativeId, run: () => navigator.clipboard?.writeText(t.nativeId) }] : []),
        { separator: true },
        {
          label: "Delete thread",
          danger: true,
          run: () => deleteThread(t),
        },
      ]);
    }

    groups(detail) {
      const groups = [];
      const byTurn = new Map();
      for (const item of detail.items) {
        const key = item.turnId || (item.dropped ? `dropped:${item.id}` : "pending");
        let g = byTurn.get(key);
        if (!g) {
          g = { key, turn: item.turnId ? detail.turns.get(item.turnId) || null : null, items: [] };
          byTurn.set(key, g);
          groups.push(g);
        }
        g.items.push(item);
      }
      // Queued messages always sit at the end.
      const pending = byTurn.get("pending");
      if (pending) {
        groups.splice(groups.indexOf(pending), 1);
        groups.push(pending);
      }
      return groups;
    }

    renderTranscript() {
      this.transcript.replaceChildren();
      const t = this.thread();
      if (!t) {
        this.transcript.append(this.emptyState());
        return;
      }
      const detail = S.details.get(t.id);
      if (!detail) {
        this.transcript.append(el("div", "ag-loading", "Loading…"));
        return;
      }
      if (!detail.items.length) {
        this.transcript.append(this.emptyState());
        return;
      }
      if (this.variant === "dock") {
        const sc = scopeLabel(t.scope);
        const mark = el("div", "ag-scope-mark");
        mark.append(icon(sc.icon), el("span", null, `${SCOPE_KIND[t.scope.kind] || "Global"} thread · `), el("b", null, sc.text));
        if (t.scope.kind === "global") mark.replaceChildren(icon(sc.icon), el("span", null, "Global thread"));
        this.transcript.append(mark);
      }
      for (const group of this.groups(detail)) {
        this.transcript.append(this.renderGroup(group));
      }
      this.markLatest();
      this.scrollToEnd();
    }

    emptyState() {
      const s = this.settings();
      const box = el("div", "ag-empty");
      box.append(icon("sparkle", "ag-empty-ico"));
      const sc = scopeLabel(s.scope);
      box.append(el("div", "ag-empty-title", this.variant === "dock" ? "Ask about this page" : "New thread"));
      const meta = el("div", "ag-empty-meta");
      meta.append(icon(sc.icon), el("span", null, sc.text));
      box.append(meta);
      if (localStorage.getItem(LS.tips) === "0") return box;
      const tips =
        s.mode === "board"
          ? ["Summarize this page", "Add a table of the key points", "Find related pages in the Library"]
          : ["Explain how this project is structured", "Find and fix the failing test", "Review my uncommitted changes"];
      const list = el("div", "ag-tips");
      for (const tip of tips) {
        list.append(
          button(tip, "ag-tip", () => {
            this.input.value = tip;
            this.autosize();
            this.focus();
          })
        );
      }
      box.append(list);
      return box;
    }

    renderGroup(group) {
      const wrap = el("div", "ag-turn");
      wrap.dataset.turn = group.key;
      // A message steered into the turn stays where the agent read it, among the steps.
      const opens = (it) => it.kind === "user" && it.steer !== "folded";
      const users = group.items.filter(opens);
      for (const user of users) wrap.append(this.renderUser(user, !group.turn && !user.dropped));
      const body = el("div", "ag-turn-body");
      const rest = group.items.filter((it) => !opens(it));
      const byParent = new Map();
      for (const it of rest) {
        if (it.parentToolId) {
          const list = byParent.get(it.parentToolId) || [];
          list.push(it);
          byParent.set(it.parentToolId, list);
        }
      }
      // Consecutive steps (reasoning, tools) hang on a rail of dots.
      const railed = true;
      let rail = null;
      const put = (node) => {
        const step = railed && (node.classList.contains("ag-reason") || node.classList.contains("ag-tool") || node.classList.contains("ag-group"));
        if (!step) {
          rail = null;
          body.append(node);
          return;
        }
        if (!rail) {
          rail = el("div", "ag-rail");
          body.append(rail);
        }
        rail.append(node);
      };
      let explore = [];
      const flush = () => {
        if (!explore.length) return;
        put(explore.length === 1 ? this.renderTool(explore[0], byParent) : this.renderExplore(explore, byParent));
        explore = [];
      };
      for (const it of rest) {
        if (it.parentToolId) continue;
        // The todos card already shows todo updates.
        if (it.kind === "tool" && it.tool === "todo") continue;
        if (it.kind === "tool" && EXPLORE.has(it.tool) && it.status !== "error") {
          explore.push(it);
          continue;
        }
        flush();
        const node = this.renderItem(it, byParent, group.turn);
        if (node) put(node);
      }
      flush();
      if (railed) {
        const rails = body.querySelectorAll(":scope > .ag-rail");
        rails[rails.length - 1]?.lastElementChild?.classList.add("ag-step-last");
        if (group.turn?.status === "running") wrap.classList.add("running");
        // Earlier turns fold their steps into one summary line, which expands them again.
        if (rails.length && group.turn) {
          const key = `s:${group.key}`;
          wrap.classList.toggle("open", this.expanded.has(key));
          const sum = button("", "ag-sum", () => this.toggle(key, wrap), "Show the steps");
          sum.append(...this.stepSummary(group), icon("chevron", "ag-ico ag-chev"));
          body.prepend(sum);
        }
      }
      if (body.childElementCount) wrap.append(body);
      if (group.turn) wrap.append(this.renderTurnFooter(group.turn, group.items));
      return wrap;
    }

    /** "Read 2 files · edited agent.css +8 −6 · 6s" for a turn whose steps are folded away. */
    stepSummary(group) {
      const tools = group.items.filter((it) => it.kind === "tool" && !it.parentToolId);
      const count = (tool) => tools.filter((it) => it.tool === tool).length;
      const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const parts = [];
      const reads = count("read");
      const searches = count("search");
      const commands = count("execute");
      const thoughts = group.items.filter((it) => it.kind === "reasoning").length;
      if (reads) parts.push(`read ${plural(reads, "file", "files")}`);
      if (searches) parts.push(plural(searches, "search", "searches"));
      if (commands) parts.push(`ran ${plural(commands, "command", "commands")}`);
      const files = group.turn?.files || [];
      const out = [];
      const push = (node) => {
        if (out.length) out.push(el("span", "ag-sum-sep", "·"));
        out.push(node);
      };
      for (const p of parts) push(el("span", null, p));
      if (files.length) {
        const edit = el("span", "ag-sum-edit");
        edit.append(el("span", null, "edited "), el("span", "ag-fname", files.length === 1 ? R.basename(files[0].path) : `${files.length} files`));
        edit.append(R.counts(files.reduce((a, f) => a + (f.added || 0), 0), files.reduce((a, f) => a + (f.removed || 0), 0)));
        push(edit);
      } else if (!parts.length) {
        push(el("span", null, thoughts ? "thought it through" : plural(tools.length, "step", "steps")));
      }
      const turn = group.turn;
      if (turn?.endedAt) {
        push(el("span", null, R.duration(turn.endedAt - turn.startedAt)));
        push(finishStamp(turn.endedAt));
      }
      const first = out[0];
      if (first?.firstChild?.nodeType === Node.TEXT_NODE) first.textContent = first.textContent.charAt(0).toUpperCase() + first.textContent.slice(1);
      else if (first?.firstElementChild) first.firstElementChild.textContent = "Edited ";
      return out;
    }

    /** Every turn but the latest folds its steps; this marks that one after each render. */
    markLatest() {
      const turns = [...this.transcript.querySelectorAll(".ag-turn")].filter((n) => !n.dataset.turn.startsWith("pending") && !n.dataset.turn.startsWith("dropped"));
      const last = turns[turns.length - 1];
      for (const n of turns) n.classList.toggle("latest", n === last);
    }

    renderUser(item, queued) {
      const row = el("div", `ag-user${queued ? " queued" : ""}`);
      row.dataset.itemId = item.id;
      const bubble = el("div", "ag-user-bubble");
      if (item.context?.length || item.images?.length || item.files?.length) {
        const chips = el("div", "ag-chips");
        for (const c of item.context || []) {
          const chip = el("span", "ag-chip small");
          chip.title = chipTitle(c);
          chip.append(icon(chipIcon(c)), el("span", null, chipLabel(c)));
          chips.append(chip);
        }
        const sent = [...(item.images || []), ...(item.files || [])];
        const previews = sent.filter((f) => f.id).map((f) => ({ ...f, url: sentFileUrl(item.threadId, f.id) }));
        for (const file of sent) {
          if (!file.id) {
            // Sent before files were kept: only the name is known.
            const chip = el("span", "ag-chip small");
            chip.append(icon(file.mimeType?.startsWith("image/") ? "image" : "read"), el("span", null, file.name));
            chips.append(chip);
            continue;
          }
          const at = previews.findIndex((f) => f.id === file.id);
          chips.append(fileChip(previews[at], () => window.scribePreview?.open(previews, at)));
        }
        bubble.append(chips);
      }
      bubble.append(el("div", "ag-user-text", item.text));
      if (item.card) bubble.prepend(el("div", "ag-from-page", item.card.resume ? `Continue card #${item.card.num}` : `Comment on card #${item.card.num}`));
      else if (item.from === "page") bubble.prepend(el("div", "ag-from-page", "Sent by the page"));
      // Your turn is marked with an arrow instead of a bubble.
      row.append(icon("you", "ag-ico ag-you"));
      row.append(bubble);
      const actions = el("div", "ag-user-actions");
      if (item.text) {
        const copy = button(icon("copy"), "ag-icon-btn ag-user-copy", () => {
          navigator.clipboard?.writeText(item.text)?.then(() => {
            copy.classList.add("done");
            setTimeout(() => copy.classList.remove("done"), 1200);
          });
        }, "Copy message");
        actions.append(copy);
      }
      if (item.turnId && !queued && !item.dropped && !item.steer) {
        actions.append(
          button(icon("revert"), "ag-icon-btn", () => this.rewindTo(item, true), "Retry: go back to before this message and send it again"),
          button(icon("edit"), "ag-icon-btn", () => this.rewindTo(item, false), "Edit: go back to before this message and change it")
        );
      }
      if (actions.childElementCount) row.append(actions);
      if (item.steer === "waiting") {
        row.classList.add("steering");
        row.append(el("div", "ag-queued", "Steering — waiting for a safe stop · Enter again to send it now"));
      } else if (item.steer === "folded") {
        row.classList.add("steered");
        row.append(el("div", "ag-queued", "Steered in"));
      } else if (queued) {
        row.append(el("div", "ag-queued", `Queued · Enter again ${emptyEnter() === "send" ? "sends it now" : "steers it in"}`));
      }
      if (item.dropped) {
        row.classList.add("dropped");
        const again = el("div", "ag-queued");
        again.append(el("span", null, "Not sent — stopped before it ran · "), button("Send again", "ag-btn tiny", () => {
          this.input.value = item.text;
          this.autosize();
          this.send();
        }));
        row.append(again);
      }
      return row;
    }

    renderItem(it, byParent, turn) {
      switch (it.kind) {
        case "user":
          return this.renderUser(it, false);
        case "text": {
          const node = el("div", "ag-md");
          node.dataset.itemId = it.id;
          R.renderMarkdown(node, it.text, mdCtx);
          return node;
        }
        case "reasoning":
          return this.renderReasoning(it);
        case "tool":
          return this.renderTool(it, byParent);
        case "approval":
          return this.renderApproval(it);
        case "question":
          return this.renderQuestion(it);
        case "plan":
          return this.renderPlan(it);
        case "todos":
          return this.renderTodos(it);
        case "notice": {
          const n = el("div", `ag-notice ${it.level}`);
          n.append(el("span", null, it.text));
          return n;
        }
        default:
          return null;
      }
    }

    toggle(key, node, cls = "open") {
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      node.classList.toggle(cls, this.expanded.has(key));
    }

    /**
     * Back to just before a message: later turns leave the chat and their changes are undone. Then
     * the message is sent again (retry) or put back in the composer (edit).
     */
    async rewindTo(item, resend) {
      const t = this.thread();
      if (!t) return;
      if (t.status !== "idle" || t.queued) return notice("Stop the running turn first");
      const detail = S.details.get(t.id);
      const from = detail?.turns.get(item.turnId);
      if (!from) return;
      const later = [...detail.turns.values()].filter((x) => x.seq >= from.seq);
      const files = new Set(later.filter((x) => !x.reverted).flatMap((x) => (x.files || []).map((f) => f.path)));
      const page = later.some((x) => x.page?.after && !x.page.reverted);
      let keepChanges = false;
      if (later.length > 1 || files.size || page) {
        const choice = await confirmRewind({ turns: later.length, files: files.size, page, resend });
        if (!choice) return;
        keepChanges = choice.keepChanges;
      }
      let msg;
      try {
        msg = await api("POST", `/threads/${encodeURIComponent(t.id)}/rewind`, { itemId: item.id, keepChanges });
      } catch (err) {
        notice(err.message);
        return;
      }
      if (resend) {
        this.stick = true;
        await api("POST", `/threads/${encodeURIComponent(t.id)}/messages`, { text: msg.text, images: msg.images, files: msg.files, context: msg.context }).catch((err) => notice(err.message));
        return;
      }
      this.input.value = msg.text || "";
      this.clearAttachments();
      this.attachments = [...(msg.images || []), ...(msg.files || [])].map((f) => ({ ...f, size: Math.floor((f.data.length * 3) / 4), url: base64Url(f.data, f.mimeType) }));
      this.restoreContextChips(msg.context);
      this.renderContext();
      this.autosize();
      this.focus();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }

    renderReasoning(it) {
      const running = !it.endedAt;
      const openDefault = localStorage.getItem(LS.reasoning) === "1";
      const key = `r:${it.id}`;
      const isOpen = this.expanded.has(key) !== openDefault;
      const node = el("div", `ag-reason${isOpen ? " open" : ""}${running ? " live" : ""}`);
      node.dataset.itemId = it.id;
      const head = button("", "ag-reason-head", () => {
        this.toggle(key, node);
      });
      const secs = it.endedAt && it.endedAt - it.startedAt >= 1000 ? R.duration(it.endedAt - it.startedAt) : "";
      head.append(icon("think"), el("span", "ag-reason-label", running ? "Thinking" : `Thought${secs ? ` for ${secs}` : ""}`), el("span", "ag-reason-preview", lastLine(it.text)), icon("chevron", "ag-ico ag-chev"));
      const body = el("div", "ag-reason-body");
      R.renderMarkdown(body, it.text, mdCtx);
      node.append(head, body);
      return node;
    }

    renderExplore(items, byParent) {
      const key = `g:${items[0].id}`;
      const running = items.some((it) => it.status === "running" || it.status === "pending");
      const node = el("div", `ag-group${this.expanded.has(key) ? " open" : ""}`);
      const reads = items.filter((it) => it.tool === "read").length;
      const searches = items.filter((it) => it.tool === "search").length;
      const other = items.length - reads - searches;
      const parts = [];
      if (reads) parts.push(`${reads} file${reads === 1 ? "" : "s"}`);
      if (searches) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
      if (other) parts.push(`${other} step${other === 1 ? "" : "s"}`);
      const head = button("", "ag-group-head", () => this.toggle(key, node));
      head.append(
        running ? el("span", "ag-spin") : icon("search"),
        el("span", "ag-group-label", `${running ? "Exploring" : "Explored"} ${parts.join(", ")}`),
        el("span", "ag-group-preview", items[items.length - 1].title),
        icon("chevron", "ag-ico ag-chev")
      );
      const body = el("div", "ag-group-body");
      for (const it of items) body.append(this.renderTool(it, byParent));
      node.append(head, body);
      return node;
    }

    renderTool(it, byParent) {
      const key = `t:${it.id}`;
      const task = it.task;
      const node = el("div", `ag-tool k-${it.tool} s-${it.status}${task ? ` has-task ts-${task.status}` : ""}${this.expanded.has(key) ? " open" : ""}`);
      node.dataset.itemId = it.id;
      const head = button("", "ag-tool-head", () => this.toggle(key, node));
      // A task outlives its tool call: a background agent is still working after the call returned.
      const busy = task ? task.status === "running" : it.status === "running" || it.status === "pending";
      const failed = task ? task.status === "error" : it.status === "error";
      const status = busy ? el("span", "ag-spin") : failed ? icon("cross", "ag-ico ag-st-err") : icon(it.tool, "ag-ico");
      head.append(status);
      const label = el("span", "ag-tool-label");
      const page = pageTool(it);
      if (page) {
        label.append(...this.pageToolLabel(page));
      } else if ((it.tool === "edit" || it.tool === "delete") && (it.files?.length || it.paths?.length)) {
        const files = it.files?.length ? it.files : it.paths.map((p) => ({ path: p }));
        label.append(el("span", "ag-tool-verb", it.tool === "delete" ? "Delete" : files.some((f) => f.status === "A") ? "Create" : "Edit"));
        for (const f of files.slice(0, 3)) {
          const chip = el("span", "ag-file");
          chip.append(el("span", "ag-fname", R.basename(f.path)));
          if (f.added !== undefined) chip.append(R.counts(f.added, f.removed));
          chip.title = f.path;
          label.append(chip);
        }
        if (files.length > 3) label.append(el("span", "ag-muted", `+${files.length - 3} more`));
      } else if (it.tool === "execute") {
        label.append(el("code", "ag-cmd", it.detail || it.title));
        if (it.detail && it.title && it.title !== it.detail && !it.title.startsWith("`")) label.title = it.title;
      } else {
        label.append(el("span", "ag-tool-title", it.title));
      }
      head.append(label);
      if (task) head.append(el("span", `ag-task-badge ts-${task.status}`, taskStatusLabel(task)));
      if (it.exitCode !== undefined && it.tool === "execute") head.append(el("span", `ag-exit${it.exitCode === 0 ? " ok" : " bad"}`, it.exitCode === 0 ? "exit 0" : `exit ${it.exitCode}`));
      if (it.endedAt && it.startedAt && it.endedAt - it.startedAt > 1500) head.append(el("span", "ag-muted ag-dur", R.duration(it.endedAt - it.startedAt)));
      head.append(icon("chevron", "ag-ico ag-chev"));
      node.append(head);
      if (task) node.append(this.renderTaskLine(it));
      const body = el("div", "ag-tool-body");
      if (page) {
        this.pageToolBody(body, it, page);
      } else if (it.tool === "execute") {
        if (it.detail && it.title && !it.title.startsWith("`") && it.title !== it.detail) body.append(el("div", "ag-tool-desc", it.title));
        // The head cuts the command to one line; the body has all of it.
        if (it.detail) body.append(el("pre", "ag-pre small ag-cmd-full", it.detail));
      } else if (it.detail && it.tool !== "execute" && !(it.tool === "task" && typeof it.input?.prompt === "string")) body.append(el("pre", "ag-pre small", it.detail));
      if (it.diff) {
        const files = R.parsePatch(it.diff);
        for (const f of files) {
          const fh = el("div", "ag-inline-diff-head");
          fh.append(el("span", "ag-fpath", f.path), R.counts(f.added, f.removed), button("Open", "ag-btn tiny", () => openDiff({ kind: "turn", threadId: it.threadId, turnId: it.turnId, path: f.path })));
          body.append(fh, R.renderDiffFile(f, { collapsedAfter: 160 }));
        }
      } else if (it.tool === "task" && typeof it.input?.prompt === "string") {
        // The brief the agent gave its subagent, readable rather than as JSON.
        const brief = el("div", "ag-task-brief");
        brief.append(el("div", "ag-task-brief-label", it.input.subagent_type ? `Brief for ${it.input.subagent_type}` : "Brief"));
        const md = el("div", "ag-md small");
        R.renderMarkdown(md, it.input.prompt, mdCtx);
        brief.append(md);
        body.append(brief);
      } else if (it.input && (it.tool === "mcp" || it.tool === "other" || it.tool === "fetch" || it.tool === "task")) {
        body.append(el("pre", "ag-pre small", jsonText(it.input)));
      }
      // A background task's tool result is only the launch receipt; its outcome is on the task line.
      if (it.output && it.tool !== "read" && !task?.background && !page) {
        const out = el("pre", "ag-pre ag-out", it.output.length > 6000 ? `${it.output.slice(0, 6000)}\n…` : it.output);
        body.append(out);
      }
      const children = byParent.get(it.toolId);
      if (children?.length) {
        const sub = el("div", "ag-subtools");
        for (const child of children) {
          const n = child.kind === "tool" ? this.renderTool(child, byParent) : this.renderItem(child, byParent);
          if (n) sub.append(n);
        }
        body.append(sub);
        const steps = children.filter((c) => c.kind === "tool").length;
        if (steps) head.querySelector(".ag-tool-label")?.append(el("span", "ag-muted", ` · ${steps} ${steps === 1 ? "step" : "steps"}`));
      }
      if (body.childElementCount) node.append(body);
      else node.classList.add("bare");
      return node;
    }

    /** A Scribe page write's head: what it did, and the page as a chip that opens it. */
    pageToolLabel(page) {
      const parts = [];
      const chip = page.ref ? this.pageChip(page) : null;
      if (page.name === "page_action") {
        if (chip) parts.push(chip);
        const text = el("span", "ag-tool-verb ag-tool-title", page.summary);
        text.title = page.summary;
        parts.push(text);
        return parts;
      }
      parts.push(el("span", "ag-tool-verb", page.verb));
      if (chip) parts.push(chip);
      if (page.summary) parts.push(el("span", "ag-muted ag-tool-title", page.summary));
      return parts;
    }

    pageChip(page) {
      const chip = el("span", "ag-page-chip", page.title);
      chip.setAttribute("role", "link");
      chip.title = `Scribe page · ${page.ref} (opens as a peek; Ctrl navigate, Shift split)`;
      chip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        app()?.openLink(page.ref, event, { mode: "peek" });
      });
      return chip;
    }

    /** A Scribe page write's body: open the page, then what changed in a readable form, and the raw call one click away. */
    pageToolBody(body, it, page) {
      const input = isRecord(it.input) ? it.input : {};
      if (page.ref) {
        const actions = el("div", "ag-page-tool-actions");
        const open = (mode) => (event) => {
          event.stopPropagation();
          app()?.openLink(page.ref, mode ? null : event, { mode });
        };
        actions.append(button("Open", "ag-btn tiny", open(null)), button("Peek", "ag-btn tiny", open("peek")), button("Split", "ag-btn tiny", open("split")));
        body.append(actions);
      }
      if (it.status === "error" && it.output) body.append(el("pre", "ag-pre ag-out", it.output.slice(0, 2000)));
      if (page.name === "page_patch") {
        const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [];
        edits.forEach((edit, i) => {
          const file = snippetDiff(String(edit.oldString ?? ""), String(edit.newString ?? ""));
          const head = el("div", "ag-inline-diff-head");
          const name = edits.length > 1 ? `Edit ${i + 1}${edit.replaceAll ? " (all matches)" : ""}` : edit.replaceAll ? "All matches" : "Edit";
          head.append(el("span", "ag-fpath", name), R.counts(file.added, file.removed));
          body.append(head, R.renderDiffFile(file, { collapsedAfter: 80 }));
        });
        if (typeof input.htmlPath === "string") body.append(el("div", "ag-tool-desc", `Replaced the HTML with ${input.htmlPath}`));
        if (typeof input.title === "string") body.append(el("div", "ag-tool-desc", `Renamed to “${input.title}”`));
      } else if (page.name === "page_update") {
        const ops = Array.isArray(input.ops) ? input.ops.filter(isRecord) : [];
        if (ops.length) {
          const list = el("div", "ag-page-ops");
          for (const op of ops.slice(0, 40)) list.append(el("div", "ag-page-op", opLine(op)));
          if (ops.length > 40) list.append(el("div", "ag-muted", `+${ops.length - 40} more`));
          body.append(list);
        }
      } else if (page.name === "page_action") {
        const args = isRecord(input.args) ? input.args : {};
        const text = [args.text, args.summary, args.note, args.description].find((v) => typeof v === "string" && v.trim());
        if (text) {
          const md = el("div", "ag-md small ag-page-tool-text");
          R.renderMarkdown(md, text, mdCtx);
          body.append(md);
        }
      }
      const rawKey = `raw:${it.id}`;
      const raw = el("div", `ag-page-raw${this.expanded.has(rawKey) ? " open" : ""}`);
      const toggle = button("Raw call", "ag-btn tiny ag-page-raw-toggle", (event) => {
        event.stopPropagation();
        this.toggle(rawKey, raw);
      });
      const shown = { ...input };
      if (typeof shown.html === "string" && shown.html.length > 600) shown.html = `${shown.html.slice(0, 600)}… (${shown.html.length} chars)`;
      const rawBody = el("div", "ag-page-raw-body");
      rawBody.append(el("pre", "ag-pre small", jsonText(shown)));
      if (it.output && it.status !== "error") rawBody.append(el("pre", "ag-pre ag-out", it.output.length > 6000 ? `${it.output.slice(0, 6000)}\n…` : it.output));
      raw.append(toggle, rawBody);
      body.append(raw);
    }

    /** Under a task's head, always visible: what it is doing now (or how it ended), its usage, and its controls. */
    renderTaskLine(it) {
      const task = it.task;
      const line = el("div", "ag-task-line");
      const running = task.status === "running";
      const what = task.summary || (running ? (task.lastTool ? `Using ${task.lastTool}` : "Starting…") : "");
      // A stopped task reports its own description as the summary; the head already says it.
      if (what && !(it.title || "").endsWith(what)) {
        const text = el("span", "ag-task-summary", what);
        text.title = what;
        line.append(text);
      }
      const usage = [];
      if (task.toolUses) usage.push(`${task.toolUses} ${task.toolUses === 1 ? "tool use" : "tool uses"}`);
      if (task.tokens) usage.push(`${task.tokens >= 1000 ? `${Math.round(task.tokens / 1000)}k` : task.tokens} tokens`);
      if (task.durationMs) usage.push(R.duration(task.durationMs));
      if (usage.length) line.append(el("span", "ag-task-usage", usage.join(" · ")));
      if (running) {
        const actions = el("span", "ag-task-actions");
        const call = (action, label) =>
          button(label, "ag-btn tiny", async (event) => {
            event.stopPropagation();
            event.currentTarget.disabled = true;
            try {
              const result = await api("POST", `/threads/${encodeURIComponent(it.threadId)}/tasks/${encodeURIComponent(it.id)}/${action}`);
              if (action === "background" && result && result.moved === false) notice("It already finished or is not running in the foreground");
            } catch (err) {
              notice(err.message);
              event.currentTarget.disabled = false;
            }
          });
        // Only a call the turn is still waiting on can move to the background.
        if (!task.background && (it.status === "running" || it.status === "pending")) actions.append(call("background", "Run in background"));
        actions.append(call("stop", "Stop"));
        line.append(actions);
      }
      if (!line.childElementCount) line.hidden = true;
      return line;
    }

    renderApproval(it) {
      const node = el("div", `ag-card ag-approval s-${it.status}`);
      node.dataset.itemId = it.id;
      if (it.status !== "pending") {
        const opt = it.options.find((o) => o.id === it.decision);
        const allowed = opt ? opt.kind.startsWith("allow") : false;
        node.classList.add("done");
        node.append(icon(it.status === "expired" ? "other" : allowed ? "check" : "cross", `ag-ico ${allowed ? "ag-st-ok" : "ag-st-err"}`), el("span", "ag-card-line", `${it.status === "expired" ? "Not answered" : opt?.label || it.decision}: ${it.title}`));
        if (it.note) node.append(el("span", "ag-muted", ` — ${it.note}`));
        return node;
      }
      const head = el("div", "ag-card-head");
      head.append(icon("shield"), el("span", "ag-card-title", it.title));
      node.append(head);
      if (it.detail) node.append(el("pre", "ag-pre small", it.detail));
      const note = el("input", "ag-input small");
      note.placeholder = "Note for the agent (optional, sent with Deny)";
      const actions = el("div", "ag-card-actions");
      for (const opt of it.options) {
        const primary = opt.kind === "allow_once";
        const b = button(opt.label, `ag-btn small${primary ? " primary" : ""}${opt.kind.startsWith("reject") ? " danger" : ""}`, async () => {
          for (const x of actions.querySelectorAll("button")) x.disabled = true;
          try {
            await api("POST", `/approvals/${encodeURIComponent(it.requestId)}`, { optionId: opt.id, note: opt.kind.startsWith("reject") ? note.value : undefined });
          } catch (err) {
            notice(err.message);
            for (const x of actions.querySelectorAll("button")) x.disabled = false;
          }
        });
        actions.append(b);
      }
      node.append(note, actions);
      return node;
    }

    renderQuestion(it) {
      if (it.page) return this.renderPageQuestion(it);
      const node = el("div", `ag-card ag-question s-${it.status}`);
      node.dataset.itemId = it.id;
      if (it.status !== "pending") {
        node.classList.add("done");
        const parts = it.questions.map((q) => {
          const picked = (it.answers?.[q.id] || []).map((id) => q.options.find((o) => o.id === id)?.label || id);
          const note = it.notes?.[q.id];
          const answer = picked.length ? picked.join(", ") : it.status === "skipped" ? "Skipped" : "—";
          return `${q.prompt}: ${answer}${note ? ` (${note})` : ""}`;
        });
        const line = el("span", "ag-card-line", parts.join(" · ") || (it.status === "skipped" ? "Skipped" : "Not answered"));
        line.title = line.textContent;
        node.append(
          icon(it.status === "answered" ? "check" : "cross", `ag-ico ${it.status === "answered" ? "ag-st-ok" : "ag-st-err"}`),
          line
        );
        return node;
      }
      const head = el("div", "ag-card-head");
      head.append(icon("question"), el("span", "ag-card-title", it.title || (it.questions.length > 1 ? "The agent has questions" : "The agent has a question")));
      node.append(head);
      const picks = new Map();
      const notes = new Map();
      for (const q of it.questions) {
        const block = el("div", "ag-q");
        if (q.header) block.append(el("div", "ag-q-header", q.header));
        block.append(el("div", "ag-q-prompt", q.prompt));
        const opts = el("div", "ag-q-opts");
        for (const o of q.options) {
          const b = button("", "ag-q-opt", () => {
            const cur = new Set(picks.get(q.id) || []);
            if (q.multi) {
              if (cur.has(o.id)) cur.delete(o.id);
              else cur.add(o.id);
            } else {
              cur.clear();
              cur.add(o.id);
            }
            picks.set(q.id, [...cur]);
            for (const x of opts.children) x.classList.toggle("on", cur.has(x.dataset.opt));
          });
          b.dataset.opt = o.id;
          b.append(el("span", "ag-q-label", o.label));
          if (o.description) b.append(el("span", "ag-q-desc", o.description));
          opts.append(b);
        }
        block.append(opts);
        const other = el("input", "ag-input small");
        other.placeholder = "Other / add detail";
        other.addEventListener("input", () => notes.set(q.id, other.value));
        block.append(other);
        node.append(block);
      }
      const actions = el("div", "ag-card-actions");
      actions.append(
        button("Submit", "ag-btn small primary", async () => {
          const answers = Object.fromEntries(it.questions.map((q) => [q.id, picks.get(q.id) || []]));
          const noteObj = Object.fromEntries([...notes].filter(([, v]) => v.trim()));
          await api("POST", `/questions/${encodeURIComponent(it.requestId)}`, { answers, notes: noteObj }).catch((err) => notice(err.message));
        }),
        button("Skip", "ag-btn small", async () => {
          await api("POST", `/questions/${encodeURIComponent(it.requestId)}`, { skip: true }).catch((err) => notice(err.message));
        })
      );
      node.append(actions);
      return node;
    }

    /** page_ask: the user answers on a form page; its submit event resumes the turn. */
    renderPageQuestion(it) {
      const node = el("div", `ag-card ag-question ag-page-ask s-${it.status}`);
      node.dataset.itemId = it.id;
      const pageTitle = app()?.resolvePages?.([it.page.key])?.[it.page.key]?.title || it.page.title;
      const open = (event) => app()?.openLink(it.page.key, event, { mode: "peek" });
      const pageLink = el("a", "ag-board-link", pageTitle);
      pageLink.tabIndex = 0;
      pageLink.title = `Scribe page · ${it.page.key} (Ctrl navigate, Shift split; opens as a peek)`;
      pageLink.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        open(event);
      });
      if (it.status !== "pending") {
        node.classList.add("done");
        const answered = it.status === "answered";
        const text = answered ? "Answered on " : it.status === "skipped" ? "Skipped · " : "Not answered · ";
        const line = el("span", "ag-card-line");
        line.append(text, pageLink);
        node.append(icon(answered ? "check" : "cross", `ag-ico ${answered ? "ag-st-ok" : "ag-st-err"}`), line);
        return node;
      }
      const head = el("div", "ag-card-head");
      head.append(icon("question"), el("span", "ag-card-title", it.title || "The agent needs your answer"));
      node.append(head);
      const body = el("div", "ag-q-prompt");
      body.append("Answer on ", pageLink, ". The agent carries on when you submit it.");
      node.append(body);
      const note = el("input", "ag-input small");
      note.placeholder = "Note for the agent (for Skip)";
      const actions = el("div", "ag-card-actions");
      actions.append(
        button("Open", "ag-btn small primary", (event) => open(event)),
        button("Skip", "ag-btn small", async () => {
          await api("POST", `/questions/${encodeURIComponent(it.requestId)}`, { skip: true, reason: note.value.trim() || undefined }).catch((err) => notice(err.message));
        })
      );
      node.append(note, actions);
      return node;
    }

    renderPlan(it) {
      const node = el("div", `ag-card ag-plan s-${it.status}`);
      node.dataset.itemId = it.id;
      const head = el("div", "ag-card-head");
      head.append(icon("todo"), el("span", "ag-card-title", it.title || "Plan"));
      if (it.status !== "pending") head.append(el("span", `ag-tag ${it.status === "accepted" ? "ok" : ""}`, it.status === "accepted" ? "Accepted" : it.status === "rejected" ? "Changes requested" : "Proposed"));
      node.append(head);
      const body = el("div", "ag-md ag-plan-body");
      R.renderMarkdown(body, it.text, mdCtx);
      node.append(body);
      if (it.status === "pending") {
        const note = el("textarea", "ag-input small");
        note.rows = 2;
        note.placeholder = "What should change? (for Request changes)";
        const actions = el("div", "ag-card-actions");
        actions.append(
          button("Accept and build", "ag-btn small primary", () => api("POST", `/plans/${encodeURIComponent(it.requestId)}`, { accepted: true }).catch((err) => notice(err.message))),
          button("Request changes", "ag-btn small", () => api("POST", `/plans/${encodeURIComponent(it.requestId)}`, { accepted: false, note: note.value }).catch((err) => notice(err.message)))
        );
        node.append(note, actions);
      }
      return node;
    }

    renderTodos(it) {
      const node = el("div", "ag-todos");
      node.dataset.itemId = it.id;
      const done = it.todos.filter((t) => t.status === "completed").length;
      const head = el("div", "ag-todos-head");
      head.append(icon("todo"), el("span", null, `Todos ${done}/${it.todos.length}`));
      node.append(head);
      for (const todo of it.todos) {
        const row = el("div", `ag-todo ${todo.status}`);
        row.append(el("span", "ag-todo-box", todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : ""), el("span", null, todo.content));
        node.append(row);
      }
      return node;
    }

    renderTurnFooter(turn, items) {
      const foot = el("div", `ag-turn-foot s-${turn.status}`);
      if (turn.status === "running") {
        const waiting = items.some((it) => (it.kind === "approval" || it.kind === "question" || it.kind === "plan") && it.status === "pending");
        foot.append(el("span", "ag-spin"), el("span", "ag-foot-label", waiting ? "Waiting for you" : "Working"), elapsed(turn.startedAt));
        foot.append(button(icon("stop"), "ag-btn tiny", () => this.stop(), "Stop"));
        return foot;
      }
      const parts = el("span", "ag-foot-meta");
      if (turn.status === "error") parts.append(el("span", "ag-st-err", "Failed"));
      else if (turn.status === "cancelled") parts.append(el("span", "ag-muted", "Stopped"));
      if (turn.endedAt) {
        parts.append(el("span", null, R.duration(turn.endedAt - turn.startedAt)));
        parts.append(finishStamp(turn.endedAt));
      }
      const usage = turn.usage || {};
      if (usage.plan?.length) parts.append(el("span", null, usage.plan.map((w) => `${planPct(w.used)} of ${planWindowShort(w)}`).join(" · ")));
      else if (usage.costUsd) parts.append(el("span", null, `$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}`));
      if (usage.outputTokens) parts.append(el("span", null, `${fmtTokens((usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0))} in · ${fmtTokens(usage.outputTokens)} out`));
      parts.append(el("span", "ag-muted", modelLabel(S.threads.get(turn.threadId)?.provider, turn.model)));
      foot.append(parts);
      if (turn.page?.after) {
        foot.append(el("span", "ag-grow"));
        const pageBtn = button(
          "",
          `ag-page-chip${turn.page.reverted ? " reverted" : ""}`,
          async () => {
            if (turn.page.reverted) return;
            if (!(await app().confirm(`Put “${turn.page.title}” back to how it was before this turn?`, "Revert"))) return;
            const res = await api("POST", `/threads/${encodeURIComponent(turn.threadId)}/turns/${encodeURIComponent(turn.id)}/revert-page`).catch((err) => ({ ok: false, error: err.message }));
            if (!res.ok) notice(res.error || "Could not revert the page");
          },
          turn.page.reverted ? "Reverted" : "Undo this turn's page edit"
        );
        pageBtn.append(icon("page"), el("span", null, turn.page.reverted ? "Page reverted" : "Page edited"));
        if (!turn.page.reverted) pageBtn.append(icon("revert"));
        foot.append(pageBtn);
      }
      const files = turn.files || [];
      if (files.length) {
        const added = files.reduce((a, f) => a + (f.added || 0), 0);
        const removed = files.reduce((a, f) => a + (f.removed || 0), 0);
        const changes = el("div", `ag-changes${turn.reverted ? " reverted" : ""}`);
        const top = button("", "ag-changes-head", () => openDiff({ kind: "turn", threadId: turn.threadId, turnId: turn.id }), "Review the diff");
        top.append(icon("diff"), el("span", null, `${turn.reverted ? "Reverted · " : ""}${files.length} file${files.length === 1 ? "" : "s"} changed`), R.counts(added, removed), el("span", "ag-grow"), el("span", "ag-link", "Review"));
        changes.append(top);
        const list = el("div", "ag-changes-list");
        for (const f of files.slice(0, 12)) {
          const row = button("", "ag-change-row", () => openDiff({ kind: "turn", threadId: turn.threadId, turnId: turn.id, path: f.path }));
          row.append(el("span", `ag-fstat s-${f.status}`, f.status), el("span", "ag-fname", R.basename(f.path)), el("span", "ag-fdir", R.dirname(f.path)), R.counts(f.added, f.removed));
          row.title = f.path;
          list.append(row);
        }
        if (files.length > 12) list.append(el("div", "ag-muted small ag-pad-x", `and ${files.length - 12} more`));
        changes.append(list);
        const wrap = el("div", "ag-turn-end");
        wrap.append(changes, foot);
        return wrap;
      }
      return foot;
    }

    /* ----- live updates ----- */

    onThread(thread, prev) {
      if (!prev || prev.title !== thread.title || prev.scope?.ref !== thread.scope?.ref || prev.stats?.files !== thread.stats?.files || prev.stats?.added !== thread.stats?.added) this.renderHeader();
      if (!prev || prev.status !== thread.status || prev.mode !== thread.mode || prev.model !== thread.model || prev.effort !== thread.effort || prev.cwd !== thread.cwd || prev.approval !== thread.approval || prev.queued !== thread.queued || prev.background !== thread.background || JSON.stringify(prev.worktree) !== JSON.stringify(thread.worktree) || prev.stats?.turns !== thread.stats?.turns) {
        this.renderComposerBar();
        if (prev && prev.cwd !== thread.cwd) this.renderHeader();
      }
      if (thread.unread && this.visible()) api("POST", `/threads/${encodeURIComponent(thread.id)}/read`).catch(() => undefined);
    }

    onItem(item, isNew) {
      if (isNew && item.kind === "user" && item.turnId === null) this.stick = true;
      this.dirtyTurns.add(item.turnId || "pending");
      // A queued message that starts a turn or is steered into one leaves the queued group.
      if ((isNew && item.turnId) || item.kind === "user") this.dirtyTurns.add("pending");
      this.schedule();
      if (item.kind === "user") this.renderContext();
    }

    onTurn(turn) {
      this.dirtyTurns.add(turn.id);
      this.schedule();
      const u = turn.usage;
      if (this.ctxMeter?.isConnected && u && (u.contextTokens != null || u.contextWindow != null)) {
        const next = contextMeter(this);
        this.ctxMeter.replaceWith(next);
        this.ctxMeter = next;
      }
      // The strip's run clock starts from the running turn, which can arrive after the thread's status.
      if (this.status && turn.status === "running" && !this.status.querySelector(".ag-clock")) this.renderComposerBar();
    }

    onDelta(item) {
      const node = this.transcript.querySelector(`[data-item-id="${item.id}"]`);
      if (!node) {
        this.dirtyTurns.add(item.turnId || "pending");
        this.schedule();
        return;
      }
      if (item.kind === "reasoning") {
        const prev = node.querySelector(".ag-reason-preview");
        if (prev) prev.textContent = lastLine(item.text);
      }
      if (this.mdTimers.has(item.id)) return;
      this.mdTimers.set(
        item.id,
        setTimeout(() => {
          this.mdTimers.delete(item.id);
          const target = item.kind === "reasoning" ? node.querySelector(".ag-reason-body") : node;
          if (target && target.isConnected) {
            const stick = this.stick;
            R.renderMarkdown(target, item.text, mdCtx);
            if (stick) this.scrollToEnd();
          }
        }, 70)
      );
    }

    schedule() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.flush();
      });
    }

    flush() {
      const t = this.thread();
      const detail = t && S.details.get(t.id);
      if (!detail) return;
      const keys = new Set(this.dirtyTurns);
      this.dirtyTurns.clear();
      if (this.transcript.querySelector(".ag-empty")) {
        this.renderTranscript();
        return;
      }
      const stick = this.stick;
      const groups = this.groups(detail);
      for (const key of keys) {
        const group = groups.find((g) => g.key === key);
        const existing = this.transcript.querySelector(`.ag-turn[data-turn="${key}"]`);
        if (!group) {
          existing?.remove();
          continue;
        }
        const fresh = this.renderGroup(group);
        if (existing) existing.replaceWith(fresh);
        else {
          const idx = groups.indexOf(group);
          const nextGroup = groups.slice(idx + 1).map((g) => this.transcript.querySelector(`.ag-turn[data-turn="${g.key}"]`)).find(Boolean);
          if (nextGroup) nextGroup.before(fresh);
          else this.transcript.append(fresh);
        }
      }
      this.markLatest();
      if (stick) this.scrollToEnd();
    }

    scrollToEnd() {
      requestAnimationFrame(() => {
        this.scroll.scrollTop = this.scroll.scrollHeight;
        this.stick = true;
      });
    }

    /* ----- composer ----- */

    buildComposer() {
      const box = el("div", "ag-composer");
      this.ctxRow = el("div", "ag-ctx");
      this.input = el("textarea", "ag-textarea");
      this.input.rows = 1;
      this.input.placeholder = this.variant === "dock" ? "Ask or make a change…" : "Message the agent…";
      this.input.title = "Enter to send · @ mentions a page, folder or file · / for commands";
      this.input.addEventListener("input", () => {
        this.autosize();
        this.updatePicker();
        this.warm();
      });
      this.input.addEventListener("keydown", (event) => this.onKey(event));
      this.input.addEventListener("keyup", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") this.updatePicker();
      });
      this.input.addEventListener("click", () => this.updatePicker());
      this.input.addEventListener("paste", (event) => this.onPaste(event));
      this.input.addEventListener("focus", () => {
        this.renderContext();
        this.warm();
      });
      this.bar = el("div", "ag-bar");
      this.slash = el("div", "ag-slash");
      this.slash.hidden = true;
      // The send button sits beside the input. The dock places it and the settings bar itself;
      // the sidebar and full window put a strip under the input with the run status and the settings.
      this.sendSlot = el("div", "ag-send-slot");
      this.forkNote = el("div", "ag-fork-note");
      this.forkNote.hidden = true;
      box.append(this.slash, this.forkNote, this.ctxRow);
      if (this.variant === "dock") {
        box.append(this.input);
      } else {
        const row = el("div", "ag-compose-row");
        row.append(this.input, this.sendSlot);
        this.status = el("span", "dock-status");
        const strip = el("div", "ag-compose-bar");
        strip.append(this.status, this.bar);
        box.append(row, strip);
      }
      // Files dropped anywhere on the composer are attached; the outline shows where a drop lands.
      let dragDepth = 0;
      const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
      box.addEventListener("dragenter", (event) => {
        if (!hasFiles(event)) return;
        dragDepth += 1;
        box.classList.add("drop-target");
      });
      box.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) box.classList.remove("drop-target");
      });
      box.addEventListener("dragover", (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      });
      box.addEventListener("drop", (event) => {
        dragDepth = 0;
        box.classList.remove("drop-target");
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length) return;
        event.preventDefault();
        this.addFiles(files);
        this.focus();
      });
      return box;
    }

    /**
     * Ask the daemon to start the provider before the message is sent: the process, the session, and
     * the model options take seconds, which would otherwise all come after Enter. Repeats only when
     * the settings change or a minute has passed.
     */
    warm() {
      const s = this.settings();
      const t = this.thread();
      if (t && t.status !== "idle") return;
      if (s.mode !== "board" && s.mode !== "ask" && !s.cwd) return;
      const key = JSON.stringify([this.draftKey(), s.provider, s.model, s.effort, s.modelParams, s.mode, s.web, s.cwd, s.scope, s.useWorktree]);
      const now = Date.now();
      if (this.lastWarm && this.lastWarm.key === key && now - this.lastWarm.at < 60_000) return;
      this.lastWarm = { key, at: now };
      if (t) {
        api("POST", `/threads/${encodeURIComponent(t.id)}/warm`).catch(() => undefined);
      } else {
        api("POST", "/warm", { provider: s.provider, model: s.model, effort: s.effort, modelParams: s.modelParams, mode: s.mode, approval: s.approval, web: s.web, cwd: s.cwd, scope: s.scope, useWorktree: Boolean(s.useWorktree) }).catch(() => undefined);
      }
    }

    autosize() {
      const el = this.input;
      const max = this.variant === "full" ? 320 : 220;
      el.style.overflowY = "hidden";
      el.style.height = "auto";
      const needed = el.scrollHeight;
      el.style.height = `${Math.min(max, needed)}px`;
      if (needed > max) el.style.overflowY = "auto";
    }

    renderContext() {
      const row = this.ctxRow;
      if (!row) return;
      row.replaceChildren();
      const tab = activeTab();
      const already = this.pageInThread(tab);
      const mentionedHere = Boolean(tab && this.mentions.some((c) => c.kind === "page" && c.id === tab.id));
      if (tab && !already && !mentionedHere) {
        const chip = button("", `ag-chip small toggle${this.contextOn ? " on" : ""}`, () => {
          this.contextOn = !this.contextOn;
          this.renderContext();
        }, this.contextOn ? "The current page is attached to your message" : "Attach the current page");
        chip.append(icon("page"), el("span", null, this.contextOn ? tab.title : `+ ${tab.title}`));
        row.append(chip);
      }
      this.mentions.forEach((chip, index) => {
        const node = el("span", "ag-chip small");
        node.title = chipTitle(chip);
        node.append(icon(chipIcon(chip)), el("span", null, chipLabel(chip)));
        node.append(button(icon("close"), "ag-chip-x", (event) => {
          event.stopPropagation();
          this.mentions.splice(index, 1);
          this.renderContext();
        }, "Remove"));
        row.append(node);
      });
      this.attachments.forEach((file, index) => {
        const chip = fileChip(file, () => window.scribePreview?.open(this.attachments, index));
        chip.append(button(icon("close"), "ag-chip-x", (event) => {
          event.stopPropagation();
          const [gone] = this.attachments.splice(index, 1);
          if (gone?.url) URL.revokeObjectURL(gone.url);
          this.renderContext();
        }, "Remove"));
        row.append(chip);
      });
      row.hidden = !row.childElementCount;
    }

    /** True when this page is already the thread's scope or was attached on an earlier message. */
    pageInThread(tab) {
      if (!tab) return false;
      const s = this.settings();
      if (s.scope?.kind === "page" && s.scope.ref === tab.id) return true;
      const items = S.details.get(this.threadId)?.items || [];
      return items.some((it) => it.kind === "user" && !it.dropped && (it.context || []).some((c) => c.kind === "page" && c.id === tab.id));
    }

    /** Pages, folders and files already on this message or earlier in the thread. */
    knownMentionKeys() {
      const keys = new Set();
      const add = (chip) => {
        const key = chipKey(chip);
        if (key) keys.add(key);
      };
      for (const chip of this.mentions) add(chip);
      const tab = activeTab();
      if (tab && this.pageInThread(tab)) keys.add(`page:${tab.id}`);
      const items = S.details.get(this.threadId)?.items || [];
      for (const it of items) {
        if (it.kind !== "user" || it.dropped) continue;
        for (const chip of it.context || []) add(chip);
      }
      return keys;
    }

    composerContext() {
      const chips = [];
      const seen = new Set();
      const push = (chip) => {
        const key = chipKey(chip);
        if (key) {
          if (seen.has(key)) return;
          seen.add(key);
        }
        chips.push(chip);
      };
      for (const chip of this.mentions) {
        if (chip.kind === "page" && this.pageInThread(chip)) continue;
        push(chip);
      }
      const tab = activeTab();
      if (this.contextOn && tab && !this.pageInThread(tab)) {
        push({ kind: "page", id: tab.id, key: tab.key, title: tab.title });
      }
      return chips;
    }

    restoreContextChips(context) {
      this.mentions = Array.isArray(context) ? context.map((c) => ({ ...c })) : [];
      const tab = activeTab();
      if (tab && this.mentions.some((c) => c.kind === "page" && c.id === tab.id)) this.contextOn = true;
    }

    hidePicker() {
      this.slash.hidden = true;
      this.mentionLoading = false;
      this.mentionGen += 1;
      clearTimeout(this.mentionTimer);
    }

    onPaste(event) {
      const files = [...(event.clipboardData?.files || [])];
      if (!files.length) return;
      // Office apps put a picture of the copied text beside the text itself: paste the text then.
      const text = event.clipboardData.getData("text/plain");
      if (text.trim() && files.every((f) => f.type.startsWith("image/"))) return;
      event.preventDefault();
      this.addFiles(files);
    }

    /** Attach pasted or dropped files, within the limits the daemon applies too. */
    addFiles(files) {
      for (const file of files) {
        const image = file.type.startsWith("image/");
        const max = image ? FILE_LIMITS.image : FILE_LIMITS.file;
        if (this.attachments.length >= FILE_LIMITS.count) return notice(`Up to ${FILE_LIMITS.count} files per message`);
        if (file.size > max) {
          notice(`${file.name || "That file"} is too big: ${image ? "images" : "files"} must be under ${max / 1024 / 1024} MB`);
          continue;
        }
        const total = this.attachments.reduce((sum, f) => sum + f.size, 0);
        if (total + file.size > FILE_LIMITS.total) {
          notice(`A message's files must add up to under ${FILE_LIMITS.total / 1024 / 1024} MB`);
          continue;
        }
        const entry = {
          name: file.name || (image ? `pasted.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*/, "")}` : "pasted file"),
          mimeType: file.type || "",
          size: file.size,
          data: null,
          url: URL.createObjectURL(file),
        };
        this.attachments.push(entry);
        const reader = new FileReader();
        reader.onload = () => {
          entry.data = String(reader.result).split(",")[1] || "";
        };
        reader.readAsDataURL(file);
      }
      this.renderContext();
    }

    /** Drop the composer's files, freeing their preview URLs. */
    clearAttachments() {
      for (const file of this.attachments) if (file.url) URL.revokeObjectURL(file.url);
      this.attachments = [];
    }

    renderComposerBar() {
      const s = this.settings();
      const t = this.thread();
      const bar = this.bar;
      bar.replaceChildren();
      this.renderForkNote(t);
      const info = modelInfo(s.provider, s.model);
      const model = button("", "ag-pill", (event) => this.modelMenu(event.currentTarget), "Model");
      model.append(el("span", `ag-prov p-${s.provider}`, PROVIDER_GLYPH[s.provider] || "?"), el("span", null, info?.label || s.model));
      bar.append(model);
      const hasEffort = info?.efforts?.length || info?.params?.some((p) => p.id !== CONTEXT_PARAM);
      if (hasEffort) {
        const effortLabel = s.effort ? info.efforts.find((e) => e.id === s.effort)?.label || s.effort : info.defaultEffort ? `${info.efforts.find((e) => e.id === info.defaultEffort)?.label || info.defaultEffort}` : "Default";
        const fast = info.params?.find((p) => p.id === "fast");
        const fastOn = fast ? (s.modelParams?.fast ?? fast.default) === "true" : false;
        const eff = button("", "ag-pill", (event) => this.effortMenu(event.currentTarget), "Reasoning and model options");
        eff.append(icon("think"), el("span", null, info.efforts.length ? effortLabel : "Options"));
        if (fastOn) eff.append(el("span", "ag-tag tiny", "fast"));
        bar.append(eff);
      }
      const mode = MODES.find((m) => m.id === s.mode) || MODES[0];
      const modeBtn = button("", `ag-pill mode-${mode.id}`, (event) => this.modeMenu(event.currentTarget), mode.detail);
      modeBtn.append(el("span", null, mode.label));
      bar.append(modeBtn);
      if (s.mode === "code") {
        const ap = APPROVALS.find((a) => a.id === s.approval) || APPROVALS[0];
        const apBtn = button("", `ag-pill ap-${ap.id}`, (event) => this.approvalMenu(event.currentTarget), approvalDetail(ap, s.provider));
        apBtn.append(icon("shield"), el("span", null, ap.label));
        bar.append(apBtn);
      }
      const wt = openWorktree(t);
      if (wt) {
        const wtBtn = button("", `ag-pill ag-wt ag-wt-icon${wt.ahead || wt.dirty ? " pending" : ""}`, (event) => this.worktreeMenu(event.currentTarget));
        wtBtn.append(icon("git"));
        wtBtn.setAttribute("aria-label", `Worktree ${wt.branch}`);
        bindHoverTip(wtBtn, () => worktreeTip(wt));
        bar.append(wtBtn);
      } else if ((s.mode === "code" || s.mode === "plan") && s.cwd && !t?.stats.turns) {
        const wtBtn = button("", `ag-pill ag-wt-icon toggle${s.useWorktree ? " on" : ""}`, () => this.setWorktree(!s.useWorktree));
        wtBtn.append(icon("git"));
        wtBtn.setAttribute("aria-label", s.useWorktree ? "Worktree on first message. Click to turn off." : "Works in the folder. Click to use a worktree.");
        bindHoverTip(wtBtn, () => worktreePendingTip(s.useWorktree));
        bar.append(wtBtn);
      }
      {
        const wm = WEB_MODES.find((w) => w.id === webMode(s.web)) || WEB_MODES[0];
        const unenforced = wm.id !== "on" && !webEnforced(s.provider);
        const detail = unenforced ? WEB_UNENFORCED : wm.id === "limited" && s.provider !== "claude" ? CURSOR_LIMITED : wm.detail;
        const web = button(
          "",
          `ag-pill toggle web-${wm.id}${wm.id !== "off" ? " on" : ""}${unenforced ? " web-unenforced" : ""}`,
          (event) => this.webMenu(event.currentTarget),
          detail
        );
        web.append(icon("fetch"));
        // The floating chat is narrow: the icon alone, with the mode in its tooltip and style.
        if (this.variant !== "dock") web.append(el("span", null, wm.id === "limited" ? "Limited" : "Web"));
        else web.classList.add("ag-web-icon");
        web.setAttribute("aria-label", `${wm.label}: ${detail}`);
        bar.append(web);
      }
      const meter = usageChip(s.provider, this.variant !== "full");
      if (meter) bar.append(meter);
      this.ctxMeter = contextMeter(this);
      bar.append(this.ctxMeter);
      const tail = this.sendSlot;
      tail.replaceChildren();
      if (this.status) {
        // Status dot and run time at the start of the strip, as in the floating chat.
        const status = t?.status || "idle";
        const start = status !== "idle" ? [...(S.details.get(t.id)?.turns.values() || [])].find((x) => x.status === "running")?.startedAt : null;
        this.status.className = `dock-status s-${status}`;
        this.status.replaceChildren(el("span", "dock-dot"));
        if (start) this.status.append(setClock(el("span", "ag-clock"), start));
      }
      if (t?.queued) tail.append(el("span", "ag-tag", `${t.queued} queued`));
      if (t?.background) tail.append(el("span", "ag-tag", `${t.background} in background`));
      const running = t && t.status !== "idle";
      if (running) {
        tail.append(button(icon("stop"), "ag-send stop", () => this.stop(), "Stop (Esc twice)"));
      }
      tail.append(button(icon("send"), "ag-send", () => this.send(), running ? "Queue message" : "Send (Enter)"));
    }

    /**
     * Above the input of a fork that has not run yet: how the earlier conversation comes along, and an
     * offer to archive the thread it came from. Both go once the first message is sent.
     */
    renderForkNote(t) {
      const note = this.forkNote;
      note.replaceChildren();
      const fork = t && !t.stats.turns ? t.fork : null;
      note.hidden = !fork;
      if (!fork) return;
      const from = S.threads.get(fork.from);
      const fromName = `“${from?.title || fork.title}”`;
      if (t.carry?.how === "summary") {
        const switched = t.provider !== fork.provider;
        const how = t.carry.summarizer
          ? `its first and last messages, and a summary of the rest written by ${t.carry.summarizer}`
          : "its messages and the last reply";
        const line = el("div", "ag-fork-line warn");
        line.append(icon("git"), el("span", null, `${switched ? `${PROVIDER_LABEL[t.provider]} can't continue a ${PROVIDER_LABEL[fork.provider]} session` : "This starts a new session"}, so ${fromName} comes along as ${how}.`));
        note.append(line);
      } else {
        const line = el("div", "ag-fork-line");
        line.append(icon("git"), el("span", null, `Continues ${fromName} with its whole conversation, in a session of its own.`));
        note.append(line);
      }
      if (from && !from.archived && !S.forkArchiveSeen.has(t.id)) {
        const line = el("div", "ag-fork-line");
        line.append(
          el("span", null, `Archive ${fromName}?`),
          button("Archive", "ag-fork-act", () => {
            S.forkArchiveSeen.add(t.id);
            archiveThread(from);
            this.renderForkNote(this.thread());
          }),
          button(icon("close"), "ag-icon-btn small", () => {
            S.forkArchiveSeen.add(t.id);
            this.renderForkNote(this.thread());
          }, "Dismiss")
        );
        note.append(line);
      }
    }

    /** Starred models only, plus the current one; "Show all models" opens the full, searchable list. */
    modelMenu(anchor, { all = false } = {}) {
      const s = this.settings();
      const favs = new Set(favoriteModels());
      const showAll = all || !favs.size;
      const items = [];
      for (const provider of PROVIDERS) {
        const status = S.config.providers.find((p) => p.id === provider);
        const models = modelsOf(provider).filter((m) => showAll || favs.has(modelKey(provider, m.id)) || (s.provider === provider && s.model === m.id));
        if (!showAll && !models.length) continue;
        items.push({ header: `${PROVIDER_LABEL[provider]}${status && !status.available ? " — unavailable" : ""}` });
        if (!models.length) {
          items.push({ label: status?.available ? "Loading models…" : status?.detail || "Not available", disabled: true });
          continue;
        }
        for (const m of models) {
          items.push({
            label: m.label,
            detail: m.id !== m.label ? m.id : m.description,
            search: `${provider} ${m.id}`,
            checked: s.provider === provider && s.model === m.id,
            disabled: !status?.available,
            star: { on: favs.has(modelKey(provider, m.id)), toggle: (on) => setFavorite(provider, m.id, on) },
            run: () => this.updateSettings(provider === s.provider ? { model: m.id } : { provider, model: m.id }),
          });
        }
      }
      if (!showAll) {
        items.push({ separator: true }, { label: "Show all models", icon: "more", run: () => this.modelMenu(anchor, { all: true }) });
      }
      openMenu(anchor, items, { search: showAll, width: 300, placeholder: "Search models · ☆ to favourite" });
    }

    effortMenu(anchor) {
      const s = this.settings();
      const info = modelInfo(s.provider, s.model);
      if (!info) return;
      const items = [];
      if (info.efforts.length) {
        items.push({ header: "Reasoning" });
        items.push({ label: "Default", detail: info.defaultEffort ? `Model default (${info.defaultEffort})` : "Model default", checked: !s.effort, run: () => this.updateSettings({ effort: null }) });
        for (const e of info.efforts) items.push({ label: e.label, checked: s.effort === e.id, run: () => this.updateSettings({ effort: e.id }) });
      }
      for (const param of info.params || []) {
        if (param.id === CONTEXT_PARAM) continue;
        items.push({ header: param.label });
        const cur = s.modelParams?.[param.id] ?? param.default;
        for (const o of param.options) {
          items.push({ label: o.label, detail: param.id === "fast" && o.id === "true" ? param.description : undefined, checked: cur === o.id, run: () => this.updateSettings({ modelParams: { ...(s.modelParams || {}), [param.id]: o.id } }) });
        }
      }
      openMenu(anchor, items, { width: 240 });
    }

    modeMenu(anchor) {
      const s = this.settings();
      openMenu(
        anchor,
        MODES.map((m) => ({ label: m.label, detail: m.detail, checked: s.mode === m.id, run: () => this.updateSettings({ mode: m.id }) })),
        { width: 290 }
      );
    }

    approvalMenu(anchor) {
      const s = this.settings();
      openMenu(
        anchor,
        APPROVALS.map((a) => ({
          label: a.label,
          detail: approvalDetail(a, s.provider),
          checked: s.approval === a.id,
          danger: a.id === "full",
          run: () => this.updateSettings({ approval: a.id }),
        })),
        { width: 300 }
      );
    }

    webMenu(anchor) {
      const s = this.settings();
      const cur = webMode(s.web);
      const items = WEB_MODES.map((w) => ({
        label: w.label,
        detail: w.id !== "on" && !webEnforced(s.provider) ? WEB_UNENFORCED : w.id === "limited" && s.provider !== "claude" ? CURSOR_LIMITED : w.detail,
        checked: cur === w.id,
        run: () => this.updateSettings({ web: w.id }),
      }));
      items.push({ separator: true }, { label: "Edit web allowlist…", icon: "shield", run: () => allowlists.open() });
      openMenu(anchor, items, { width: 300 });
    }

    onKey(event) {
      if (!this.slash.hidden) {
        const items = [...this.slash.querySelectorAll(".ag-slash-item")];
        const at = items.findIndex((i) => i.classList.contains("on"));
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!items.length) return;
          const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
          items.forEach((i, n) => i.classList.toggle("on", n === next));
          items[next]?.scrollIntoView({ block: "nearest" });
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          if (items.length) {
            event.preventDefault();
            (items[at >= 0 ? at : 0]).click();
            return;
          }
          if (this.mentionLoading || event.key === "Tab") {
            event.preventDefault();
            return;
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.hidePicker();
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.input.value.trim() && !this.attachments.length && !this.mentions.length && this.pushQueued()) return;
        this.send();
        return;
      }
      if (event.key === "ArrowUp" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !this.input.value && !this.attachments.length && !this.mentions.length && this.withdrawQueued()) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        const t = this.thread();
        if (t && t.status !== "idle") {
          const now = Date.now();
          if (this.lastEsc && now - this.lastEsc < 800) {
            event.preventDefault();
            event.stopPropagation();
            this.stop();
            this.lastEsc = 0;
            return;
          }
          this.lastEsc = now;
        }
      }
    }

    async updatePicker() {
      const value = this.input.value;
      const slash = /^\/([\w:.-]*)$/.exec(value);
      if (slash) {
        this.hidePicker();
        await this.showSlash(slash[1]);
        return;
      }
      const cur = this.input.selectionStart ?? value.length;
      const mention = mentionAt(value, cur);
      if (mention) {
        this.showMentions(mention);
        return;
      }
      if (!this.slash.hidden || this.mentionLoading) this.hidePicker();
    }

    async showSlash(typed) {
      const gen = this.mentionGen;
      const s = this.settings();
      let list = S.commands.get(s.provider);
      if (this.threadId || !list) {
        try {
          const data = await api("GET", this.threadId ? `/threads/${encodeURIComponent(this.threadId)}/commands` : `/commands?provider=${s.provider}`);
          if (data.commands?.length) {
            list = data.commands;
            S.commands.set(s.provider, list);
          }
        } catch {
          /* keep cache */
        }
      }
      if (gen !== this.mentionGen) return;
      if (!/^\/([\w:.-]*)$/.exec(this.input.value)) return;
      const q = typed.toLowerCase();
      const local = SCOPE_SLASH.filter((c) => c.name.includes(q)).map((c) => ({ ...c, local: true }));
      // The open page's template actions (#152): /<id>, with any text after it as {{input}}.
      const page = pageActions(activeTab(), "slash")
        .filter((a) => !SCOPE_SLASH.some((c) => c.name === a.id) && (a.id.includes(q) || a.label.toLowerCase().includes(q)))
        .map((a) => ({ name: a.id, description: a.description ? `${a.label}: ${a.description}` : a.label }));
      const remote = (list || []).filter(
        (c) => c.name.toLowerCase().includes(q) && !SCOPE_SLASH.some((s) => s.name === c.name.toLowerCase()) && !page.some((a) => a.name === c.name.toLowerCase())
      );
      const hits = [...local, ...page, ...remote].slice(0, 40);
      this.slash.replaceChildren();
      if (!hits.length) {
        this.slash.hidden = true;
        return;
      }
      hits.forEach((c, i) => {
        const row = button("", `ag-slash-item${i === 0 ? " on" : ""}`, () => {
          if (c.local) {
            this.input.value = "";
            this.hidePicker();
            this.autosize();
            void this.applyScopeSlash(c.name);
            this.focus();
            return;
          }
          this.input.value = `/${c.name} `;
          this.hidePicker();
          this.autosize();
          this.focus();
        });
        row.append(el("span", "ag-slash-name", `/${c.name}`), el("span", "ag-slash-desc", c.description || c.hint || ""));
        this.slash.append(row);
      });
      this.slash.hidden = false;
    }

    showMentions(mention) {
      const gen = ++this.mentionGen;
      this.mentionLoading = true;
      clearTimeout(this.mentionTimer);
      this.mentionTimer = setTimeout(() => {
        void this.loadMentions(mention, gen);
      }, mention.query ? 70 : 0);
    }

    async loadMentions(mention, gen) {
      if (gen !== this.mentionGen) return;
      const q = mention.query;
      const taken = this.knownMentionKeys();
      const s = this.settings();
      const folders = this.localFolderMentions(q, taken);
      const wantFiles = (s.mode === "code" || s.mode === "plan") && s.cwd;
      this.renderMentionPicker({ pages: [], folders, files: [], mention, loading: true });
      try {
        const [pages, folderHits, files] = await Promise.all([
          this.searchPageMentions(q, taken),
          folders.length ? Promise.resolve(folders) : this.fetchFolderMentions(q, taken),
          wantFiles ? this.searchFileMentions(s.cwd, q, taken) : Promise.resolve([]),
        ]);
        if (gen !== this.mentionGen) return;
        this.mentionLoading = false;
        this.renderMentionPicker({ pages, folders: folderHits, files, mention, loading: false });
      } catch {
        if (gen !== this.mentionGen) return;
        this.mentionLoading = false;
        this.renderMentionPicker({ pages: [], folders, files: [], mention, loading: false });
      }
    }

    localFolderMentions(query, taken) {
      const q = query.toLowerCase();
      return (app()?.folders?.() || [])
        .map((f) => ({ kind: "folder", id: f.id, path: folderPath(f.id) || f.name }))
        .filter((f) => f.path && !taken.has(`folder:${f.id}`) && (!q || f.path.toLowerCase().includes(q)))
        .slice(0, 8);
    }

    async fetchFolderMentions(query, taken) {
      try {
        const res = await fetch("/api/folders/tree");
        if (!res.ok) return [];
        const data = await res.json();
        const q = query.toLowerCase();
        return (data.folders || [])
          .filter((f) => f.path && !taken.has(`folder:${f.id}`) && (!q || String(f.path).toLowerCase().includes(q)))
          .slice(0, 8)
          .map((f) => ({ kind: "folder", id: f.id, path: f.path }));
      } catch {
        return [];
      }
    }

    async searchPageMentions(query, taken) {
      try {
        const url = `/api/search?limit=16${query ? `&query=${encodeURIComponent(query)}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.tabs || [])
          .filter((t) => t.id && t.key && !taken.has(`page:${t.id}`))
          .slice(0, 12)
          .map((t) => ({ kind: "page", id: t.id, key: t.key, title: t.title, folder: t.folder || "" }));
      } catch {
        return [];
      }
    }

    async searchFileMentions(cwd, query, taken) {
      try {
        const data = await api("GET", `/fs/files?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}&limit=16`);
        return (data.files || [])
          .filter((f) => f.path && !taken.has(`file:${f.path}`))
          .slice(0, 12)
          .map((f) => ({ kind: "file", path: f.path, name: f.name || R.basename(f.path) }));
      } catch {
        return [];
      }
    }

    renderMentionPicker({ pages, folders, files, mention, loading }) {
      this.slash.replaceChildren();
      const sections = [
        { title: "Pages", items: pages },
        { title: "Folders", items: folders },
        { title: "Files", items: files },
      ];
      let first = true;
      for (const section of sections) {
        if (!section.items.length) continue;
        this.slash.append(el("div", "ag-slash-head", section.title));
        for (const item of section.items) {
          const on = first;
          first = false;
          const row = button("", `ag-slash-item${on ? " on" : ""}`, () => this.pickMention(item, mention));
          row.addEventListener("mousedown", (event) => event.preventDefault());
          const name = item.kind === "page" ? item.title : item.kind === "folder" ? item.path : item.name || R.basename(item.path);
          const detail = item.kind === "page" ? item.folder : item.kind === "file" ? R.dirname(item.path) : "";
          row.append(icon(chipIcon(item)), el("span", "ag-slash-title", name));
          if (detail) row.append(el("span", "ag-slash-desc", detail));
          row.title = item.kind === "file" ? item.path : item.kind === "page" ? item.key : item.path;
          this.slash.append(row);
        }
      }
      if (!this.slash.querySelector(".ag-slash-item")) {
        this.slash.append(el("div", "ag-slash-empty", loading ? "Searching…" : "No matching pages, folders or files"));
      }
      this.slash.hidden = false;
    }

    pickMention(item, mention) {
      const chip =
        item.kind === "page"
          ? { kind: "page", id: item.id, key: item.key, title: item.title }
          : item.kind === "folder"
            ? { kind: "folder", id: item.id, path: item.path }
            : { kind: "file", path: item.path };
      const value = this.input.value;
      const cur = this.input.selectionStart ?? value.length;
      const at = mention || mentionAt(value, cur);
      if (at) {
        const next = `${value.slice(0, at.start)}${value.slice(at.end)}`;
        this.input.value = next;
        this.input.setSelectionRange(at.start, at.start);
      }
      const key = chipKey(chip);
      if (key && this.knownMentionKeys().has(key)) {
        this.hidePicker();
        this.autosize();
        this.focus();
        return;
      }
      if (this.mentions.length >= MENTION_LIMIT) {
        notice(`Up to ${MENTION_LIMIT} mentions per message`);
        this.hidePicker();
        this.autosize();
        this.focus();
        return;
      }
      this.mentions.push(chip);
      this.hidePicker();
      this.renderContext();
      this.autosize();
      this.focus();
    }

    async stop() {
      const t = this.thread();
      if (!t) return;
      await api("POST", `/threads/${encodeURIComponent(t.id)}/cancel`).catch((err) => notice(err.message));
    }

    /**
     * Enter on an empty composer while a turn runs: steer the first queued message into the turn,
     * or, when one is already steering (or Settings say so), stop the turn and send it now.
     */
    pushQueued() {
      const t = this.thread();
      if (!t || t.status === "idle") return false;
      const steering = (S.details.get(t.id)?.items || []).some((it) => it.kind === "user" && it.steer === "waiting");
      if (!t.queued && !steering) return false;
      const action = steering || emptyEnter() === "send" ? "send-now" : "steer";
      api("POST", `/threads/${encodeURIComponent(t.id)}/${action}`).catch((err) => notice(err.message));
      return true;
    }

    /** Up on an empty composer: take the latest queued or waiting steered message back into the input. */
    withdrawQueued() {
      const t = this.thread();
      if (!t) return false;
      const steering = (S.details.get(t.id)?.items || []).some((it) => it.kind === "user" && it.steer === "waiting");
      if (!t.queued && !steering) return false;
      api("POST", `/threads/${encodeURIComponent(t.id)}/withdraw`)
        .then((msg) => {
          if (this.input.value || this.threadId !== t.id) return;
          this.input.value = msg.text || "";
          this.clearAttachments();
          this.attachments = [...(msg.images || []), ...(msg.files || [])].map((f) => ({ ...f, size: Math.floor((f.data.length * 3) / 4), url: base64Url(f.data, f.mimeType) }));
          this.restoreContextChips(msg.context);
          this.renderContext();
          this.autosize();
          this.focus();
          this.input.setSelectionRange(this.input.value.length, this.input.value.length);
        })
        .catch((err) => notice(err.message));
      return true;
    }

    async send() {
      const text = this.input.value.trim();
      const scopeCmd = /^\/(here|folder|workspace|global)$/i.exec(text);
      if (scopeCmd && !this.attachments.length) {
        this.input.value = "";
        this.hidePicker();
        this.autosize();
        await this.applyScopeSlash(scopeCmd[1].toLowerCase());
        return;
      }
      const actionCmd = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text);
      const actionTab = actionCmd ? activeTab() : null;
      const action = actionTab ? pageActions(actionTab, "slash").find((a) => a.id === actionCmd[1]) : null;
      if (action) {
        // A selection attached from the page (Ask agent) becomes the action's {{selection}}.
        const selection = this.mentions
          .filter((c) => c.kind === "selection")
          .map((c) => c.text)
          .join("\n\n");
        if (action.selection === "required" && !selection) {
          notice(`${action.label}: select text on the page first`);
          return;
        }
        this.input.value = "";
        this.hidePicker();
        this.autosize();
        if (action.selection !== "none") this.mentions = this.mentions.filter((c) => c.kind !== "selection");
        this.renderContext();
        await runAction(actionTab, action, { selection: action.selection === "none" ? "" : selection, input: actionCmd[2] || "", view: this });
        return;
      }
      if (!text && !this.attachments.length) return;
      if (this.attachments.some((f) => f.data === null)) {
        // Still being read (a large file just dropped): try again in a moment.
        setTimeout(() => this.send(), 100);
        return;
      }
      const s = this.settings();
      if (s.mode !== "board" && s.mode !== "ask" && !s.cwd) {
        const dir = await pickWorkspace(null);
        if (!dir) return;
        const patch = { cwd: dir };
        if (s.scope.kind === "global" || s.scope.kind === "workspace") patch.scope = { kind: "workspace", ref: dir };
        await this.updateSettings(patch);
      }
      const context = this.composerContext();
      const sending = this.attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
      const images = sending.filter((f) => f.mimeType.startsWith("image/"));
      const files = sending.filter((f) => !f.mimeType.startsWith("image/"));
      const held = this.attachments;
      const heldMentions = this.mentions;
      this.attachments = [];
      this.mentions = [];
      this.input.value = "";
      this.autosize();
      this.renderContext();
      this.hidePicker();
      this.drafts.delete(this.draftKey());
      try {
        let id = this.threadId;
        if (!id) {
          const cur = this.settings();
          const { thread } = await api("POST", "/threads", {
            provider: cur.provider,
            model: cur.model,
            effort: cur.effort,
            modelParams: cur.modelParams,
            mode: cur.mode,
            approval: cur.approval,
            web: cur.web,
            cwd: cur.cwd,
            useWorktree: Boolean(cur.useWorktree),
            scope: cur.scope,
          });
          S.threads.set(thread.id, thread);
          S.details.set(thread.id, { items: [], byId: new Map(), turns: new Map() });
          id = thread.id;
          this.threadId = id;
          this.draft = null;
          if (this.variant !== "dock") setCurrent(id);
          else dock.remember(id);
          this.renderAll();
        }
        this.stick = true;
        await api("POST", `/threads/${encodeURIComponent(id)}/messages`, { text, images, files, context });
        for (const file of held) if (file.url) URL.revokeObjectURL(file.url);
        this.renderContext();
      } catch (err) {
        notice(err.message);
        if (!this.input.value && !this.attachments.length && !this.mentions.length) {
          this.input.value = text;
          this.attachments = held;
          this.mentions = heldMentions;
          this.autosize();
          this.renderContext();
        } else {
          for (const file of held) if (file.url) URL.revokeObjectURL(file.url);
        }
      }
    }
  }

  /** Markdown to one plain line for previews: link labels kept, markup dropped. */
  function plain(text) {
    return String(text || "")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, key, label) => label || key)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`#>~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function lastLine(text) {
    const lines = String(text || "").trim().split(/\n+/);
    return plain(lines[lines.length - 1] || "").slice(0, 160);
  }

  const PAGE_WRITE_TOOLS = new Set(["page_show", "page_patch", "page_update", "page_action"]);

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * A call to one of Scribe's page-writing tools, read for the chat: { name, ref, title, verb, summary }.
   * Claude names it mcp__scribe__page_show; Cursor and Pi title it "Scribe: page_show".
   */
  function pageTool(it) {
    if (it.tool !== "mcp") return null;
    const name = /^Scribe:\s+(page_\w+)/.exec(it.title || "")?.[1] || (PAGE_WRITE_TOOLS.has(it.name) ? it.name : "");
    if (!PAGE_WRITE_TOOLS.has(name)) return null;
    const input = isRecord(it.input) ? it.input : {};
    const result = parseToolJson(it.output);
    const ref = [input.key, input.id, result?.key, result?.id].find((v) => typeof v === "string" && v.trim()) || "";
    const resolved = ref ? app()?.resolvePages?.([ref])?.[ref] : null;
    const title = resolved?.title || result?.title || (typeof input.title === "string" && input.title) || ref.replace(/^scribe:/, "") || "page";
    const done = it.status === "done";
    const page = { name, ref, title, verb: "", summary: "" };
    if (name === "page_show") page.verb = done ? (result?.created ? "Created" : "Showed") : it.status === "error" ? "Show" : "Showing";
    else if (name === "page_patch") {
      page.verb = done ? "Edited" : it.status === "error" ? "Edit" : "Editing";
      const n = Array.isArray(input.edits) ? input.edits.length : 0;
      page.summary = n ? `${n} ${n === 1 ? "edit" : "edits"}` : typeof input.htmlPath === "string" ? "whole page" : typeof input.title === "string" ? "title" : "";
    } else if (name === "page_update") {
      page.verb = done ? "Updated" : it.status === "error" ? "Update" : "Updating";
      const ops = Array.isArray(input.ops) ? input.ops.filter(isRecord) : [];
      page.summary = ops.length === 1 ? opLine(ops[0]) : ops.length ? `${ops.length} changes` : "";
    } else page.summary = actionSummary(typeof input.action === "string" ? input.action : "", isRecord(input.args) ? input.args : {}, result?.result, done);
    return page;
  }

  /** The JSON object a page tool returned; its text may carry a guide or note after it. */
  function parseToolJson(output) {
    const text = String(output || "").trim();
    if (!text.startsWith("{")) return null;
    for (const end of [text.length, text.indexOf("\n}") + 2]) {
      if (end < 2) continue;
      try {
        const value = JSON.parse(text.slice(0, end));
        if (isRecord(value)) return value;
      } catch {
        /* try the next cut */
      }
    }
    return null;
  }

  /** One line for a page_action call, e.g. "Moved #12 to Done". Written for Kanban and todo pages; other actions read as "Action #12". */
  function actionSummary(action, args, result, done) {
    const ref = (v) => (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ? `#${v}` : typeof v === "string" ? v : "");
    const item = ref(args.card ?? args.item);
    const quote = (v) => {
      const text = typeof v === "string" ? v.trim() : "";
      return text ? `“${text.length > 60 ? `${text.slice(0, 60)}…` : text}”` : "";
    };
    const pick = (past, now) => (done ? past : now);
    switch (action) {
      case "list": {
        const filters = ["column", "label", "assignee", "q"].filter((k) => typeof args[k] === "string" && args[k]).map((k) => `${k} ${args[k]}`);
        return `${pick("Listed", "Listing")} ${args.archived ? "archived " : ""}items${filters.length ? ` · ${filters.join(", ")}` : ""}`;
      }
      case "get":
        return `${pick("Read", "Reading")} ${item}`.trim();
      case "create":
        return [pick("Created", "Creating"), done && isRecord(result) && result.num ? `#${result.num}` : "", quote(args.title), typeof args.column === "string" ? `in ${args.column}` : ""].filter(Boolean).join(" ");
      case "update": {
        if (args.status === null) return `${pick("Cleared the status of", "Clearing the status of")} ${item}`;
        if (isRecord(args.status) && typeof args.status.text === "string") return `${item} status: ${args.status.text}`;
        const fields = Object.keys(args).filter((k) => k !== "card" && k !== "item");
        return `${pick("Updated", "Updating")} ${item}${fields.length ? ` · ${fields.join(", ")}` : ""}`;
      }
      case "comment":
        return `${pick("Commented on", "Commenting on")} ${item}`;
      case "move":
        return `${pick("Moved", "Moving")} ${item}${args.to ? ` to ${args.to}` : ""}`;
      case "claim":
        return `${pick("Claimed", "Claiming")} ${item}${typeof args.text === "string" ? ` · ${args.text}` : ""}`;
      case "release":
        return `${pick("Released", "Releasing")} ${item}${args.to ? ` to ${args.to}` : ""}`;
      case "finish":
        return `${pick("Finished", "Finishing")} ${item}${args.to ? ` to ${args.to}` : ""}`;
      default: {
        const words = action.replace(/[_-]+/g, " ").trim() || "action";
        return `${words[0].toUpperCase()}${words.slice(1)}${item ? ` ${item}` : ""}`;
      }
    }
  }

  /** One page_update op in a short form: "merge cards/num=31 · status, title". */
  function opLine(op) {
    const path = typeof op.path === "string" ? op.path || "(whole state)" : "?";
    const brief = (v) => {
      let text;
      try {
        text = JSON.stringify(v);
      } catch {
        text = String(v);
      }
      return text === undefined ? "" : text.length > 60 ? `${text.slice(0, 60)}…` : text;
    };
    switch (op.op) {
      case "merge":
        return `merge ${path}${isRecord(op.value) ? ` · ${Object.keys(op.value).join(", ")}` : ""}`;
      case "set":
        return `set ${path} = ${brief(op.value)}`;
      case "insert":
        return `insert into ${path}${isRecord(op.value) && (op.value.title || op.value.text) ? ` · ${brief(op.value.title || op.value.text)}` : ""}`;
      case "remove":
        return `remove ${path}`;
      case "move":
        return `move ${path}${op.before ? ` before ${op.before}` : op.after ? ` after ${op.after}` : op.at !== undefined ? ` to ${op.at}` : ""}`;
      case "test":
        return `check ${path} = ${brief(op.value)}`;
      default:
        return `${op.op || "op"} ${path}`;
    }
  }

  /** An old → new snippet pair as a diff file for R.renderDiffFile, with shared leading and trailing lines as context. */
  function snippetDiff(oldText, newText) {
    const a = oldText.split("\n");
    const b = newText === "" ? [] : newText.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
    const lines = [];
    let oldNo = 1;
    let newNo = 1;
    for (let i = 0; i < head; i += 1) lines.push({ kind: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ });
    for (let i = head; i < a.length - tail; i += 1) lines.push({ kind: "del", text: a[i], oldNo: oldNo++ });
    for (let i = head; i < b.length - tail; i += 1) lines.push({ kind: "add", text: b[i], newNo: newNo++ });
    for (let i = a.length - tail; i < a.length; i += 1) lines.push({ kind: "ctx", text: a[i], oldNo: oldNo++, newNo: newNo++ });
    return { path: "", lines, added: b.length - tail - head, removed: a.length - tail - head, binary: false, status: "M" };
  }

  function jsonText(value) {
    try {
      const text = JSON.stringify(value, null, 2);
      return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
    } catch {
      return String(value);
    }
  }

  function fmtTokens(n) {
    if (!n) return "0";
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  function modelLabel(provider, id) {
    return modelInfo(provider, id)?.label || id || "";
  }

  function elapsed(start) {
    const span = el("span", "ag-elapsed", R.duration(Date.now() - start));
    span.dataset.start = String(start);
    return span;
  }

  /** Clock time of a finished turn; tooltip has the full datetime. */
  function finishStamp(ms) {
    const span = el("span", "ag-muted", R.finishTime(ms));
    span.title = new Date(ms).toLocaleString();
    return span;
  }

  /** Idle threads show when the last turn finished; running ones stay relative. */
  function threadWhenMs(t) {
    return t.status === "idle" && t.finishedAt ? t.finishedAt : t.activityAt;
  }

  function threadWhenText(t) {
    const ms = threadWhenMs(t);
    return t.status === "idle" && t.finishedAt ? R.finishTime(ms) : R.timeAgo(ms);
  }

  function threadWhen(t) {
    const ms = threadWhenMs(t);
    const span = el("span", null, threadWhenText(t));
    span.title = new Date(ms).toLocaleString();
    return span;
  }

  /** Points a stopwatch span at a start time, or clears it. Returns the span. */
  function setClock(span, start) {
    if (start) {
      span.dataset.start = String(start);
      span.textContent = clockText(Date.now() - start);
    } else {
      delete span.dataset.start;
      span.textContent = "";
    }
    return span;
  }

  /** Elapsed time as a stopwatch, "0:42" or "1:05:09". */
  function clockText(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  setInterval(() => {
    for (const span of document.querySelectorAll(".ag-elapsed[data-start]")) {
      span.textContent = R.duration(Date.now() - Number(span.dataset.start));
    }
    for (const span of document.querySelectorAll(".ag-clock[data-start]")) {
      span.textContent = clockText(Date.now() - Number(span.dataset.start));
    }
  }, 1000);

  const mdCtx = { resolvePages: (targets) => app()?.resolvePages?.(targets) || {} };

  function onLinkClick(event) {
    const board = event.target.closest?.(".ag-board-link");
    if (board) {
      event.preventDefault();
      app()?.openLink(board.dataset.boardTarget, event);
      return;
    }
    const web = event.target.closest?.("a.ag-web-link");
    if (web) {
      event.preventDefault();
      app()?.openLink(web.dataset.webHref, event);
    }
  }

  /* ---------- thread list ---------- */

  function newThreadMenu(anchor, view) {
    const tab = activeTab();
    const items = [{ header: "New thread for" }];
    if (tab) items.push({ label: tab.title, detail: "This page (Pages mode)", icon: "page", run: () => view.startDraft({ kind: "page", ref: tab.id }) });
    if (tab?.folderId) items.push({ label: folderPath(tab.folderId), detail: "This folder", icon: "folder", run: () => view.startDraft({ kind: "folder", ref: tab.folderId }) });
    items.push({ label: "Global", detail: "Not tied to a page or folder", icon: "globe", run: () => view.startDraft({ kind: "global", ref: null }) });
    items.push({ separator: true });
    for (const dir of recentWorkspaceDirs(null)) {
      items.push({ label: R.basename(dir), detail: dir, icon: "box", run: () => view.startDraft({ kind: "workspace", ref: dir }, { cwd: dir }) });
    }
    items.push({
      label: "Another workspace…",
      icon: "folder",
      run: async () => {
        const dir = await pickWorkspace(null);
        if (dir) view.startDraft({ kind: "workspace", ref: dir }, { cwd: dir });
      },
    });
    openMenu(anchor, items, { width: 280 });
  }

  function groupKey(thread) {
    if (S.filter === "workspaces") {
      const dir = workspaceDir(thread);
      return dir ? `ws:${dirKey(dir)}` : "ws";
    }
    const s = thread.scope;
    if (s.kind === "global") return "global";
    return `${s.kind}:${s.ref}`;
  }

  function groupTitle(thread) {
    if (S.filter === "workspaces") {
      const dir = workspaceDir(thread);
      return { icon: "box", text: dir ? R.basename(dir) || dir : "", kind: "Workspace" };
    }
    const s = thread.scope;
    const label = scopeLabel(s);
    const kind = s.kind === "page" ? "Page" : s.kind === "folder" ? "Folder" : s.kind === "workspace" ? "Workspace" : "Global";
    return { icon: label.icon, text: s.kind === "global" ? "Global" : label.text, kind };
  }

  /**
   * Draft for a new thread in a list group: the group's scope, with the settings of the group's
   * latest thread (threads a person started win over page-launched ones).
   */
  function groupDraft(key) {
    const members = [...S.threads.values()].filter((t) => !t.archived && groupKey(t) === key);
    const last = (members.some((t) => !t.fromPage) ? members.filter((t) => !t.fromPage) : members).sort((a, b) => b.activityAt - a.activityAt)[0];
    if (!last) return null;
    const dir = S.filter === "workspaces" ? workspaceDir(last) : null;
    const scope = dir ? { kind: "workspace", ref: dir } : { ...last.scope };
    const settings = { mode: last.mode, web: last.web, cwd: dir || homeDir(last), useWorktree: Boolean(last.useWorktree) };
    if (providerAvailable(last.provider)) {
      Object.assign(settings, { provider: last.provider, model: last.model, effort: last.effort, modelParams: { ...(last.modelParams || {}) }, approval: last.approval });
    }
    return { scope, settings };
  }

  function renderThreadList(container, { onPick, currentId, onNew, onNewIn }) {
    // Thread updates re-render the list; typing in its search box keeps the focus and the highlighted row.
    const oldSearch = container.querySelector(".ag-list-top input[type=search]");
    const hadFocus = Boolean(oldSearch) && document.activeElement === oldSearch;
    const caret = hadFocus ? [oldSearch.selectionStart, oldSearch.selectionEnd] : null;
    container.replaceChildren();
    const top = el("div", "ag-list-top");
    const search = el("input", "ag-input small");
    search.type = "search";
    search.placeholder = "Search threads";
    search.value = S.search;
    search.addEventListener("input", () => {
      S.search = search.value;
      container.dataset.activeId = "";
      fill();
    });
    // Up and Down move a highlight through the rows; Enter opens the highlighted thread. The highlight
    // shows from the first arrow press until the search box next gets the focus.
    const rows = () => [...list.querySelectorAll("button.ag-row")];
    const highlight = (at, scroll = true) => {
      const items = rows();
      if (!items.length) return;
      const i = ((at % items.length) + items.length) % items.length;
      items.forEach((row, j) => row.classList.toggle("ag-row-active", j === i));
      container.dataset.activeId = items[i].dataset.id;
      if (scroll) items[i].scrollIntoView({ block: "nearest" });
    };
    search.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = rows();
        if (!container.classList.contains("ag-list-kb")) {
          container.classList.add("ag-list-kb");
          // The first press shows the row Enter opens before it moves on.
          const shown = items.findIndex((row) => row.classList.contains("ag-row-active"));
          if (shown >= 0) {
            items[shown].scrollIntoView({ block: "nearest" });
            return;
          }
        }
        const at = items.findIndex((row) => row.classList.contains("ag-row-active"));
        highlight(at < 0 ? (event.key === "ArrowDown" ? 0 : -1) : at + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const items = rows();
        (items.find((row) => row.classList.contains("ag-row-active")) || items[0])?.click();
      }
    });
    const seg = el("div", "ag-seg small");
    for (const [id, label] of [
      ["here", "Here"],
      ["workspaces", "Workspaces"],
      ["all", "All"],
      ["archived", "Archived"],
    ]) {
      seg.append(
        button(label, `ag-seg-btn${S.filter === id ? " on" : ""}`, () => {
          S.filter = id;
          localStorage.setItem(LS.filter, id);
          renderLists();
        })
      );
    }
    const newBtn = button("", "ag-btn small primary ag-new", (event) => onNew(event.currentTarget));
    newBtn.append(icon("plus"), el("span", null, "New"));
    // Toolbox row above the threads: list toggles that change which rows show.
    const tools = el("div", "ag-list-tools");
    const hide = button("", `ag-chip small toggle${S.hidePageThreads ? " on" : ""}`, () => {
      S.hidePageThreads = !S.hidePageThreads;
      localStorage.setItem(LS.hidePage, S.hidePageThreads ? "1" : "0");
      hide.classList.toggle("on", S.hidePageThreads);
      hide.setAttribute("aria-pressed", String(S.hidePageThreads));
      fill();
    }, "Threads started by a page stay hidden until you type in them");
    hide.setAttribute("aria-pressed", String(S.hidePageThreads));
    hide.append(icon("page"), el("span", null, "Hide page-launched"));
    tools.append(hide);
    top.append(search, seg, newBtn, tools);
    const list = el("div", `ag-list${compactThreads() ? " compact" : ""}`);
    container.append(top, list);
    const fill = () => {
      list.replaceChildren();
      const q = S.search.trim().toLowerCase();
      let threads = [...S.threads.values()].filter((t) => (S.filter === "archived" ? t.archived : !t.archived));
      if (S.filter === "here") threads = threads.filter(hereMatch);
      if (S.filter === "workspaces") threads = threads.filter((t) => workspaceDir(t));
      if (q) threads = threads.filter((t) => threadMatchesQuery(t, q));
      threads.sort((a, b) => threadRank(b) - threadRank(a));
      if (!threads.length) {
        list.append(
          el(
            "div",
            "ag-list-empty",
            S.filter === "here"
              ? "No threads for this page yet. Threads for its folder and global threads show here too."
              : S.filter === "workspaces"
                ? "No threads belonging to a workspace yet."
                : "No threads"
          )
        );
        return;
      }
      const order = [];
      const groups = new Map();
      for (const t of threads) {
        const key = groupKey(t);
        if (!groups.has(key)) {
          groups.set(key, []);
          order.push(key);
        }
        groups.get(key).push(t);
      }
      const kindRank = { page: 0, folder: 1, workspace: 2, global: 3 };
      if (S.filter === "here") order.sort((a, b) => kindRank[groups.get(a)[0].scope.kind] - kindRank[groups.get(b)[0].scope.kind]);
      const now = Date.now();
      let shown = 0;
      for (const key of order) {
        const members = groups.get(key);
        const { visible, hidden } = windowGroup(members, {
          extra: S.groupExtra.get(key) || 0,
          now,
          currentId,
          searching: Boolean(q),
          hidePage: S.hidePageThreads,
        });
        if (!visible.length) continue;
        shown += visible.length;
        const first = visible[0];
        const gt = groupTitle(first);
        const head = el("div", "ag-list-group");
        const name = gt.kind === "Global" ? "" : gt.text;
        head.append(icon(gt.icon), el("span", "ag-list-group-kind", gt.kind), el("span", "ag-list-group-name", name));
        if (S.filter === "workspaces") {
          const dir = workspaceDir(first);
          if (dir) head.title = dir;
        }
        if (S.filter !== "archived") {
          const add = button(icon("plus"), "ag-icon-btn small ag-list-group-new", () => {
            const draft = groupDraft(key);
            if (draft) onNewIn(draft.scope, draft.settings);
          }, `New thread here, with the settings of its latest thread`);
          head.append(add);
        }
        list.append(head);
        for (const t of visible) list.append(threadRow(t, t.id === currentId, onPick));
        if (hidden) {
          const more = button("", "ag-list-more", () => {
            S.groupExtra.set(key, (S.groupExtra.get(key) || 0) + LIST_PAGE);
            fill();
          });
          more.append(el("span", null, "Show 10 more"), el("span", "ag-list-more-count", hidden === 1 ? "1 hidden" : `${hidden} hidden`));
          list.append(more);
        }
      }
      if (!shown) {
        list.append(
          el(
            "div",
            "ag-list-empty",
            S.hidePageThreads
              ? "No recent threads. Page-launched and older threads are hidden."
              : "No recent threads. Older threads are hidden."
          )
        );
      }
      const at = rows().findIndex((row) => row.dataset.id === container.dataset.activeId);
      highlight(Math.max(0, at), false);
    };
    fill();
    search.addEventListener("focus", () => container.classList.remove("ag-list-kb"));
    if (hadFocus) {
      // A re-render while typing keeps the highlight shown or hidden.
      const kb = container.classList.contains("ag-list-kb");
      search.focus();
      container.classList.toggle("ag-list-kb", kb);
      search.setSelectionRange(caret[0], caret[1]);
    }
  }

  /** The line under a thread's title: provider, model, when, page, changes and worktree branch. */
  function threadRowMeta(t) {
    const meta = el("span", "ag-row-meta");
    meta.append(el("span", `ag-prov p-${t.provider}`, PROVIDER_GLYPH[t.provider] || "?"), el("span", null, modelLabel(t.provider, t.model)), el("span", null, "·"), threadWhen(t));
    if (t.fromPage) meta.append(el("span", null, "·"), el("span", null, "page"));
    if (t.stats.files) meta.append(el("span", null, "·"), R.counts(t.stats.added, t.stats.removed));
    const wt = openWorktree(t);
    if (wt) {
      const branch = el("span", `ag-row-branch${wt.ahead || wt.dirty ? " pending" : ""}`);
      branch.append(icon("git"), el("span", null, wt.branch.replace(/^agent\//, "")));
      branch.title = `${wt.branch}${wt.ahead || wt.dirty ? ": work not merged yet" : ""}`;
      meta.append(branch);
    }
    return meta;
  }

  function threadRow(t, current, onPick) {
    const row = button("", `ag-row${current ? " on" : ""}${t.unread && !t.fromPage ? " unread" : ""}`, () => onPick(t.id));
    row.dataset.id = t.id;
    const dot = el("span", `ag-dot s-${t.status === "idle" && t.background ? "running" : t.status}`);
    if (t.background) dot.title = `${t.background} background ${t.background === 1 ? "task" : "tasks"} running`;
    const main = el("span", "ag-row-main");
    const title = el("span", "ag-row-title", t.title);
    if (compactThreads()) main.append(title);
    else main.append(title, threadRowMeta(t));
    row.append(dot, main);
    if (t.pinned) row.append(el("span", "ag-pin", "•"));
    row.title = t.title;
    const wrap = el("div", `ag-row-wrap${current ? " on" : ""}`);
    wrap.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(wrap, [
        { label: t.pinned ? "Unpin" : "Pin", run: () => api("PATCH", `/threads/${t.id}`, { pinned: !t.pinned }).catch((e) => notice(e.message)) },
        { label: t.archived ? "Unarchive" : "Archive", run: () => archiveThread(t) },
        ...(t.stats.turns ? [{ label: "Fork thread", run: () => forkThread(t, onPick) }] : []),
        ...(t.stats.files ? [{ label: "Changes in this thread", icon: "diff", run: () => openDiff({ kind: "thread", threadId: t.id }) }] : []),
        { separator: true },
        {
          label: "Delete thread",
          danger: true,
          run: () => deleteThread(t),
        },
      ], { width: 220 });
    });
    const acts = el("div", "ag-row-actions");
    acts.append(
      button(icon("archive"), "ag-icon-btn small", (e) => {
        e.stopPropagation();
        archiveThread(t);
      }, t.archived ? "Unarchive" : "Archive"),
      button(icon("trash"), "ag-icon-btn small danger", (e) => {
        e.stopPropagation();
        void deleteThread(t);
      }, "Delete thread"),
    );
    wrap.append(row, acts);
    return wrap;
  }

  /* ---------- sidebar pane ---------- */

  const sidebar = {
    pane: null,
    view: new ChatView("side"),
    listEl: el("div", "ag-listview"),
    listOpen: false,
    mount() {
      const pane = document.getElementById("agent-pane");
      if (!pane) return;
      this.pane = pane;
      const inner = pane.querySelector(".agent-inner");
      inner.append(this.view.root, this.listEl);
      this.listEl.hidden = true;
      const resizer = pane.querySelector(".agent-resizer");
      applyWidth(Number(localStorage.getItem(LS.width)) || 420);
      resizer.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        document.body.classList.add("resizing-side");
        const startX = event.clientX;
        const startW = pane.getBoundingClientRect().width;
        const move = (e) => applyWidth(startW + (startX - e.clientX));
        const up = () => {
          document.body.classList.remove("resizing-side");
          resizer.removeEventListener("pointermove", move);
          resizer.removeEventListener("pointerup", up);
          localStorage.setItem(LS.width, String(Math.round(pane.getBoundingClientRect().width)));
        };
        resizer.addEventListener("pointermove", move);
        resizer.addEventListener("pointerup", up);
      });
      this.apply();
    },
    setOpen(open) {
      S.sideOpen = open;
      localStorage.setItem(LS.side, open ? "1" : "0");
      this.apply();
      if (open) {
        this.ensureThread();
        setTimeout(() => this.view.focus(), 50);
      }
    },
    apply() {
      if (!this.pane) return;
      this.pane.classList.toggle("closed", !S.sideOpen);
      this.pane.toggleAttribute("inert", !S.sideOpen);
      this.pane.setAttribute("aria-hidden", S.sideOpen ? "false" : "true");
      document.getElementById("agent-toggle")?.setAttribute("aria-expanded", S.sideOpen ? "true" : "false");
    },
    ensureThread() {
      if (this.view.threadId || this.view.draft) return;
      if (S.current && S.threads.has(S.current)) this.view.setThread(S.current);
      else this.view.startDraft(defaultScope());
    },
    toggleList() {
      this.listOpen = !this.listOpen;
      this.listEl.hidden = !this.listOpen;
      this.view.scroll.hidden = this.listOpen;
      this.view.composer.hidden = this.listOpen;
      this.view.root.classList.toggle("listing", this.listOpen);
      this.view.renderHeader();
      this.renderList();
    },
    renderList() {
      if (!this.listOpen) return;
      renderThreadList(this.listEl, {
        currentId: this.view.threadId,
        onPick: (id) => {
          setCurrent(id);
          this.view.setThread(id);
          this.toggleList();
          this.view.focus();
        },
        onNew: (anchor) => newThreadMenu(anchor, { startDraft: (scope, settings) => this.startDraft(scope, settings) }),
        onNewIn: (scope, settings) => this.startDraft(scope, settings),
      });
    },
    startDraft(scope, settings) {
      this.view.startDraft(scope, settings);
      if (this.listOpen) this.toggleList();
    },
  };

  function applyWidth(px) {
    const width = Math.max(320, Math.min(900, px));
    document.documentElement.style.setProperty("--agent-width", `${width}px`);
  }

  function defaultScope() {
    const tab = activeTab();
    return tab ? { kind: "page", ref: tab.id } : { kind: "global", ref: null };
  }

  /* ---------- full window ---------- */

  const full = {
    root: null,
    list: el("div", "ag-full-list"),
    view: new ChatView("full"),
    mount() {
      const root = el("div", "agent-full");
      root.hidden = true;
      const side = el("aside", "ag-full-side");
      side.append(this.list);
      const main = el("div", "ag-full-main");
      main.append(this.view.root);
      root.append(side, main);
      document.body.append(root);
      this.root = root;
    },
    open(threadId, draft) {
      S.fullOpen = true;
      this.root.hidden = false;
      document.body.classList.add("agent-full-open");
      if (threadId) this.view.setThread(threadId);
      else this.view.startDraft(draft?.scope || defaultScope(), draft?.settings || {});
      this.renderList();
      setTimeout(() => this.view.focus(), 50);
    },
    close() {
      S.fullOpen = false;
      this.root.hidden = true;
      document.body.classList.remove("agent-full-open");
      if (this.view.threadId && S.sideOpen) sidebar.view.setThread(this.view.threadId);
    },
    renderList() {
      if (!S.fullOpen) return;
      renderThreadList(this.list, {
        currentId: this.view.threadId,
        onPick: (id) => {
          setCurrent(id);
          this.view.setThread(id);
          this.renderList();
          this.view.focus();
        },
        onNew: (anchor) => newThreadMenu(anchor, this.view),
        onNewIn: (scope, settings) => {
          this.view.startDraft(scope, settings);
          this.renderList();
        },
      });
    },
  };

  /* ---------- floating dock ---------- */

  const dock = {
    root: null,
    view: new ChatView("dock"),
    feed: el("div", "dock-feed"),
    handle: null,
    feedLines: new Map(),
    /** When each thread's current run started, for threads whose turn list is not loaded. */
    starts: new Map(),
    mount() {
      const main = document.querySelector(".workspace main");
      if (!main) return;
      const view = this.view;
      const root = el("div", "agent-dock");
      const panel = el("div", "dock-panel");
      // Output: the conversation when expanded, the live step feed when collapsed.
      const out = el("div", "dock-out");
      const history = el("div", "dock-history");
      history.append(view.scroll);
      out.append(history, this.feed, el("span", "dock-sweep"));
      // Input: composer and send. The island style also shows the model orb here.
      const toggle = button(icon("list"), "ag-icon-btn small dock-toggle", () => this.setExpanded(!S.dockExpanded), "Show conversation (Ctrl+↑)");
      this.orb = button("", "dock-orb", (event) => view.modelMenu(event.currentTarget));
      const input = el("div", "dock-input");
      flyout.bind(this.orb, "orb");
      input.append(this.orb, view.composer, view.sendSlot);
      // Bar: status, thread and scope on the left; settings and window tools on the right.
      // The island style moves status, thread, scope and the window tools into two tabs above the input (see place).
      this.status = el("span", "dock-status");
      this.titleBtn = button("", "dock-title", (event) => this.threadMenu(event.currentTarget), "Switch thread");
      this.scopeBtn = button("", "dock-scope", (event) => view.scopeMenu(event.currentTarget), "Page, folder, or workspace this thread belongs to");
      const tools = [
        toggle,
        button(icon("expand"), "ag-icon-btn small", () => {
          const id = this.view.threadId;
          if (id) setCurrent(id);
          sidebar.setOpen(true);
          if (id) sidebar.view.setThread(id);
        }, "Open in the sidebar"),
        button(icon("close"), "ag-icon-btn small dock-close", () => this.setShown(false), "Hide (Esc)"),
      ];
      const left = el("div", "dock-bar-left");
      const right = el("div", "dock-bar-right");
      right.append(view.bar, el("span", "ag-grow"));
      const bar = el("div", "dock-bar");
      bar.append(left, right);
      const topLeft = el("div", "dock-top-tab dock-top-left");
      const topRight = el("div", "dock-top-tab dock-top-right");
      const top = el("div", "dock-top");
      top.append(topLeft, topRight);
      this.parts = { left, right, topLeft, topRight, tools, sep: el("span", "dock-top-sep") };
      const head = el("div", "dock-head");
      head.append(out, top);
      panel.append(head, input, bar);
      const handle = button("", "dock-handle", () => this.setShown(true), "Agent (Ctrl+K)");
      this.handleClock = el("span", "ag-clock dock-handle-clock");
      this.handleText = el("span", "dock-handle-text");
      handle.append(icon("sparkle", "ag-ico dock-handle-ico"), el("span", "dock-dot"), this.handleClock, el("span", "dock-handle-sep"), this.handleText, el("kbd", null, "Ctrl K"));
      this.handle = handle;
      root.append(panel, handle);
      main.append(root);
      this.root = root;
      this.history = history;
      this.view.root = root;
      this.view.root.addEventListener("click", (event) => onLinkClick(event));
      this.feed.addEventListener("click", () => this.setExpanded(true));
      this.apply();
    },
    apply() {
      if (!this.root) return;
      const style = dockStyle();
      for (const s of DOCK_STYLES) this.root.classList.toggle(`style-${s.id}`, s.id === style);
      this.place(style);
      this.root.classList.toggle("shown", S.dockShown);
      this.root.classList.toggle("expanded", S.dockShown && S.dockExpanded);
      this.renderHandle();
      // The input sizes itself to its text; measure again once the layout for this style is in place.
      requestAnimationFrame(() => this.view.autosize());
    },
    /** Island: status and thread in a tab on the left above the input, scope and window tools in one on the right. Bar: all in the bar. */
    place(style) {
      const p = this.parts;
      if (style === "island") {
        p.topLeft.append(this.status, this.titleBtn);
        p.topRight.append(this.scopeBtn, p.sep, ...p.tools);
      } else {
        p.left.append(this.status, this.titleBtn, this.scopeBtn);
        p.right.append(...p.tools);
      }
    },
    setShown(shown) {
      S.dockShown = shown;
      localStorage.setItem(LS.dock, shown ? "1" : "0");
      if (shown) this.syncThread();
      this.apply();
      if (shown) {
        this.bindFeed();
        setTimeout(() => this.view.focus(), 60);
      } else this.view.input.blur();
    },
    setExpanded(expanded) {
      S.dockExpanded = expanded;
      this.apply();
      if (expanded) {
        this.clearFeedLines();
        this.view.renderTranscript();
      } else {
        this.bindFeed();
      }
    },
    remember(id) {
      const tab = activeTab();
      if (tab) S.dockPicks.set(tab.id, id);
      this.renderTitle();
    },
    /** The dock follows the active page: its picked thread, else its newest page thread, else a draft. */
    syncThread() {
      if (!this.root) return;
      const tab = activeTab();
      let id = tab ? S.dockPicks.get(tab.id) : null;
      if (id && !S.threads.has(id)) id = null;
      if (!id && tab) {
        id = [...S.threads.values()].filter((t) => !t.archived && t.scope.kind === "page" && t.scope.ref === tab.id).sort((a, b) => b.activityAt - a.activityAt)[0]?.id || null;
      }
      if (id) {
        if (this.view.threadId !== id) this.view.setThread(id);
      } else {
        const scope = tab ? { kind: "page", ref: tab.id } : { kind: "global", ref: null };
        if (this.view.threadId || !sameScope(this.view.draft?.scope, scope)) this.view.startDraft(scope);
      }
      this.renderTitle();
    },
    draftMatches(thread) {
      return !this.view.threadId && this.view.draft && sameScope(this.view.draft.scope, thread.scope);
    },
    renderTitle() {
      if (!this.titleBtn) return;
      const t = this.view.thread();
      const s = this.view.settings();
      this.titleBtn.replaceChildren(icon(t ? "sparkle" : "plus"), el("span", null, t ? t.title : "New thread for this page"), icon("chevron", "ag-ico ag-chev-down"));
      const sc = scopeLabel(s.scope);
      this.scopeBtn.replaceChildren(icon(sc.icon), el("span", null, sc.text));
      this.scopeBtn.classList.toggle("warn", s.mode !== "board" && s.mode !== "ask" && !s.cwd);
      this.scopeBtn.title = "Page, folder, or workspace this thread belongs to";
      this.orb.textContent = PROVIDER_GLYPH[s.provider] || "?";
      // No native title: hovering the orb opens the threads flyout, and a tooltip would sit on top of it.
      this.orb.setAttribute("aria-label", `Model: ${modelLabel(s.provider, s.model)}`);
      this.renderHandle();
    },
    /** When the thread's current run started: its running turn, else when the dock first saw it running. */
    runStart(t) {
      const turn = [...(S.details.get(t.id)?.turns.values() || [])].find((x) => x.status === "running");
      if (turn) return turn.startedAt;
      if (!this.starts.has(t.id)) this.starts.set(t.id, Date.now());
      return this.starts.get(t.id);
    },
    renderHandle() {
      if (!this.handle) return;
      const t = this.view.thread();
      const status = t?.status || "idle";
      if (status === "idle" && t) this.starts.delete(t.id);
      const start = t && status !== "idle" ? this.runStart(t) : null;
      for (const node of [this.handle, this.root]) {
        node?.classList.toggle("busy", status === "running");
        node?.classList.toggle("waiting", status === "waiting");
      }
      setClock(this.handleClock, status === "running" ? start : null);
      // Status dot and run time at the start of the bar.
      this.status.className = `dock-status s-${status}`;
      this.status.replaceChildren(el("span", "dock-dot"));
      if (start) this.status.append(setClock(el("span", "ag-clock"), start));
      if (status === "running") this.setHandleText(this.live?.text || "Working…", this.live?.key || "working");
      else this.setHandleText(status === "waiting" ? "Needs your answer" : t?.unread && !t.fromPage ? "Reply ready" : "Ask the agent", status);
    },
    /** The hidden handle shows one line at a time; a new step slides the previous one up with a short motion blur. */
    setHandleText(text, key) {
      const box = this.handleText;
      const cur = box.lastElementChild;
      if (cur && box.dataset.key === key) {
        cur.textContent = text;
        return;
      }
      box.dataset.key = key;
      // Only the line on its way out may stay; anything older is gone already.
      for (const old of [...box.children]) if (old !== cur) old.remove();
      const next = el("span", "dock-handle-line", text);
      box.append(next);
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const animate = !reduce && cur && !S.dockShown && this.handle.classList.contains("busy") && Date.now() - (this.handleAt || 0) > 600;
      this.handleAt = Date.now();
      if (!animate) {
        for (const old of [...box.children]) if (old !== next) old.remove();
        return;
      }
      const ease = { duration: 460, easing: "cubic-bezier(.42,0,.58,1)" };
      next.animate(
        [
          { transform: "translateY(100%)", filter: "blur(5px)", opacity: 0.75 },
          { transform: "none", filter: "blur(0px)", opacity: 1 },
        ],
        ease,
      );
      cur.animate(
        [
          { transform: "none", filter: "blur(0px)", opacity: 1 },
          { transform: "translateY(-100%)", filter: "blur(5px)", opacity: 0.5 },
        ],
        { ...ease, fill: "forwards" },
      );
      // A timer rather than onfinish: animations stall in a hidden window, and the old line must still go.
      setTimeout(() => cur.remove(), ease.duration + 20);
    },
    threadMenu(anchor) {
      const tab = activeTab();
      const threads = [...S.threads.values()].filter((t) => !t.archived).sort((a, b) => threadRank(b) - threadRank(a));
      const pageThreads = tab ? threads.filter((t) => t.scope.kind === "page" && t.scope.ref === tab.id) : [];
      const others = threads.filter((t) => !pageThreads.includes(t)).slice(0, 12);
      const items = [];
      items.push({ label: "New thread for this page", icon: "plus", run: () => { if (tab) S.dockPicks.delete(tab.id); this.view.startDraft(tab ? { kind: "page", ref: tab.id } : { kind: "global", ref: null }); this.renderTitle(); } });
      if (pageThreads.length) items.push({ header: "This page" });
      for (const t of pageThreads) items.push({ label: t.title, detail: threadWhenText(t), checked: t.id === this.view.threadId, run: () => this.pick(t.id) });
      if (others.length) items.push({ header: "Recent" });
      for (const t of others) items.push({ label: t.title, detail: `${scopeLabel(t.scope).text} · ${threadWhenText(t)}`, checked: t.id === this.view.threadId, run: () => this.pick(t.id) });
      openMenu(anchor, items, { search: true, width: 320, placeholder: "Search threads" });
    },
    pick(id) {
      this.remember(id);
      this.view.setThread(id);
      this.renderTitle();
      // The picker is a popover: closing it drops the focused search field, and focus would
      // land on the title button. Put it in the composer, as the sidebar and full window do.
      if (S.dockShown) setTimeout(() => this.view.focus(), 0);
    },
    /* Collapsed feed is bound to the composer thread: that thread's latest reply, or empty
       when none is selected. Live steps cap at 4 while it runs, then fade once it stops. */
    clearFeedLines() {
      clearTimeout(this._settle);
      for (const node of this.feed.children) clearTimeout(node._fade);
      this.feed.replaceChildren();
      this.feedLines.clear();
      this.feed.classList.remove("deep");
    },
    /** Drop feed lines and live-handle text so another thread cannot leak into this one. */
    resetFeed() {
      this.clearFeedLines();
      this.live = null;
    },
    /** Clear now and drop any in-flight paint, so a switch never keeps the previous thread's reply. */
    invalidateFeed() {
      this.resetFeed();
      this.feedPainted = null;
      this.feedSeq = (this.feedSeq || 0) + 1;
      this.renderHandle();
    },
    /**
     * Paint the collapsed feed for the thread in the composer, or clear it when there is none.
     * A generation counter drops a paint that started before a later bind (switch, show, collapse).
     */
    bindFeed(force) {
      const id = this.view.threadId || null;
      if (!force && id && this.feedPainted === id && S.dockShown && !S.dockExpanded && this.feed.childElementCount) return;
      this.invalidateFeed();
      const seq = this.feedSeq;
      if (!id || S.dockExpanded || !S.dockShown) return;
      const paint = () => {
        if (seq !== this.feedSeq || this.view.threadId !== id) return;
        this.resetFeed();
        this.paintFeed(id);
        if (S.details.has(id)) this.feedPainted = id;
        this.renderHandle();
      };
      if (S.details.has(id)) paint();
      else ensureDetail(id).then(paint);
    },
    paintFeed(id) {
      const detail = S.details.get(id);
      const t = S.threads.get(id);
      if (!detail || !t) return;
      this.feedQuiet = true;
      try {
        if (t.status === "running") {
          const turn = [...detail.turns.values()].find((x) => x.status === "running");
          if (!turn) return;
          for (const item of detail.items) {
            if (item.turnId === turn.id && !item.parentToolId) this.paintLiveItem(item);
          }
          return;
        }
        const lastText = [...detail.items].reverse().find((it) => it.kind === "text" && !it.parentToolId && String(it.text || "").trim());
        if (lastText) {
          this.line(`${lastText.turnId || lastText.id}:done`, "check", plain(lastText.text).slice(0, 220), { cls: "text done" });
          return;
        }
        const lastTurn = [...detail.turns.values()].sort((a, b) => b.seq - a.seq)[0];
        if (lastTurn?.status === "error") {
          this.line(`${lastTurn.id}:err`, "cross", lastTurn.error || "The turn failed", { cls: "error", keep: true });
        }
      } finally {
        this.feedQuiet = false;
      }
    },
    paintLiveItem(item) {
      if (item.kind === "tool") {
        const label = item.tool === "edit" && item.files?.length ? `Edited ${item.files.map((f) => `${R.basename(f.path)} +${f.added} −${f.removed}`).join(", ")}` : item.detail && item.tool === "execute" ? `$ ${item.detail}` : item.title;
        this.line(item.id, item.tool, label, { cls: `k-${item.tool}` });
      } else if (item.kind === "notice") {
        this.line(item.id, "other", item.text, { cls: item.level });
      } else if (item.kind === "reasoning") {
        this.line(item.id, "think", lastLine(item.text) || "Thinking…", { cls: "reason" });
      } else if (item.kind === "text") {
        this.line(item.id, "sparkle", lastLine(item.text), { cls: "text" });
      }
    },
    line(key, _icon, text, { cls = "", keep = false } = {}) {
      if (!this.root) return;
      const hold = keep || /\btext\b/.test(cls);
      if (!/\b(done|files|error)\b/.test(cls)) {
        this.live = { key, text };
        if (this.view.thread()?.status === "running") this.renderHandle();
      }
      if (S.dockExpanded || !S.dockShown) return;
      let line = this.feedLines.get(key);
      if (!line) {
        line = el("div", `dock-line ${cls}`);
        line.append(el("span", "dock-dot"), el("span", "dock-line-text"));
        const before = [...this.feed.children];
        this.feed.append(line);
        this.feedLines.set(key, line);
        if (!this.feedQuiet) {
          const lift = line.offsetHeight + 2;
          for (const node of before) if (node.isConnected) node.animate([{ transform: `translateY(${lift}px)` }, { transform: "none" }], { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" });
        }
      }
      line.className = `dock-line ${cls}${hold ? " keep" : ""}`;
      line.querySelector(".dock-line-text").textContent = text;
      clearTimeout(line._fade);
      line.classList.remove("fading");
      if (hold) {
        for (const node of [...this.feed.children]) {
          if (node === line || !node.classList.contains("keep")) continue;
          node.remove();
          for (const [k, v] of this.feedLines) if (v === node) this.feedLines.delete(k);
        }
      }
      while (this.feed.childElementCount > 4) {
        const drop = [...this.feed.children].find((n) => n !== line && !n.classList.contains("keep")) || [...this.feed.children].find((n) => n !== line);
        if (!drop) break;
        drop.remove();
        for (const [k, v] of this.feedLines) if (v === drop) this.feedLines.delete(k);
      }
      this.feed.classList.remove("deep");
    },
    settleFeed() {
      clearTimeout(this._settle);
      this._settle = setTimeout(() => {
        for (const node of [...this.feed.children]) {
          if (node.classList.contains("keep")) continue;
          node.classList.add("fading");
          clearTimeout(node._fade);
          node._fade = setTimeout(() => {
            node.remove();
            for (const [k, v] of this.feedLines) if (v === node) this.feedLines.delete(k);
          }, 900);
        }
      }, 1400);
    },
    onItem(item) {
      if (item.threadId !== this.view.threadId) return;
      if ((item.kind === "approval" || item.kind === "question" || item.kind === "plan") && item.status === "pending") {
        if (!S.dockShown) this.setShown(true);
        this.setExpanded(true);
        return;
      }
      this.paintLiveItem(item);
      this.renderHandle();
    },
    onDelta(item) {
      if (item.threadId !== this.view.threadId) return;
      this.paintLiveItem(item);
    },
    onTurn(turn) {
      if (turn.threadId !== this.view.threadId) return;
      if (turn.status !== "running") this.live = null;
      this.renderHandle();
      if (turn.status === "running") {
        clearTimeout(this._settle);
        return;
      }
      const detail = S.details.get(turn.threadId);
      const lastText = detail ? [...detail.items].reverse().find((it) => it.turnId === turn.id && it.kind === "text" && !it.parentToolId) : null;
      const files = turn.files || [];
      if (files.length) {
        const added = files.reduce((a, f) => a + f.added, 0);
        const removed = files.reduce((a, f) => a + f.removed, 0);
        this.line(`${turn.id}:files`, "diff", `${files.length} file${files.length === 1 ? "" : "s"} changed  +${added} −${removed}`, { cls: "files", keep: !lastText });
      }
      if (lastText) {
        this.feedLines.get(lastText.id)?.remove();
        this.feedLines.delete(lastText.id);
        this.line(`${turn.id}:done`, "check", plain(lastText.text).slice(0, 220), { cls: "text done" });
      } else if (turn.status === "error") this.line(`${turn.id}:err`, "cross", turn.error || "The turn failed", { cls: "error", keep: true });
      this.settleFeed();
    },
  };

  // The dock's view renders its transcript into the history panel and its composer at the bottom.
  dock.view.renderHeader = () => dock.renderTitle();

  /* ---------- chrome badge ---------- */

  let lastAsks = "";

  function renderBadge() {
    const btn = document.getElementById("agent-toggle");
    if (!btn) return;
    const threads = [...S.threads.values()];
    const waiting = threads.some((t) => t.status === "waiting");
    const running = threads.filter((t) => t.status === "running").length;
    const unread = threads.filter((t) => t.unread && !t.archived && !t.fromPage).length;
    btn.classList.toggle("busy", running > 0);
    btn.classList.toggle("waiting", waiting);
    const badge = document.getElementById("agent-badge");
    if (badge) {
      badge.hidden = !(waiting || unread);
      badge.textContent = waiting ? "!" : unread ? String(unread) : "";
      badge.classList.toggle("warn", waiting);
    }
    dock.renderHandle();
    for (const rowEl of document.querySelectorAll(".tab[data-id], .lib-page[data-id]")) {
      const status = pageStatus(rowEl.dataset.id);
      rowEl.classList.toggle("agent-running", status === "running");
      rowEl.classList.toggle("agent-waiting", status === "waiting");
    }
    const asks = threads
      .filter((t) => t.status === "waiting")
      .map((t) => `${t.id}:${t.asking?.itemId || ""}`)
      .join(",");
    if (asks !== lastAsks) {
      lastAsks = asks;
      window.dispatchEvent(new Event("scribe:agent-status"));
    }
    flyout.render();
    toasts.update();
  }

  /**
   * "waiting" or "running" when a thread for this page is at work, for the tab strip and Library.
   * A page another thread is asking with (page_ask) also shows as waiting.
   */
  function pageStatus(tabId) {
    let status = null;
    for (const t of S.threads.values()) {
      if (t.status === "waiting" && t.asking?.page?.id === tabId) return "waiting";
      if (t.scope.kind !== "page" || t.scope.ref !== tabId || t.status === "idle") continue;
      if (t.status === "waiting") return "waiting";
      status = "running";
    }
    return status;
  }

  /** Questions, approvals and plans the user still has to answer, newest thread first, for the palette. */
  function pendingAsks() {
    const label = { approval: "Approval", question: "Question", plan: "Plan" };
    return [...S.threads.values()]
      .filter((t) => t.status === "waiting" && !t.archived)
      .sort((a, b) => threadRank(b) - threadRank(a))
      .map((t) => ({
        kind: "ask",
        id: `ask:${t.id}`,
        threadId: t.id,
        itemId: t.asking?.itemId || "",
        page: t.asking?.page || null,
        title: t.asking?.title || "Needs your answer",
        snippet: t.title,
        locationLabel: label[t.asking?.kind] || "Waiting",
        location: "ask",
      }));
  }

  /** Open a waiting thread in the sidebar and bring its question into view. */
  function openAsk(threadId, itemId) {
    if (!openThread(threadId)) return false;
    if (!itemId) return true;
    let tries = 0;
    const reveal = () => {
      const node = (S.fullOpen ? full.view : sidebar.view).root?.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
      if (node) node.scrollIntoView({ block: "center" });
      else if (++tries < 20) setTimeout(reveal, 50);
    };
    requestAnimationFrame(reveal);
    return true;
  }

  /* ---------- activity flyout and needs-you toasts ---------- */

  const FLYOUT_CAP = 8;
  const TOAST_CAP = 3;
  const FINISH_TOAST_MS = 8000;

  /** Waiting, then running, then user-level unread threads, each newest first. */
  function activeThreads() {
    const all = [...S.threads.values()].filter((t) => !t.archived).sort((a, b) => threadRank(b) - threadRank(a));
    return [
      ...all.filter((t) => t.status === "waiting"),
      ...all.filter((t) => t.status === "running"),
      ...all.filter((t) => t.status === "idle" && t.unread && !t.fromPage),
    ];
  }

  /** The thread is open in the dock, the sidebar or the full window. */
  function threadOnScreen(id) {
    return (S.dockShown && dock.view.threadId === id) || (S.sideOpen && sidebar.view.threadId === id) || (S.fullOpen && full.view.threadId === id);
  }

  /** Allow / Deny for a waiting approval, through the same route as the transcript card. */
  function approvalButtons(t, onDone) {
    const ask = t.asking;
    const options = ask?.kind === "approval" ? ask.options || [] : [];
    const allow = options.find((o) => o.kind === "allow_once") || options.find((o) => o.kind.startsWith("allow"));
    const deny = options.find((o) => o.kind === "reject_once") || options.find((o) => o.kind.startsWith("reject"));
    const box = el("span", "ag-act-btns");
    if (!allow || !deny) return box;
    for (const [opt, label, cls] of [[allow, "Allow", " primary"], [deny, "Deny", " danger"]]) {
      box.append(
        button(label, `ag-btn tiny${cls}`, async (event) => {
          event.stopPropagation();
          for (const b of box.querySelectorAll("button")) b.disabled = true;
          try {
            await api("POST", `/approvals/${encodeURIComponent(ask.itemId)}`, { optionId: opt.id });
            onDone?.();
          } catch (err) {
            notice(err.message);
            for (const b of box.querySelectorAll("button")) b.disabled = false;
          }
        }, opt.label)
      );
    }
    return box;
  }

  /** One line on what the thread is doing, for flyout rows. */
  function activityLine(t) {
    if (t.status === "waiting") {
      const kind = { approval: "Approve", question: "Question", plan: "Plan" }[t.asking?.kind] || "Waiting";
      return t.asking ? `${kind}: ${t.asking.title}` : "Needs your answer";
    }
    return t.activity?.line || (t.status === "running" ? "Working…" : "Reply ready");
  }

  /**
   * Hover the island orb or the top-bar agent button: every waiting, running and unread thread.
   * The anchor, the panel and its peek are one hover group, so the pointer can move onto the list.
   */
  const flyout = {
    node: null,
    peek: null,
    anchor: null,
    from: null,
    showTimer: 0,
    hideTimer: 0,
    peekTimer: 0,
    peekId: null,
    bind(anchor, from) {
      anchor.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "mouse" || event.buttons) return;
        clearTimeout(this.hideTimer);
        if (this.node && this.anchor === anchor) return;
        clearTimeout(this.showTimer);
        this.showTimer = setTimeout(() => this.open(anchor, from), 180);
      });
      anchor.addEventListener("pointerleave", () => {
        clearTimeout(this.showTimer);
        this.hideSoon();
      });
      // A click keeps its own job (model menu, sidebar).
      anchor.addEventListener("pointerdown", () => {
        clearTimeout(this.showTimer);
        this.close();
      });
    },
    hold(node) {
      node.addEventListener("pointerenter", () => clearTimeout(this.hideTimer));
      node.addEventListener("pointerleave", () => this.hideSoon());
    },
    hideSoon() {
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.close(), 200);
    },
    open(anchor, from) {
      if (openMenuEl || !anchor.isConnected || anchor.offsetParent === null) return;
      if (!activeThreads().length) return;
      this.close();
      this.anchor = anchor;
      this.from = from;
      // The native title would sit on top of the panel.
      anchor.dataset.flyTitle = anchor.title;
      anchor.removeAttribute("title");
      hideHoverTip();
      this.node = el("div", `ag-fly from-${from}`);
      this.hold(this.node);
      document.body.append(this.node);
      this.render();
    },
    close() {
      clearTimeout(this.hideTimer);
      clearTimeout(this.peekTimer);
      this.node?.remove();
      this.peek?.remove();
      this.node = this.peek = this.peekId = this.sig = null;
      if (this.anchor && this.anchor.dataset.flyTitle !== undefined) {
        this.anchor.title = this.anchor.dataset.flyTitle;
        delete this.anchor.dataset.flyTitle;
      }
      this.anchor = null;
    },
    render() {
      if (!this.node) return;
      const threads = activeThreads();
      if (!threads.length) return this.close();
      // Running threads resend every second or so; rebuild only when a row would change.
      const sig = JSON.stringify(threads.slice(0, FLYOUT_CAP + 1).map((t) => [t.id, t.status, t.title, activityLine(t), t.activity?.lastText, t.asking?.detail]));
      if (sig === this.sig && this.node.childElementCount) return;
      this.sig = sig;
      const waiting = threads.filter((t) => t.status === "waiting").length;
      const running = threads.filter((t) => t.status === "running").length;
      const ready = threads.length - waiting - running;
      const counts = [];
      if (waiting) counts.push(`${waiting} need${waiting === 1 ? "s" : ""} you`);
      if (running) counts.push(`${running} running`);
      if (ready) counts.push(`${ready} ready`);
      const head = el("div", "ag-fly-head");
      head.append(el("b", null, "Active"), el("span", null, counts.join(" · ")));
      this.node.replaceChildren(head);
      for (const t of threads.slice(0, FLYOUT_CAP)) this.node.append(this.row(t));
      if (threads.length > FLYOUT_CAP) {
        this.node.append(
          button(`+${threads.length - FLYOUT_CAP} in the sidebar`, "ag-fly-more", () => {
            this.close();
            sidebar.setOpen(true);
            if (!sidebar.listOpen) sidebar.toggleList();
          })
        );
      }
      this.place();
      if (this.peekId) {
        const t = S.threads.get(this.peekId);
        const rowEl = this.node.querySelector(`[data-thread="${CSS.escape(this.peekId)}"]`);
        if (t && rowEl) this.showPeek(t, rowEl);
        else this.hidePeek();
      }
    },
    row(t) {
      const row = el("div", `ag-fly-row s-${t.status}`);
      row.dataset.thread = t.id;
      row.tabIndex = 0;
      row.role = "button";
      const meta = el("span", "ag-fly-meta");
      meta.append(el("span", "ag-fly-title", t.title), el("span", "ag-fly-line", activityLine(t)));
      row.append(el("span", `ag-dot s-${t.status === "idle" ? "ready" : t.status}`), meta);
      if (t.status === "waiting" && t.asking?.kind === "approval") row.append(approvalButtons(t));
      else if (t.status === "waiting") {
        row.append(
          button("Open", "ag-btn tiny", (event) => {
            event.stopPropagation();
            this.go(t);
          })
        );
      }
      row.addEventListener("click", () => this.go(t));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.go(t);
      });
      row.addEventListener("pointerenter", () => {
        clearTimeout(this.peekTimer);
        this.peekTimer = setTimeout(() => this.showPeek(S.threads.get(t.id) || t, row), this.peek ? 60 : 220);
      });
      return row;
    },
    /** Row click: the island orb switches the dock to it; the agent button too while the dock is up, else the sidebar. */
    go(t) {
      const inDock = this.from === "orb" || S.dockShown;
      this.close();
      openActive(t, inDock);
    },
    showPeek(t, rowEl) {
      if (!this.node) return;
      this.peekId = t.id;
      for (const r of this.node.querySelectorAll(".ag-fly-row")) r.classList.toggle("on", r === rowEl);
      const peek = el("div", "ag-fly-peek");
      const state = t.status === "waiting" ? "Waiting" : t.status === "running" ? "Running" : "Reply ready";
      peek.append(el("p", "ag-fly-peek-head", `${state} · ${t.title}`));
      if (t.status === "waiting" && t.asking) {
        peek.append(el("p", "ag-fly-peek-title", t.asking.title));
        if (t.asking.detail) peek.append(el("pre", "ag-pre small", t.asking.detail));
      } else if (t.status === "running" && t.activity?.line) {
        peek.append(el("p", "ag-fly-peek-title", t.activity.line));
      }
      if (t.activity?.lastText) peek.append(el("p", "ag-fly-peek-quote", t.activity.lastText));
      if (t.status === "waiting" && t.asking?.kind === "approval") peek.append(approvalButtons(t));
      this.hold(peek);
      this.peek?.remove();
      this.peek = peek;
      document.body.append(peek);
      // Beside the panel, level with the row; on the other side when there is no room.
      const box = this.node.getBoundingClientRect();
      const r = rowEl.getBoundingClientRect();
      const w = Math.min(300, window.innerWidth - 16);
      peek.style.width = `${w}px`;
      let left = box.right + 8;
      if (left + w > window.innerWidth - 8) left = box.left - w - 8;
      const top = Math.min(r.top, window.innerHeight - peek.offsetHeight - 8);
      peek.style.left = `${Math.max(8, left)}px`;
      peek.style.top = `${Math.max(8, top)}px`;
    },
    hidePeek() {
      this.peek?.remove();
      this.peek = this.peekId = null;
    },
    place() {
      const rect = this.anchor.getBoundingClientRect();
      const w = Math.min(340, window.innerWidth - 16);
      this.node.style.width = `${w}px`;
      if (this.from === "orb") {
        this.node.style.left = `${Math.min(Math.max(8, rect.left - 8), window.innerWidth - w - 8)}px`;
        this.node.style.bottom = `${window.innerHeight - rect.top + 10}px`;
      } else {
        this.node.style.left = `${Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8)}px`;
        this.node.style.top = `${rect.bottom + 8}px`;
      }
    },
    /** From a toast's "+N more": at the orb while the island shows it, else at the agent button. */
    openAnywhere() {
      const orb = dock.orb;
      if (orb && orb.offsetParent !== null && getComputedStyle(orb).display !== "none") this.open(orb, "orb");
      else {
        const btn = document.getElementById("agent-toggle");
        if (btn) this.open(btn, "button");
      }
    },
  };

  /** Open a thread from the flyout or a toast: in the dock (expanded), else in the sidebar at its question. */
  function openActive(t, inDock) {
    if (inDock) {
      showPageThread(t.id, "dock", { reveal: true });
      dock.setExpanded(true);
    } else if (t.status === "waiting" && t.asking) openAsk(t.id, t.asking.itemId);
    else openThread(t.id);
  }

  /**
   * Needs-you toasts: a thread starts waiting, or a user-level thread finishes, while it is not on
   * screen. × snoozes that request (or that finish); a new request toasts again.
   */
  const toasts = {
    box: null,
    shown: new Map(),
    snoozed: new Set(),
    seen: new Map(),
    mount() {
      const main = document.querySelector(".workspace main");
      if (!main) return;
      this.box = el("div", "ag-toasts");
      main.append(this.box);
    },
    update() {
      if (!this.box) return;
      const live = new Set();
      for (const t of S.threads.values()) {
        const prev = this.seen.get(t.id);
        const ask = t.status === "waiting" && t.asking ? t.asking.itemId : null;
        this.seen.set(t.id, { ask, finishedAt: t.finishedAt || 0 });
        if (t.archived) continue;
        // Threads seen for the first time (the list loading) do not toast.
        if (ask) {
          const key = `ask:${ask}`;
          live.add(key);
          if (prev && prev.ask !== ask && !threadOnScreen(t.id) && !this.snoozed.has(key)) this.add(key, t, "ask");
        }
        if (t.status === "idle" && t.unread && !t.fromPage && t.finishedAt) {
          const key = `fin:${t.id}:${t.finishedAt}`;
          live.add(key);
          if (prev && prev.finishedAt !== t.finishedAt && !threadOnScreen(t.id)) this.add(key, t, "finish");
        }
      }
      for (const id of this.seen.keys()) if (!S.threads.has(id)) this.seen.delete(id);
      // Answered, opened or gone: drop its toast. A snooze ends with its request.
      for (const [key, entry] of this.shown) {
        if (!live.has(key) || threadOnScreen(entry.threadId)) this.drop(key);
      }
      for (const key of this.snoozed) if (!live.has(key)) this.snoozed.delete(key);
      if (this.signature() !== this.sig) this.render();
    },
    add(key, t, kind) {
      if (this.shown.has(key)) return;
      const entry = { key, threadId: t.id, kind, at: Date.now() };
      if (kind === "finish") entry.timer = setTimeout(() => this.remove(key), FINISH_TOAST_MS);
      this.shown.set(key, entry);
    },
    drop(key) {
      clearTimeout(this.shown.get(key)?.timer);
      this.shown.delete(key);
    },
    remove(key) {
      if (!this.shown.has(key)) return;
      this.drop(key);
      this.render();
    },
    /** What the toasts show; the thread list resends running threads often, and most resends change nothing here. */
    signature() {
      return JSON.stringify(
        [...this.shown.values()].map((e) => {
          const t = S.threads.get(e.threadId);
          return [e.key, t?.title, t?.asking?.title, t?.activity?.lastText];
        })
      );
    },
    dismiss(key) {
      if (key.startsWith("ask:")) this.snoozed.add(key);
      this.remove(key);
    },
    render() {
      if (!this.box) return;
      this.sig = this.signature();
      // Waiting before finished, newest first.
      const entries = [...this.shown.values()].sort((a, b) => (a.kind === b.kind ? b.at - a.at : a.kind === "ask" ? -1 : 1));
      this.box.replaceChildren();
      for (const entry of entries.slice(0, TOAST_CAP)) {
        const t = S.threads.get(entry.threadId);
        if (t) this.box.append(this.toast(entry, t));
      }
      if (entries.length > TOAST_CAP) {
        this.box.append(button(`+${entries.length - TOAST_CAP} more`, "ag-toast-more", () => flyout.openAnywhere()));
      }
    },
    toast(entry, t) {
      const node = el("div", `ag-toast k-${entry.kind}`);
      const body = el("div", "ag-toast-body");
      const title = el("b", null, t.title);
      const actions = el("div", "ag-toast-actions");
      if (entry.kind === "ask") {
        const what = { approval: "wants to:", question: "asks:", plan: "has a plan:" }[t.asking?.kind] || "needs you";
        body.append(title, ` ${what} `, el("span", "ag-toast-what", t.asking?.title || ""));
        if (t.asking?.detail) body.append(el("code", "ag-toast-detail", t.asking.detail));
        if (t.asking?.kind === "approval") actions.append(approvalButtons(t, () => this.remove(entry.key)));
      } else {
        body.append(title, " finished");
        if (t.activity?.lastText) body.append(el("span", "ag-toast-text", t.activity.lastText));
      }
      actions.append(
        button("Open", "ag-btn tiny", () => {
          this.remove(entry.key);
          openActive(t, S.dockShown);
        })
      );
      body.append(actions);
      node.append(
        el("span", `ag-dot s-${entry.kind === "ask" ? "waiting" : "ready"}`),
        body,
        button(icon("close"), "ag-icon-btn small ag-toast-x", () => this.dismiss(entry.key), entry.kind === "ask" ? "Dismiss for now (it stays in the orb's list)" : "Dismiss")
      );
      return node;
    },
  };

  function views() {
    return [sidebar.view, full.view, dock.view];
  }

  function renderLists() {
    sidebar.renderList();
    full.renderList();
  }

  function renderAll() {
    for (const view of views()) {
      if (view.threadId && !S.threads.has(view.threadId)) {
        view.threadId = null;
      }
      view.renderAll();
    }
    dock.renderTitle();
    renderLists();
    renderBadge();
  }

  /* ---------- favourite models and cycling ---------- */

  function modelKey(provider, id) {
    return `${provider}:${id}`;
  }

  function favoriteModels() {
    const list = prefs().favoriteModels;
    return Array.isArray(list) ? list : [];
  }

  async function setFavorite(provider, id, on) {
    const key = modelKey(provider, id);
    const list = favoriteModels().filter((k) => k !== key);
    if (on) list.push(key);
    S.config.prefs = { ...prefs(), favoriteModels: list };
    try {
      S.config.prefs = await api("PUT", "/prefs", { favoriteModels: list });
    } catch (err) {
      notice(err.message);
    }
  }

  /** The chat a cycling shortcut applies to: the one in focus, else the most prominent one open. */
  function targetView() {
    if (S.fullOpen) return full.view;
    const active = document.activeElement;
    if (S.dockShown && (dock.root?.contains(active) || !S.sideOpen)) return dock.view;
    if (S.sideOpen) return sidebar.view;
    return dock.view;
  }

  /** Latest non-favourite model per chat, kept in that chat's cycle until another replaces it. */
  const cycleExtras = new Map();

  async function cycleModel() {
    const view = targetView();
    const s = view.settings();
    const t = view.thread();
    // A thread with messages keeps its provider, so only that provider's favourites apply.
    const locked = Boolean(t && t.stats.turns > 0);
    const usable = (f) => providerAvailable(f.provider) && modelInfo(f.provider, f.id) && (!locked || f.provider === s.provider);
    const list = favoriteModels()
      .map((key) => ({ provider: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1) }))
      .filter(usable);
    const current = modelKey(s.provider, s.model);
    const chatKey = view.draftKey();
    if (!list.some((f) => modelKey(f.provider, f.id) === current)) cycleExtras.set(chatKey, { provider: s.provider, id: s.model });
    const extra = cycleExtras.get(chatKey);
    if (extra && usable(extra) && !list.some((f) => modelKey(f.provider, f.id) === modelKey(extra.provider, extra.id))) list.unshift(extra);
    if (list.length < 2) {
      notice(favoriteModels().length ? "Star another model to cycle between them" : "Star models in the model picker to cycle them with Ctrl+'");
      return;
    }
    const at = list.findIndex((f) => modelKey(f.provider, f.id) === current);
    const next = list[(at + 1) % list.length];
    await view.updateSettings(next.provider === s.provider ? { model: next.id } : { provider: next.provider, model: next.id });
    notice(`Model: ${modelInfo(next.provider, next.id)?.label || next.id}`);
  }

  async function cycleEffort() {
    const view = targetView();
    const s = view.settings();
    const info = modelInfo(s.provider, s.model);
    if (!info?.efforts?.length) {
      notice(`${info?.label || s.model} has no reasoning levels`);
      return;
    }
    const levels = [null, ...info.efforts.map((e) => e.id)];
    const next = levels[(levels.indexOf(s.effort ?? null) + 1) % levels.length];
    await view.updateSettings({ effort: next });
    const label = next ? info.efforts.find((e) => e.id === next)?.label || next : `Default${info.defaultEffort ? ` (${info.efforts.find((e) => e.id === info.defaultEffort)?.label || info.defaultEffort})` : ""}`;
    notice(`Reasoning: ${label}`);
  }

  function applyButton() {
    const btn = document.getElementById("agent-toggle");
    if (btn) btn.hidden = localStorage.getItem(LS.button) === "0";
  }

  /* ---------- plan usage ---------- */

  function usageLevel(utilization) {
    return utilization >= 0.9 ? "high" : utilization >= 0.75 ? "warn" : "ok";
  }

  function percent(utilization) {
    return `${Math.round(utilization * 100)}%`;
  }

  function planPct(used) {
    const p = used * 100;
    if (p < 0.1) return "<0.1%";
    if (p < 1) return `${p.toFixed(1)}%`;
    return `${Math.round(p)}%`;
  }

  function planWindowShort(w) {
    if (w.id === "five_hour") return "5h";
    if (w.id === "seven_day") return "wk";
    if (w.id === "seven_day_opus") return "wk Opus";
    if (w.id === "seven_day_sonnet") return "wk Sonnet";
    if (w.id === "seven_day_overage_included") return "wk extra";
    if (w.id === "overage") return "extra";
    if (w.id === "cursor_auto") return "auto";
    if (w.id === "cursor_api") return "api";
    if (w.id === "cursor_on_demand") return "on-demand";
    return w.label;
  }

  /** "in 2 h 10 min" / "Sat 10:00" for a window's reset time. */
  function resetText(at) {
    if (!at) return "";
    const ms = at - Date.now();
    if (ms <= 0) return "";
    if (ms < 24 * 3600 * 1000) {
      const h = Math.floor(ms / 3600000);
      const m = Math.round((ms % 3600000) / 60000);
      return `resets in ${h ? `${h} h ` : ""}${m} min`;
    }
    return `resets ${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
  }

  function liveWindows(windows) {
    const now = Date.now();
    return (windows || []).map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, utilization: 0 } : w));
  }

  function planLimits(provider) {
    const limits = S.config.limits?.[provider];
    if (!limits?.windows?.length) return null;
    return { ...limits, windows: liveWindows(limits.windows) };
  }

  let usageTick = 0;

  function refreshUsageUi() {
    for (const view of views()) view.renderComposerBar();
    agentSettings.renderUsage();
  }

  function soonestFutureReset(limits) {
    const now = Date.now();
    let next = null;
    for (const entry of Object.values(limits || {})) {
      for (const w of entry?.windows || []) {
        if (typeof w.resetsAt === "number" && w.resetsAt > now && (next == null || w.resetsAt < next)) next = w.resetsAt;
      }
    }
    return next;
  }

  function armUsageTick() {
    clearTimeout(usageTick);
    const next = soonestFutureReset(S.config?.limits);
    if (next == null) return;
    usageTick = setTimeout(() => {
      refreshUsageUi();
      armUsageTick();
    }, Math.min(Math.max(50, next - Date.now()), 24 * 3600 * 1000));
  }

  let hoverTipEl = null;
  let hoverTipTimer = 0;

  function hideHoverTip() {
    clearTimeout(hoverTipTimer);
    hoverTipEl?.remove();
    hoverTipEl = null;
  }

  function placeHoverTip(anchor, tip, width = 280) {
    hideHoverTip();
    document.body.append(tip);
    const rect = anchor.getBoundingClientRect();
    const tw = Math.min(width, window.innerWidth - 16);
    tip.style.width = `${tw}px`;
    let top = rect.top - tip.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    const left = Math.min(Math.max(8, rect.right - tw), window.innerWidth - tw - 8);
    tip.style.top = `${Math.max(8, top)}px`;
    tip.style.left = `${left}px`;
    hoverTipEl = tip;
  }

  function bindHoverTip(anchor, build) {
    anchor.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      clearTimeout(hoverTipTimer);
      hoverTipTimer = setTimeout(() => {
        const node = build();
        if (node) placeHoverTip(anchor, node);
      }, 160);
    });
    anchor.addEventListener("pointerleave", () => {
      clearTimeout(hoverTipTimer);
      hoverTipTimer = setTimeout(hideHoverTip, 120);
    });
    anchor.addEventListener("pointerdown", hideHoverTip);
  }

  function worktreePendingTip(on) {
    const tip = el("div", "ag-usage-tip ag-wt-tip");
    tip.append(el("div", "ag-usage-tip-title", "Worktree"));
    tip.append(
      el(
        "div",
        "ag-usage-tip-note",
        on ? "New git worktree on a branch of its own, made on the first message. Click to turn off." : "Works in the folder. Click to use a new git worktree instead."
      )
    );
    return tip;
  }

  function worktreeTip(wt) {
    const tip = el("div", "ag-usage-tip ag-wt-tip");
    tip.append(el("div", "ag-usage-tip-title", wt.branch));
    const rows = el("dl", "ag-wt-tip-rows");
    const add = (label, value, cls) => {
      rows.append(el("dt", null, label), el("dd", cls, value));
    };
    add("From", wt.base || "detached HEAD");
    const state = [wt.ahead ? `${wt.ahead} commit${wt.ahead === 1 ? "" : "s"} ahead` : "No new commits"];
    if (wt.dirty) state.push("uncommitted changes");
    add("State", state.join(" · "));
    add("Path", wt.path, "ag-wt-tip-path");
    tip.append(rows);
    return tip;
  }

  function hideUsageTip() {
    hideHoverTip();
  }

  function usageTip(provider) {
    const limits = planLimits(provider);
    if (!limits) return null;
    const tip = el("div", "ag-usage-tip");
    tip.append(el("div", "ag-usage-tip-title", `${PROVIDER_LABEL[provider] || provider} plan usage`));
    for (const w of limits.windows) {
      const row = el("div", `ag-usage-tip-row lvl-${usageLevel(w.utilization)}`);
      const bar = el("div", "ag-meter-bar");
      const fill = el("div", "ag-meter-fill");
      fill.style.width = `${Math.min(100, Math.round(w.utilization * 100))}%`;
      bar.append(fill);
      row.append(el("span", "ag-usage-tip-label", w.label), bar, el("span", "ag-usage-tip-pct", percent(w.utilization)));
      if (w.resetsAt) row.append(el("span", "ag-usage-tip-reset", resetText(w.resetsAt)));
      tip.append(row);
    }
    if (limits.overage) tip.append(el("div", "ag-usage-tip-note", "Using extra usage"));
    return tip;
  }

  /* ----- context window ----- */

  /** Cursor's model parameter for the context window size ("272k", "1m"). */
  const CONTEXT_PARAM = "context";

  function tokenCount(n) {
    if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  /** "272k" or "1m" as tokens. */
  function sizeTokens(value) {
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(String(value || "").trim());
    if (!m) return 0;
    return Math.round(parseFloat(m[1]) * (m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2] ? 1000 : 1));
  }

  /** The context of a chat: the latest turn's usage, and the size option when the model has one. */
  function contextInfo(view) {
    const s = view.settings();
    const t = view.thread();
    const info = modelInfo(s.provider, s.model);
    const param = info?.params?.find((p) => p.id === CONTEXT_PARAM) || null;
    const size = param ? (s.modelParams?.[CONTEXT_PARAM] ?? param.default) : null;
    const turns = t ? [...(S.details.get(t.id)?.turns.values() || [])].sort((a, b) => a.seq - b.seq) : [];
    const last = [...turns].reverse().find((x) => x.usage?.contextWindow || x.usage?.contextTokens);
    const usage = last?.usage || null;
    const window = usage?.contextWindow || sizeTokens(size) || 0;
    const used = usage?.contextTokens || 0;
    return { s, param, size, usage, used, window, fraction: window ? Math.min(1, used / window) : 0 };
  }

  /** A ring that fills as the context does. Click picks the window size where the model has one; hover gives details. */
  function contextMeter(view) {
    const ctx = contextInfo(view);
    const level = usageLevel(ctx.fraction);
    const meter = button("", `ag-ctx-meter lvl-${level}${ctx.param ? "" : " fixed"}`, (event) => {
      if (!ctx.param) return;
      hideUsageTip();
      const cur = ctx.size;
      openMenu(
        event.currentTarget,
        [
          { header: "Context window" },
          ...ctx.param.options.map((o) => ({
            label: o.label,
            detail: sizeTokens(o.id) > sizeTokens(ctx.param.default) ? "Uses more credits per message" : undefined,
            checked: cur === o.id,
            run: () => view.updateSettings({ modelParams: { ...(ctx.s.modelParams || {}), [CONTEXT_PARAM]: o.id } }),
          })),
        ],
        { width: 240 }
      );
    });
    meter.setAttribute("aria-label", ctx.window ? `Context ${percent(ctx.fraction)} of ${tokenCount(ctx.window)}` : "Context");
    // Two circles: the track and an arc whose dash length is the share in use.
    const r = 6;
    const length = 2 * Math.PI * r;
    meter.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="${r}" class="ag-ctx-track"/>${ctx.fraction > 0 ? `<circle cx="8" cy="8" r="${r}" class="ag-ctx-fill" stroke-dasharray="${(ctx.fraction * length).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 8 8)"/>` : ""}</svg>`;
    bindHoverTip(meter, () => contextTip(contextInfo(view)));
    return meter;
  }

  function contextTip(ctx) {
    const tip = el("div", "ag-usage-tip");
    tip.append(el("div", "ag-usage-tip-title", "Context"));
    if (ctx.window && (ctx.used > 0 || ctx.usage?.contextTokens != null)) {
      const row = el("div", `ag-usage-tip-row lvl-${usageLevel(ctx.fraction)}`);
      const bar = el("div", "ag-meter-bar");
      const fill = el("div", "ag-meter-fill");
      fill.style.width = `${Math.round(ctx.fraction * 100)}%`;
      bar.append(fill);
      row.append(el("span", "ag-usage-tip-label", `${tokenCount(ctx.used)} of ${tokenCount(ctx.window)}`), bar, el("span", "ag-usage-tip-pct", percent(ctx.fraction)));
      tip.append(row);
    } else {
      const note = !ctx.window
        ? "Shows how full the context is after the first reply."
        : ctx.s.provider === "cursor" && !ctx.usage
          ? `Window: ${tokenCount(ctx.window)}. Cursor does not report how full it is.`
          : `Window: ${tokenCount(ctx.window)}. Shows how full it is after the first reply.`;
      tip.append(el("div", "ag-usage-tip-note", note));
    }
    const u = ctx.usage;
    if (u && (u.inputTokens || u.outputTokens)) {
      const parts = [u.inputTokens ? `${tokenCount(u.inputTokens)} in` : "", u.cacheReadTokens ? `${tokenCount(u.cacheReadTokens)} cached` : "", u.outputTokens ? `${tokenCount(u.outputTokens)} out` : ""].filter(Boolean);
      tip.append(el("div", "ag-usage-tip-note", `Last turn: ${parts.join(" · ")}`));
    }
    if (ctx.param) tip.append(el("div", "ag-usage-tip-note", "Click to change the window size. A bigger window costs more credits per message."));
    return tip;
  }

  /** Windows the full chip lists: Cursor's Included is Auto + API, on-demand only once used. */
  function chipWindows(limits) {
    return limits.windows.filter((w) => w.id !== "cursor_included" && (w.id !== "cursor_on_demand" || w.utilization > 0));
  }

  /** Compact chip: Claude's 5-hour, Cursor's Included, else the fullest listed window. */
  function compactWindow(limits) {
    const listed = chipWindows(limits);
    return limits.windows.find((w) => w.id === "five_hour") || limits.windows.find((w) => w.id === "cursor_included") || listed.reduce((a, b) => (a.utilization >= b.utilization ? a : b), listed[0]) || null;
  }

  /** Plan usage on the composer: one percent in the floating chat and sidebar, or "5h 84%" windows in the full window. Nothing until the provider has reported. */
  function usageChip(provider, compact = false) {
    const limits = planLimits(provider);
    if (!limits) return null;
    const listed = chipWindows(limits);
    const one = compact ? compactWindow(limits) : null;
    if (!(compact ? one : listed.length)) return null;
    const top = one ? one.utilization : Math.max(...limits.windows.map((w) => w.utilization));
    const chip = button("", `ag-usage lvl-${usageLevel(top)}`, () => {
      hideUsageTip();
      agentSettings.open();
    }, "");
    if (compact) {
      chip.append(el("span", `ag-usage-w lvl-${usageLevel(one.utilization)}`, percent(one.utilization)));
      chip.setAttribute("aria-label", `${PROVIDER_LABEL[provider] || provider} plan usage ${percent(one.utilization)} of ${one.label}`);
    } else {
      chip.setAttribute("aria-label", `${PROVIDER_LABEL[provider] || provider} plan usage`);
      for (const w of listed) chip.append(el("span", `ag-usage-w lvl-${usageLevel(w.utilization)}`, `${planWindowShort(w)} ${percent(w.utilization)}`));
    }
    bindHoverTip(chip, () => usageTip(provider));
    return chip;
  }

  /** Full meters for the settings dialog. */
  function usageMeters(provider) {
    const box = el("div", "ag-meters");
    const limits = planLimits(provider);
    const head = el("div", "ag-meter-head");
    head.append(el("strong", null, PROVIDER_LABEL[provider] || provider));
    if (limits) head.append(el("span", "ag-muted", ` · updated ${R.timeAgo(limits.at)}${limits.overage ? " · using extra usage" : ""}`));
    box.append(head);
    if (!limits) {
      box.append(
        el(
          "p",
          "ag-muted ag-meter-none",
          provider === "claude" ? "Shows after the next Claude turn. After that, Scribe checks again when a usage window resets." : "Shows after the next Cursor turn, then refreshes after turns at most every 30 minutes. Needs CURSOR_ACCESS_TOKEN in the daemon's environment."
        )
      );
      return box;
    }
    for (const w of limits.windows) {
      const row = el("div", `ag-meter lvl-${usageLevel(w.utilization)}`);
      const bar = el("div", "ag-meter-bar");
      const fill = el("div", "ag-meter-fill");
      fill.style.width = `${Math.min(100, Math.round(w.utilization * 100))}%`;
      bar.append(fill);
      row.append(el("span", "ag-meter-label", w.label), bar, el("span", "ag-meter-pct", percent(w.utilization)), el("span", "ag-meter-reset", resetText(w.resetsAt)));
      box.append(row);
    }
    return box;
  }

  /* ---------- agent settings: their own dialog, opened from the chat header or the board's Settings ---------- */

  const KEYS = [
    ["Ctrl+L", "Sidebar chat"],
    ["Ctrl+K", "Floating chat"],
    ["Ctrl+Shift+L", "Full window"],
    ["Ctrl+↑ / Ctrl+↓", "From a chat into the full window and back; expand, collapse, or hide the floating chat"],
    ["Ctrl+J", "Threads"],
    ["Ctrl+Shift+K", "New thread with this chat's agent settings"],
    ["Ctrl+'", "Next starred model"],
    ["Ctrl+Alt+'", "Next reasoning level"],
    ["Ctrl+Shift+'", "Next mode"],
    ["Enter on an empty box", "Steer in, or send, the first queued message"],
    ["↑ on an empty box", "Edit the last queued message"],
    ["Esc Esc", "Stop the agent"],
  ];

  /** A labelled setting row with its control on the right. */
  function settingRow(text, control, { id, title } = {}) {
    const row = el("div", "setting-row");
    const label = el("span", null, text);
    if (title) label.title = title;
    if (id) {
      label.id = id;
      control.setAttribute("aria-labelledby", id);
    }
    row.append(label, control);
    return row;
  }

  function switchControl(isOn, toggle) {
    const b = el("button", "pill-toggle");
    b.type = "button";
    b.setAttribute("role", "switch");
    const sync = () => b.setAttribute("aria-checked", String(isOn()));
    b.addEventListener("click", () => {
      toggle();
      sync();
    });
    sync();
    return b;
  }

  function choiceTrack(options, current, pick) {
    const track = el("div", "button-track text-track");
    track.setAttribute("role", "group");
    const sync = () => {
      for (const b of track.children) b.setAttribute("aria-pressed", String(b.dataset.value === current()));
    };
    for (const option of options) {
      const b = button(option.label, null, () => {
        pick(option.id);
        sync();
      });
      b.dataset.value = option.id;
      track.append(b);
    }
    sync();
    return track;
  }

  /* ---------- allowlists: the providers' own allow / ask / deny rules ---------- */

  const RULE_HELP = {
    claude: "Tool name, optionally with a pattern: Bash(npm test:*), Bash(git status), Read(./src/**), Edit, WebFetch(domain:docs.rs), mcp__server__tool.",
    cursor: "Shell(git status) allows that command (prefix match), Read(**/*.md), Write(src/**), Mcp(server:tool), WebFetch(docs.rs).",
  };
  const SCOPE_LABEL = { user: "Everywhere (user)", project: "This workspace (shared)", local: "This workspace (only you)" };
  const KIND_LABEL = { allow: "Allow", ask: "Always ask", deny: "Deny" };

  const allowlists = {
    root: null,
    body: null,
    picker: null,
    cwd: null,
    mount() {
      const root = el("div", "settings ag-perm-dialog");
      root.hidden = true;
      const backdrop = el("div", "settings-backdrop");
      backdrop.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.close();
      });
      const panel = el("div", "settings-panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "ag-perm-title");
      const title = el("h2", "settings-title", "Allowlists");
      title.id = "ag-perm-title";
      this.web = el("section", "settings-section ag-web-allow");
      this.hooks = el("section", "settings-section");
      const commands = el("section", "settings-section");
      const intro = el(
        "p",
        "settings-hint",
        "The rules Claude Code and Cursor apply before they ask you. They live in the providers' own config files; Scribe only edits their permission lists. \"Always allow\" on an approval adds a rule here too."
      );
      const pick = el("div", "setting-row");
      const label = el("span", null, "Workspace");
      label.id = "ag-perm-ws-label";
      this.picker = el("select");
      this.picker.setAttribute("aria-labelledby", label.id);
      this.picker.addEventListener("change", () => {
        this.cwd = this.picker.value || null;
        void this.load();
      });
      pick.append(label, this.picker);
      commands.append(el("h3", null, "Commands"), intro, pick);
      this.body = el("div", "ag-perm-body");
      panel.append(title, this.web, this.hooks, commands, this.body);
      root.append(backdrop, panel);
      document.body.append(root);
      this.root = root;
      this.pickerWrap = window.createSelect ? window.createSelect(this.picker) : null;
    },
    isOpen() {
      return Boolean(this.root && !this.root.hidden);
    },
    open() {
      if (!this.root) return;
      const current = targetView().settings().cwd || null;
      const dirs = [...new Set([current, ...(prefs().recentWorkspaces || [])].filter(Boolean))];
      this.picker.replaceChildren(...dirs.map((dir) => el("option", null, dir)), el("option", null, "No workspace: user rules only"));
      [...this.picker.options].forEach((option, i) => (option.value = i < dirs.length ? dirs[i] : ""));
      this.cwd = dirs[0] || null;
      this.picker.value = this.cwd || "";
      this.pickerWrap?.syncSelect?.();
      this.renderWeb();
      this.renderHooks();
      this.root.hidden = false;
      void this.load();
    },
    /** Domains for Limited web access. Scribe's own list (prefs), the same for every workspace. */
    renderWeb() {
      const list = prefs().webAllowlist || [];
      const rows = el("div", "ag-perm-rules");
      for (const domain of list) {
        const row = el("span", "ag-perm-rule");
        row.append(el("code", null, domain), button(icon("close"), "ag-chip-x", () => this.saveWeb(list.filter((d) => d !== domain)), `Remove ${domain}`));
        rows.append(row);
      }
      const input = el("input", "ag-input small ag-perm-add");
      input.placeholder = "Add a domain, e.g. example.com";
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || !input.value.trim()) return;
        event.preventDefault();
        void this.saveWeb([...list, input.value.trim()]);
      });
      rows.append(input);
      const actions = el("div", "settings-actions");
      actions.append(button("Reset to defaults", null, () => this.saveWeb(null)));
      this.web.replaceChildren(
        el("h3", null, "Web"),
        el(
          "p",
          "settings-hint",
          "With web set to Limited, Claude threads may search and fetch only these domains and their subdomains, without asking. Fetches anywhere else are refused."
        ),
        rows,
        actions
      );
    },
    /** Whether Claude threads run the hooks from Claude Code's settings files and plugins (prefs). */
    renderHooks() {
      const label = el("label", "ag-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = Boolean(prefs().claudeHooks);
      box.addEventListener("change", async () => {
        try {
          S.config.prefs = await api("PUT", "/prefs", { claudeHooks: box.checked });
        } catch (err) {
          box.checked = !box.checked;
          notice(err.message);
        }
      });
      label.append(box, el("span", null, "Run Claude Code hooks in Claude threads"));
      this.hooks.replaceChildren(
        el("h3", null, "Hooks"),
        el(
          "p",
          "settings-hint",
          "Hooks from your Claude Code settings files and plugins are written for your own terminal sessions. One that fails closed, such as a plugin that checks each tool call with a local service, can deny every tool in Scribe without saying why. Off by default; Scribe's own checks run either way. Applies from a thread's next message."
        ),
        label
      );
    },
    async saveWeb(list) {
      try {
        S.config.prefs = await api("PUT", "/prefs", { webAllowlist: list });
        this.renderWeb();
        this.web.querySelector(".ag-perm-add")?.focus();
      } catch (err) {
        notice(err.message);
      }
    },
    close() {
      if (!this.isOpen()) return false;
      this.root.hidden = true;
      return true;
    },
    async load() {
      this.body.replaceChildren(el("div", "ag-muted", "Loading…"));
      try {
        const { sets } = await api("GET", `/permissions${this.cwd ? `?cwd=${encodeURIComponent(this.cwd)}` : ""}`);
        this.render(sets);
      } catch (err) {
        this.body.replaceChildren(el("div", "ag-muted", err.message));
      }
    },
    render(sets) {
      this.body.replaceChildren();
      for (const provider of ["claude", "cursor"]) {
        const mine = sets.filter((set) => set.provider === provider);
        if (!mine.length) continue;
        const section = el("section", "settings-section");
        section.append(el("h3", null, PROVIDER_LABEL[provider]), el("p", "settings-hint ag-perm-help", RULE_HELP[provider]));
        for (const set of mine) section.append(this.renderSet(set));
        this.body.append(section);
      }
    },
    renderSet(set) {
      const box = el("div", "ag-perm-set");
      box.dataset.key = `${set.provider}:${set.scope}`;
      const head = el("div", "ag-perm-head");
      head.append(el("strong", null, SCOPE_LABEL[set.scope]), el("span", "ag-perm-path", set.path + (set.exists ? "" : " (created when you add a rule)")));
      box.append(head);
      if (set.error) {
        box.append(el("div", "ag-perm-error", `Can't read this file, so it is left alone: ${set.error}`));
        return box;
      }
      for (const kind of set.kinds) {
        const list = set[kind] || [];
        const group = el("div", `ag-perm-kind k-${kind}`);
        group.append(el("span", "ag-perm-kind-label", KIND_LABEL[kind]));
        const rows = el("div", "ag-perm-rules");
        for (const rule of list) {
          const row = el("span", "ag-perm-rule");
          row.append(el("code", null, rule), button(icon("close"), "ag-chip-x", () => this.save(set, kind, list.filter((r) => r !== rule)), `Remove ${rule}`));
          rows.append(row);
        }
        const input = el("input", "ag-input small ag-perm-add");
        input.placeholder = list.length ? "Add a rule" : kind === "allow" ? (set.provider === "claude" ? "e.g. Bash(npm test:*)" : "e.g. Shell(npm test)") : "Add a rule";
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || !input.value.trim()) return;
          event.preventDefault();
          void this.save(set, kind, [...list, input.value.trim()]);
        });
        rows.append(input);
        group.append(rows);
        box.append(group);
      }
      return box;
    },
    async save(set, kind, rules) {
      try {
        const { set: next } = await api("PUT", "/permissions", { provider: set.provider, scope: set.scope, cwd: this.cwd, kind, rules });
        const old = this.body.querySelector(`.ag-perm-set[data-key="${set.provider}:${set.scope}"]`);
        const fresh = this.renderSet(next);
        old?.replaceWith(fresh);
        fresh.querySelector(`.k-${kind} .ag-perm-add`)?.focus();
      } catch (err) {
        notice(err.message);
      }
    },
  };

  const agentSettings = {
    root: null,
    status: null,
    mount() {
      const root = el("div", "settings ag-settings-dialog");
      root.hidden = true;
      const backdrop = el("div", "settings-backdrop");
      backdrop.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.close();
      });
      const panel = el("div", "settings-panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-labelledby", "ag-settings-title");
      const title = el("h2", "settings-title", "Agent settings");
      title.id = "ag-settings-title";

      const providers = el("section", "settings-section");
      this.status = el("div", "ag-settings-status");
      const actions = el("div", "settings-actions");
      actions.append(
        button("Refresh models", null, async () => {
          for (const provider of PROVIDERS) {
            if (!providerAvailable(provider)) continue;
            const data = await api("GET", `/models?provider=${provider}&refresh=1`).catch(() => null);
            if (data?.models?.length) S.config.models[provider] = data.models;
          }
          notice("Models refreshed");
          renderAll();
        })
      );
      actions.append(
        button("Allowlists…", null, () => {
          this.close();
          allowlists.open();
        })
      );
      providers.append(el("h3", null, "Providers"), this.status, actions);

      const cursor = el("section", "settings-section");
      const hostShell = switchControl(
        () => Boolean(prefs().cursorHostShell),
        () => {
          const on = !prefs().cursorHostShell;
          S.config.prefs = { ...prefs(), cursorHostShell: on };
          api("PUT", "/prefs", { cursorHostShell: on })
            .then((next) => {
              S.config.prefs = next;
              renderAll();
            })
            .catch((err) => {
              S.config.prefs = { ...prefs(), cursorHostShell: !on };
              hostShell.setAttribute("aria-checked", String(!on));
              notice(err.message);
            });
        }
      );
      cursor.append(
        el("h3", null, "Cursor"),
        settingRow("Ask before shell commands (experimental)", hostShell, { id: "ag-cursor-shell-label" }),
        el(
          "p",
          "settings-hint",
          "The Cursor SDK can't ask you before a tool runs. With this on, Code and Plan threads set to Ask or Edits get Scribe's own shell tool instead of Cursor's: you approve each command, and Scribe runs it outside Cursor's sandbox. File edits still go through Auto-review. Board workers keep Cursor's shell. Applies from a thread's next message."
        )
      );

      const sources = el("section", "settings-section");
      this.sources = el("div", "ag-sources");
      const sourceActions = el("div", "settings-actions");
      sourceActions.append(button("Add source…", null, () => editSource(null)));
      sources.append(
        el("h3", null, "Model sources"),
        el("p", "settings-hint", "OpenAI-compatible endpoints (OpenRouter, LM Studio, Ollama, vLLM, llama.cpp…) for Pi threads. Pi also offers the models of providers whose API key is set in the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, …)."),
        this.sources,
        sourceActions
      );

      const usage = el("section", "settings-section");
      this.usage = el("div", "ag-usage-list");
      usage.append(el("h3", null, "Plan usage"), this.usage);

      const chat = el("section", "settings-section");
      chat.append(
        el("h3", null, "Chat"),
        settingRow(
          "Agent button in the top bar",
          switchControl(
            () => localStorage.getItem(LS.button) !== "0",
            () => {
              localStorage.setItem(LS.button, localStorage.getItem(LS.button) === "0" ? "1" : "0");
              applyButton();
            }
          ),
          { id: "ag-button-label" }
        ),
        settingRow(
          "Floating chat style",
          choiceTrack(DOCK_STYLES, dockStyle, (id) => {
            localStorage.setItem(LS.dockStyle, id);
            dock.apply();
          }),
          { id: "ag-dock-style-label" }
        ),
        settingRow(
          "Suggestions in a new thread",
          switchControl(
            () => localStorage.getItem(LS.tips) !== "0",
            () => {
              localStorage.setItem(LS.tips, localStorage.getItem(LS.tips) === "0" ? "1" : "0");
              for (const view of views()) if (!view.thread() || !S.details.get(view.threadId)?.items.length) view.renderTranscript();
            }
          ),
          { id: "ag-tips-label" }
        ),
        settingRow(
          "Compact thread list",
          switchControl(
            () => compactThreads(),
            () => {
              localStorage.setItem(LS.compact, compactThreads() ? "0" : "1");
              renderLists();
            }
          ),
          { id: "ag-compact-label", title: "Each thread shows only its title and status dot, in a smaller font with less spacing." }
        ),
        settingRow(
          "Show reasoning expanded",
          switchControl(
            () => localStorage.getItem(LS.reasoning) === "1",
            () => {
              localStorage.setItem(LS.reasoning, localStorage.getItem(LS.reasoning) === "1" ? "0" : "1");
              renderAll();
            }
          ),
          { id: "ag-reasoning-label" }
        ),
        settingRow("Summaries for forks", this.summarizerButton(), {
          id: "ag-summarizer-label",
          title: "A fork that starts a new session (another provider) gets the earlier thread's first and last messages, and a summary of the rest written by this model. A small, fast model is enough.",
        }),
        settingRow(
          "Enter on an empty box sends a queued message",
          choiceTrack(EMPTY_ENTER, emptyEnter, (id) => {
            localStorage.setItem(LS.emptyEnter, id);
            for (const view of views()) view.renderTranscript();
          }),
          {
            id: "ag-empty-enter-label",
            title: "While the agent works. Steer hands it to the running turn, which reads it at the next safe stop; pressing Enter again stops the turn and sends it. Send now always stops the turn and sends it.",
          }
        )
      );

      const keys = el("section", "settings-section");
      const list = el("div", "ag-keys");
      for (const [combo, what] of KEYS) list.append(el("kbd", null, combo), el("span", null, what));
      keys.append(el("h3", null, "Keys"), list);

      const about = el(
        "p",
        "settings-hint",
        "Cursor runs through the Cursor SDK (log in above, or set CURSOR_API_KEY); Claude through the Claude Agent SDK with your Claude Code login."
      );
      panel.append(title, providers, cursor, sources, usage, chat, keys, about);
      root.append(backdrop, panel);
      document.body.append(root);
      this.root = root;

      // The board's Settings keep a short entry that opens this dialog.
      const boardPanel = document.getElementById("settings-panel");
      if (boardPanel) {
        const section = el("section", "settings-section ag-settings");
        section.append(
          el("h3", null, "Agent"),
          settingRow(
            "Providers, chat and keys",
            button("Agent settings…", null, () => {
              app()?.closeSettings?.();
              this.open();
            }),
            { id: "ag-open-settings-label" }
          )
        );
        boardPanel.append(section);
      }
    },
    renderStatus() {
      this.status.replaceChildren();
      for (const p of S.config.providers) {
        const row = el("div", "setting-row");
        const label = el("span");
        label.append(el("strong", null, p.label), el("span", "ag-muted", ` · ${p.detail || ""}`));
        row.append(label);
        if (p.login && !p.available) {
          row.append(
            button("Log in", "ag-btn", async () => {
              try {
                const res = await api("POST", `/${p.id}/login`);
                if (res?.url) window.open(res.url, "_blank", "noopener");
                notice("Finish the login in your browser.");
                // The login finishes in the daemon; pick it up when it does.
                for (let i = 0; i < 100; i += 1) {
                  await new Promise((resolve) => setTimeout(resolve, 3000));
                  await loadConfig();
                  if (providerAvailable(p.id)) break;
                }
                agentSettings.renderStatus();
                renderAll();
              } catch (err) {
                notice(err.message);
              }
            })
          );
        } else {
          row.append(el("span", p.available ? "ag-tag ok" : "ag-tag", p.available ? "Ready" : "Unavailable"));
        }
        this.status.append(row);
      }
    },
    async renderSources() {
      if (!this.sources) return;
      let list = [];
      try {
        list = (await api("GET", "/model-sources")).sources || [];
      } catch (err) {
        this.sources.replaceChildren(el("div", "ag-muted", err.message));
        return;
      }
      this.sources.replaceChildren();
      if (!list.length) this.sources.append(el("div", "ag-muted", "None yet."));
      for (const source of list) {
        const row = el("div", "setting-row");
        const label = el("span");
        const models = source.models.length ? `${source.models.length} model${source.models.length === 1 ? "" : "s"}` : "models from the endpoint";
        label.append(el("strong", null, source.name), el("span", "ag-muted", ` · ${source.baseUrl} · ${models}${source.hasKey ? "" : " · no key"}`));
        row.append(label, button("Edit", "ag-btn small", () => editSource(source)));
        this.sources.append(row);
      }
    },
    isOpen() {
      return Boolean(this.root && !this.root.hidden);
    },
    renderUsage() {
      if (!this.usage || !this.isOpen()) return;
      this.usage.replaceChildren(...["claude", "cursor"].filter((p) => S.config.providers.some((x) => x.id === p)).map(usageMeters));
    },
    /** The model that writes a fork's summary; picks from every available provider's models. */
    summarizerButton() {
      const b = el("button", "ag-pill ag-summarizer");
      b.type = "button";
      this.summarizer = b;
      b.addEventListener("click", () => {
        const cur = prefs().summarizer || {};
        const items = [];
        for (const provider of PROVIDERS) {
          if (!providerAvailable(provider)) continue;
          items.push({ header: PROVIDER_LABEL[provider] });
          for (const m of modelsOf(provider)) {
            items.push({
              label: m.label,
              detail: m.id !== m.label ? m.id : m.description,
              search: `${provider} ${m.id}`,
              checked: cur.provider === provider && cur.model === m.id,
              run: async () => {
                try {
                  S.config.prefs = await api("PUT", "/prefs", { summarizer: { provider, model: m.id } });
                  this.renderSummarizer();
                } catch (err) {
                  notice(err.message);
                }
              },
            });
          }
        }
        openMenu(b, items, { search: true, width: 300, placeholder: "Search models" });
      });
      this.renderSummarizer();
      return b;
    },
    renderSummarizer() {
      if (!this.summarizer) return;
      const cur = prefs()?.summarizer;
      this.summarizer.replaceChildren();
      if (!cur) return;
      this.summarizer.append(el("span", `ag-prov p-${cur.provider}`, PROVIDER_GLYPH[cur.provider] || "?"), el("span", null, modelInfo(cur.provider, cur.model)?.label || cur.model));
    },
    open() {
      if (!this.root) return;
      this.renderStatus();
      void this.renderSources();
      this.renderSummarizer();
      this.root.hidden = false;
      this.renderUsage();
      this.root.querySelector(".settings-panel button")?.focus({ preventScroll: true });
    },
    close() {
      if (!this.isOpen()) return false;
      this.root.hidden = true;
      return true;
    },
  };

  /* ---------- board.agent: pages that start and continue their own threads ---------- */

  const PAGE_PROMPT_MAX = 20000;
  const PAGE_MODES = new Set(["board", "ask", "code", "plan"]);
  /** Modes with file and shell access: the page needs the folder approved (agent.workspace). */
  const FOLDER_MODES = new Set(["code", "plan"]);
  /** board.agent.wait calls by thread id. */
  const pageWaiters = new Map();
  /** When a page last sent to each thread: until the thread has been active since, it is not done with it. */
  const pageSentAt = new Map();

  function ownedBy(tab, t) {
    return Boolean(t && t.scope.kind === "page" && t.scope.ref === tab.id);
  }

  function pageBrief(t) {
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      queued: t.queued || 0,
      activityAt: t.activityAt,
      ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
      mode: t.mode,
      provider: t.provider,
      model: t.model,
      effort: t.effort,
      ...(FOLDER_MODES.has(t.mode) ? { cwd: pageFolder(t), approval: t.approval } : {}),
    };
  }

  /** The folder a page's Code or Plan thread was approved for: the picked folder, not its worktree. */
  function pageFolder(t) {
    return t.worktree?.home || t.cwd || null;
  }

  /** The text of the latest turn's replies. */
  async function lastReply(id) {
    const detail = await ensureDetail(id);
    if (!detail) return "";
    const turns = [...detail.turns.values()].sort((a, b) => b.seq - a.seq);
    const turn = turns.find((x) => x.status !== "running") || turns[0];
    if (!turn) return "";
    return detail.items
      .filter((it) => it.kind === "text" && it.turnId === turn.id && !it.parentToolId)
      .map((it) => it.text)
      .join("\n\n")
      .trim();
  }

  /**
   * Show a thread in the sidebar or the floating chat. `reveal` (the user clicked for it) also clears
   * whatever would hide it: an open menu, the sidebar's thread list, and the full window, which shows it instead.
   * Without it (background starts and sends) nothing the user has open is closed.
   */
  function showPageThread(id, where, { reveal = false } = {}) {
    if (reveal) {
      closeMenu();
      setCurrent(id);
      if (S.fullOpen && where === "sidebar") {
        full.view.setThread(id);
        full.renderList();
        full.view.focus();
        return;
      }
    }
    if (where === "sidebar") {
      if (!S.sideOpen) sidebar.setOpen(true);
      sidebar.view.setThread(id);
      if (reveal && sidebar.listOpen) sidebar.toggleList();
    } else if (where === "dock") {
      if (id !== dock.view.threadId) dock.pick(id);
      if (!S.dockShown) dock.setShown(true);
    }
  }

  /** A user's "open thread" click from a page, card, link, toast, or the palette. */
  function openThread(id) {
    const thread = S.threads.get(id);
    if (!thread || thread.archived) return false;
    showPageThread(id, "sidebar", { reveal: true });
    return true;
  }

  /** Palette (`=` prefix) and anything else that wants the same match as the thread-menu search. */
  function searchThreads(query, { limit = 40 } = {}) {
    const q = String(query || "").trim();
    let threads = [...S.threads.values()].filter((t) => !t.archived);
    if (q) threads = threads.filter((t) => threadMatchesQuery(t, q));
    threads.sort((a, b) => threadRank(b) - threadRank(a));
    return threads.slice(0, limit).map((t) => {
      const scope = scopeLabel(t.scope);
      const running = t.status === "running" || (t.status === "idle" && t.background);
      return {
        kind: "thread",
        id: t.id,
        title: t.title,
        snippet: scope.text && scope.text !== "Global" ? scope.text : "",
        locationLabel: "Thread",
        location: "thread",
        qualityLabel: running ? "Running" : "",
        open: t.id === S.current,
      };
    });
  }

  function threadTitle(id) {
    const thread = S.threads.get(id);
    return thread && !thread.archived ? thread.title : null;
  }

  /** Tell the page about its thread's status changes, and settle board.agent.wait calls once it is idle. */
  function pageThreadChanged(t, prev) {
    if (t.scope.kind !== "page" || !t.scope.ref) return;
    if (prev && prev.status === t.status && prev.title === t.title && prev.queued === t.queued) return;
    const settle = t.status === "idle" && !t.queued;
    const send = (reply) => app()?.postToPage?.(t.scope.ref, { type: "scribe-agent-event", thread: { ...pageBrief(t), ...(reply !== undefined ? { reply } : {}) } });
    if (!settle) {
      send();
      return;
    }
    void lastReply(t.id).then((reply) => {
      send(reply);
      for (const waiter of pageWaiters.get(t.id) || []) waiter(reply);
      pageWaiters.delete(t.id);
    });
  }

  function waitIdle(id, timeoutMs) {
    return new Promise((resolve) => {
      const list = pageWaiters.get(id) || [];
      const done = (reply) => {
        clearTimeout(timer);
        resolve({ ok: true, reply });
      };
      const timer = setTimeout(() => {
        const rest = (pageWaiters.get(id) || []).filter((w) => w !== done);
        if (rest.length) pageWaiters.set(id, rest);
        else pageWaiters.delete(id);
        resolve({ ok: false, error: "timeout" });
      }, Math.min(Math.max(Number(timeoutMs) || 600000, 1000), 6 * 3600 * 1000));
      list.push(done);
      pageWaiters.set(id, list);
    });
  }

  /**
   * Whether `tab` may start, send, or stop now: agent.chat always, and agent.unattended when the
   * click or key press did not reach the board. scribePermissions asks the user when undecided.
   */
  async function pageMayWrite(tab, activated) {
    const perms = window.scribePermissions;
    if (!perms) return activated ? { ok: true } : { ok: false, error: "no_gesture" };
    const chat = await perms.ensure(tab, { perm: "agent.chat" });
    if (!chat.ok || activated) return chat;
    return perms.ensure(tab, { perm: "agent.unattended" });
  }

  /** Code and Plan threads need their folder approved for the page, at this approval or a looser one. */
  function pageMayUseFolder(tab, folder, approval) {
    const perms = window.scribePermissions;
    if (!perms) return { ok: false, error: "denied", permission: "agent.workspace" };
    return perms.ensure(tab, { perm: "agent.workspace", folder, approval });
  }

  /** What scribe.agent.start can pick from. */
  async function pageOptions() {
    const p = prefs();
    const available = S.config.providers.filter((x) => x.available);
    await Promise.all(
      available
        .filter((x) => !modelsOf(x.id).length)
        .map((x) =>
          api("GET", `/models?provider=${x.id}`)
            .then((data) => {
              if (data.models?.length) S.config.models[x.id] = data.models;
            })
            .catch(() => undefined)
        )
    );
    const provider = providerAvailable(p.provider) ? p.provider : available[0]?.id || null;
    return {
      ok: true,
      providers: S.config.providers.map((x) => ({ id: x.id, label: x.label, available: Boolean(x.available) })),
      models: Object.fromEntries(
        available.map((x) => [
          x.id,
          modelsOf(x.id).map((m) => ({
            id: m.id,
            label: m.label,
            efforts: m.efforts || [],
            defaultEffort: m.defaultEffort ?? null,
            params: (m.params || []).map((param) => ({
              id: param.id,
              label: param.label,
              description: param.description || "",
              options: (param.options || []).map((o) => ({ id: o.id, label: o.label })),
              default: param.default || "",
            })),
          })),
        ])
      ),
      modes: MODES.map((m) => ({ id: m.id, label: m.label, detail: m.detail, needsFolder: FOLDER_MODES.has(m.id) })),
      approvals: APPROVALS.map((a) => ({ id: a.id, label: a.label, detail: a.detail })),
      defaults: provider
        ? {
            provider,
            model: p.models?.[provider] || "default",
            effort: p.efforts?.[provider] ?? null,
            approval: approvalFor(provider, p),
            web: webMode(p.web),
            fast: p.modelParams?.[provider]?.fast === "true",
          }
        : null,
    };
  }

  /** The new thread's settings from scribe.agent.start options, or { error }. Unset ones follow the user's defaults. */
  function pageThreadSettings(data) {
    const p = prefs();
    let provider = providerAvailable(p.provider) ? p.provider : S.config.providers.find((x) => x.available)?.id;
    if (data.provider) {
      if (!providerAvailable(data.provider)) return { error: "unknown_provider" };
      provider = data.provider;
    }
    if (!provider) return { error: "no_provider" };
    const mode = data.mode || "board";
    if (!PAGE_MODES.has(mode)) return { error: "unknown_mode" };
    // The user's model settings only carry over when the page keeps their provider and model.
    const own = Boolean((data.model && data.model !== "default") || data.provider);
    if (data.model && data.model !== "default" && modelsOf(provider).length && !modelInfo(provider, data.model)) return { error: "unknown_model" };
    const model = data.model || (own ? "default" : p.models?.[provider] || "default");
    const efforts = modelInfo(provider, model)?.efforts || [];
    if (data.effort && efforts.length && !efforts.some((e) => e.id === data.effort)) return { error: "unknown_effort" };
    if (data.approval && !APPROVALS.some((a) => a.id === data.approval)) return { error: "unknown_approval" };
    const folderMode = FOLDER_MODES.has(mode);
    const cwd = folderMode && typeof data.cwd === "string" ? data.cwd.trim() : "";
    if (folderMode && !cwd) return { error: "needs_folder" };
    const modelParams = { ...(own ? {} : p.modelParams?.[provider] || {}) };
    if (data.modelParams && typeof data.modelParams === "object" && !Array.isArray(data.modelParams)) {
      for (const [key, value] of Object.entries(data.modelParams)) {
        if (value != null && value !== "") modelParams[key] = String(value);
      }
    }
    if (typeof data.fast === "boolean") modelParams.fast = data.fast ? "true" : "false";
    else if (data.fast === "true" || data.fast === "false") modelParams.fast = data.fast;
    return {
      provider,
      model,
      effort: data.effort || (own ? null : p.efforts?.[provider] ?? null),
      modelParams,
      mode,
      approval: data.approval || approvalFor(provider, p),
      web: webMode(data.web, webMode(p.web)),
      cwd: cwd || null,
      useWorktree: folderMode && data.worktree === true,
    };
  }

  /**
   * One scribe.agent call from `tab` (app.js found it from the asking frame, and whether the click
   * or key press reached the board). Pages only see and drive threads that belong to them; the
   * permissions the user gave the page decide what else they may do.
   */
  async function pageRequest(tab, data, { activated = true } = {}) {
    const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
    const thread = data.threadId ? S.threads.get(data.threadId) : null;
    switch (data.op) {
      case "threads":
        return {
          ok: true,
          threads: [...S.threads.values()]
            .filter((t) => ownedBy(tab, t) && !t.archived)
            .sort((a, b) => b.activityAt - a.activityAt)
            .map(pageBrief),
        };
      case "get":
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        return { ok: true, thread: pageBrief(thread), reply: await lastReply(thread.id) };
      case "wait": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        await ensureDetail(thread.id);
        const now = S.threads.get(thread.id);
        const caughtUp = (now.activityAt || 0) >= (pageSentAt.get(now.id) || 0);
        if (now.status === "idle" && !now.queued && caughtUp) return { ok: true, thread: pageBrief(now), reply: await lastReply(now.id) };
        const result = await waitIdle(now.id, data.timeoutMs);
        const after = S.threads.get(now.id);
        return after ? { ...result, thread: pageBrief(after) } : { ok: false, error: "not_found" };
      }
      case "show":
        // Only opens it for the user; nothing about the thread goes back to the page.
        if (!activated) return { ok: false, error: "no_gesture" };
        if (!thread || thread.archived) return { ok: false, error: "not_found" };
        showPageThread(thread.id, data.where === "dock" ? "dock" : "sidebar", { reveal: true });
        return { ok: true };
      case "options":
        return pageOptions();
      case "actions":
        // The template's right-click actions, for a page that draws its own menu (#161).
        return {
          ok: true,
          actions: declaredActions(tab, "menu").map((a) => ({
            id: a.id,
            label: a.label,
            ...(a.description ? { description: a.description } : {}),
            ...(a.selection ? { selection: a.selection } : {}),
            context: a.context || [],
          })),
        };
      case "runAction": {
        if (!activated) return { ok: false, error: "no_gesture" };
        const action = declaredActions(tab, "menu").find((a) => a.id === data.action);
        if (!action) return { ok: false, error: "not_found" };
        const context = data.context && typeof data.context === "object" && !Array.isArray(data.context) ? data.context : {};
        if (!hasContext(action, context)) return { ok: false, error: "missing_context" };
        const selection = typeof data.selection === "string" ? data.selection.trim().slice(0, 20000) : "";
        if (action.selection === "required" && !selection) return { ok: false, error: "needs_selection" };
        await runAction(tab, action, { selection: action.selection === "none" ? "" : selection, context });
        return { ok: true };
      }
      case "pickFolder": {
        if (!activated) return { ok: false, error: "no_gesture" };
        const picked = await pickWorkspace(typeof data.initial === "string" ? data.initial : "");
        return picked ? { ok: true, path: picked } : { ok: false, error: "cancelled" };
      }
      case "start": {
        if (!prompt) return { ok: false, error: "empty_prompt" };
        if (prompt.length > PAGE_PROMPT_MAX) return { ok: false, error: "prompt_too_long" };
        const settings = pageThreadSettings(data);
        if (settings.error) return { ok: false, error: settings.error };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        if (settings.cwd) {
          const folder = await pageMayUseFolder(tab, settings.cwd, settings.approval);
          if (!folder.ok) return folder;
        }
        const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 120) : undefined;
        const { thread: created } = await api("POST", "/threads", {
          ...settings,
          scope: { kind: "page", ref: tab.id },
          ...(title ? { title } : {}),
        });
        S.threads.set(created.id, created);
        S.details.set(created.id, { items: [], byId: new Map(), turns: new Map() });
        pageSentAt.set(created.id, Date.now());
        const sent = await api("POST", `/threads/${encodeURIComponent(created.id)}/messages`, { text: prompt, from: "page" });
        showPageThread(created.id, data.show, { reveal: activated });
        return { ok: true, threadId: created.id, queued: Boolean(sent.queued) };
      }
      case "send": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        if (!prompt) return { ok: false, error: "empty_prompt" };
        if (prompt.length > PAGE_PROMPT_MAX) return { ok: false, error: "prompt_too_long" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        if (FOLDER_MODES.has(thread.mode)) {
          const folder = await pageMayUseFolder(tab, pageFolder(thread), thread.approval);
          if (!folder.ok) return folder;
        }
        await ensureDetail(thread.id);
        pageSentAt.set(thread.id, Date.now());
        const sent = await api("POST", `/threads/${encodeURIComponent(thread.id)}/messages`, { text: prompt, from: "page" });
        showPageThread(thread.id, data.show, { reveal: activated });
        return { ok: true, queued: Boolean(sent.queued) };
      }
      case "card": {
        // A card comment for the thread working on the card (steered into its turn, or queued), or
        // Continue for the one that worked on it. The thread may be any of the user's (one that
        // claimed the card from its own chat), so other pages' threads need the click; the daemon
        // words the message, so it reads as the board's, not the user's in the chat.
        if (!thread || thread.archived) return { ok: false, error: "not_found" };
        const num = Number(data.card);
        if (!Number.isInteger(num) || num < 1) return { ok: false, error: "bad_card" };
        const resume = data.resume === true;
        if (!resume && !prompt) return { ok: false, error: "empty_prompt" };
        if (prompt.length > PAGE_PROMPT_MAX) return { ok: false, error: "prompt_too_long" };
        const own = ownedBy(tab, thread);
        if (!own && !activated) return { ok: false, error: "no_gesture" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        if (own && FOLDER_MODES.has(thread.mode)) {
          const folder = await pageMayUseFolder(tab, pageFolder(thread), thread.approval);
          if (!folder.ok) return folder;
        }
        await ensureDetail(thread.id);
        const title = typeof data.title === "string" ? data.title.trim().slice(0, 200) : "";
        const sent = await api("POST", `/threads/${encodeURIComponent(thread.id)}/card-message`, {
          num,
          text: resume ? "" : prompt,
          resume,
          title,
          board: tab.title || "Kanban board",
          boardKey: tab.key || "",
        });
        if (sent.delivered && own) pageSentAt.set(thread.id, Date.now());
        return { ok: true, delivered: sent.delivered || null };
      }
      case "stop": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        await api("POST", `/threads/${encodeURIComponent(thread.id)}/cancel`);
        return { ok: true };
      }
      case "merge": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        if (!openWorktree(thread)) return { ok: true, merged: false, message: "The thread has no open worktree." };
        if (thread.status !== "idle") return { ok: false, error: "busy" };
        const may = await pageMayWrite(tab, activated);
        if (!may.ok) return may;
        const folder = await pageMayUseFolder(tab, pageFolder(thread), thread.approval);
        if (!folder.ok) return folder;
        try {
          const res = await api("POST", `/threads/${encodeURIComponent(thread.id)}/worktree`, { action: "merge" });
          return { ok: true, merged: true, message: res.message };
        } catch (err) {
          return { ok: false, error: "merge_failed", message: String(err?.message || err) };
        }
      }
      default:
        return { ok: false, error: "unknown_op" };
    }
  }

  /* ---------- keys ---------- */

  function shortcut(action) {
    if (action === "side") {
      if (S.fullOpen) full.close();
      sidebar.setOpen(!S.sideOpen);
    } else if (action === "dock") {
      if (S.dockShown && document.activeElement !== dock.view.input) {
        dock.view.focus();
        return;
      }
      dock.setShown(!S.dockShown);
    } else if (action === "full") {
      if (S.fullOpen) leaveFull();
      else enterFull(dockFocused() ? "dock" : "side");
    } else if (action === "model") {
      void cycleModel();
    } else if (action === "effort") {
      void cycleEffort();
    } else if (action === "mode") {
      void cycleMode();
    } else if (action === "threads") {
      openThreads();
    } else if (action === "new") {
      newThread();
    } else if (action === "up") {
      chatUp();
    } else if (action === "down") {
      chatDown();
    }
  }

  function dockFocused() {
    return S.dockShown && Boolean(dock.root?.contains(document.activeElement));
  }

  function sideFocused() {
    return S.sideOpen && Boolean(sidebar.pane?.contains(document.activeElement));
  }

  /** The chat a thread shortcut acts on: the full window, the focused (or only) floating chat, else the sidebar, opened if needed. */
  function shortcutChat() {
    if (S.fullOpen) return "full";
    if (S.dockShown && (dockFocused() || !S.sideOpen)) return "dock";
    if (!S.sideOpen) sidebar.setOpen(true);
    return "side";
  }

  /** Where Ctrl+Down goes back to from the full window. */
  let fullFrom = null;

  function enterFull(from) {
    fullFrom = from;
    const view = from === "dock" ? dock.view : sidebar.view;
    // From the floating chat, keep its thread or its empty draft — don't open the sidebar's thread.
    const threadId = view.threadId || (from !== "dock" && S.current && S.threads.has(S.current) ? S.current : null);
    const draft = threadId ? view.draft : { scope: view.draft?.scope || defaultScope(), settings: inheritSettings(view) };
    full.open(threadId, draft);
  }

  /** Close the full window into the chat it was opened from: the floating chat, else the sidebar. */
  function leaveFull() {
    const id = full.view.threadId;
    const from = fullFrom;
    fullFrom = null;
    full.close();
    if (from === "dock" && S.dockShown) {
      if (id && id !== dock.view.threadId) dock.pick(id);
      dock.view.focus();
      return;
    }
    if (!S.sideOpen) sidebar.setOpen(true);
    if (id) sidebar.view.setThread(id);
    setTimeout(() => sidebar.view.focus(), 60);
  }

  /** Ctrl+Up: a collapsed floating chat expands; an expanded one, or the sidebar, goes full window. */
  function chatUp() {
    if (S.fullOpen) return;
    if (dockFocused()) {
      if (!S.dockExpanded) dock.setExpanded(true);
      else enterFull("dock");
    } else if (sideFocused()) {
      enterFull("side");
    }
  }

  /** Ctrl+Down: the full window goes back where it came from; an expanded floating chat collapses; a collapsed one hides. */
  function chatDown() {
    if (S.fullOpen) leaveFull();
    else if (dockFocused() && S.dockExpanded) dock.setExpanded(false);
    else if (dockFocused()) dock.setShown(false);
  }

  /** Ctrl+J: open the thread picker of the chat in use; a second press closes it and gives the focus back to the input. */
  function openThreads() {
    // The floating chat's menu takes the focus out of the dock, so check for it before picking a chat.
    if (openMenuEl && openMenuAnchor === dock.titleBtn) {
      closeMenu();
      dock.view.focus();
      return;
    }
    const where = shortcutChat();
    if (where === "full") {
      const search = full.list.querySelector("input[type=search]");
      if (search && document.activeElement === search) full.view.focus();
      else search?.focus();
    } else if (where === "dock") {
      dock.threadMenu(dock.titleBtn);
    } else if (sidebar.listOpen) {
      sidebar.toggleList();
      sidebar.view.focus();
    } else {
      sidebar.toggleList();
      setTimeout(() => sidebar.listEl.querySelector("input[type=search]")?.focus(), 0);
    }
  }

  /** Provider, model, mode, approval, workspace — whatever the current chat is using. */
  function inheritSettings(view) {
    const s = view.settings();
    return {
      provider: s.provider,
      model: s.model,
      effort: s.effort ?? null,
      modelParams: { ...(s.modelParams || {}) },
      mode: s.mode,
      approval: s.approval,
      web: webMode(s.web),
      cwd: homeDir(s),
      useWorktree: Boolean(s.useWorktree),
    };
  }

  function newThread() {
    const where = shortcutChat();
    const view = where === "dock" ? dock.view : where === "full" ? full.view : sidebar.view;
    const scope = defaultScope();
    const settings = inheritSettings(view);
    if (where === "dock") {
      if (scope.kind === "page") S.dockPicks.delete(scope.ref);
      view.startDraft(scope, settings);
      dock.renderTitle();
    } else if (where === "full") {
      view.startDraft(scope, settings);
      full.renderList();
    } else {
      if (sidebar.listOpen) sidebar.toggleList();
      view.startDraft(scope, settings);
    }
    notice("New thread");
  }

  async function cycleMode() {
    const view = targetView();
    const s = view.settings();
    const modes = MODES;
    const at = modes.findIndex((m) => m.id === s.mode);
    const next = modes[(at + 1) % modes.length];
    await view.updateSettings({ mode: next.id });
    notice(`Mode: ${next.label}`);
  }

  function escape() {
    if (allowlists.close()) return true;
    if (agentSettings.close()) return true;
    if (openMenuEl) {
      const fromDock = openMenuAnchor === dock.titleBtn;
      closeMenu();
      if (fromDock) dock.view.focus();
      return true;
    }
    if (sidebar.listOpen && sideFocused()) {
      sidebar.toggleList();
      sidebar.view.focus();
      return true;
    }
    if (modalStack.length) {
      modalStack[modalStack.length - 1]();
      return true;
    }
    if (S.fullOpen) {
      full.close();
      return true;
    }
    if (S.dockShown && (dock.root?.contains(document.activeElement) || S.dockExpanded)) {
      if (S.dockExpanded) dock.setExpanded(false);
      else dock.setShown(false);
      return true;
    }
    return false;
  }

  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    // The apostrophe key by character, or by position on Nordic layouts (the '* key next to Enter).
    // With Shift the US key types ", the Nordic one *.
    const quote = event.key === "'" || event.key === '"' || (event.code === "Backslash" && event.key !== "\\" && event.key !== "|");
    if (quote) {
      if (event.shiftKey && event.altKey) return;
      event.preventDefault();
      shortcut(event.shiftKey ? "mode" : event.altKey ? "effort" : "model");
      return;
    }
    if (event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "k") {
      event.preventDefault();
      shortcut(event.shiftKey ? "new" : "dock");
    } else if (key === "l") {
      event.preventDefault();
      shortcut(event.shiftKey ? "full" : "side");
    } else if (key === "j" && !event.shiftKey) {
      event.preventDefault();
      shortcut("threads");
    } else if (event.key === "ArrowUp" && !event.shiftKey && (dockFocused() || sideFocused())) {
      event.preventDefault();
      shortcut("up");
    } else if (event.key === "ArrowDown" && !event.shiftKey && (S.fullOpen || dockFocused())) {
      event.preventDefault();
      shortcut("down");
    }
  });

  /* ---------- template agent actions (#152) ---------- */

  /** The page's template actions offered at `place` (menu, palette, slash). */
  function pageActions(tab, place, context = null) {
    return declaredActions(tab, place).filter((a) => hasContext(a, context));
  }

  function declaredActions(tab, place) {
    const actions = (tab && app()?.templateActions?.(tab)) || [];
    return actions.filter((a) => a && a.id && a.prompt && (a.where || []).includes(place));
  }

  /** An action with page-supplied placeholders (#161) is offered only where the page supplies them all. */
  function hasContext(action, context) {
    return (action.context || []).every((name) => context && String(context[name] ?? "").trim());
  }

  /** The values a page supplied for an action's declared context names; anything else is dropped. */
  function contextValues(action, context) {
    const out = {};
    for (const name of action.context || []) {
      const value = context?.[name];
      if (typeof value === "string" || typeof value === "number") out[name] = String(value).trim().slice(0, 2000);
    }
    return out;
  }

  /** Fill in an action's prompt or title; the same rules as renderAgentActionText in src/templates.ts. */
  function actionText(source, values) {
    const sections = /\{\{\s*#\s*([a-zA-Z_.]+)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\1\s*\}\}/g;
    let text = String(source || "");
    for (let pass = 0; pass < 4; pass += 1) {
      const next = text.replace(sections, (_m, name, inner) => ((values[name] ?? "").trim() ? inner : ""));
      if (next === text) break;
      text = next;
    }
    return text.replace(/\{\{\s*([#/]?)\s*([a-zA-Z_.]+)\s*\}\}/g, (_m, mark, name) => (mark ? "" : values[name] ?? "")).trim();
  }

  /** The chat an action from the page menu or palette goes to: the one the user has open, else the floating chat. */
  function actionView() {
    if (S.fullOpen) return full.view;
    if (S.sideOpen && !S.dockShown) return sidebar.view;
    if (!S.dockShown) dock.setShown(true);
    return dock.view;
  }

  function showInView(view, id) {
    if (view === full.view) {
      setCurrent(id);
      full.view.setThread(id);
      full.renderList();
    } else if (view === sidebar.view) {
      if (!S.sideOpen) sidebar.setOpen(true);
      sidebar.view.setThread(id);
    } else {
      if (id !== dock.view.threadId) dock.pick(id);
      if (!S.dockShown) dock.setShown(true);
    }
  }

  /**
   * Run a template action on `tab`: a new thread on the page with the action's settings, or with run: "chat",
   * a message in the chat at hand. `view` is the chat it was typed in (slash menu).
   */
  async function runAction(tab, action, { selection = "", input = "", context = null, view = null } = {}) {
    if (!tab || !action) return;
    const values = {
      ...contextValues(action, context),
      selection: String(selection || "").trim(),
      input: String(input || "").trim(),
      "page.title": tab.title || "",
      "page.key": tab.key || "",
    };
    const prompt = actionText(action.prompt, values).slice(0, PAGE_PROMPT_MAX);
    if (!prompt) return;
    // A selection the prompt does not quote still goes along, as a chip.
    const chips =
      values.selection && !/\{\{\s*selection\s*\}\}/.test(action.prompt)
        ? [{ kind: "selection", text: values.selection, source: `"${tab.title}" (key: ${tab.key})` }]
        : [];
    const target = view || actionView();
    if (action.run === "chat") {
      const draft = target.input.value;
      target.mentions.push(...chips);
      const shown = (target.contextOn && activeTab()?.id === tab.id) || target.pageInThread(tab);
      if (!shown && !target.mentions.some((c) => c.kind === "page" && c.id === tab.id)) {
        target.mentions.push({ kind: "page", id: tab.id, key: tab.key, title: tab.title });
      }
      target.input.value = prompt;
      await target.send();
      if (draft && !target.input.value) {
        target.input.value = draft;
        target.autosize();
      }
      return;
    }
    const settings = pageThreadSettings({ ...(action.thread || {}), mode: action.thread?.mode || "board" });
    if (settings.error) {
      notice(`${action.label}: ${settings.error.replace(/_/g, " ")}`);
      return;
    }
    const title = (action.thread?.title ? actionText(action.thread.title, values) : "") || action.label;
    try {
      const { thread } = await api("POST", "/threads", { ...settings, scope: { kind: "page", ref: tab.id }, title: title.slice(0, 120) });
      S.threads.set(thread.id, thread);
      S.details.set(thread.id, { items: [], byId: new Map(), turns: new Map() });
      showInView(target, thread.id);
      await api("POST", `/threads/${encodeURIComponent(thread.id)}/messages`, { text: prompt, context: chips });
    } catch (err) {
      notice(`${action.label}: ${err.message}`);
    }
  }

  /**
   * Ask about a page: attach a selection from it (or the page itself, with no text) to a chat and focus
   * its input. target "dock" or "side" picks that chat (Ctrl+K / Ctrl+L); otherwise the open one.
   */
  function ask(text, tab, target) {
    if (!tab) return;
    let view;
    if (S.fullOpen) {
      view = full.view;
    } else if (target === "side" || (!target && S.sideOpen && !S.dockShown)) {
      if (!S.sideOpen) sidebar.setOpen(true);
      view = sidebar.view;
    } else {
      if (!S.dockShown) dock.setShown(true);
      view = dock.view;
    }
    const chip = text
      ? { kind: "selection", text, source: `"${tab.title}" (key: ${tab.key})` }
      : { kind: "page", id: tab.id, key: tab.key, title: tab.title };
    const same = (c) => c.kind === chip.kind && (chip.kind === "page" ? c.id === chip.id : c.text === chip.text);
    const shownAlready = chip.kind === "page" && ((view.contextOn && activeTab()?.id === tab.id) || view.pageInThread(tab));
    if (!shownAlready && !view.mentions.some(same)) view.mentions.push(chip);
    view.renderContext();
    setTimeout(() => view.focus(), 70);
  }

  window.scribeChat = { shortcut, escape, pageStatus, pageRequest, ask, openThread, openAsk, pendingAsks, searchThreads, threadTitle, pageActions, runAction };

  /* ---------- boot ---------- */

  function boot() {
    sidebar.mount();
    full.mount();
    dock.mount();
    agentSettings.mount();
    allowlists.mount();
    applyButton();
    toasts.mount();
    const toggleBtn = document.getElementById("agent-toggle");
    toggleBtn?.addEventListener("click", () => shortcut("side"));
    if (toggleBtn) flyout.bind(toggleBtn, "button");
    const origSetThread = sidebar.view.setThread.bind(sidebar.view);
    sidebar.view.setThread = (id) => {
      origSetThread(id);
      if (id) setCurrent(id);
      sidebar.renderList();
    };
    Promise.all([loadConfig(), loadThreads(), loadBrowsers()]).then(() => {
      if (S.sideOpen) sidebar.ensureThread();
      dock.syncThread();
      renderAll();
      window.dispatchEvent(new Event("scribe:threads-ready"));
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
