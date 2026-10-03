/*
 * File preview: one overlay for images, PDFs, media, text, code, Markdown, CSV and HTML, used by the
 * agent chat for attachments and by pages through scribe.preview. Files are { url, name, mimeType, size };
 * url is anything the shell can load (a blob: URL or a same-origin path).
 */
(() => {
  const TEXT_EXT = new Set(
    (
      "txt md markdown mdx rst log csv tsv json jsonl ndjson yaml yml toml ini cfg conf env xml html htm css scss less svg js mjs cjs jsx ts tsx " +
      "py rb go rs java kt kts swift c h cc cpp hpp cs fs php pl lua r sql sh bash zsh ps1 psm1 bat cmd gradle vue svelte dart scala clj ex exs erl " +
      "hs ml tex diff patch graphql gql proto dockerfile gitignore editorconfig"
    ).split(" ")
  );
  /** Text past this is cut off in the preview, so a huge log does not freeze the window. */
  const MAX_TEXT = 2 * 1024 * 1024;
  const MAX_TABLE_ROWS = 2000;

  function ext(name) {
    const base = String(name || "").toLowerCase();
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(dot + 1) : base;
  }

  /** How a file is shown: image, pdf, video, audio, markdown, csv, html, json, text, or none. */
  function kindOf(name, mimeType) {
    const mime = String(mimeType || "").toLowerCase();
    const e = ext(name);
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf" || e === "pdf") return "pdf";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (e === "md" || e === "markdown" || e === "mdx" || mime === "text/markdown") return "markdown";
    if (e === "csv" || e === "tsv" || mime === "text/csv" || mime === "text/tab-separated-values") return "csv";
    if (e === "html" || e === "htm" || mime === "text/html") return "html";
    if (e === "json" || mime === "application/json") return "json";
    if (mime.startsWith("text/") || /^application\/(.*\+)?(json|xml|javascript|typescript|yaml|toml|sql)$/.test(mime) || TEXT_EXT.has(e)) return "text";
    return "none";
  }

  function sizeLabel(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function iconButton(svg, title, onClick) {
    const b = el("button", "pv-btn");
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = svg;
    b.addEventListener("click", onClick);
    return b;
  }

  const SVG = {
    close: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    download:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2.5v8M4.5 7.2L8 10.7l3.5-3.5M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    prev: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.5 3l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5.5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  /** Split CSV/TSV text into rows, with quoted fields. */
  function parseDelimited(text, sep) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"' && !field) quoted = true;
      else if (c === sep) {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        if (rows.length > MAX_TABLE_ROWS) break;
      } else field += c;
    }
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  let current = null;

  async function readText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status === 404 ? "This file is no longer available." : `Could not load the file (${res.status}).`);
    const text = await res.text();
    return text.length > MAX_TEXT ? { text: text.slice(0, MAX_TEXT), cut: true } : { text, cut: false };
  }

  function message(text) {
    return el("div", "pv-empty", text);
  }

  /** Two views (rendered and source) behind a small switch in the header. */
  function withSource(body, tools, renderView, text) {
    let source = false;
    const toggle = el("button", "pv-btn pv-text-btn", "Source");
    toggle.type = "button";
    toggle.title = "Show the source";
    const draw = () => {
      body.replaceChildren(source ? el("pre", "pv-text", text) : renderView());
      toggle.textContent = source ? "Preview" : "Source";
      toggle.title = source ? "Show the preview" : "Show the source";
    };
    toggle.addEventListener("click", () => {
      source = !source;
      draw();
    });
    tools.prepend(toggle);
    draw();
  }

  async function renderBody(file, body, tools) {
    const kind = kindOf(file.name, file.mimeType);
    body.dataset.kind = kind;
    switch (kind) {
      case "image": {
        const img = el("img", "pv-img");
        img.alt = file.name;
        img.src = file.url;
        img.addEventListener("error", () => body.replaceChildren(message("This image could not be shown.")));
        body.append(img);
        return;
      }
      case "pdf": {
        const frame = el("iframe", "pv-frame");
        frame.title = file.name;
        frame.src = file.url;
        body.append(frame);
        return;
      }
      case "video":
      case "audio": {
        const media = el(kind, `pv-${kind}`);
        media.controls = true;
        media.src = file.url;
        body.append(media);
        return;
      }
      case "none":
        body.append(message(`No preview for ${ext(file.name) ? `.${ext(file.name)} files` : "this file"}. Download it to open it in another app.`));
        return;
    }
    body.append(message("Loading…"));
    let loaded;
    try {
      loaded = await readText(file.url);
    } catch (err) {
      body.replaceChildren(message(err.message));
      return;
    }
    if (current?.body !== body) return;
    const { text, cut } = loaded;
    body.replaceChildren();
    if (kind === "markdown") {
      withSource(body, tools, () => {
        const md = el("div", "pv-md ag-md");
        if (window.AgentRender?.renderMarkdown) window.AgentRender.renderMarkdown(md, text);
        else md.textContent = text;
        return md;
      }, text);
    } else if (kind === "csv") {
      withSource(body, tools, () => {
        const rows = parseDelimited(text, ext(file.name) === "tsv" || /tab-separated/.test(file.mimeType || "") ? "\t" : ",");
        const wrap = el("div", "pv-table-wrap");
        const table = el("table", "pv-table");
        rows.slice(0, MAX_TABLE_ROWS).forEach((cells, index) => {
          const tr = el("tr");
          for (const cell of cells) tr.append(el(index ? "td" : "th", null, cell));
          table.append(tr);
        });
        wrap.append(table);
        if (rows.length > MAX_TABLE_ROWS) wrap.append(el("div", "pv-note", `Showing the first ${MAX_TABLE_ROWS} rows.`));
        return wrap;
      }, text);
    } else if (kind === "html") {
      withSource(body, tools, () => {
        // No scripts and no same-origin access: a sent page is only looked at, never run.
        const frame = el("iframe", "pv-frame pv-html");
        frame.title = file.name;
        frame.setAttribute("sandbox", "");
        frame.srcdoc = text;
        return frame;
      }, text);
    } else if (kind === "json") {
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not valid JSON: show it as it is */
      }
      body.append(el("pre", "pv-text", pretty));
    } else {
      body.append(el("pre", "pv-text", text));
    }
    if (cut) body.append(el("div", "pv-note", "The file is long; only the start is shown."));
  }

  function show(index) {
    if (!current) return;
    const { files, root } = current;
    current.index = index;
    const file = files[index];
    const panel = el("div", "pv-panel");
    const head = el("div", "pv-head");
    const title = el("div", "pv-title");
    title.append(el("span", "pv-name", file.name || "File"));
    const meta = [sizeLabel(file.size), files.length > 1 ? `${index + 1} of ${files.length}` : ""].filter(Boolean).join(" · ");
    if (meta) title.append(el("span", "pv-meta", meta));
    const tools = el("div", "pv-tools");
    if (files.length > 1) {
      tools.append(iconButton(SVG.prev, "Previous (←)", () => step(-1)), iconButton(SVG.next, "Next (→)", () => step(1)));
    }
    const download = el("a", "pv-btn");
    download.href = file.url;
    download.download = file.name || "file";
    download.title = "Download";
    download.setAttribute("aria-label", "Download");
    download.innerHTML = SVG.download;
    const closeBtn = iconButton(SVG.close, "Close (Esc)", close);
    tools.append(download, closeBtn);
    head.append(title, tools);
    const body = el("div", "pv-body");
    panel.append(head, body);
    root.querySelector(".pv-panel")?.remove();
    root.append(panel);
    current.body = body;
    renderBody(file, body, tools);
    closeBtn.focus({ preventScroll: true });
  }

  function step(delta) {
    if (!current || current.files.length < 2) return;
    const n = current.files.length;
    show((current.index + delta + n) % n);
  }

  function onKey(event) {
    if (!current) return;
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft" && !event.target.closest?.("input, textarea")) step(-1);
    else if (event.key === "ArrowRight" && !event.target.closest?.("input, textarea")) step(1);
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /** Show files[index] (files may be one file). onClose runs once the preview is closed, e.g. to revoke blob URLs. */
  function open(files, index = 0, opts = {}) {
    const list = (Array.isArray(files) ? files : [files]).filter((f) => f && f.url);
    if (!list.length) return false;
    close();
    const root = el("div", "pv");
    const backdrop = el("div", "pv-backdrop");
    backdrop.addEventListener("mousedown", (event) => {
      event.preventDefault();
      close();
    });
    root.append(backdrop);
    document.body.append(root);
    current = { files: list, index: 0, root, body: null, onClose: opts.onClose, returnFocus: document.activeElement };
    window.addEventListener("keydown", onKey, true);
    show(Math.max(0, Math.min(list.length - 1, index)));
    return true;
  }

  function close() {
    if (!current) return false;
    const { root, onClose, returnFocus } = current;
    current = null;
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    try {
      onClose?.();
    } catch {
      /* the caller's cleanup */
    }
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus?.({ preventScroll: true });
    return true;
  }

  window.scribePreview = { open, close, isOpen: () => Boolean(current), kindOf, sizeLabel };
})();
