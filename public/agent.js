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

  function emptyEnter() {
    return localStorage.getItem(LS.emptyEnter) === "send" ? "send" : "steer";
  }

  const MODES = [
    { id: "code", label: "Code", detail: "Read, edit files and run commands in the workspace" },
    { id: "ask", label: "Ask", detail: "Read-only: answer, read and search, no edits" },
    { id: "plan", label: "Plan", detail: "Investigate and propose a plan before changing anything" },
    { id: "board", label: "Pages", detail: "Scribe pages and web only, no shell (Cursor can still write files)" },
  ];
  const APPROVALS = [
    { id: "ask", label: "Ask first", detail: "Ask before edits and commands that are not allowlisted" },
    { id: "edits", label: "Auto-edit", detail: "Accept file edits, ask before commands" },
    { id: "auto", label: "Auto review", detail: "A classifier approves safe calls and asks for the rest (Claude)" },
    { id: "full", label: "Full access", detail: "Approve everything automatically" },
  ];
  const EXPLORE = new Set(["read", "search", "think"]);
  const SCOPE_KIND = { page: "Page", folder: "Folder", workspace: "Workspace", global: "Global" };
  const PROVIDER_LABEL = { claude: "Claude", cursor: "Cursor" };

  /* ---------- state ---------- */

  const S = {
    config: { providers: [], prefs: null, models: { claude: [], cursor: [] } },
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
    filter: ["here", "all", "archived"].includes(localStorage.getItem(LS.filter)) ? localStorage.getItem(LS.filter) : "here",
    search: "",
    lastActiveId: null,
    ready: false,
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
    app()?.showNotice?.(text);
  }

  function prefs() {
    return S.config.prefs || { provider: "cursor", models: {}, efforts: {}, modelParams: {}, mode: "code", approval: "ask", web: true, recentWorkspaces: [], scopeWorkspaces: {} };
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
    for (const provider of ["cursor", "claude"]) {
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
    const menu = el("div", "ag-menu");
    menu.style.width = `${width}px`;
    const list = el("div", "ag-menu-list");
    let filter = "";
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
        list.append(row);
      }
      if (!list.childElementCount) list.append(el("div", "ag-menu-empty", "Nothing matches"));
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
        if (event.key === "Enter") {
          const first = list.querySelector(".ag-menu-item:not(:disabled)");
          first?.click();
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

  function modal(cls) {
    const root = el("div", `ag-modal ${cls}`);
    const backdrop = el("div", "ag-modal-backdrop");
    const panel = el("div", "ag-modal-panel");
    root.append(backdrop, panel);
    const close = () => {
      root.remove();
      modalStack.splice(modalStack.indexOf(close), 1);
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
      const recent = el("div", "ag-ws-recent");
      for (const dir of prefs().recentWorkspaces.slice(0, 8)) {
        const chip = button(R.basename(dir), "ag-chip", () => finish(dir), dir);
        chip.prepend(icon("box"));
        recent.append(chip);
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
      if (recent.childElementCount) panel.append(recent);
      panel.append(browser, actions);
      load(input.value.trim());
      setTimeout(() => input.focus(), 0);
      // Esc from the modal stack resolves as cancel.
      modalStack[modalStack.length - 1] = () => finish(null);
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
    head.append(title, tabs, el("span", "ag-grow"), actions, button(icon("close"), "ag-icon-btn", () => close(), "Close (Esc)"));
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
    if (cwd) kinds.push({ id: "git", label: "Git working tree" });
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
          const info = await api("GET", `/git?cwd=${encodeURIComponent(cwd)}`);
          if (!info.repo) {
            side.replaceChildren(el("div", "ag-muted ag-pad", "Not a git repository"));
            return;
          }
          title.textContent = `Changes · ${info.branch || R.basename(info.repo)}`;
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
                  if (!confirm("Undo this turn's file changes in the working copy?")) return;
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
      this.images = [];
      this.drafts = new Map();
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
      return {
        id: null,
        provider,
        model: d.settings.model || p.models?.[provider] || "default",
        effort: d.settings.effort !== undefined ? d.settings.effort : p.efforts?.[provider] ?? null,
        modelParams: d.settings.modelParams || p.modelParams?.[provider] || {},
        mode: d.settings.mode || (d.scope.kind === "page" || d.scope.kind === "folder" ? "board" : p.mode || "code"),
        approval: d.settings.approval || p.approval || "ask",
        web: d.settings.web !== undefined ? d.settings.web : p.web !== false,
        cwd: d.settings.cwd !== undefined ? d.settings.cwd : d.scope.kind === "workspace" ? d.scope.ref : p.scopeWorkspaces?.[scopeKey] || p.recentWorkspaces?.[0] || null,
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
        }
        this.renderComposerBar();
        this.renderHeader();
        return;
      }
      if (patch.provider && patch.provider !== t.provider && t.stats.turns > 0) {
        // A thread keeps its provider; continue in a new thread in the same scope.
        this.startDraft(t.scope, { provider: patch.provider, model: patch.model, mode: t.mode, cwd: t.cwd, approval: t.approval, web: t.web });
        notice(`New ${PROVIDER_LABEL[patch.provider]} thread`);
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

    setThread(id) {
      if (this.threadId === id && id) return;
      this.saveDraftText();
      this.threadId = id;
      if (id) this.draft = null;
      this.expanded.clear();
      this.restoreDraftText();
      this.renderAll();
      if (id) {
        ensureDetail(id).then(() => {
          if (this.threadId === id) {
            this.stick = true;
            this.renderAll();
            const t = S.threads.get(id);
            if (t?.unread && this.visible()) api("POST", `/threads/${encodeURIComponent(id)}/read`).catch(() => undefined);
          }
        });
      }
    }

    startDraft(scope, settings = {}) {
      this.saveDraftText();
      this.threadId = null;
      this.draft = { scope, settings };
      this.restoreDraftText();
      this.renderAll();
      setTimeout(() => this.focus(), 0);
    }

    draftKey() {
      return this.threadId || `draft:${this.draft?.scope?.kind}:${this.draft?.scope?.ref}`;
    }

    saveDraftText() {
      if (this.input) this.drafts.set(this.draftKey(), this.input.value);
    }

    restoreDraftText() {
      if (!this.input) return;
      this.input.value = this.drafts.get(this.draftKey()) || "";
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
      const scope = button("", "ag-scope-chip", (event) => this.scopeMenu(event.currentTarget), "Where this thread belongs");
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
        acts.append(button(icon("git"), "ag-icon-btn", () => openDiff({ kind: "git", threadId: t?.id, cwd: s.cwd }), "Git working tree changes"));
      }
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
      if (s.cwd) items.push({ label: R.basename(s.cwd), detail: s.cwd, icon: "box", checked: s.scope.kind === "workspace" && s.scope.ref === s.cwd, run: () => this.setScope({ kind: "workspace", ref: s.cwd }) });
      items.push({ label: "Global", detail: "Not tied to a page or folder", icon: "globe", checked: s.scope.kind === "global", run: () => this.setScope({ kind: "global", ref: null }) });
      if (s.scope.kind === "page" && s.scope.ref !== tab?.id && s.scope.ref) {
        items.push({ separator: true }, { label: "Open its page", icon: "page", run: () => app()?.openLink(s.scope.ref) });
      }
      openMenu(anchor, items);
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

    threadMenu(anchor) {
      const t = this.thread();
      if (!t) return;
      openMenu(anchor, [
        { label: "Rename", run: () => { const ti = this.header.querySelector(".ag-title"); if (ti) this.rename(ti); } },
        { label: t.pinned ? "Unpin" : "Pin", run: () => api("PATCH", `/threads/${t.id}`, { pinned: !t.pinned }).catch((e) => notice(e.message)) },
        { label: t.archived ? "Unarchive" : "Archive", run: () => api("PATCH", `/threads/${t.id}`, { archived: !t.archived }).catch((e) => notice(e.message)) },
        { label: "Changes in this thread", icon: "diff", run: () => openDiff({ kind: "thread", threadId: t.id }) },
        ...(t.nativeId ? [{ label: "Copy session id", detail: t.nativeId, run: () => navigator.clipboard?.writeText(t.nativeId) }] : []),
        { separator: true },
        {
          label: "Delete thread",
          danger: true,
          run: async () => {
            if (!confirm(`Delete “${t.title}”? This removes its transcript from Scribe.`)) return;
            await api("DELETE", `/threads/${t.id}`).catch((e) => notice(e.message));
          },
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
      if (turn?.endedAt) push(el("span", null, R.duration(turn.endedAt - turn.startedAt)));
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
      if (item.context?.length || item.images?.length) {
        const chips = el("div", "ag-chips");
        for (const c of item.context || []) {
          const chip = el("span", "ag-chip small");
          chip.append(icon(c.kind === "page" ? "page" : c.kind === "folder" ? "folder" : "read"), el("span", null, c.title || c.path || (c.text ? `“${c.text.slice(0, 30)}…”` : c.kind)));
          chips.append(chip);
        }
        for (const img of item.images || []) {
          const chip = el("span", "ag-chip small");
          chip.append(icon("image"), el("span", null, img.name));
          chips.append(chip);
        }
        bubble.append(chips);
      }
      bubble.append(el("div", "ag-user-text", item.text));
      if (item.from === "page") bubble.prepend(el("div", "ag-from-page", "Sent by the page"));
      // Your turn is marked with an arrow instead of a bubble.
      row.append(icon("you", "ag-ico ag-you"));
      row.append(bubble);
      if (item.steer === "waiting") {
        row.classList.add("steering");
        row.append(el("div", "ag-queued", "Steering — the agent reads it at its next step · Enter again to send it now"));
      } else if (item.steer === "folded") {
        row.classList.add("steered");
        row.append(el("div", "ag-queued", "Steered in"));
      } else if (queued) {
        row.append(el("div", "ag-queued", `Queued — sends when the current turn ends · Enter on an empty box ${emptyEnter() === "send" ? "sends it now" : "steers it in"}`));
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
      const node = el("div", `ag-tool k-${it.tool} s-${it.status}${this.expanded.has(key) ? " open" : ""}`);
      node.dataset.itemId = it.id;
      const head = button("", "ag-tool-head", () => this.toggle(key, node));
      const status = it.status === "running" || it.status === "pending" ? el("span", "ag-spin") : it.status === "error" ? icon("cross", "ag-ico ag-st-err") : icon(it.tool, "ag-ico");
      head.append(status);
      const label = el("span", "ag-tool-label");
      if ((it.tool === "edit" || it.tool === "delete") && (it.files?.length || it.paths?.length)) {
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
      if (it.exitCode !== undefined && it.tool === "execute") head.append(el("span", `ag-exit${it.exitCode === 0 ? " ok" : " bad"}`, it.exitCode === 0 ? "exit 0" : `exit ${it.exitCode}`));
      if (it.endedAt && it.startedAt && it.endedAt - it.startedAt > 1500) head.append(el("span", "ag-muted ag-dur", R.duration(it.endedAt - it.startedAt)));
      head.append(icon("chevron", "ag-ico ag-chev"));
      node.append(head);
      const body = el("div", "ag-tool-body");
      if (it.detail && it.tool === "execute" && it.title && !it.title.startsWith("`") && it.title !== it.detail) body.append(el("div", "ag-tool-desc", it.title));
      else if (it.detail && it.tool !== "execute") body.append(el("pre", "ag-pre small", it.detail));
      if (it.diff) {
        const files = R.parsePatch(it.diff);
        for (const f of files) {
          const fh = el("div", "ag-inline-diff-head");
          fh.append(el("span", "ag-fpath", f.path), R.counts(f.added, f.removed), button("Open", "ag-btn tiny", () => openDiff({ kind: "turn", threadId: it.threadId, turnId: it.turnId, path: f.path })));
          body.append(fh, R.renderDiffFile(f, { collapsedAfter: 160 }));
        }
      } else if (it.input && (it.tool === "mcp" || it.tool === "other" || it.tool === "fetch" || it.tool === "task")) {
        body.append(el("pre", "ag-pre small", jsonText(it.input)));
      }
      if (it.output && !(it.tool === "read")) {
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
        head.querySelector(".ag-tool-label")?.append(el("span", "ag-muted", ` · ${children.filter((c) => c.kind === "tool").length} steps`));
      }
      if (body.childElementCount) node.append(body);
      else node.classList.add("bare");
      return node;
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
      const node = el("div", `ag-card ag-question s-${it.status}`);
      node.dataset.itemId = it.id;
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
        const answered = it.answers?.[q.id] || [];
        for (const o of q.options) {
          const b = button("", `ag-q-opt${answered.includes(o.id) ? " on" : ""}`, () => {
            if (it.status !== "pending") return;
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
          b.disabled = it.status !== "pending";
          opts.append(b);
        }
        block.append(opts);
        if (it.status === "pending") {
          const other = el("input", "ag-input small");
          other.placeholder = "Other / add detail";
          other.addEventListener("input", () => notes.set(q.id, other.value));
          block.append(other);
        } else if (it.notes?.[q.id]) {
          block.append(el("div", "ag-muted", it.notes[q.id]));
        }
        node.append(block);
      }
      if (it.status === "pending") {
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
      } else {
        node.classList.add("done");
        node.append(el("div", "ag-muted small", it.status === "answered" ? "Answered" : it.status === "skipped" ? "Skipped" : "Not answered"));
      }
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
      if (turn.endedAt) parts.append(el("span", null, R.duration(turn.endedAt - turn.startedAt)));
      const usage = turn.usage || {};
      if (usage.costUsd) parts.append(el("span", null, `$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}`));
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
            if (!confirm(`Put “${turn.page.title}” back to how it was before this turn?`)) return;
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
      if (!prev || prev.status !== thread.status || prev.mode !== thread.mode || prev.model !== thread.model || prev.effort !== thread.effort || prev.cwd !== thread.cwd || prev.approval !== thread.approval || prev.queued !== thread.queued) {
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
    }

    onTurn(turn) {
      this.dirtyTurns.add(turn.id);
      this.schedule();
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
      this.input.placeholder = this.variant === "dock" ? "Ask or make a change… (Enter to send)" : "Message the agent… (Enter to send, Shift+Enter for a new line)";
      this.input.addEventListener("input", () => {
        this.autosize();
        this.updateSlash();
        this.warm();
      });
      this.input.addEventListener("keydown", (event) => this.onKey(event));
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
      box.append(this.slash, this.ctxRow);
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
      box.addEventListener("dragover", (event) => {
        if ([...(event.dataTransfer?.items || [])].some((i) => i.type.startsWith("image/"))) event.preventDefault();
      });
      box.addEventListener("drop", (event) => {
        const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
        if (files.length) {
          event.preventDefault();
          files.forEach((f) => this.addImage(f));
        }
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
      const key = JSON.stringify([this.draftKey(), s.provider, s.model, s.effort, s.modelParams, s.mode, s.web, s.cwd, s.scope]);
      const now = Date.now();
      if (this.lastWarm && this.lastWarm.key === key && now - this.lastWarm.at < 60_000) return;
      this.lastWarm = { key, at: now };
      if (t) {
        api("POST", `/threads/${encodeURIComponent(t.id)}/warm`).catch(() => undefined);
      } else {
        api("POST", "/warm", { provider: s.provider, model: s.model, effort: s.effort, modelParams: s.modelParams, mode: s.mode, approval: s.approval, web: s.web, cwd: s.cwd, scope: s.scope }).catch(() => undefined);
      }
    }

    autosize() {
      this.input.style.height = "auto";
      const max = this.variant === "full" ? 320 : 220;
      this.input.style.height = `${Math.min(max, this.input.scrollHeight)}px`;
    }

    renderContext() {
      const row = this.ctxRow;
      if (!row) return;
      row.replaceChildren();
      const s = this.settings();
      const tab = activeTab();
      const pageScoped = s.scope?.kind === "page" && s.scope.ref === tab?.id;
      if (tab && !pageScoped) {
        const chip = button("", `ag-chip small toggle${this.contextOn ? " on" : ""}`, () => {
          this.contextOn = !this.contextOn;
          this.renderContext();
        }, this.contextOn ? "The current page is attached to your message" : "Attach the current page");
        chip.append(icon("page"), el("span", null, this.contextOn ? tab.title : `+ ${tab.title}`));
        row.append(chip);
      }
      this.images.forEach((img, index) => {
        const chip = el("span", "ag-chip small img");
        const thumb = el("img");
        thumb.src = `data:${img.mimeType};base64,${img.data}`;
        chip.append(thumb, el("span", null, img.name), button(icon("close"), "ag-chip-x", () => {
          this.images.splice(index, 1);
          this.renderContext();
        }, "Remove"));
        row.append(chip);
      });
      row.hidden = !row.childElementCount;
    }

    onPaste(event) {
      const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        event.preventDefault();
        files.forEach((f) => this.addImage(f));
      }
    }

    addImage(file) {
      if (this.images.length >= 6) return notice("Up to 6 images per message");
      if (file.size > 8 * 1024 * 1024) return notice("Images must be under 8 MB");
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(",")[1] || "";
        this.images.push({ name: file.name || "pasted.png", mimeType: file.type || "image/png", data });
        this.renderContext();
      };
      reader.readAsDataURL(file);
    }

    renderComposerBar() {
      const s = this.settings();
      const t = this.thread();
      const bar = this.bar;
      bar.replaceChildren();
      const info = modelInfo(s.provider, s.model);
      const model = button("", "ag-pill", (event) => this.modelMenu(event.currentTarget), "Model");
      model.append(el("span", `ag-prov p-${s.provider}`, s.provider === "claude" ? "C" : "⌘"), el("span", null, info?.label || s.model));
      bar.append(model);
      const hasEffort = info?.efforts?.length || info?.params?.length;
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
        const apBtn = button("", `ag-pill ap-${ap.id}`, (event) => this.approvalMenu(event.currentTarget), ap.detail);
        apBtn.append(icon("shield"), el("span", null, ap.label));
        bar.append(apBtn);
      }
      const web = button("", `ag-pill toggle${s.web ? " on" : ""}`, () => this.updateSettings({ web: !s.web }), s.web ? "Web search is on" : "Web search is off");
      web.append(icon("fetch"), el("span", null, "Web"));
      if (this.variant !== "dock") bar.append(web);
      if (s.mode !== "board") {
        const ws = button("", `ag-pill ws${s.cwd ? "" : " warn"}`, () => this.chooseWorkspace(), s.cwd || "Choose a workspace folder");
        ws.append(icon("box"), el("span", null, s.cwd ? R.basename(s.cwd) : "Workspace…"));
        bar.append(ws);
      }
      const meter = usageChip(s.provider);
      if (meter) bar.append(meter);
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
      const running = t && t.status !== "idle";
      if (running) {
        tail.append(button(icon("stop"), "ag-send stop", () => this.stop(), "Stop (Esc twice)"));
      }
      tail.append(button(icon("send"), "ag-send", () => this.send(), running ? "Queue message" : "Send (Enter)"));
    }

    async chooseWorkspace() {
      const s = this.settings();
      const dir = await pickWorkspace(s.cwd);
      if (dir) await this.updateSettings({ cwd: dir });
      this.focus();
    }

    /** Starred models only, plus the current one; "Show all models" opens the full, searchable list. */
    modelMenu(anchor, { all = false } = {}) {
      const s = this.settings();
      const favs = new Set(favoriteModels());
      const showAll = all || !favs.size;
      const items = [];
      for (const provider of ["cursor", "claude"]) {
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
          detail: a.id === "auto" && s.provider !== "claude" ? "Claude only; Cursor asks as usual" : a.detail,
          checked: s.approval === a.id,
          danger: a.id === "full",
          run: () => this.updateSettings({ approval: a.id }),
        })),
        { width: 300 }
      );
    }

    onKey(event) {
      if (!this.slash.hidden) {
        const items = [...this.slash.querySelectorAll(".ag-slash-item")];
        const at = items.findIndex((i) => i.classList.contains("on"));
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
          items.forEach((i, n) => i.classList.toggle("on", n === next));
          items[next]?.scrollIntoView({ block: "nearest" });
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && items.length) {
          event.preventDefault();
          (items[at >= 0 ? at : 0]).click();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.slash.hidden = true;
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.input.value.trim() && !this.images.length && this.pushQueued()) return;
        this.send();
        return;
      }
      if (event.key === "ArrowUp" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !this.input.value && !this.images.length && this.withdrawQueued()) {
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

    async updateSlash() {
      const value = this.input.value;
      const m = /^\/([\w:.-]*)$/.exec(value);
      if (!m) {
        this.slash.hidden = true;
        return;
      }
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
      const q = m[1].toLowerCase();
      const hits = (list || []).filter((c) => c.name.toLowerCase().includes(q)).slice(0, 40);
      this.slash.replaceChildren();
      if (!hits.length) {
        this.slash.hidden = true;
        return;
      }
      hits.forEach((c, i) => {
        const row = button("", `ag-slash-item${i === 0 ? " on" : ""}`, () => {
          this.input.value = `/${c.name} `;
          this.slash.hidden = true;
          this.autosize();
          this.focus();
        });
        row.append(el("span", "ag-slash-name", `/${c.name}`), el("span", "ag-slash-desc", c.description || c.hint || ""));
        this.slash.append(row);
      });
      this.slash.hidden = false;
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
          this.images = (msg.images || []).slice();
          const tab = activeTab();
          if (tab && (msg.context || []).some((c) => c.kind === "page" && c.id === tab.id)) this.contextOn = true;
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
      if (!text && !this.images.length) return;
      const s = this.settings();
      if (s.mode !== "board" && s.mode !== "ask" && !s.cwd) {
        const dir = await pickWorkspace(null);
        if (!dir) return;
        await this.updateSettings({ cwd: dir });
      }
      const tab = activeTab();
      const context = [];
      if (this.contextOn && tab && !(s.scope?.kind === "page" && s.scope.ref === tab.id)) {
        context.push({ kind: "page", id: tab.id, key: tab.key, title: tab.title });
      }
      const images = this.images.slice();
      this.input.value = "";
      this.images = [];
      this.autosize();
      this.renderContext();
      this.slash.hidden = true;
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
        await api("POST", `/threads/${encodeURIComponent(id)}/messages`, { text, images, context });
      } catch (err) {
        notice(err.message);
        if (!this.input.value) {
          this.input.value = text;
          this.autosize();
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
    for (const dir of prefs().recentWorkspaces.slice(0, 5)) {
      items.push({ label: R.basename(dir), detail: dir, icon: "box", run: () => view.startDraft({ kind: "workspace", ref: dir }, { cwd: dir }) });
    }
    items.push({
      label: "Other workspace…",
      icon: "folder",
      run: async () => {
        const dir = await pickWorkspace(null);
        if (dir) view.startDraft({ kind: "workspace", ref: dir }, { cwd: dir });
      },
    });
    items.push({ label: "Global", detail: "Not tied to a page or folder", icon: "globe", run: () => view.startDraft({ kind: "global", ref: null }) });
    openMenu(anchor, items, { width: 280 });
  }

  function groupKey(thread) {
    const s = thread.scope;
    if (s.kind === "global") return "global";
    return `${s.kind}:${s.ref}`;
  }

  function groupTitle(thread) {
    const s = thread.scope;
    const label = scopeLabel(s);
    const kind = s.kind === "page" ? "Page" : s.kind === "folder" ? "Folder" : s.kind === "workspace" ? "Workspace" : "Global";
    return { icon: label.icon, text: s.kind === "global" ? "Global" : label.text, kind };
  }

  function renderThreadList(container, { onPick, currentId, onNew }) {
    container.replaceChildren();
    const top = el("div", "ag-list-top");
    const search = el("input", "ag-input small");
    search.type = "search";
    search.placeholder = "Search threads";
    search.value = S.search;
    search.addEventListener("input", () => {
      S.search = search.value;
      fill();
    });
    const seg = el("div", "ag-seg small");
    for (const [id, label] of [
      ["here", "Here"],
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
    top.append(search, seg, newBtn);
    const list = el("div", "ag-list");
    container.append(top, list);
    const fill = () => {
      list.replaceChildren();
      const q = S.search.trim().toLowerCase();
      let threads = [...S.threads.values()].filter((t) => (S.filter === "archived" ? t.archived : !t.archived));
      if (S.filter === "here") threads = threads.filter(hereMatch);
      if (q) threads = threads.filter((t) => `${t.title} ${groupTitle(t).text}`.toLowerCase().includes(q));
      threads.sort((a, b) => threadRank(b) - threadRank(a));
      if (!threads.length) {
        list.append(el("div", "ag-list-empty", S.filter === "here" ? "No threads for this page yet. Threads for its folder and global threads show here too." : "No threads"));
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
      for (const key of order) {
        const first = groups.get(key)[0];
        const gt = groupTitle(first);
        const head = el("div", "ag-list-group");
        head.append(icon(gt.icon), el("span", "ag-list-group-kind", gt.kind), el("span", "ag-list-group-name", first.scope.kind === "global" ? "" : gt.text));
        list.append(head);
        for (const t of groups.get(key)) list.append(threadRow(t, t.id === currentId, onPick));
      }
    };
    fill();
  }

  function threadRow(t, current, onPick) {
    const row = button("", `ag-row${current ? " on" : ""}${t.unread ? " unread" : ""}`, () => onPick(t.id));
    const dot = el("span", `ag-dot s-${t.status}`);
    const main = el("span", "ag-row-main");
    const title = el("span", "ag-row-title", t.title);
    const meta = el("span", "ag-row-meta");
    meta.append(el("span", `ag-prov p-${t.provider}`, t.provider === "claude" ? "C" : "⌘"), el("span", null, modelLabel(t.provider, t.model)), el("span", null, "·"), el("span", null, R.timeAgo(t.activityAt)));
    if (t.stats.files) meta.append(el("span", null, "·"), R.counts(t.stats.added, t.stats.removed));
    main.append(title, meta);
    row.append(dot, main);
    if (t.pinned) row.append(el("span", "ag-pin", "•"));
    row.title = t.title;
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(row, [
        { label: t.pinned ? "Unpin" : "Pin", run: () => api("PATCH", `/threads/${t.id}`, { pinned: !t.pinned }).catch((e) => notice(e.message)) },
        { label: t.archived ? "Unarchive" : "Archive", run: () => api("PATCH", `/threads/${t.id}`, { archived: !t.archived }).catch((e) => notice(e.message)) },
        ...(t.stats.files ? [{ label: "Changes in this thread", icon: "diff", run: () => openDiff({ kind: "thread", threadId: t.id }) }] : []),
        { separator: true },
        {
          label: "Delete thread",
          danger: true,
          run: async () => {
            if (!confirm(`Delete “${t.title}”? This removes its transcript from Scribe.`)) return;
            await api("DELETE", `/threads/${t.id}`).catch((e) => notice(e.message));
          },
        },
      ], { width: 220 });
    });
    return row;
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
        },
        onNew: (anchor) => {
          newThreadMenu(anchor, {
            startDraft: (scope, settings) => {
              this.view.startDraft(scope, settings);
              if (this.listOpen) this.toggleList();
            },
          });
        },
      });
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
      const id = threadId || (S.current && S.threads.has(S.current) ? S.current : null);
      if (id) this.view.setThread(id);
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
        },
        onNew: (anchor) => newThreadMenu(anchor, this.view),
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
      // Input: composer and send. The island style also shows the model orb and the conversation toggle here.
      const toggle = () => button(icon("list"), "ag-icon-btn small dock-toggle", () => this.setExpanded(!S.dockExpanded), "Show conversation (Ctrl+↑)");
      this.orb = button("", "dock-orb", (event) => view.modelMenu(event.currentTarget), "Model");
      const input = el("div", "dock-input");
      input.append(this.orb, view.composer, toggle(), view.sendSlot);
      // Bar: status, thread and scope on the left; settings and window tools on the right.
      this.status = el("span", "dock-status");
      this.titleBtn = button("", "dock-title", (event) => this.threadMenu(event.currentTarget), "Switch thread");
      this.scopeBtn = button("", "dock-scope", (event) => view.scopeMenu(event.currentTarget), "Where this thread belongs");
      const left = el("div", "dock-bar-left");
      left.append(this.status, this.titleBtn, this.scopeBtn);
      const right = el("div", "dock-bar-right");
      right.append(
        view.bar,
        el("span", "ag-grow"),
        toggle(),
        button(icon("expand"), "ag-icon-btn small", () => {
          const id = this.view.threadId;
          if (id) setCurrent(id);
          sidebar.setOpen(true);
          if (id) sidebar.view.setThread(id);
        }, "Open in the sidebar"),
        button(icon("close"), "ag-icon-btn small dock-close", () => this.setShown(false), "Hide (Esc)")
      );
      const bar = el("div", "dock-bar");
      bar.append(left, right);
      panel.append(out, input, bar);
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
      this.root.classList.toggle("shown", S.dockShown);
      this.root.classList.toggle("expanded", S.dockShown && S.dockExpanded);
      this.renderHandle();
      // The input sizes itself to its text; measure again once the layout for this style is in place.
      requestAnimationFrame(() => this.view.autosize());
    },
    setShown(shown) {
      S.dockShown = shown;
      localStorage.setItem(LS.dock, shown ? "1" : "0");
      if (shown) this.syncThread();
      this.apply();
      if (shown) setTimeout(() => this.view.focus(), 60);
      else this.view.input.blur();
    },
    setExpanded(expanded) {
      S.dockExpanded = expanded;
      this.apply();
      if (expanded) {
        this.feed.replaceChildren();
        this.feedLines.clear();
        this.view.renderTranscript();
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
        if (this.view.threadId !== id) {
          this.view.setThread(id);
          this.feed.replaceChildren();
          this.feedLines.clear();
        }
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
      this.orb.textContent = s.provider === "claude" ? "C" : "⌘";
      this.orb.title = `Model: ${modelLabel(s.provider, s.model)}`;
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
      else this.setHandleText(status === "waiting" ? "Needs your answer" : t?.unread ? "Reply ready" : "Ask the agent", status);
    },
    /** The hidden handle shows one line at a time; a new step slides the previous one up and out. */
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
      const animate = cur && !S.dockShown && this.handle.classList.contains("busy") && Date.now() - (this.handleAt || 0) > 600;
      this.handleAt = Date.now();
      if (!animate) {
        for (const old of [...box.children]) if (old !== next) old.remove();
        return;
      }
      const ease = { duration: 340, easing: "cubic-bezier(.2,.8,.2,1)" };
      next.animate([{ transform: "translateY(100%)", opacity: 0 }, { transform: "none", opacity: 1 }], ease);
      cur.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }], { ...ease, fill: "forwards" });
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
      for (const t of pageThreads) items.push({ label: t.title, detail: R.timeAgo(t.activityAt), checked: t.id === this.view.threadId, run: () => this.pick(t.id) });
      if (others.length) items.push({ header: "Recent" });
      for (const t of others) items.push({ label: t.title, detail: `${scopeLabel(t.scope).text} · ${R.timeAgo(t.activityAt)}`, checked: t.id === this.view.threadId, run: () => this.pick(t.id) });
      openMenu(anchor, items, { search: true, width: 320, placeholder: "Search threads" });
    },
    pick(id) {
      this.remember(id);
      this.view.setThread(id);
      this.feed.replaceChildren();
      this.feedLines.clear();
      this.renderTitle();
    },
    /* Transient progress lines while the conversation is collapsed; the newest also shows in the hidden handle. */
    line(key, _icon, text, { sticky = false, cls = "" } = {}) {
      if (!this.root) return;
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
        while (this.feed.childElementCount > 5) {
          const first = this.feed.firstElementChild;
          for (const [k, v] of this.feedLines) if (v === first) this.feedLines.delete(k);
          first.remove();
        }
        // Older lines glide up to make room instead of jumping.
        const lift = line.offsetHeight + 2;
        for (const node of before) if (node.isConnected) node.animate([{ transform: `translateY(${lift}px)` }, { transform: "none" }], { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
      this.feed.classList.toggle("deep", this.feed.childElementCount > 2);
      line.querySelector(".dock-line-text").textContent = text;
      clearTimeout(line._fade);
      line.classList.remove("fading");
      line._fade = setTimeout(() => {
        line.classList.add("fading");
        line._fade = setTimeout(() => {
          line.remove();
          for (const [k, v] of this.feedLines) if (v === line) this.feedLines.delete(k);
          this.feed.classList.toggle("deep", this.feed.childElementCount > 2);
        }, 900);
      }, sticky ? 14000 : 5000);
    },
    onItem(item) {
      if (item.threadId !== this.view.threadId) return;
      if ((item.kind === "approval" || item.kind === "question" || item.kind === "plan") && item.status === "pending") {
        if (!S.dockShown) this.setShown(true);
        this.setExpanded(true);
        return;
      }
      if (item.kind === "tool") {
        const label = item.tool === "edit" && item.files?.length ? `Edited ${item.files.map((f) => `${R.basename(f.path)} +${f.added} −${f.removed}`).join(", ")}` : item.detail && item.tool === "execute" ? `$ ${item.detail}` : item.title;
        this.line(item.id, item.tool, label, { cls: `k-${item.tool}` });
      } else if (item.kind === "notice") {
        this.line(item.id, "other", item.text, { sticky: item.level === "error", cls: item.level });
      }
      this.renderHandle();
    },
    onDelta(item) {
      if (item.threadId !== this.view.threadId) return;
      if (item.kind === "reasoning") this.line(item.id, "think", lastLine(item.text) || "Thinking…", { cls: "reason" });
      else if (item.kind === "text") this.line(item.id, "sparkle", lastLine(item.text), { cls: "text" });
    },
    onTurn(turn) {
      if (turn.threadId !== this.view.threadId) return;
      if (turn.status !== "running") this.live = null;
      this.renderHandle();
      if (turn.status === "running") return;
      const detail = S.details.get(turn.threadId);
      const lastText = detail ? [...detail.items].reverse().find((it) => it.turnId === turn.id && it.kind === "text") : null;
      const files = turn.files || [];
      if (files.length) {
        const added = files.reduce((a, f) => a + f.added, 0);
        const removed = files.reduce((a, f) => a + f.removed, 0);
        this.line(`${turn.id}:files`, "diff", `${files.length} file${files.length === 1 ? "" : "s"} changed  +${added} −${removed}`, { sticky: true, cls: "files" });
      }
      if (lastText) {
        this.feedLines.get(lastText.id)?.remove();
        this.feedLines.delete(lastText.id);
        this.line(`${turn.id}:done`, "check", plain(lastText.text).slice(0, 220), { sticky: true, cls: "text done" });
      }
      else if (turn.status === "error") this.line(`${turn.id}:err`, "cross", turn.error || "The turn failed", { sticky: true, cls: "error" });
    },
  };

  // The dock's view renders its transcript into the history panel and its composer at the bottom.
  dock.view.renderHeader = () => dock.renderTitle();

  /* ---------- chrome badge ---------- */

  function renderBadge() {
    const btn = document.getElementById("agent-toggle");
    if (!btn) return;
    const threads = [...S.threads.values()];
    const waiting = threads.some((t) => t.status === "waiting");
    const running = threads.filter((t) => t.status === "running").length;
    const unread = threads.filter((t) => t.unread && !t.archived).length;
    btn.classList.toggle("busy", running > 0);
    btn.classList.toggle("waiting", waiting);
    const badge = document.getElementById("agent-badge");
    if (badge) {
      badge.hidden = !(waiting || unread);
      badge.textContent = waiting ? "!" : unread ? String(unread) : "";
      badge.classList.toggle("warn", waiting);
    }
    dock.renderHandle();
    for (const tabEl of document.querySelectorAll(".tab[data-id]")) {
      const status = pageStatus(tabEl.dataset.id);
      tabEl.classList.toggle("agent-running", status === "running");
      tabEl.classList.toggle("agent-waiting", status === "waiting");
    }
  }

  /** "waiting" or "running" when a thread for this page is at work, for the tab strip. */
  function pageStatus(tabId) {
    let status = null;
    for (const t of S.threads.values()) {
      if (t.scope.kind !== "page" || t.scope.ref !== tabId || t.status === "idle") continue;
      if (t.status === "waiting") return "waiting";
      status = "running";
    }
    return status;
  }

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

  /** "in 2 h 10 min" / "Sat 10:00" for a window's reset time. */
  function resetText(at) {
    if (!at) return "";
    const ms = at - Date.now();
    if (ms <= 0) return "resets now";
    if (ms < 24 * 3600 * 1000) {
      const h = Math.floor(ms / 3600000);
      const m = Math.round((ms % 3600000) / 60000);
      return `resets in ${h ? `${h} h ` : ""}${m} min`;
    }
    return `resets ${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
  }

  function planLimits(provider) {
    const limits = S.config.limits?.[provider];
    return limits && limits.windows?.length ? limits : null;
  }

  /** Compact "5-hour 84% · Weekly 76%" for the chat's settings bar; nothing until the provider has reported. */
  function usageChip(provider) {
    const limits = planLimits(provider);
    if (!limits) return null;
    const top = Math.max(...limits.windows.map((w) => w.utilization));
    const chip = button("", `ag-usage lvl-${usageLevel(top)}`, () => agentSettings.open(), "");
    chip.title = `${PROVIDER_LABEL[provider] || provider} plan usage\n${limits.windows.map((w) => `${w.label}: ${percent(w.utilization)} · ${resetText(w.resetsAt)}`).join("\n")}${limits.overage ? "\nUsing extra usage" : ""}`;
    for (const w of limits.windows) chip.append(el("span", `ag-usage-w lvl-${usageLevel(w.utilization)}`, `${w.label === "5-hour" ? "5h" : w.label === "Weekly" ? "wk" : w.label} ${percent(w.utilization)}`));
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
          provider === "claude" ? "Shows after the next Claude turn: Claude Code reports the plan's usage as it runs." : "Cursor does not report plan usage to Scribe (its ACP server has no usage call)."
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
    ["Ctrl+↑ / Ctrl+↓", "From a chat into the full window and back; expand or collapse the floating chat"],
    ["Ctrl+J", "Threads"],
    ["Ctrl+Shift+K", "New thread"],
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
      const title = el("h2", "settings-title", "Command allowlists");
      title.id = "ag-perm-title";
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
      this.body = el("div", "ag-perm-body");
      panel.append(title, intro, pick, this.body);
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
      this.root.hidden = false;
      void this.load();
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
          for (const provider of ["cursor", "claude"]) {
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
        settingRow(
          "Enter on an empty box sends a queued message",
          choiceTrack(EMPTY_ENTER, emptyEnter, (id) => {
            localStorage.setItem(LS.emptyEnter, id);
            for (const view of views()) view.renderTranscript();
          }),
          {
            id: "ag-empty-enter-label",
            title: "While the agent works. Steer hands it to the running turn, which reads it at its next step; pressing Enter again stops the turn and sends it. Send now always stops the turn and sends it.",
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
        "Cursor runs through its CLI (agent acp); Claude through the Claude Agent SDK with your Claude Code login."
      );
      panel.append(title, providers, usage, chat, keys, about);
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
        row.append(label, el("span", p.available ? "ag-tag ok" : "ag-tag", p.available ? "Ready" : "Unavailable"));
        this.status.append(row);
      }
    },
    isOpen() {
      return Boolean(this.root && !this.root.hidden);
    },
    renderUsage() {
      if (!this.usage || !this.isOpen()) return;
      this.usage.replaceChildren(...["claude", "cursor"].filter((p) => S.config.providers.some((x) => x.id === p)).map(usageMeters));
    },
    open() {
      if (!this.root) return;
      this.renderStatus();
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
  /** board.agent.wait calls by thread id. */
  const pageWaiters = new Map();
  /** When a page last sent to each thread: until the thread has been active since, it is not done with it. */
  const pageSentAt = new Map();

  function ownedBy(tab, t) {
    return Boolean(t && t.scope.kind === "page" && t.scope.ref === tab.id);
  }

  function pageBrief(t) {
    return { id: t.id, title: t.title, status: t.status, queued: t.queued || 0, activityAt: t.activityAt };
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

  function showPageThread(id, where) {
    if (where === "sidebar") {
      if (!S.sideOpen) sidebar.setOpen(true);
      sidebar.view.setThread(id);
    } else if (where === "dock") {
      if (id !== dock.view.threadId) dock.pick(id);
      if (!S.dockShown) dock.setShown(true);
    }
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
   * One board.agent call from `tab` (app.js found it from the asking frame and checked the gesture).
   * Pages only see and drive threads that belong to them, and only start Board or Ask threads: no
   * file or shell access unless you gave the thread that yourself.
   */
  async function pageRequest(tab, data) {
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
      case "start": {
        if (!prompt) return { ok: false, error: "empty_prompt" };
        if (prompt.length > PAGE_PROMPT_MAX) return { ok: false, error: "prompt_too_long" };
        const p = prefs();
        const provider = providerAvailable(p.provider) ? p.provider : S.config.providers.find((x) => x.available)?.id;
        if (!provider) return { ok: false, error: "no_provider" };
        const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 120) : undefined;
        const { thread: created } = await api("POST", "/threads", {
          provider,
          model: p.models?.[provider] || "default",
          effort: p.efforts?.[provider] ?? null,
          modelParams: p.modelParams?.[provider] || {},
          mode: data.mode === "ask" ? "ask" : "board",
          approval: p.approval || "ask",
          web: p.web !== false,
          cwd: null,
          scope: { kind: "page", ref: tab.id },
          ...(title ? { title } : {}),
        });
        S.threads.set(created.id, created);
        S.details.set(created.id, { items: [], byId: new Map(), turns: new Map() });
        pageSentAt.set(created.id, Date.now());
        const sent = await api("POST", `/threads/${encodeURIComponent(created.id)}/messages`, { text: prompt, from: "page" });
        showPageThread(created.id, data.show);
        return { ok: true, threadId: created.id, queued: Boolean(sent.queued) };
      }
      case "send": {
        if (!ownedBy(tab, thread)) return { ok: false, error: "not_found" };
        if (!prompt) return { ok: false, error: "empty_prompt" };
        if (prompt.length > PAGE_PROMPT_MAX) return { ok: false, error: "prompt_too_long" };
        await ensureDetail(thread.id);
        pageSentAt.set(thread.id, Date.now());
        const sent = await api("POST", `/threads/${encodeURIComponent(thread.id)}/messages`, { text: prompt, from: "page" });
        showPageThread(thread.id, data.show);
        return { ok: true, queued: Boolean(sent.queued) };
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
    full.open(view.threadId, view.draft);
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

  /** Ctrl+Down: the full window goes back where it came from; an expanded floating chat collapses. */
  function chatDown() {
    if (S.fullOpen) leaveFull();
    else if (dockFocused() && S.dockExpanded) dock.setExpanded(false);
  }

  function openThreads() {
    const where = shortcutChat();
    if (where === "full") {
      full.list.querySelector("input[type=search]")?.focus();
    } else if (where === "dock") {
      // A second press closes the menu again (it toggles); give the focus back to the input.
      const wasOpen = Boolean(openMenuEl);
      dock.threadMenu(dock.titleBtn);
      if (wasOpen && !openMenuEl) dock.view.focus();
    } else {
      if (!sidebar.listOpen) sidebar.toggleList();
      setTimeout(() => sidebar.listEl.querySelector("input[type=search]")?.focus(), 0);
    }
  }

  function newThread() {
    const where = shortcutChat();
    const scope = defaultScope();
    if (where === "dock") {
      if (scope.kind === "page") S.dockPicks.delete(scope.ref);
      dock.view.startDraft(scope);
      dock.renderTitle();
    } else if (where === "full") {
      full.view.startDraft(scope);
      full.renderList();
    } else {
      if (sidebar.listOpen) sidebar.toggleList();
      sidebar.view.startDraft(scope);
    }
    notice("New thread");
  }

  async function cycleMode() {
    const view = targetView();
    const s = view.settings();
    const at = MODES.findIndex((m) => m.id === s.mode);
    const next = MODES[(at + 1) % MODES.length];
    await view.updateSettings({ mode: next.id });
    notice(`Mode: ${next.label}`);
  }

  function escape() {
    if (allowlists.close()) return true;
    if (agentSettings.close()) return true;
    if (openMenuEl) {
      closeMenu();
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
    } else if (event.key === "ArrowDown" && !event.shiftKey && (S.fullOpen || (dockFocused() && S.dockExpanded))) {
      event.preventDefault();
      shortcut("down");
    }
  });

  window.scribeChat = { shortcut, escape, pageStatus, pageRequest };

  /* ---------- boot ---------- */

  function boot() {
    sidebar.mount();
    full.mount();
    dock.mount();
    agentSettings.mount();
    allowlists.mount();
    applyButton();
    document.getElementById("agent-toggle")?.addEventListener("click", () => shortcut("side"));
    const origSetThread = sidebar.view.setThread.bind(sidebar.view);
    sidebar.view.setThread = (id) => {
      origSetThread(id);
      if (id) setCurrent(id);
      sidebar.renderList();
    };
    Promise.all([loadConfig(), loadThreads()]).then(() => {
      if (S.sideOpen) sidebar.ensureThread();
      dock.syncThread();
      renderAll();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
