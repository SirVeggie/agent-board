import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { CONTENT_HOST, HOST, PORT, VERSION, baseUrl, contentBaseUrl } from "./config.js";
import { log } from "./log.js";
import { store } from "./store.js";
import { toMeta, type BoardEvent, type TabMeta } from "./types.js";
import { BOARD_SCROLLBAR_CSS } from "./wrapHtml.js";

const publicDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const startedAt = Date.now();
const sockets = new Set<WebSocket>();

export function viewerCount(): number {
  return sockets.size;
}

export async function startHttp(): Promise<http.Server> {
  store.load();

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
      activeId: store.getActiveId(),
      uptimeMs: Date.now() - startedAt,
    });
  });

  app.get("/api/tabs", (_req, res) => {
    res.json({ tabs: store.list(), activeId: store.getActiveId() });
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
      const { tab, created } = store.upsert({
        key: optionalString(req.body?.key),
        title: String(req.body?.title ?? ""),
        html: String(req.body?.html ?? ""),
        activate: req.body?.activate,
        pin: req.body?.pin,
      });
      res.status(created ? 201 : 200).json({ created, tab: toMeta(tab) });
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

  app.post("/api/tabs/:id/focus", (req, res) => {
    try {
      const tab = store.focus(req.params.id);
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
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

  app.delete("/api/tabs/:id", (req, res) => {
    try {
      const tab = store.close(req.params.id);
      res.json({ closed: [tab.id] });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/tabs", (req, res) => {
    const filter = req.query.filter === "all" ? "all" : "unpinned";
    const closed = store.closeMany(filter);
    res.json({ closed });
  });

  app.get("/view/:id", (req, res) => {
    const tab = store.get(req.params.id);
    if (!tab) {
      res.status(404).type("html").send("<!DOCTYPE html><title>Missing</title><p>Tab not found.</p>");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(injectBoardKeys(tab.html));
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
    setTimeout(() => process.exit(0), 50);
  });

  const server = http.createServer(app);
  const contentServer = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    sockets.add(socket);
    send(socket, { type: "snapshot", ...store.snapshot() });
    socket.on("close", () => sockets.delete(socket));
  });

  store.on("tab_upserted", (tab: TabMeta, index?: number) =>
    broadcast({ type: "tab_upserted", tab, index })
  );
  store.on("tab_closed", (id: string) => broadcast({ type: "tab_closed", id }));
  store.on("tab_focused", (id: string | null) => broadcast({ type: "tab_focused", id }));

  await listen(server, PORT, HOST);
  await listen(contentServer, PORT, CONTENT_HOST);

  log(`Agent Board listening on ${baseUrl()} (tab pages on ${contentBaseUrl()})`);
  return server;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isContentHost(req: express.Request): boolean {
  return req.hostname === CONTENT_HOST;
}

function contentOriginGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (isContentHost(req)) {
    if (req.method === "GET" && /^\/view\/[^/]+$/.test(req.path)) {
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
    }
  }, true);
})();
</script>`;

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

function safeFilename(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*]+/g, " ").trim().replace(/\s+/g, "-");
  return (cleaned || "page").slice(0, 80);
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
