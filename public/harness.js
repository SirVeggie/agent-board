/**
 * The agent harness view (#456): a full panel on what every chat is given at its start (Scribe's
 * instructions and tools, MCP servers, skills) and how the stored threads used it. It reads
 * /api/agent/harness/* and changes nothing; the settings dialogs stay where things are edited.
 */
(() => {
  const PROVIDERS = ["cursor", "claude", "codex", "pi"];
  const PROVIDER_LABEL = { claude: "Claude", cursor: "Cursor", codex: "Codex", pi: "Native" };
  const MODE_LABEL = { code: "Code", plan: "Plan", ask: "Ask", board: "Pages" };
  const KIND_LABEL = { execute: "Shell commands", mcp: "MCP tools", read: "File reads", search: "Searches", edit: "File edits", fetch: "Web", think: "Thinking", task: "Subagents", todo: "To-dos", delete: "Deletes", move: "Moves", other: "Other" };
  const RANGES = [
    { id: 7, label: "7 days" },
    { id: 30, label: "30 days" },
    { id: 90, label: "90 days" },
    { id: 0, label: "All" },
  ];
  const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "context", label: "Session context" },
    { id: "tools", label: "Tool use" },
    { id: "mcp", label: "MCP servers" },
    { id: "skills", label: "Skills" },
    { id: "threads", label: "Heaviest threads" },
  ];
  const LS = { days: "scribe.harness.days", section: "scribe.harness.section", pick: "scribe.harness.pick" };

  const S = {
    section: localStorage.getItem(LS.section) || "overview",
    days: Number(localStorage.getItem(LS.days) ?? 30),
    pick: { provider: "claude", mode: "code", cwd: null },
    stats: null,
    context: null,
    skills: null,
    config: null,
    measure: null,
    probes: new Map(),
    error: "",
    loading: 0,
  };
  try {
    Object.assign(S.pick, JSON.parse(localStorage.getItem(LS.pick) || "{}"));
  } catch {
    /* keep the defaults */
  }

  let root, body, heading, controls, nav;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(label, cls, onClick) {
    const node = el("button", cls, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  async function api(method, path, payload) {
    const write = method !== "GET";
    const res = await fetch(`/api/agent${path}`, {
      method,
      headers: write ? { "Content-Type": "application/json" } : {},
      body: write ? JSON.stringify(payload ?? {}) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  function tokens(n) {
    if (!n) return "0";
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
    return `${(n / 1_000_000_000).toFixed(1)}B`;
  }

  const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");
  const count = (n) => Number(n || 0).toLocaleString();

  function duration(ms) {
    if (!ms) return "–";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.round(ms / 60_000)} min`;
  }

  /* ---------- pieces ---------- */

  function card(title, hint) {
    const node = el("section", "hx-card");
    if (title) node.append(el("h3", null, title));
    if (hint) node.append(el("p", "hx-hint", hint));
    return node;
  }

  function tiles(list) {
    const row = el("div", "hx-tiles");
    for (const [label, value, note] of list) {
      const tile = el("div", "hx-tile");
      tile.append(el("span", "hx-tile-label", label), el("strong", "hx-tile-value", value));
      if (note) tile.append(el("span", "hx-tile-note", note));
      row.append(tile);
    }
    return row;
  }

  /** rows: [{ label, sub?, value, text, tone?, detail? }], drawn as one bar each against the largest value. */
  function bars(rows, { max } = {}) {
    const list = el("div", "hx-bars");
    const top = max ?? Math.max(1, ...rows.map((row) => row.value));
    for (const row of rows) {
      const line = el(row.detail ? "details" : "div", "hx-bar-row");
      const head = el(row.detail ? "summary" : "div", "hx-bar-head");
      const label = el("span", "hx-bar-label");
      label.append(el("span", null, row.label));
      if (row.sub) label.append(el("span", "hx-muted", ` ${row.sub}`));
      const track = el("span", "hx-bar-track");
      const fill = el("span", `hx-bar-fill${row.tone ? ` ${row.tone}` : ""}`);
      fill.style.width = `${Math.max(row.value > 0 ? 0.6 : 0, (row.value / top) * 100)}%`;
      track.append(fill);
      head.append(label, track, el("span", "hx-bar-value", row.text));
      if (row.tip) head.dataset.tooltip = row.tip;
      line.append(head);
      if (row.detail) line.append(el("pre", "hx-pre", row.detail));
      list.append(line);
    }
    return list;
  }

  /** columns: [{ label, num?, get(row) -> string | Node }] */
  function table(columns, rows, { onRow } = {}) {
    const node = el("table", "hx-table");
    const head = el("tr");
    for (const column of columns) head.append(el("th", column.num ? "num" : null, column.label));
    node.appendChild(el("thead")).append(head);
    const tbody = node.appendChild(el("tbody"));
    for (const row of rows) {
      const tr = el("tr");
      for (const column of columns) {
        const cell = el("td", column.num ? "num" : null);
        const value = column.get(row);
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value ?? "";
        tr.append(cell);
      }
      if (onRow) {
        tr.classList.add("hx-row-link");
        tr.tabIndex = 0;
        tr.addEventListener("click", () => onRow(row));
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter") onRow(row);
        });
      }
      tbody.append(tr);
    }
    const wrap = el("div", "hx-table-wrap");
    wrap.append(node);
    return wrap;
  }

  function providerChip(provider) {
    const chip = el("span", "hx-provider");
    chip.append(el("i", `hx-dot hx-p-${provider}`), document.createTextNode(PROVIDER_LABEL[provider] || provider));
    return chip;
  }

  function empty(text) {
    return el("p", "hx-empty", text);
  }

  function track(options, current, onPick, label) {
    const node = el("div", "button-track text-track");
    node.setAttribute("role", "group");
    if (label) node.setAttribute("aria-label", label);
    for (const option of options) {
      const control = button(option.label, null, () => onPick(option.id));
      control.setAttribute("aria-pressed", String(option.id === current));
      node.append(control);
    }
    return node;
  }

  /* ---------- sections ---------- */

  function rangeText() {
    return S.days ? `the last ${S.days} days` : "all stored threads";
  }

  function renderOverview() {
    const stats = S.stats;
    if (!stats) return [empty("Loading…")];
    if (!stats.totals.turns) return [empty(`No turns in ${rangeText()}.`)];
    const t = stats.totals;
    const out = [];
    out.push(
      tiles([
        ["Threads", count(stats.threads)],
        ["Turns", count(t.turns), `${count(stats.outcomes.error)} failed · ${count(stats.outcomes.cancelled)} stopped`],
        ["Sent to models", tokens(t.prompt), `${pct(t.cached, t.prompt)} read from cache`],
        ["Written by models", tokens(t.output), t.reasoning ? `${tokens(t.reasoning)} reasoning` : ""],
        ["Tool calls", count(t.toolCalls), `${(t.toolCalls / Math.max(1, t.turns)).toFixed(1)} a turn · ${pct(t.toolErrors, t.toolCalls)} failed`],
        ...(t.costUsd ? [["Reported cost", `$${t.costUsd.toFixed(2)}`, "Where the provider reports one"]] : []),
      ])
    );

    const daily = card("Tokens sent to models, by day", "Everything each turn sent, cached input included. A turn sends its whole conversation again on every model call, so long tool loops dominate.");
    daily.append(dayChart(stats.days));
    out.push(daily);

    const providers = card("By provider");
    providers.append(
      table(
        [
          { label: "Provider", get: (r) => providerChip(r.provider) },
          { label: "Threads", num: true, get: (r) => count(r.threads) },
          { label: "Turns", num: true, get: (r) => count(r.turns) },
          { label: "Sent", num: true, get: (r) => tokens(r.prompt) },
          { label: "Cached", num: true, get: (r) => pct(r.cached, r.prompt) },
          { label: "Sent a turn", num: true, get: (r) => tokens(r.prompt / Math.max(1, r.turns)) },
          { label: "Written", num: true, get: (r) => tokens(r.output) },
          { label: "Tools a turn", num: true, get: (r) => (r.toolCalls / Math.max(1, r.turns)).toFixed(1) },
          { label: "Tools failed", num: true, get: (r) => pct(r.toolErrors, r.toolCalls) },
          { label: "Turns failed", num: true, get: (r) => pct(r.errors, r.turns) },
        ],
        stats.providers
      )
    );
    out.push(providers);

    const models = card("By model");
    models.append(
      table(
        [
          { label: "Model", get: (r) => r.model },
          { label: "Provider", get: (r) => providerChip(r.provider) },
          { label: "Turns", num: true, get: (r) => count(r.turns) },
          { label: "Sent", num: true, get: (r) => tokens(r.prompt) },
          { label: "Cached", num: true, get: (r) => pct(r.cached, r.prompt) },
          { label: "Written", num: true, get: (r) => tokens(r.output) },
          { label: "Tools a turn", num: true, get: (r) => (r.toolCalls / Math.max(1, r.turns)).toFixed(1) },
          { label: "Cost", num: true, get: (r) => (r.costUsd ? `$${r.costUsd.toFixed(2)}` : "–") },
        ],
        stats.models
      )
    );
    out.push(models);

    const base = card(
      "What a session starts with, measured",
      "The tokens sent by first turns that made no tool call: one model call, so nearly all of it is what the session was given before your message (system prompt, tool schemas, instructions, skills). Session context shows Scribe's share."
    );
    base.append(
      stats.baselines.length
        ? table(
            [
              { label: "Provider", get: (r) => providerChip(r.provider) },
              { label: "Mode", get: (r) => MODE_LABEL[r.mode] || r.mode },
              { label: "Typical first call", num: true, get: (r) => tokens(r.median) },
              { label: "Smallest", num: true, get: (r) => tokens(r.min) },
              { label: "Turns measured", num: true, get: (r) => count(r.samples) },
            ],
            stats.baselines
          )
        : empty("No first turn without a tool call in this range yet.")
    );
    out.push(base);
    return out;
  }

  /** Stacked columns: one per day, a segment per provider, drawn in SVG with a hover tooltip per day. */
  function dayChart(days) {
    const wrap = el("div", "hx-chart");
    const shown = days.slice(-60);
    const total = (day) => PROVIDERS.reduce((sum, p) => sum + (day.prompt[p] || 0), 0);
    const max = Math.max(1, ...shown.map(total));
    const W = 960;
    const H = 180;
    const slot = W / Math.max(shown.length, 14);
    const width = Math.max(3, Math.min(34, slot - 2));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H + 22}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Tokens sent to models by day and provider");
    const make = (name, attrs) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      return node;
    };
    for (const share of [0.5, 1]) {
      const y = H - H * share;
      svg.append(make("line", { x1: 0, x2: W, y1: y + 0.5, y2: y + 0.5, class: "hx-grid" }));
      const label = make("text", { x: W, y: y + 12, class: "hx-axis", "text-anchor": "end" });
      label.textContent = tokens(max * share);
      svg.append(label);
    }
    svg.append(make("line", { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: "hx-base" }));
    shown.forEach((day, index) => {
      const x = index * slot + (slot - width) / 2;
      let y = H;
      const group = make("g", { class: "hx-day" });
      const parts = [];
      for (const provider of PROVIDERS) {
        const value = day.prompt[provider] || 0;
        if (!value) continue;
        const h = Math.max(1, (value / max) * H);
        y -= h;
        // A 2px gap of surface between stacked segments.
        group.append(make("rect", { x, y, width, height: Math.max(1, h - 2), rx: 2, class: `hx-p-${provider}` }));
        parts.push(`${PROVIDER_LABEL[provider]} ${tokens(value)}`);
      }
      const hit = make("rect", { x: index * slot, y: 0, width: slot, height: H, class: "hx-hit" });
      hit.dataset.tooltip = `${day.day} · ${tokens(total(day))} in ${day.turns} ${day.turns === 1 ? "turn" : "turns"}\n${parts.join(" · ")}`;
      group.append(hit);
      svg.append(group);
      if (index === 0 || index === shown.length - 1 || (shown.length > 8 && index === shown.length >> 1)) {
        const label = make("text", { x: Math.min(W - 30, Math.max(30, x + width / 2)), y: H + 16, class: "hx-axis", "text-anchor": "middle" });
        label.textContent = day.day.slice(5);
        svg.append(label);
      }
    });
    const legend = el("div", "hx-legend");
    for (const provider of PROVIDERS) if (shown.some((day) => day.prompt[provider])) legend.append(providerChip(provider));
    wrap.append(legend, svg);
    return wrap;
  }

  function pickers() {
    const row = el("div", "hx-pickers");
    const repick = (patch) => {
      Object.assign(S.pick, patch);
      localStorage.setItem(LS.pick, JSON.stringify(S.pick));
      S.context = null;
      S.measure = null;
      S.skills = null;
      render();
      void loadContext();
    };
    row.append(
      track(PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id] })), S.pick.provider, (provider) => repick({ provider }), "Provider"),
      track(Object.entries(MODE_LABEL).map(([id, label]) => ({ id, label })), S.pick.mode, (mode) => repick({ mode }), "Mode")
    );
    const select = el("select", "hx-select");
    select.setAttribute("aria-label", "Workspace");
    const folders = [...new Set([S.pick.cwd, ...(S.config?.prefs?.recentWorkspaces || [])].filter(Boolean))];
    select.append(new Option("No workspace", ""));
    for (const folder of folders) select.append(new Option(folder, folder));
    select.value = S.pick.cwd || "";
    select.addEventListener("change", () => repick({ cwd: select.value || null }));
    row.append(select);
    return row;
  }

  function baselineFor(pick) {
    return S.stats?.baselines.find((b) => b.provider === pick.provider && b.mode === pick.mode) || null;
  }

  function renderContext() {
    const out = [pickers()];
    const ctx = S.context;
    if (!ctx) return [...out, empty(S.error || "Loading…")];
    const label = `${PROVIDER_LABEL[ctx.thread.provider]} ${MODE_LABEL[ctx.thread.mode]} thread`;
    const tools = ctx.scribeTools;
    const files = ctx.own.files.reduce((sum, file) => sum + file.tokens, 0);
    const scribe = ctx.instructions.tokens + tools.tokens;
    const base = baselineFor(ctx.thread);

    const summary = card(
      `What Scribe adds to a new ${label}`,
      "Estimated from the length of the text, so read these as rough sizes. Tool schemas count in full here; Claude Code lists MCP tools by name and loads a schema only when it is used, so there they cost less (Measure below gives its own count)."
    );
    summary.append(
      tiles([
        ["Scribe's instructions", `≈ ${tokens(ctx.instructions.tokens)}`, `${ctx.instructions.sections.length} parts${ctx.memories ? ` · ${ctx.memories} memories` : ""}`],
        ["Scribe's tools", tools.error ? "?" : `≈ ${tokens(tools.tokens)}`, tools.error ? "Could not list them" : `${tools.tools.length} tool schemas`],
        ["Instruction files", `≈ ${tokens(files)}`, ctx.own.files.length ? `${ctx.own.files.length} found, read by the provider` : "None found"],
        ["Measured first call", base ? tokens(base.median) : "–", base ? `Scribe's part is about ${pct(scribe, base.median)} of it` : "No first turn without tools in range"],
      ])
    );
    if (base) {
      const rest = Math.max(0, base.median - scribe - files);
      summary.append(
        bars(
          [
            { label: "Scribe's instructions", value: ctx.instructions.tokens, text: `≈ ${tokens(ctx.instructions.tokens)}` },
            { label: "Scribe's tool schemas", value: tools.tokens, text: `≈ ${tokens(tools.tokens)}` },
            { label: "Instruction files", value: files, text: `≈ ${tokens(files)}`, tone: "quiet" },
            { label: "Everything else", sub: "the provider's prompt and tools, skills, other MCP servers, your message", value: rest, text: `≈ ${tokens(rest)}`, tone: "quiet" },
          ],
          { max: base.median }
        )
      );
    }
    out.push(summary);

    if (ctx.thread.provider === "claude") out.push(measureCard());

    const parts = card("Scribe's instructions, part by part", `${ctx.own.delivery} Open a part to read what is sent.`);
    parts.append(
      bars(
        [...ctx.instructions.sections]
          .sort((a, b) => b.tokens - a.tokens)
          .map((section) => ({ label: section.label, value: section.tokens, text: `≈ ${tokens(section.tokens)}`, detail: section.text }))
      )
    );
    out.push(parts);

    const toolCard = card("Scribe's tools", "The schema of each tool on Scribe's MCP server as this thread gets it, largest first, with how often threads called it in the chosen range.");
    if (tools.error) toolCard.append(empty(`Could not start Scribe's MCP server to list them: ${tools.error}`));
    else {
      const used = new Map((S.stats?.mcp || []).filter((row) => row.server === "scribe").map((row) => [row.tool, row.calls]));
      toolCard.append(
        bars(
          tools.tools.map((tool) => ({
            label: tool.name,
            sub: used.get(tool.name) ? `${count(used.get(tool.name))} calls` : "never called",
            value: tool.tokens,
            text: `≈ ${tokens(tool.tokens)}`,
            tone: used.get(tool.name) ? "" : "quiet",
            tip: tool.description,
          }))
        )
      );
    }
    out.push(toolCard);

    const own = card(`What ${PROVIDER_LABEL[ctx.thread.provider]} loads by itself`, "Not sent by Scribe, but part of every session.");
    const list = el("ul", "hx-list");
    for (const line of ctx.own.loads) list.append(el("li", null, line));
    own.append(list);
    if (ctx.own.files.length) {
      own.append(
        table(
          [
            { label: "Instruction file", get: (r) => el("code", null, r.path) },
            { label: "Tokens", num: true, get: (r) => `≈ ${tokens(r.tokens)}` },
          ],
          ctx.own.files
        )
      );
    }
    out.push(own);
    return out;
  }

  function measureCard() {
    const node = card(
      "Measured by Claude Code",
      "Starts Claude Code twice without sending a message, once set up as Scribe does and once as it runs on its own in the same folder, and asks each for its /context count. It calls no model; it takes a few seconds."
    );
    const m = S.measure;
    const run = button(m?.busy ? "Measuring…" : m?.scribe ? "Measure again" : "Measure", "hx-btn", async () => {
      S.measure = { busy: true };
      render();
      try {
        const payload = { provider: "claude", mode: S.pick.mode, cwd: S.pick.cwd };
        const [scribe, plain] = await Promise.all([api("POST", "/harness/measure", payload), api("POST", "/harness/measure", { ...payload, plain: true })]);
        S.measure = { scribe: scribe.measure, plain: plain.measure };
      } catch (err) {
        S.measure = { error: err.message };
      }
      render();
    });
    run.disabled = Boolean(m?.busy);
    node.append(run);
    if (m?.error) node.append(empty(`Could not measure: ${m.error}`));
    if (!m?.scribe) return node;
    const diff = m.scribe.totalTokens - m.plain.totalTokens;
    node.append(
      tiles([
        ["In Scribe", tokens(m.scribe.totalTokens), `${pct(m.scribe.totalTokens, m.scribe.maxTokens)} of the window`],
        ["Claude Code alone", tokens(m.plain.totalTokens), m.plain.model],
        ["Difference", `${diff >= 0 ? "+" : "−"}${tokens(Math.abs(diff))}`, "Per session, before your first message"],
      ])
    );
    const names = [...new Set([...m.scribe.categories, ...m.plain.categories].map((c) => c.name))];
    const find = (measure, name) => measure.categories.find((c) => c.name === name)?.tokens ?? 0;
    const rows = names.map((name) => ({ name, scribe: find(m.scribe, name), plain: find(m.plain, name) })).filter((row) => row.scribe || row.plain);
    node.append(
      table(
        [
          { label: "Category", get: (r) => r.name },
          { label: "In Scribe", num: true, get: (r) => tokens(r.scribe) },
          { label: "Claude Code alone", num: true, get: (r) => tokens(r.plain) },
          { label: "Difference", num: true, get: (r) => (r.scribe === r.plain ? "–" : `${r.scribe > r.plain ? "+" : "−"}${tokens(Math.abs(r.scribe - r.plain))}`) },
        ],
        rows
      )
    );
    const mcpTools = [...m.scribe.mcpTools].sort((a, b) => b.tokens - a.tokens).slice(0, 15);
    if (mcpTools.length) {
      const loaded = m.scribe.mcpTools.filter((tool) => tool.loaded).length;
      node.append(el("h4", null, `MCP tools in Scribe: ${m.scribe.mcpTools.length}, ${loaded} with their schema loaded at the start`));
      node.append(bars(mcpTools.map((tool) => ({ label: tool.name, sub: tool.loaded ? "" : "by name only", value: tool.tokens, text: tokens(tool.tokens), tone: tool.loaded ? "" : "quiet" }))));
    }
    if (m.scribe.skills.length) {
      node.append(el("h4", null, "Skill descriptions"));
      node.append(bars([...m.scribe.skills].sort((a, b) => b.tokens - a.tokens).map((skill) => ({ label: skill.name, sub: skill.source, value: skill.tokens, text: tokens(skill.tokens) }))));
    }
    return node;
  }

  function renderTools() {
    const stats = S.stats;
    if (!stats) return [empty("Loading…")];
    if (!stats.totals.toolCalls) return [empty(`No tool calls in ${rangeText()}.`)];
    const out = [];
    const kinds = card("Calls by kind of tool");
    kinds.append(
      bars(
        stats.toolKinds.map((row) => ({
          label: KIND_LABEL[row.kind] || row.kind,
          sub: `${pct(row.errors, row.calls)} failed`,
          value: row.calls,
          text: count(row.calls),
        }))
      )
    );
    out.push(kinds);

    const fed = card(
      "What tool results put into the context",
      "The size of the results each kind of tool returned, as stored with the thread and estimated at four characters a token. Every later model call in the turn sends them again, so this is where a turn's cost grows."
    );
    fed.append(
      bars(
        [...stats.toolKinds]
          .sort((a, b) => b.outputTokens - a.outputTokens)
          .map((row) => ({ label: KIND_LABEL[row.kind] || row.kind, sub: `${tokens(row.outputTokens / Math.max(1, row.calls))} a call`, value: row.outputTokens, text: `≈ ${tokens(row.outputTokens)}` }))
      )
    );
    out.push(fed);

    const each = card("By tool and provider", "Each provider names its tools its own way. Commands that a provider names by their text are counted together.");
    each.append(
      table(
        [
          { label: "Tool", get: (r) => r.name },
          { label: "Provider", get: (r) => providerChip(r.provider) },
          { label: "Calls", num: true, get: (r) => count(r.calls) },
          { label: "Failed", num: true, get: (r) => pct(r.errors, r.calls) },
          { label: "Result a call", num: true, get: (r) => `≈ ${tokens(r.outputTokens / Math.max(1, r.calls))}` },
          { label: "Results in all", num: true, get: (r) => `≈ ${tokens(r.outputTokens)}` },
          { label: "Time a call", num: true, get: (r) => duration(r.ms / Math.max(1, r.calls)) },
        ],
        stats.tools
      )
    );
    out.push(each);
    return out;
  }

  function renderMcp() {
    const out = [pickers()];
    const ctx = S.context;
    if (!ctx) return [...out, empty(S.error || "Loading…")];
    const calls = new Map();
    for (const row of S.stats?.mcp || []) {
      const entry = calls.get(row.server) || { calls: 0, errors: 0, tools: [] };
      entry.calls += row.calls;
      entry.errors += row.errors;
      entry.tools.push(row);
      calls.set(row.server, entry);
    }

    const servers = card(`Servers for a ${PROVIDER_LABEL[ctx.thread.provider]} ${MODE_LABEL[ctx.thread.mode]} thread${ctx.thread.cwd ? ` in ${ctx.thread.cwd}` : ""}`, ctx.own.mcpDelivery);
    const edit = button("Edit servers…", "hx-btn", () => {
      harness.close();
      window.scribeChat?.openMcpServers?.();
    });
    servers.append(edit);
    const scribeUse = calls.get("scribe");
    const rows = [
      { name: "scribe", layer: "Built in", target: "Scribe's own page, browser, thread and memory tools", approve: "auto", active: true, builtin: true },
      ...ctx.servers,
    ];
    for (const server of rows) {
      const use = server.builtin ? scribeUse : calls.get(server.name.toLowerCase());
      const box = el("div", `hx-server${server.active ? "" : " off"}`);
      const head = el("div", "hx-server-head");
      const name = el("span", "hx-server-name");
      name.append(el("strong", null, server.name), el("span", `ag-tag${server.active ? " ok" : ""}`, server.active ? "Given to this thread" : server.why || "Not given"));
      head.append(name);
      const meta = [server.layer === "global" ? "Everywhere" : server.layer, server.builtin ? null : server.approve === "auto" ? "runs without asking" : "asks before each call", use ? `${count(use.calls)} calls, ${pct(use.errors, use.calls)} failed` : "no calls in range"].filter(Boolean).join(" · ");
      head.append(el("span", "hx-muted", meta));
      box.append(head, el("code", "hx-target", server.target));
      const key = server.builtin ? "scribe" : `${server.name}\n${ctx.thread.cwd || ""}`;
      const probe = server.builtin ? ctx.scribeTools : S.probes.get(key);
      if (!server.builtin && !probe) {
        box.append(
          button("List its tools", "hx-btn", async (event) => {
            event.currentTarget.disabled = true;
            event.currentTarget.textContent = "Starting the server…";
            try {
              S.probes.set(key, await api("POST", "/harness/mcp/probe", { name: server.name, cwd: ctx.thread.cwd }));
            } catch (err) {
              S.probes.set(key, { tools: [], tokens: 0, error: err.message });
            }
            render();
          })
        );
      }
      if (probe?.error) box.append(empty(`Could not list its tools: ${probe.error}`));
      else if (probe) {
        const usedTools = new Map((use?.tools || []).map((row) => [row.tool, row.calls]));
        const details = el("details", "hx-server-tools");
        details.append(el("summary", null, `${probe.tools.length} tools · schemas ≈ ${tokens(probe.tokens)} tokens · ${probe.tools.filter((tool) => !usedTools.get(tool.name)).length} never called in range`));
        details.append(
          bars(
            probe.tools.map((tool) => ({
              label: tool.name,
              sub: usedTools.get(tool.name) ? `${count(usedTools.get(tool.name))} calls` : "never called",
              value: tool.tokens,
              text: `≈ ${tokens(tool.tokens)}`,
              tone: usedTools.get(tool.name) ? "" : "quiet",
              tip: tool.description,
            }))
          )
        );
        box.append(details);
      }
      servers.append(box);
    }
    out.push(servers);

    if (ctx.leftOut.length || ctx.duplicates.length) {
      const notes = card("Worth a look");
      const list = el("ul", "hx-list");
      if (ctx.leftOut.length) list.append(el("li", null, `In your own Claude Code config but not given to Claude threads here: ${ctx.leftOut.join(", ")}. A skill written for one of them finds its tools missing. Import them with Edit servers.`));
      if (ctx.duplicates.length) list.append(el("li", null, `Your Cursor config also loads Scribe as ${ctx.duplicates.join(", ")}, so a Cursor thread sees every page tool twice and pays for both sets of schemas. Remove it from ~/.cursor/mcp.json.`));
      notes.append(list);
      out.push(notes);
    }

    const all = card("Calls by server and tool", `Across every provider, in ${rangeText()}.`);
    all.append(
      S.stats?.mcp.length
        ? table(
            [
              { label: "Server", get: (r) => r.server },
              { label: "Tool", get: (r) => r.tool },
              { label: "Calls", num: true, get: (r) => count(r.calls) },
              { label: "Failed", num: true, get: (r) => pct(r.errors, r.calls) },
              { label: "Result a call", num: true, get: (r) => `≈ ${tokens(r.outputTokens / Math.max(1, r.calls))}` },
              {
                label: "Providers",
                get: (r) => {
                  const cell = el("span", "hx-chips");
                  for (const provider of PROVIDERS) if (r.providers.includes(provider)) cell.append(providerChip(provider));
                  return cell;
                },
              },
            ],
            S.stats.mcp
          )
        : empty("No MCP calls in this range.")
    );
    out.push(all);
    return out;
  }

  function renderSkills() {
    const out = [pickers()];
    if (!S.skills) return [...out, empty(S.error || "Loading…")];
    const uses = new Map((S.stats?.skills || []).map((row) => [row.name, row.calls]));
    const node = card(
      "Skills each provider finds",
      "Every chat is sent each skill's name and description; the body is read only when the skill is used. Uses are counted from Claude's Skill tool: the other providers read a skill as a plain file, which cannot be told apart from any other read."
    );
    const mine = S.skills.filter((skill) => skill.providers.includes(S.pick.provider) && (S.pick.mode !== "board" || (skill.scope === "user" && S.pick.provider === "claude")));
    node.append(
      tiles([
        [`For ${PROVIDER_LABEL[S.pick.provider]} ${MODE_LABEL[S.pick.mode]} threads`, count(mine.length), `≈ ${tokens(mine.reduce((sum, skill) => sum + skill.indexTokens, 0))} tokens of descriptions in every chat`],
        ["Found in all", count(S.skills.length), S.pick.cwd ? "Your own and this workspace's" : "Your own; pick a workspace for its skills"],
      ])
    );
    node.append(
      S.skills.length
        ? table(
            [
              { label: "Skill", get: (r) => el("strong", null, r.name) },
              {
                label: "Providers",
                get: (r) => {
                  const cell = el("span", "hx-chips");
                  for (const provider of PROVIDERS) if (r.providers.includes(provider)) cell.append(providerChip(provider));
                  return cell;
                },
              },
              { label: "From", get: (r) => (r.scope === "user" ? "You" : "Workspace") },
              { label: "In every chat", num: true, get: (r) => `≈ ${tokens(r.indexTokens)}` },
              { label: "When used", num: true, get: (r) => `≈ ${tokens(r.bodyTokens)}` },
              { label: "Files", num: true, get: (r) => count(r.files + 1) },
              { label: "Uses", num: true, get: (r) => (uses.has(r.name) ? count(uses.get(r.name)) : "–") },
              {
                label: "Description",
                get: (r) => {
                  const cell = el("span", "hx-desc", r.description || "No description");
                  cell.dataset.tooltip = r.file;
                  return cell;
                },
              },
            ],
            S.skills
          )
        : empty("No skills found.")
    );
    out.push(node);
    const known = new Set(S.skills.map((skill) => skill.name));
    const other = (S.stats?.skills || []).filter((row) => !known.has(row.name));
    if (other.length) {
      const extra = card("Used, but not in these folders", "Skills Claude loaded from elsewhere: built into Claude Code, a plugin, or another workspace.");
      extra.append(bars(other.map((row) => ({ label: row.name, value: row.calls, text: count(row.calls) }))));
      out.push(extra);
    }
    return out;
  }

  function renderThreads() {
    const stats = S.stats;
    if (!stats) return [empty("Loading…")];
    const node = card("Threads that sent the most", `In ${rangeText()}. Open one to see where its turns went.`);
    node.append(
      stats.heavy.length
        ? table(
            [
              { label: "Thread", get: (r) => r.title },
              { label: "Provider", get: (r) => providerChip(r.provider) },
              { label: "Model", get: (r) => r.model },
              { label: "Turns", num: true, get: (r) => count(r.turns) },
              { label: "Tool calls", num: true, get: (r) => count(r.toolCalls) },
              { label: "Sent", num: true, get: (r) => tokens(r.prompt) },
              { label: "Written", num: true, get: (r) => tokens(r.output) },
              { label: "Cost", num: true, get: (r) => (r.costUsd ? `$${r.costUsd.toFixed(2)}` : "–") },
            ],
            stats.heavy,
            {
              onRow: (row) => {
                harness.close();
                window.scribeChat?.openThread?.(row.id);
              },
            }
          )
        : empty("No threads in this range.")
    );
    return [node];
  }

  const RENDER = { overview: renderOverview, context: renderContext, tools: renderTools, mcp: renderMcp, skills: renderSkills, threads: renderThreads };
  /** Sections whose numbers depend on the range. */
  const RANGED = new Set(["overview", "tools", "mcp", "threads", "context", "skills"]);

  function render() {
    if (!root || root.hidden) return;
    const section = SECTIONS.find((s) => s.id === S.section) || SECTIONS[0];
    for (const control of nav.querySelectorAll("button")) control.setAttribute("aria-pressed", String(control.dataset.section === section.id));
    heading.textContent = section.label;
    controls.replaceChildren();
    if (RANGED.has(section.id)) {
      controls.append(
        track(RANGES, S.days, (days) => {
          S.days = days;
          localStorage.setItem(LS.days, String(days));
          S.stats = null;
          render();
          void loadStats();
        }, "Range")
      );
    }
    controls.append(button("Refresh", "hx-btn", () => void refresh()));
    const close = button("", "settings-close", () => harness.close());
    close.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    close.setAttribute("aria-label", "Close");
    close.dataset.tooltip = "Close (Esc)";
    controls.append(close);
    const scroll = body.scrollTop;
    body.replaceChildren(...RENDER[section.id]());
    body.scrollTop = scroll;
    root.classList.toggle("loading", S.loading > 0);
  }

  async function load(fn) {
    S.loading += 1;
    S.error = "";
    try {
      await fn();
    } catch (err) {
      S.error = err.message;
    } finally {
      S.loading -= 1;
      render();
    }
  }

  const loadStats = () => load(async () => {
    S.stats = await api("GET", `/harness/stats${S.days ? `?days=${S.days}` : ""}`);
  });

  const loadContext = () => load(async () => {
    const pick = { ...S.pick };
    const [context, skills] = await Promise.all([
      api("POST", "/harness/context", { provider: pick.provider, mode: pick.mode, cwd: pick.cwd, scope: { kind: "global", ref: null } }),
      api("GET", `/harness/skills${pick.cwd ? `?cwd=${encodeURIComponent(pick.cwd)}` : ""}`),
    ]);
    if (pick.provider !== S.pick.provider || pick.mode !== S.pick.mode || pick.cwd !== S.pick.cwd) return;
    S.context = context;
    S.skills = skills.skills;
  });

  async function refresh() {
    S.probes.clear();
    await Promise.all([
      loadStats(),
      load(async () => {
        S.config = await api("GET", "/config");
        if (S.pick.cwd === undefined) S.pick.cwd = null;
      }).then(loadContext),
    ]);
  }

  function mount() {
    root = el("div", "agent-harness");
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Agent harness");
    const side = el("aside", "hx-side");
    side.append(el("h2", "hx-title", "Agent harness"));
    side.append(el("p", "hx-hint", "What your chats are given, and what they do with it."));
    nav = el("nav", "hx-nav");
    nav.setAttribute("aria-label", "Harness sections");
    for (const section of SECTIONS) {
      const control = button(section.label, "hx-nav-link", () => {
        S.section = section.id;
        localStorage.setItem(LS.section, section.id);
        body.scrollTop = 0;
        render();
      });
      control.dataset.section = section.id;
      nav.append(control);
    }
    side.append(nav);
    const settings = button("Agent settings…", "hx-nav-link hx-nav-bottom", () => {
      harness.close();
      window.scribeChat?.openSettings?.();
    });
    side.append(settings);
    const main = el("div", "hx-main");
    const head = el("header", "hx-head");
    heading = el("h2", "hx-heading");
    controls = el("div", "hx-controls");
    head.append(heading, controls);
    body = el("div", "hx-body");
    main.append(head, body);
    root.append(side, main);
    document.body.append(root);
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !harness.isOpen()) return;
        if (document.querySelector("dialog[open]") || window.scribeSettingsUI?.isOpen?.() || document.querySelector(".ag-modal")) return;
        event.preventDefault();
        event.stopPropagation();
        harness.close();
      },
      true
    );
    // A tab picked from the strip shows that page again, as it does over the full-window chat.
    document.addEventListener(
      "click",
      (event) => {
        if (harness.isOpen() && event.target.closest?.(".tabs .tab, #new-tab") && !event.target.closest(".tab-close")) harness.close();
      },
      true
    );
  }

  let returnFocus = null;
  const harness = {
    isOpen: () => Boolean(root && !root.hidden),
    open(section) {
      if (!root) mount();
      if (section && RENDER[section]) S.section = section;
      returnFocus = document.activeElement;
      root.hidden = false;
      document.body.classList.add("agent-harness-open");
      render();
      void refresh();
      nav.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    },
    close() {
      if (!harness.isOpen()) return false;
      root.hidden = true;
      document.body.classList.remove("agent-harness-open");
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      return true;
    },
    toggle() {
      if (harness.isOpen()) harness.close();
      else harness.open();
    },
  };
  window.scribeHarness = harness;
})();
