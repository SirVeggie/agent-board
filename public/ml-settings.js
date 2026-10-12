/* The Classifier category of Settings: sources for the decision service (/api/ml), what may be sent, and today's use. */
(function () {
  "use strict";

  const SEND = [
    ["messages", "My messages"],
    ["agentText", "Agent text and thinking"],
    ["toolCalls", "Tool calls", "The tool's name and its input, such as a command or a file path."],
    ["toolResults", "Tool results", "What a tool returned: file contents, command output, pages and web pages the agent read."],
  ];
  const JEV_URL = "https://api.typesafe.ai";
  const JEV_MODEL = "jev-latest";

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, run, className) => {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", run);
    return node;
  };
  const tip = (node, text) => {
    node.dataset.tooltip = text;
    node.setAttribute("aria-description", text);
    return node;
  };
  const section = (title, help) => {
    const node = el("section", "settings-section");
    const heading = el("h3", null, title);
    if (help) {
      const mark = tip(el("button", "search-help", "?"), help);
      mark.type = "button";
      mark.setAttribute("aria-label", `About ${title.toLowerCase()}`);
      heading.append(" ", mark);
    }
    node.append(heading);
    return node;
  };
  const number = (n) => Number(n || 0).toLocaleString();

  const sourcesSection = section(
    "Classifier sources",
    "Small, fast models that answer yes/no, choice and score questions for Scribe's features, such as what a message is asking for. A source is a Jev API endpoint: TypeSafe's hosted one, or a local server that speaks the same API. Keys are stored on this PC and never shown again."
  );
  const sourceList = el("div", "ml-sources");
  const status = el("p", "settings-hint ml-status");
  status.setAttribute("role", "status");
  const form = el("form", "ml-source-form");
  form.hidden = true;
  const addButton = button("Add source", () => edit(null));
  const sourceActions = el("div", "settings-actions");
  sourceActions.append(addButton);
  sourcesSection.append(sourceList, status, form, sourceActions);

  const sendSection = section(
    "What may be sent",
    "What features may put in a request to the classifier. With a hosted source, that text leaves this PC. A feature that needs something switched off here goes without an answer."
  );
  const featureSection = section("Features");
  const usageSection = section("Today");
  const usageLine = el("p", "settings-hint");
  const latencyLine = el("p", "settings-hint");
  usageSection.append(usageLine, latencyLine);

  let view = null;
  let confirmRemove = async () => true;
  /** Told each time the settings are read or changed, for a feature's switch that also sits in another category. */
  let onView = () => {};

  async function request(method, path, body) {
    // Every change is sent as JSON, even an empty one: the daemon refuses anything else.
    const response = await fetch(`/api/ml/${path}`, method === "GET" ? {} : {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
    });
    let result = null;
    try { result = await response.json(); } catch { /* an older daemon answers with a page, not JSON */ }
    if (!result || (response.status === 404 && !result.error)) throw new Error("Restart Scribe to use the classifier settings.");
    if (!response.ok) throw new Error(result?.error || "Cannot update classifier settings");
    return result;
  }
  const say = (text) => { status.textContent = text; };

  function switchRow(parent, id, label, hint, on, change) {
    const row = el("div", "setting-row");
    const name = el("span", hint ? "setting-hinted" : null, label);
    name.id = `ml-${id}-label`;
    if (hint) tip(name, hint);
    const toggle = el("button", "pill-toggle");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(on));
    toggle.setAttribute("aria-labelledby", name.id);
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try { render(await request("PUT", "settings", change(toggle.getAttribute("aria-checked") !== "true"))); }
      catch (err) { say(err.message); toggle.disabled = false; }
    });
    row.append(name, toggle);
    parent.append(row);
  }

  function renderUsage(usage) {
    usageLine.textContent = `${number(usage.calls)} ${usage.calls === 1 ? "call" : "calls"} · ${number(usage.inputTokens)} tokens in`
      + (usage.cached ? ` · ${number(usage.cached)} from cache` : "")
      + (usage.failed ? ` · ${number(usage.failed)} failed` : "");
    const l = usage.latency;
    latencyLine.hidden = !l;
    if (l) latencyLine.textContent = `Since Scribe started: last ${number(l.last)} ms · median ${number(l.median)} ms · 95% under ${number(l.p95)} ms`;
  }

  function render(next) {
    view = next;
    sourceList.replaceChildren();
    if (!view.sources.length) sourceList.append(el("p", "settings-hint", "None yet. Features that use a classifier stay off until you add one."));
    for (const source of view.sources) {
      const row = el("div", "setting-row ml-source");
      const pick = el("input");
      pick.type = "radio";
      pick.name = "ml-default-source";
      pick.checked = source.id === view.defaultSource;
      pick.setAttribute("aria-label", `Use ${source.name} by default`);
      tip(pick, "The default: features use this source.");
      pick.addEventListener("change", async () => {
        try { render(await request("PUT", "settings", { defaultSource: source.id })); }
        catch (err) { say(err.message); render(view); }
      });
      const text = el("span", "ml-source-text");
      let host = source.baseUrl;
      try { host = new URL(source.baseUrl).host; } catch { /* shown as saved */ }
      text.append(el("strong", null, source.name), el("span", "ml-source-detail", ` ${source.model} · ${host}${source.hasKey ? "" : " · no key"}`));
      const test = button("Test", async () => {
        test.disabled = true;
        say(`Asking ${source.name}…`);
        try {
          const result = await request("POST", `sources/${encodeURIComponent(source.id)}/test`, {});
          say(result.ok
            ? `${source.name} answered in ${number(result.ms)} ms (${result.model}, ${number(result.usage.inputTokens)} tokens).`
            : `${source.name}: ${result.message}`);
          renderUsage(await request("GET", "usage"));
        } catch (err) { say(err.message); }
        test.disabled = false;
      });
      tip(test, "Sends one short made-up question to check the URL, key and model.");
      row.append(pick, text, test, button("Edit", () => edit(source)));
      sourceList.append(row);
    }

    sendSection.replaceChildren(sendSection.firstChild);
    for (const [kind, label, hint] of SEND) switchRow(sendSection, `send-${kind}`, label, hint, view.send[kind], (on) => ({ send: { [kind]: on } }));

    featureSection.replaceChildren(featureSection.firstChild);
    if (!view.features.length) featureSection.append(el("p", "settings-hint", "Nothing uses a classifier yet. Features that do will each get a switch here."));
    for (const feature of view.features) switchRow(featureSection, `feature-${feature.id}`, feature.label, feature.hint, feature.on, (on) => ({ features: { [feature.id]: on } }));

    renderUsage(view.usage);
    onView(view);
  }

  /** Add (source null) or edit a source, in place under the list. The key field only sends a new key; it never shows the old one. */
  function edit(source) {
    const field = (label, value, placeholder, type = "text") => {
      const wrap = el("label", "ml-field");
      const input = el("input");
      input.type = type;
      input.value = value || "";
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.autocomplete = "off";
      wrap.append(el("span", null, label), input);
      return { wrap, input };
    };
    const name = field("Name", source?.name, "e.g. Jev");
    const baseUrl = field("Base URL", source ? source.baseUrl : JEV_URL, JEV_URL);
    tip(baseUrl.wrap.firstChild, "Without the version path: Scribe calls /v1/systemone under it. Pointing a source at another host clears its saved key.").classList.add("setting-hinted");
    const key = field("API key", "", source?.hasKey ? "Saved (type to replace)" : "Leave empty for a local server that needs none", "password");
    const model = field("Model", source ? source.model : JEV_MODEL, JEV_MODEL);
    const error = el("p", "settings-hint ml-form-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const close = () => {
      form.hidden = true;
      form.replaceChildren();
      sourceActions.hidden = false;
    };
    const send = async (method, path, body) => {
      try {
        render(await request(method, path, body));
        close();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    };
    const actions = el("div", "settings-actions");
    if (source) {
      actions.append(button("Remove", async () => {
        if (await confirmRemove(`Remove “${source.name}”?`, "Remove")) await send("DELETE", `sources/${encodeURIComponent(source.id)}`);
      }));
      if (source.hasKey) actions.append(button("Clear key", () => send("PUT", `sources/${encodeURIComponent(source.id)}`, { apiKey: "" })));
    }
    const save = el("button", "primary", source ? "Save" : "Add");
    save.type = "submit";
    actions.append(el("span", "ml-grow"), button("Cancel", close), save);
    form.replaceChildren(name.wrap, baseUrl.wrap, key.wrap, model.wrap, error, actions);
    form.onsubmit = (event) => {
      event.preventDefault();
      const body = { name: name.input.value, baseUrl: baseUrl.input.value, model: model.input.value };
      if (key.input.value.trim()) body.apiKey = key.input.value.trim();
      send(source ? "PUT" : "POST", source ? `sources/${encodeURIComponent(source.id)}` : "sources", body);
    };
    form.hidden = false;
    sourceActions.hidden = true;
    say("");
    (source ? baseUrl : name).input.focus();
  }

  window.scribeMlSettings = {
    sections: [sourcesSection, sendSection, featureSection, usageSection],
    /** `confirm(message, label)` resolves true when the user agrees to remove a source. */
    init({ confirm, view: listener }) {
      if (confirm) confirmRemove = confirm;
      if (listener) onView = listener;
    },
    /** Switch a feature from outside this category; every copy of its switch follows. */
    async setFeature(id, on) {
      render(await request("PUT", "settings", { features: { [id]: on } }));
    },
    /** Called when Settings opens. */
    refresh() {
      say("");
      request("GET", "settings").then(render).catch((err) => say(err.message));
    },
  };
})();
