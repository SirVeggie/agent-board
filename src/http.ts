import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { isSafeAssetName, parseAssetInputs, prepareAssets, readStoredAsset, rewriteAssetRefs } from "./assets.js";
import { CONTENT_HOST, HOST, MAX_WAIT_MS, PORT, VERSION, baseUrl, contentBaseUrl } from "./config.js";
import { BOARD_BRIDGE_JS, BOARD_STALE_CSS } from "./bridge.js";
import { parseHtmlEdits } from "./htmlEdit.js";
import { log } from "./log.js";
import { clampWaitMs, parseAfterRevision, parseSignalNames, toSignalView } from "./signal.js";
import { locationLabel, qualityLabel } from "./pageSearch.js";
import { store } from "./store.js";
import { isAppTab, isPlainObject, toMeta, type BoardEvent, type Tab, type TabMeta, type UpsertNotice } from "./types.js";
import { ViewerHub } from "./viewers.js";
import { captureTab, closeScreenshotBrowser, screenshotHttpStatus } from "./screenshot.js";
import { waitForSignal } from "./wait.js";
import { BOARD_SCROLLBAR_CSS } from "./wrapHtml.js";

const publicDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const startedAt = Date.now();
const sockets = new Set<WebSocket>();
const viewers = new ViewerHub();

export function viewerCount(): number {
  return viewers.count();
}

export async function startHttp(): Promise<http.Server> {
  store.load();
  const flush = () => {
    try {
      store.closeDb();
    } catch {
      /* already logged */
    }
  };
  process.once("SIGINT", () => {
    flush();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    flush();
    process.exit(0);
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(contentOriginGate);
  app.use(noStoreShell);
  app.use(express.json({ limit: "3mb" }));
  app.use(express.static(publicDir));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      url: baseUrl(),
      viewers: viewerCount(),
      tabs: store.list().length,
      archiveCount: store.archiveCount(),
      activeId: store.getActiveId(),
      uptimeMs: Date.now() - startedAt,
    });
  });

  app.get("/api/tabs", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
    if (query) {
      const result = store.searchOpen(query);
      res.json({
        tabs: result.hits.map((hit) => ({ ...toMeta(hit.tab), snippet: hit.snippet })),
        returned: result.returned,
        remaining: result.remaining,
        matchCount: result.matchCount,
        openCount: result.archiveCount,
        activeId: store.getActiveId(),
        archiveCount: store.archiveCount(),
      });
      return;
    }
    res.json({ tabs: store.list(), activeId: store.getActiveId(), archiveCount: store.archiveCount() });
  });

  app.get("/api/archive", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const offset = optionalNumber(req.query.offset) ?? 0;
    const limit = optionalNumber(req.query.limit) ?? 200;
    const result = store.searchArchive(query, offset, limit);
    res.json({
      tabs: result.hits.map((hit) => ({ ...toMeta(hit.tab), snippet: hit.snippet })),
      returned: result.returned,
      remaining: result.remaining,
      matchCount: result.matchCount,
      archiveCount: result.archiveCount,
    });
  });

  app.get("/api/search", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const limit = optionalNumber(req.query.limit);
    const result = store.searchPages(query, limit);
    res.json({
      tabs: result.hits.map((hit) => ({
        ...toMeta(hit.tab),
        archived: hit.archived,
        location: hit.location,
        quality: hit.quality,
        locationLabel: hit.location ? locationLabel(hit.location) : null,
        qualityLabel: hit.quality ? qualityLabel(hit.quality, hit.matchedParts, hit.totalParts) : null,
        matchedParts: hit.matchedParts,
        totalParts: hit.totalParts,
        snippet: hit.snippet,
      })),
      returned: result.returned,
      matchCount: result.matchCount,
    });
  });

  app.get("/api/tabs/:id", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).json({ error: `tab not found: ${req.params.id}` });
      return;
    }
    res.json(tab);
  });

  app.post("/api/tabs", (req, res) => {
    try {
      const assets = prepareAssets(parseAssetInputs(req.body?.assets));
      const { tab, created, archived } = store.upsert({
        key: optionalString(req.body?.key),
        title: String(req.body?.title ?? ""),
        html: String(req.body?.html ?? ""),
        activate: req.body?.activate,
        pin: req.body?.pin,
        state: isPlainObject(req.body?.state) ? req.body.state : undefined,
        assets: assets.length ? assets : undefined,
      });
      res.status(created ? 201 : 200).json({ created, archived, tab: toMeta(tab) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch("/api/tabs/:id", (req, res) => {
    try {
      const tab = store.update(req.params.id, {
        title: optionalString(req.body?.title),
        html: optionalString(req.body?.html),
        pin: typeof req.body?.pin === "boolean" ? req.body.pin : undefined,
        activate: req.body?.activate,
      });
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/patch", (req, res) => {
    try {
      const edits = parseHtmlEdits(req.body?.edits);
      const { tab, applied, archived } = store.patchHtml(req.params.id, {
        edits,
        title: optionalString(req.body?.title),
        activate: req.body?.activate,
      });
      res.json({ applied, archived, tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.get("/api/tabs/:id/state", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).json({ error: `tab not found: ${req.params.id}` });
      return;
    }
    res.json({
      id: tab.id,
      key: tab.key,
      state: tab.state,
      stateRevision: tab.stateRevision,
      stateUpdatedAt: tab.stateUpdatedAt,
      signal: toSignalView(tab.signal),
      signalRevision: tab.signalRevision,
    });
  });

  app.post("/api/tabs/:id/signal", (req, res) => {
    try {
      const tab = store.signal(req.params.id, {
        name: String(req.body?.name ?? ""),
        state: isPlainObject(req.body?.state) ? req.body.state : undefined,
        client: optionalString(req.body?.client),
      });
        res.json({
          signal: toSignalView(tab.signal),
          state: tab.state,
          stateRevision: tab.stateRevision,
        });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/wait", (req, res) => {
    handleWait(req, res, req.body?.signal ?? req.body?.signals, req.body?.afterSignalRevision, req.body?.timeoutMs);
  });

  app.get("/api/tabs/:id/wait", (req, res) => {
    handleWait(
      req,
      res,
      req.query.signal ?? req.query.signals,
      req.query.afterSignalRevision ?? req.query.after,
      req.query.timeoutMs
    );
  });

  app.put("/api/tabs/:id/state", (req, res) => {
    try {
      const result = store.setState(req.params.id, {
        state: req.body?.state,
        replace: req.body?.replace === true,
        expectedRevision:
          typeof req.body?.expectedRevision === "number" ? req.body.expectedRevision : undefined,
        client: optionalString(req.body?.client),
      });
      if (!result.ok) {
        res.status(409).json({
          error: "stale expectedRevision",
          conflict: true,
          state: result.state,
          stateRevision: result.stateRevision,
        });
        return;
      }
      res.json({ state: result.tab.state, stateRevision: result.tab.stateRevision });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/focus", (req, res) => {
    try {
      const tab = store.focus(req.params.id);
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/tabs/:id/screenshot", (req, res) => {
    captureTab({
      idOrKey: req.params.id,
      selector: optionalString(req.body?.selector),
      fullPage: req.body?.fullPage === true,
      width: optionalNumber(req.body?.width),
      height: optionalNumber(req.body?.height),
    })
      .then((shot) => {
        if (!res.writableEnded) {
          res.json(shot);
        }
      })
      .catch((err: Error) => {
        if (res.writableEnded) {
          return;
        }
        res.status(screenshotHttpStatus(err.message)).json({ error: err.message });
      });
  });

  app.post("/api/undo", (_req, res) => {
    try {
      const tab = store.restoreLast();
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message === "nothing to restore" ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/restore", (req, res) => {
    try {
      const tab = store.restore(req.params.id, { placement: "append", activate: true });
      res.json({ tab: toMeta(tab), archiveCount: store.archiveCount() });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/archive", (_req, res) => {
    const deleted = store.emptyArchive();
    res.json({ deleted, archiveCount: 0 });
  });

  app.delete("/api/tabs/:id", (req, res) => {
    try {
      const permanent = req.query.permanent === "true" || req.query.permanent === "1";
      if (permanent) {
        const tab = store.deletePermanent(req.params.id);
        res.json({ deleted: [tab.id], archiveCount: store.archiveCount() });
        return;
      }
      const existing = store.get(req.params.id);
      if (store.isArchived(req.params.id) && existing && !isAppTab(existing)) {
        res.status(400).json({
          error: "tab is archived; restore it or pass permanent=true to delete",
        });
        return;
      }
      const tab = store.archiveTab(req.params.id);
      if (store.isArchived(tab.id)) {
        res.json({ archived: [tab.id], archiveCount: store.archiveCount() });
        return;
      }
      res.json({ deleted: [tab.id], archiveCount: store.archiveCount() });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/tabs", (req, res) => {
    const permanent = req.query.permanent === "true" || req.query.permanent === "1";
    const filter = req.query.filter === "all" ? "all" : "unpinned";
    if (permanent) {
      const ids = store.list().filter((tab) => filter === "all" || !tab.pinned).map((tab) => tab.id);
      const deleted: string[] = [];
      for (const id of ids) {
        deleted.push(store.deletePermanent(id).id);
      }
      res.json({ deleted, archiveCount: store.archiveCount() });
      return;
    }
    const archived = store.archiveMany(filter);
    res.json({ archived, archiveCount: store.archiveCount() });
  });

  app.get("/view/:id/asset/:name", (req, res) => {
    const tab = store.get(req.params.id);
    const name = req.params.name;
    const meta = tab?.assets.find((asset) => asset.name === name);
    const file = tab && meta && isSafeAssetName(name) ? readStoredAsset(tab.id, name) : undefined;
    if (!tab || !meta || !file) {
      res.status(404).type("text").send("asset not found");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.type(meta.mimeType).send(file);
  });

  app.get("/view/:id", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).type("html").send("<!DOCTYPE html><title>Missing</title><p>Tab not found.</p>");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(injectBoardRuntime(tab));
  });

  app.get("/download/:id", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).json({ error: `tab not found: ${req.params.id}` });
      return;
    }
    const filename = `${safeFilename(tab.title)}.html`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.type("html").send(tab.html);
  });

  app.post("/api/shutdown", (_req, res) => {
    res.json({ ok: true });
    try {
      store.closeDb();
    } catch {
      /* already logged */
    }
    void closeScreenshotBrowser().finally(() => process.exit(0));
  });

  const server = http.createServer(app);
  const contentServer = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    sockets.add(socket);
    viewers.add(socket);
    send(socket, { type: "snapshot", ...store.snapshot() });
    socket.on("message", (raw) => {
      let msg: { type?: string; selectedId?: string | null; lastInteractedAt?: unknown; lastEditAt?: unknown };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg?.type !== "viewer_state") {
        return;
      }
      viewers.update(socket, {
        selectedId: msg.selectedId,
        lastInteractedAt: msg.lastInteractedAt,
        lastEditAt: msg.lastEditAt,
      });
    });
    socket.on("close", () => {
      sockets.delete(socket);
      viewers.remove(socket);
    });
  });

  store.on("tab_upserted", (tab: TabMeta, index?: number, notice?: UpsertNotice) => {
    broadcast({ type: "tab_upserted", tab, index });
    if (notice?.activate && notice.structural) {
      requestAgentFocus(tab.id);
    }
  });
  store.on("tab_closed", (id: string) => broadcast({ type: "tab_closed", id }));
  store.on("archive_cleared", () => broadcast({ type: "archive_cleared" }));
  store.on("tab_state", (tab: Tab, client?: string) =>
    broadcast({
      type: "tab_state",
      id: tab.id,
      state: tab.state,
      stateRevision: tab.stateRevision,
      client,
    })
  );
  store.on("tab_signal", (tab: Tab) => {
    if (tab.signal) {
      broadcast({ type: "tab_signal", id: tab.id, signal: tab.signal });
    }
  });

  server.requestTimeout = MAX_WAIT_MS + 30_000;
  contentServer.requestTimeout = MAX_WAIT_MS + 30_000;

  await listen(server, PORT, HOST);
  await listen(contentServer, PORT, CONTENT_HOST);

  log(`Agent Board listening on ${baseUrl()} (tab pages on ${contentBaseUrl()})`);
  return server;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function handleWait(
  req: express.Request,
  res: express.Response,
  signalInput: unknown,
  afterInput: unknown,
  timeoutInput: unknown
): void {
  let names: string[];
  try {
    names = parseSignalNames(signalInput);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const timeoutMs = clampWaitMs(typeof timeoutInput === "string" ? Number(timeoutInput) : timeoutInput);
  req.setTimeout(timeoutMs + 10_000);
  res.setTimeout(timeoutMs + 10_000);

  const abort = new AbortController();
  const onClientGone = () => {
    if (!res.writableEnded) {
      abort.abort();
    }
  };
  res.on("close", onClientGone);

  waitForSignal({
    idOrKey: req.params.id,
    names,
    afterRevision: parseAfterRevision(typeof afterInput === "string" ? Number(afterInput) : afterInput),
    timeoutMs,
    abort: abort.signal,
  })
    .then((result) => {
      if (!res.writableEnded) {
        res.json({
          ...result,
          signal: toSignalView(result.signal),
        });
      }
    })
    .catch((err: Error) => {
      if (res.writableEnded) {
        return;
      }
      res.status(err.message.startsWith("tab not found") ? 404 : 400).json({ error: err.message });
    })
    .finally(() => {
      res.off("close", onClientGone);
    });
}

function isContentHost(req: express.Request): boolean {
  return req.hostname === CONTENT_HOST;
}

const STATE_PATH = /^\/api\/tabs\/[^/]+\/state$/;
const SIGNAL_PATH = /^\/api\/tabs\/[^/]+\/signal$/;

function contentOriginGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (isContentHost(req)) {
    if (req.method === "GET" && /^\/view\/[^/]+$/.test(req.path)) {
      next();
      return;
    }
    if (req.method === "GET" && /^\/view\/[^/]+\/asset\/[^/]+$/.test(req.path)) {
      next();
      return;
    }
    if ((req.method === "GET" || req.method === "PUT") && STATE_PATH.test(req.path)) {
      next();
      return;
    }
    if (req.method === "POST" && SIGNAL_PATH.test(req.path)) {
      next();
      return;
    }
    if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
      res.redirect(302, `${baseUrl()}/`);
      return;
    }
    res.status(403).json({ error: "This origin only serves tab pages" });
    return;
  }
  if (req.path === "/view" || req.path.startsWith("/view/")) {
    res.status(404).type("text").send("Tab pages are served from the content origin.");
    return;
  }
  next();
}

function noStoreShell(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.path === "/" || req.path === "/index.html" || req.path === "/app.js" || req.path === "/app.css") {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const BOARD_CHROME_INJECT = `<style data-agent-board-scroll>${BOARD_SCROLLBAR_CSS}</style>
<script data-agent-board-keys>
(function () {
  function typing(el) {
    if (!el || el === document.body) return false;
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return Boolean(el.isContentEditable);
  }
  window.addEventListener("keydown", function (event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    var key = event.key.toLowerCase();
    if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "agent-board-download" }, "*");
      return;
    }
    if (key === "h" && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "agent-board-help" }, "*");
      return;
    }
    if (key === "z" && !event.shiftKey && !typing(event.target)) {
      event.preventDefault();
      parent.postMessage({ type: "agent-board-undo" }, "*");
      return;
    }
    if (key === "d" && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "agent-board-palette" }, "*");
    }
  }, true);
})();
</script>`;

function injectBoardRuntime(tab: Tab): string {
  const html = injectBoardKeys(rewriteAssetRefs(tab.html, tab.id));
  if (html.includes("data-agent-board-bridge")) {
    return html;
  }
  const boot = jsonForScript({ id: tab.id, state: tab.state, stateRevision: tab.stateRevision });
  const snippet = `<style data-agent-board-bridge>${BOARD_STALE_CSS}</style>
<script>window.__BOARD_BOOT__=${boot};
${BOARD_BRIDGE_JS}
</script>`;
  return injectIntoHead(html, snippet);
}

function injectBoardKeys(html: string): string {
  if (html.includes("data-agent-board-keys")) {
    return html;
  }
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) {
    return html + BOARD_CHROME_INJECT;
  }
  return html.slice(0, idx) + BOARD_CHROME_INJECT + html.slice(idx);
}

/** The bridge has to exist before any page script runs, so it goes as early as the document allows. */
function injectIntoHead(html: string, snippet: string): string {
  const opening = /<head[^>]*>/i.exec(html) || /<body[^>]*>/i.exec(html);
  if (!opening) {
    return snippet + html;
  }
  const at = opening.index + opening[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function safeFilename(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*]+/g, " ").trim().replace(/\s+/g, "-");
  return (cleaned || "page").slice(0, 80);
}

function requestAgentFocus(tabId: string): void {
  const target = viewers.focusTarget(tabId);
  if (!target || target === "already-visible") {
    return;
  }
  send(target.socket, { type: "tab_focus_request", id: tabId });
}

function send(socket: WebSocket, event: BoardEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function broadcast(event: BoardEvent): void {
  for (const socket of sockets) {
    send(socket, event);
  }
}
