/**
 * The New page screen (Ctrl+T): what a blank page shows instead of a frame. Shapeless moving
 * matter behind a short prompt and the templates; picking one fills this page. Once the page has a
 * chat thread, the templates step aside and the screen waits for what the agent makes.
 */
(() => {
  const FILE_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2h7.5l3.5 3.5V14h-11z" fill="currentColor"/></svg>';
  const BUILTIN_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M2.5 2h7.5l3.5 3.5V14h-11zM8 7.2l.9 1.8 2 .3-1.45 1.4.35 2L8 11.75l-1.8.95.35-2L5.1 9.3l2-.3z" fill="currentColor"/></svg>';
  const SPARK_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.2l1.5 3.9 3.9 1.5-3.9 1.5L8 12l-1.5-3.9L2.6 6.6l3.9-1.5z" fill="currentColor"/><circle cx="12.8" cy="12.6" r="1.5" fill="currentColor"/></svg>';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * host: templates() and builtins() (template metas), pick(template), threads(id) (the page's chat
   * threads), working(id) (an agent is at work on it), openChat().
   */
  window.createNewPage = (host) => {
    const root = document.getElementById("newpage");
    const lede = root.querySelector(".newpage-lede");
    const askBtn = root.querySelector(".newpage-ask");
    const grid = root.querySelector(".newpage-templates");
    const gridHead = root.querySelector(".newpage-templates-head");
    askBtn.innerHTML = `${SPARK_SVG}<span>Ask the agent</span><kbd>Ctrl</kbd><kbd>K</kbd>`;
    askBtn.addEventListener("click", () => host.openChat());
    /** The page shown and what was drawn for it, so a re-render with nothing new keeps focus and scroll. */
    let shown = null;
    let drawn = "";

    function card(template, builtin) {
      const btn = el("button", "newpage-card");
      btn.type = "button";
      const icon = el("span", "newpage-card-icon");
      icon.innerHTML = builtin ? BUILTIN_SVG : FILE_SVG;
      const text = el("span", "newpage-card-text");
      text.append(el("span", "newpage-card-title", template.title));
      if (template.description) text.append(el("span", "newpage-card-desc", template.description));
      btn.append(icon, text);
      btn.addEventListener("click", () => host.pick(template));
      return btn;
    }

    /** Built-ins that already have a local copy show once, as the copy. */
    function templateList() {
      const own = host.templates();
      const copied = new Set(own.map((t) => t.builtinSource).filter(Boolean));
      const builtins = host.builtins().filter((t) => !t.localId && !copied.has(t.key));
      return [...own.map((t) => [t, false]), ...builtins.map((t) => [t, true])];
    }

    function render(tab) {
      root.hidden = !tab;
      if (!tab) {
        shown = null;
        drawn = "";
        return;
      }
      const threads = host.threads(tab.id);
      const working = host.working(tab.id);
      const list = threads ? [] : templateList();
      const key = JSON.stringify([tab.id, threads, working, list.map(([t]) => [t.id, t.title, t.description])]);
      if (shown === tab.id && drawn === key) return;
      shown = tab.id;
      drawn = key;
      root.classList.toggle("has-thread", threads > 0);
      root.classList.toggle("working", Boolean(working));
      lede.textContent = threads
        ? working
          ? "The agent is working on it. What it makes takes this page's place."
          : "Ask the agent in the chat. The page it makes takes this page's place."
        : "Start from a template, or ask the agent to make something here.";
      askBtn.querySelector("span").textContent = threads ? "Open the chat" : "Ask the agent";
      gridHead.hidden = !list.length;
      grid.replaceChildren(...list.map(([template, builtin]) => card(template, builtin)));
    }

    return {
      render,
      /** Focus the first template, or the chat button once the templates are gone. */
      focus() {
        (grid.querySelector("button") || askBtn).focus({ preventScroll: true });
      },
    };
  };
})();
