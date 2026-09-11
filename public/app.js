(() => {
  const tabsEl = document.getElementById("tabs");
  const fadeEl = document.getElementById("tabs-fade");
  const emptyEl = document.getElementById("empty");
  const framesEl = document.getElementById("frames");
  const clearBtn = document.getElementById("clear");

  const SANDBOX =
    "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
  const LIVE_FRAME_CAP = 5;

  /** @type {{ tabs: Array<{id: string, key: string, title: string, pinned: boolean, revision: number}>, activeId: string | null, connected: boolean }} */
  const state = {
    tabs: [],
    activeId: null,
    connected: false,
  };

  /** @type {Map<string, { el: HTMLIFrameElement, revision: number }>} */
  const frames = new Map();
  /** @type {Set<string>} */
  const unread = new Set();

  /** @type {WebSocket | null} */
  let socket = null;
  let lastInteractedAt = 0;
  let lastEditAt = 0;

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

  function applyEvent(msg) {
    if (msg.type === "snapshot") {
      state.tabs = msg.tabs;
      const hash = location.hash.replace(/^#/, "");
      const fromHash = state.tabs.find((tab) => tab.id === hash || tab.key === hash);
      state.activeId = fromHash ? fromHash.id : msg.activeId;
      unread.clear();
      syncHash();
      render();
      reportViewer();
      return;
    }
    if (msg.type === "tab_upserted") {
      const idx = state.tabs.findIndex((tab) => tab.id === msg.tab.id);
      const prev = idx === -1 ? null : state.tabs[idx];
      const structural = !prev || prev.revision !== msg.tab.revision;
      if (idx === -1) {
        const at = Number.isInteger(msg.index) ? Math.max(0, Math.min(msg.index, state.tabs.length)) : state.tabs.length;
        state.tabs.splice(at, 0, msg.tab);
      } else {
        state.tabs[idx] = msg.tab;
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
      return;
    }
    if (msg.type === "tab_closed") {
      state.tabs = state.tabs.filter((tab) => tab.id !== msg.id);
      unread.delete(msg.id);
      discardFrame(msg.id);
      if (state.activeId === msg.id) {
        state.activeId = state.tabs.length ? state.tabs[state.tabs.length - 1].id : null;
        if (state.activeId) {
          unread.delete(state.activeId);
        }
        syncHash();
      }
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
      if (tab) {
        tab.stateRevision = msg.stateRevision;
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

  function renderChrome() {
    clearBtn.disabled = !state.tabs.some((tab) => !tab.pinned);
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
    fadeEl.hidden = !(overflow && moreToTheRight);
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
      el.title = unread.has(tab.id) && tab.id !== state.activeId ? tab.title + " (updated)" : tab.pinned ? tab.title + " (pinned)" : tab.title;
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
        closeTab(tab.id);
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
      lastInteractedAt = Date.now();
    }
    reportViewer();
  }

  async function closeTab(id) {
    await fetch(`/api/tabs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async function setPinned(id, pin) {
    const tab = state.tabs.find((item) => item.id === id);
    if (tab) {
      tab.pinned = pin;
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

  function onBoardShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
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
    } else if (event.data?.type === "agent-board-activity") {
      noteEdit();
    }
  });

  clearBtn.addEventListener("click", async () => {
    await fetch("/api/tabs?filter=unpinned", { method: "DELETE" });
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.replace(/^#/, "");
    if (id && state.tabs.some((tab) => tab.id === id || tab.key === id)) {
      const tab = state.tabs.find((item) => item.id === id || item.key === id);
      if (tab && tab.id !== state.activeId) {
        selectTab(tab.id, { fromUser: true });
      }
    }
  });

  connect();
  render();
})();
