/* Desktop app additions. The Tauri shell loads this same board; in a browser this file does nothing. */
(() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core) {
    return;
  }
  const invoke = tauri.core.invoke;
  const root = document.documentElement;
  const chrome = document.querySelector(".chrome");
  const actions = chrome.querySelector(".actions");
  const HIDDEN_KEY = "scribe.desktop.hiddenButtons";
  root.classList.add("desktop");

  // Empty strip space and the spacing around panels move the window; double-click maximizes.
  // Bare drag regions only react to clicks on the element itself, so tabs, buttons, and panels keep theirs.
  for (const el of [chrome, chrome.querySelector(".tabs-wrap"), document.getElementById("tabs"), actions, document.querySelector(".workspace")]) {
    el?.setAttribute("data-tauri-drag-region", "");
  }

  const ICONS = {
    compact:
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="8" y="8" width="5" height="4.5" rx="1" fill="currentColor"/></svg>',
    expand:
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 5.5h4v4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 5.5L5 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
    minimize: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
    maximize:
      '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    restore:
      '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    close: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>',
  };

  let desktop = {
    compact: false,
    maximized: false,
    compactOnTop: true,
    openFromAgents: true,
    closeToTray: false,
    launchAtStartup: false,
    hidden: false,
  };

  /** The four title bar buttons, in strip order. `label` follows the window state. */
  const BUTTONS = [
    {
      id: "compact",
      action: "toggle-compact",
      setting: "Compact window button",
      label: () => (desktop.compact ? "Normal window" : "Compact window"),
      hint: "Ctrl+Shift+M",
    },
    { id: "minimize", action: "minimize", setting: "Minimize button", label: () => "Minimize" },
    {
      id: "maximize",
      action: "toggle-maximize",
      setting: "Maximize button",
      label: () => (desktop.maximized ? "Restore" : "Maximize"),
    },
    { id: "close", action: "close", setting: "Close button", label: () => "Close" },
  ];

  let hidden = loadHidden();

  function loadHidden() {
    try {
      const ids = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]");
      return new Set(Array.isArray(ids) ? ids.filter((id) => BUTTONS.some((button) => button.id === id)) : []);
    } catch {
      return new Set();
    }
  }

  function saveHidden() {
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
    } catch {
      /* the choice just won't survive a reload */
    }
  }

  // Compact and the overflow menu sit with the other strip buttons; window controls stay at the edge.
  const compactBtn = iconButton("desktop-compact");
  const moreBtn = iconButton("desktop-more", ICONS.more, "Window");
  moreBtn.setAttribute("aria-haspopup", "menu");
  actions.append(compactBtn, moreBtn);

  const controls = document.createElement("div");
  controls.className = "win-controls";
  const minBtn = winButton("win-min", ICONS.minimize);
  const maxBtn = winButton("win-max");
  const closeBtn = winButton("win-close", ICONS.close);
  controls.append(minBtn, maxBtn, closeBtn);
  chrome.append(controls);

  const elements = { compact: compactBtn, minimize: minBtn, maximize: maxBtn, close: closeBtn };
  for (const button of BUTTONS) {
    const el = elements[button.id];
    el.addEventListener("click", () => run(button));
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const rest = BUTTONS.filter((item) => hidden.has(item.id));
      if (rest.length > 0) {
        openMenu(el, rest);
      }
    });
  }
  moreBtn.addEventListener("click", () => (menu ? closeMenu() : openMenu(moreBtn, BUTTONS)));
  moreBtn.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu(moreBtn, BUTTONS);
  });

  function iconButton(id, icon = "", label = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = id;
    btn.className = "icon-btn";
    btn.innerHTML = icon;
    if (label) {
      btn.dataset.tooltip = label;
      btn.setAttribute("aria-label", label);
    }
    return btn;
  }

  function winButton(className, icon = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `win-btn ${className}`;
    btn.innerHTML = icon;
    // A double-click here must not reach the drag region behind it and maximize.
    btn.addEventListener("dblclick", (event) => event.stopPropagation());
    return btn;
  }

  function run(button) {
    closeMenu();
    invoke("window_action", { action: button.action });
  }

  let menu = null;

  function openMenu(anchor, items) {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "tab-menu desktop-menu";
    menu.setAttribute("role", "menu");
    for (const button of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.className = button.id === "close" ? "danger" : "";
      item.textContent = button.label();
      if (button.hint) {
        const hint = document.createElement("span");
        hint.className = "menu-hint";
        hint.textContent = button.hint;
        item.append(hint);
      }
      item.addEventListener("click", () => run(button));
      menu.append(item);
    }
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.transformOrigin = "top right";
    anchor.setAttribute("aria-expanded", "true");
    menu.anchor = anchor;
    menu.querySelector("button")?.focus({ preventScroll: true });
  }

  function closeMenu() {
    if (!menu) {
      return;
    }
    menu.anchor.removeAttribute("aria-expanded");
    menu.remove();
    menu = null;
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (menu && !menu.contains(event.target) && !menu.anchor.contains(event.target)) {
        closeMenu();
      }
    },
    true
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (menu && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        const anchor = menu.anchor;
        closeMenu();
        anchor.focus({ preventScroll: true });
      }
    },
    true
  );
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);

  // Settings → Desktop.
  const section = document.createElement("section");
  section.className = "settings-section";
  section.innerHTML =
    '<h3>Desktop</h3><p class="settings-hint">Right-click a title bar button to bring back hidden ones.</p>';
  const buttonTrack = buttonTrackRow();
  const onTopRow = settingRow("desktop-on-top", "Keep the compact window on top", desktop.compactOnTop, (on) =>
    saveSetting("compactOnTop", on)
  );
  const openRow = settingRow(
    "desktop-open",
    "Agents open Scribe in this app instead of the browser",
    desktop.openFromAgents,
    (on) => saveSetting("openFromAgents", on)
  );
  const trayRow = settingRow("desktop-tray", "Close to tray", desktop.closeToTray, (on) =>
    saveSetting("closeToTray", on)
  );
  const startupRow = settingRow("desktop-startup", "Launch at startup", desktop.launchAtStartup, (on) =>
    saveSetting("launchAtStartup", on)
  );
  const hint = document.createElement("p");
  hint.className = "settings-hint settings-hint-after";
  hint.innerHTML = "<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> switches between the normal and compact window.";
  section.append(buttonTrack.row, onTopRow.row, openRow.row, trayRow.row, startupRow.row, hint);
  document.getElementById("import-page")?.closest(".settings-section")?.before(section);

  /** One row of connected icon toggles, one per title bar button, in strip order. */
  function buttonTrackRow() {
    const row = document.createElement("div");
    row.className = "setting-row";
    const label = document.createElement("span");
    label.id = "desktop-buttons-label";
    label.textContent = "Title bar buttons";
    const track = document.createElement("div");
    track.className = "button-track";
    track.setAttribute("role", "group");
    track.setAttribute("aria-labelledby", label.id);
    const toggles = {};
    for (const button of BUTTONS) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.innerHTML = button.id === "maximize" ? ICONS.maximize : ICONS[button.id];
      toggle.dataset.tooltip = button.setting;
      toggle.setAttribute("aria-label", button.setting);
      toggle.addEventListener("click", () => {
        if (hidden.has(button.id)) {
          hidden.delete(button.id);
        } else {
          hidden.add(button.id);
        }
        saveHidden();
        render();
      });
      toggles[button.id] = toggle;
      track.append(toggle);
    }
    row.append(label, track);
    return { row, toggles };
  }

  function settingRow(id, text, on, onChange) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const label = document.createElement("span");
    label.id = `${id}-label`;
    label.textContent = text;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pill-toggle";
    toggle.id = id;
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(on));
    toggle.setAttribute("aria-labelledby", label.id);
    toggle.addEventListener("click", () => {
      const next = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(next));
      onChange(next);
    });
    row.append(label, toggle);
    return { row, toggle };
  }

  async function saveSetting(name, value) {
    try {
      setState(await invoke("set_desktop_setting", { name, value }));
    } catch (err) {
      console.error(err);
      setState(await invoke("desktop_state"));
    }
  }

  function render() {
    for (const button of BUTTONS) {
      const el = elements[button.id];
      el.hidden = hidden.has(button.id);
      const label = button.hint ? `${button.label()} (${button.hint})` : button.label();
      el.dataset.tooltip = label;
      el.setAttribute("aria-label", label);
    }
    moreBtn.hidden = hidden.size < BUTTONS.length;
    for (const button of BUTTONS) {
      buttonTrack.toggles[button.id].setAttribute("aria-pressed", String(!hidden.has(button.id)));
    }
    compactBtn.innerHTML = desktop.compact ? ICONS.expand : ICONS.compact;
    compactBtn.classList.toggle("on", desktop.compact);
    maxBtn.innerHTML = desktop.maximized ? ICONS.restore : ICONS.maximize;
    controls.hidden = [minBtn, maxBtn, closeBtn].every((el) => el.hidden);
    onTopRow.toggle.setAttribute("aria-checked", String(desktop.compactOnTop));
    openRow.toggle.setAttribute("aria-checked", String(desktop.openFromAgents));
    trayRow.toggle.setAttribute("aria-checked", String(desktop.closeToTray));
    startupRow.toggle.setAttribute("aria-checked", String(desktop.launchAtStartup));
  }

  function setState(state) {
    if (!state) {
      return;
    }
    if (state.hidden !== desktop.hidden) {
      window.scribeSetHidden?.(state.hidden);
    }
    desktop = state;
    root.classList.toggle("compact", state.compact);
    render();
  }

  window.scribeDesktop = { setState };

  // Lost the daemon for more than a moment (it restarts for a new build in about that long):
  // the app swaps in its offline page, which brings the board back once the daemon answers.
  let offlineTimer = 0;
  addEventListener("scribe:connection", (event) => {
    if (event.detail.connected) {
      clearTimeout(offlineTimer);
      offlineTimer = 0;
    } else if (!offlineTimer) {
      // Each failed reconnect reports again; time from the first.
      offlineTimer = setTimeout(() => invoke("window_action", { action: "daemon-offline" }), 4000);
    }
  });
  render();
  invoke("desktop_state").then(setState);
})();
