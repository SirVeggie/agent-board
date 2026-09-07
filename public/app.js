(() => {
  const tabsEl = document.getElementById("tabs");
  const fadeEl = document.getElementById("tabs-fade");
  const emptyEl = document.getElementById("empty");
  const frameEl = document.getElementById("frame");
  const clearBtn = document.getElementById("clear");

  /** @type {{ tabs: Array<{id: string, key: string, title: string, pinned: boolean, revision: number}>, activeId: string | null, connected: boolean, shownRevision: number | null }} */
  const state = {
    tabs: [],
    activeId: null,
    connected: false,
    shownRevision: null,
  };

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener("open", () => {
      state.connected = true;
      renderChrome();
    });
    ws.addEventListener("message", (event) => {
      applyEvent(JSON.parse(event.data));
    });
    ws.addEventListener("close", () => {
      state.connected = false;
      renderChrome();
      setTimeout(connect, 1000);
    });
  }

  function applyEvent(msg) {
    if (msg.type === "snapshot") {
      state.tabs = msg.tabs;
      const hash = location.hash.replace(/^#/, "");
      const fromHash = state.tabs.find((tab) => tab.id === hash || tab.key === hash);
      state.activeId = fromHash ? fromHash.id : msg.activeId;
      syncHash();
      render();
      return;
    }
    if (msg.type === "tab_upserted") {
      const idx = state.tabs.findIndex((tab) => tab.id === msg.tab.id);
      if (idx === -1) {
        const at = Number.isInteger(msg.index) ? Math.max(0, Math.min(msg.index, state.tabs.length)) : state.tabs.length;
        state.tabs.splice(at, 0, msg.tab);
      } else {
        state.tabs[idx] = msg.tab;
      }
      render();
      return;
    }
    if (msg.type === "tab_closed") {
      state.tabs = state.tabs.filter((tab) => tab.id !== msg.id);
      if (state.activeId === msg.id) {
        state.activeId = state.tabs.length ? state.tabs[state.tabs.length - 1].id : null;
      }
      render();
      return;
    }
    if (msg.type === "tab_focused") {
      state.activeId = msg.id;
      syncHash();
      render();
    }
  }

  function syncHash() {
    if (!state.activeId) {
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
      el.className = "tab" + (tab.id === state.activeId ? " active" : "") + (tab.pinned ? " pinned" : "");
      el.role = "tab";
      el.title = tab.pinned ? tab.title + " (pinned)" : tab.title;
      el.addEventListener("click", (event) => {
        if (event.detail > 1) {
          setPinned(tab.id, !tab.pinned);
          return;
        }
        focusTab(tab.id);
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

  function renderFrame() {
    const tab = activeTab();
    if (!tab) {
      emptyEl.hidden = false;
      frameEl.hidden = true;
      frameEl.removeAttribute("src");
      state.shownRevision = null;
      document.title = "Agent Board";
      return;
    }
    emptyEl.hidden = true;
    frameEl.hidden = false;
    document.title = tab.title + " · Agent Board";
    const next = `/view/${encodeURIComponent(tab.id)}?r=${tab.revision}`;
    if (!frameEl.src.includes(`${tab.id}?r=${tab.revision}`)) {
      frameEl.src = next;
      state.shownRevision = tab.revision;
    }
  }

  function render() {
    renderChrome();
    renderTabs();
    renderFrame();
  }

  async function focusTab(id) {
    if (state.activeId !== id) {
      state.activeId = id;
      syncHash();
      render();
    }
    await fetch(`/api/tabs/${encodeURIComponent(id)}/focus`, { method: "POST" });
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

  tabsEl.parentElement.addEventListener("wheel", onTabsWheel, { passive: false });
  tabsEl.addEventListener("scroll", updateTabFade);
  window.addEventListener("resize", updateTabFade);

  window.addEventListener("keydown", onBoardShortcut, true);
  window.addEventListener("message", (event) => {
    if (event.source !== frameEl.contentWindow) {
      return;
    }
    if (event.data?.type === "agent-board-download") {
      downloadActive();
    } else if (event.data?.type === "agent-board-undo") {
      undoClose();
    } else if (event.data?.type === "agent-board-help") {
      openWelcome();
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
        focusTab(tab.id);
      }
    }
  });

  connect();
  render();
})();
