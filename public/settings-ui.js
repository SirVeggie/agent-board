(() => {
  const transitions = new WeakMap();
  let host, active, releaseTrap, returnFocus;
  let resizeFrame;
  const isOpen = () => Boolean(host && !host.root.hidden && !host.root.classList.contains("settings-closing"));
  function resize() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!isOpen() || !active) return;
      const rootStyle = getComputedStyle(host.root);
      const contentStyle = getComputedStyle(active.content);
      const available = host.root.clientHeight - parseFloat(rootStyle.paddingTop) - parseFloat(rootStyle.paddingBottom);
      const natural = active.header.offsetHeight + active.body().scrollHeight + parseFloat(contentStyle.paddingTop) + parseFloat(contentStyle.paddingBottom);
      host.panel.style.height = `${Math.min(available, 960, Math.max(700, natural))}px`;
    });
  }
  window.addEventListener("resize", resize);

  function close() {
    if (!isOpen()) return false;
    releaseTrap?.();
    releaseTrap = null;
    show(host.root, false);
    document.getElementById("settings-toggle")?.setAttribute("aria-expanded", "false");
    const target = returnFocus?.isConnected && !host.root.contains(returnFocus) ? returnFocus : document.getElementById("settings-toggle");
    target?.focus({ preventScroll: true });
    return true;
  }
  function show(root, visible) {
    const previous = transitions.get(root);
    previous?.forEach(animation => animation.cancel());
    transitions.delete(root);
    root.classList.toggle("settings-closing", !visible);
    root.inert = !visible;
    root.hidden = false;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.hidden = !visible;
      return;
    }
    const panel = root.querySelector(".settings-panel");
    const backdrop = root.querySelector(".settings-backdrop");
    const frames = [{ opacity: 0, transform: "translateY(12px) scale(.98)" }, { opacity: 1, transform: "translateY(0) scale(1)" }];
    const options = { duration: visible ? 180 : 140, easing: "ease-out", fill: "both" };
    const animations = [
      panel.animate(visible ? frames : [...frames].reverse(), options),
      backdrop.animate(visible ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], options),
    ];
    transitions.set(root, animations);
    Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (transitions.get(root) !== animations) return;
      root.hidden = !visible;
      transitions.delete(root);
      animations.forEach(animation => animation.cancel());
    }).catch(() => {});
  }

  function mount(panel, categories, { close: onClose, before, after } = {}) {
    panel.classList.add("settings-categorized");
    const title = panel.querySelector(".settings-title");
    const header = document.createElement("div");
    header.className = "settings-header";
    header.append(title);
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "settings-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Close settings");
    closeButton.dataset.tooltip = "Close settings (Esc)";
    closeButton.addEventListener("click", onClose);
    header.append(closeButton);
    const nav = document.createElement("nav");
    nav.className = "settings-nav";
    nav.setAttribute("aria-label", `${title.textContent} categories`);
    const content = document.createElement("div");
    content.className = "settings-content";
    const entries = [];
    const link = (entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.label;
      button.className = "settings-nav-link";
      button.addEventListener("click", entry.run);
      nav.append(button);
      return button;
    };
    if (before) {
      link(before);
      const separator = document.createElement("hr");
      separator.className = "settings-nav-separator";
      nav.append(separator);
    }
    let selected = 0;
    const select = (index) => {
      selected = index;
      entries.forEach((entry, i) => {
        entry.body.hidden = i !== index;
        entry.button.setAttribute("aria-pressed", String(i === index));
      });
      content.scrollTop = 0;
      resize();
    };
    categories.forEach((category, index) => {
      const body = document.createElement("div");
      body.className = "settings-category";
      body.id = `${title.id}-category-${index}`;
      body.append(...category.sections);
      const button = link({ label: category.label, run: () => select(index) });
      button.setAttribute("aria-controls", body.id);
      entries.push({ body, button });
      content.append(body);
    });
    if (after) {
      const button = link(after);
      button.classList.add("settings-nav-bottom");
    }
    nav.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = [...nav.querySelectorAll("button")];
      const current = buttons.indexOf(document.activeElement);
      if (current < 0) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].focus();
    });
    if (!host) host = { panel, root: panel.parentElement };
    const element = document.createElement("div");
    element.className = "settings-view";
    element.hidden = Boolean(active);
    element.append(header, nav, content);
    host.panel.append(element);
    const view = {
      element, header, content,
      body: () => entries[selected].body,
      select,
      isOpen: () => active === view && isOpen(),
      close: () => active === view && close(),
      open() {
        const opening = !isOpen();
        if (opening) returnFocus = document.activeElement;
        if (active !== view) {
          if (active) active.element.hidden = true;
          element.hidden = false;
          host.panel.setAttribute("aria-labelledby", title.id);
          host.root.classList.toggle("ag-settings-dialog", Boolean(before));
          active = view;
        }
        if (opening) show(host.root, true);
        document.getElementById("settings-toggle")?.setAttribute("aria-expanded", "true");
        releaseTrap?.();
        releaseTrap = window.scribeFocusTrap?.bind(host.panel);
        resize();
      },
    };
    if (!active) active = view;
    const observer = new ResizeObserver(() => { if (active === view) resize(); });
    entries.forEach(entry => observer.observe(entry.body));
    observer.observe(header);
    select(0);
    return view;
  }
  window.scribeSettingsUI = { mount, close, isOpen };
})();
