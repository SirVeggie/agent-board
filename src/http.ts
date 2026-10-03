import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { isSafeAssetName, parseAssetInputs, prepareAssets, readStoredAsset, rewriteAssetRefs } from "./assets.js";
import { exportAllFilename, exportFilename, parseImport } from "./boardExport.js";
import { guideSent, markGuideSent } from "./guideMemory.js";
import { AGENT_CLIENT, AGENT_LABEL_HEADER, CLIENT_HEADER, CONTENT_HOST, SESSION_HEADER, THREAD_HEADER, HOST, MAX_IMPORT_BYTES, MAX_PAGE_ASSET_BYTES, PORT, REQUEST_TIMEOUT_MS, VERSION, baseUrl, contentBaseUrl } from "./config.js";
import { skipInlinePageImage } from "./mcpImages.js";
import { pageAssetUrl, type PageAssetMeta, type PageAssetUsage } from "./pageAssets.js";
import { BOARD_BRIDGE_JS, BOARD_STALE_CSS } from "./bridge.js";
import { checkFramable } from "./frameCheck.js";
import { parseHtmlEdits, RevisionConflictError } from "./htmlEdit.js";
import { log } from "./log.js";
import { checkPermission, isPermissionValue, permissionViews } from "./pagePermissions.js";
import { clampWaitMs, parseCursor, parseEventNames, parseWhere } from "./signal.js";
import type { StateOp } from "./stateOps.js";
import { locationLabel, qualityLabel } from "./pageSearch.js";
import { store, type CleanupBasis, type CleanupOptions, type FolderDeleteMode } from "./store.js";
import { isPlainObject, toMeta, type BoardEvent, type BuiltinTemplateMeta, type Folder, type ImportDestination, type PageEvent, type Tab, type TabMeta, type Template, type TemplateMeta, type UpsertNotice, type Viewer } from "./types.js";
import { ViewerHub } from "./viewers.js";
import { captureTab, closeScreenshotBrowser, screenshotHttpStatus } from "./screenshot.js";
import { waitForEvents } from "./wait.js";
import type { ActionCaller } from "./actions/index.js";
import { AgentHost } from "./agent/host.js";
import { agentRouter } from "./agent/routes.js";
import { BOARD_SCROLLBAR_CSS } from "./wrapHtml.js";

const publicDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const startedAt = Date.now();
const sockets = new Set<WebSocket>();
const viewers = new ViewerHub();
let agentHost: AgentHost | null = null;

export function viewerCount(): number {
  return viewers.count();
}

export async function startHttp(): Promise<http.Server> {
  store.load();
  const flush = () => {
    try {
      agentHost?.dispose();
    } catch {
      /* ignore */
    }
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
  agentHost = new AgentHost((event) => {
    broadcast(event);
    // A turn that ends may leave a claimed card behind; check soon rather than at the next tick.
    if (event.type === "agent_turn" && event.turn.status !== "running") {
      scheduleSweep(2000);
    }
  });
  const sweepTimer = setInterval(() => scheduleSweep(0), 60_000);
  sweepTimer.unref?.();
  scheduleSweep(5000);
  app.use("/api/agent", agentRouter(agentHost));
  app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(publicDir, "..", "node_modules", "marked", "lib", "marked.umd.js")));
  app.get("/vendor/purify.js", (_req, res) => res.sendFile(path.join(publicDir, "..", "node_modules", "dompurify", "dist", "purify.min.js")));
  app.use(express.json({ limit: "6mb" }));
  app.use(noteAgentSession);
  app.use(express.static(publicDir));

  app.param("id", (req, res, next, id: string) => {
    if (!req.path.startsWith("/api/templates/") && store.get(id) && !store.get(id, viewerOf(req))) {
      res.status(404).json({ error: `tab not found: ${id}` });
      return;
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      url: baseUrl(),
      viewers: viewerCount(),
      tabs: store.list().length,
      closedCount: store.closedCount(),
      activeId: store.getActiveId(),
      uptimeMs: Date.now() - startedAt,
    });
  });

  /** Whether an external link can be shown in a peek or split, or needs the browser. */
  app.get("/api/frame-check", (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    checkFramable(url)
      .then((result) => res.json(result))
      .catch((err: Error) => res.json({ framable: null, reason: err.message }));
  });

  app.get("/api/tabs", (req, res) => {
    const viewer = viewerOf(req);
    const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
    if (query) {
      const result = store.searchOpen(query, viewer);
      res.json({
        tabs: result.hits.map((hit) => ({ ...libraryMeta(hit.tab), snippet: hit.snippet })),
        returned: result.returned,
        remaining: result.remaining,
        matchCount: result.matchCount,
        openCount: result.total,
        activeId: store.getActiveId(viewer),
        closedCount: store.closedCount(viewer),
      });
      return;
    }
    res.json({
      tabs: store.listOpenTabs(viewer).map(libraryMeta),
      activeId: store.getActiveId(viewer),
      closedCount: store.closedCount(viewer),
    });
  });

  app.get("/api/library", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const offset = optionalNumber(req.query.offset) ?? 0;
    const limit = optionalNumber(req.query.limit) ?? 200;
    const folderPath = typeof req.query.folder === "string" ? req.query.folder.trim() : "";
    let folderId: string | null | undefined;
    if (folderPath) {
      folderId = folderPath === "/" ? null : store.findFolderPath(folderPath);
      if (folderId === undefined) {
        res.status(404).json({ error: `folder not found: ${folderPath}` });
        return;
      }
    }
    const result = store.searchLibrary(query, { offset, limit, folderId, viewer: viewerOf(req) });
    res.json({
      tabs: result.hits.map((hit) => ({ ...libraryMeta(hit.tab), snippet: hit.snippet })),
      returned: result.returned,
      remaining: result.remaining,
      matchCount: result.matchCount,
      total: result.total,
    });
  });

  app.get("/api/search", (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    const limit = optionalNumber(req.query.limit);
    const result = store.searchPages(query, limit, viewerOf(req));
    res.json({
      tabs: result.hits.map((hit) => ({
        ...libraryMeta(hit.tab),
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
    const usage = store.pageAssetUsageOf(tab.id);
    res.json({ ...tab, folder: store.folderPath(tab.folderId), ...(usage.count ? { pageAssets: usage } : {}) });
  });

  app.post("/api/tabs", (req, res) => {
    try {
      const assets = prepareAssets(parseAssetInputs(req.body?.assets));
      const { tab, created, closed, titleKept } = store.upsert({
        key: optionalString(req.body?.key),
        title: String(req.body?.title ?? ""),
        html: String(req.body?.html ?? ""),
        activate: req.body?.activate,
        pin: req.body?.pin,
        state: isPlainObject(req.body?.state) ? req.body.state : undefined,
        assets: assets.length ? assets : undefined,
        folder: optionalString(req.body?.folder),
        viewer: viewerOf(req),
      });
      if (!created) {
        agentRewrote(req, tab.id);
      }
      res.status(created ? 201 : 200).json({ created, closed, titleKept, tab: libraryMeta(tab) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.patch("/api/tabs/:id", (req, res) => {
    try {
      const { tab, titleKept } = store.update(req.params.id, {
        title: optionalString(req.body?.title),
        html: optionalString(req.body?.html),
        pin: typeof req.body?.pin === "boolean" ? req.body.pin : undefined,
        activate: req.body?.activate,
        viewer: viewerOf(req),
      });
      if (optionalString(req.body?.html) !== undefined) {
        agentRewrote(req, tab.id);
      }
      res.json({ titleKept, tab: libraryMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/rename", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the board UI can rename a page this way" });
      return;
    }
    try {
      const tab = store.renamePage(req.params.id, String(req.body?.title ?? ""));
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/move", (req, res) => {
    try {
      const folderId = parseFolderRef(req.body?.folderId);
      const index = optionalNumber(req.body?.index) ?? 0;
      const tab = store.movePage(req.params.id, folderId, index, { close: req.body?.close === true });
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/tabs/:id/patch", (req, res) => {
    try {
      const title = optionalString(req.body?.title);
      const html = typeof req.body?.html === "string" ? req.body.html : undefined;
      const rawRevision = req.body?.expectedRevision;
      const expectedRevision = typeof rawRevision === "number" && Number.isFinite(rawRevision) ? rawRevision : undefined;
      const rawEdits = req.body?.edits;
      const noEdits = rawEdits === undefined || (Array.isArray(rawEdits) && rawEdits.length === 0);
      if (noEdits && html === undefined && title) {
        const { tab, titleKept } = store.update(req.params.id, {
          title,
          activate: req.body?.activate,
          expectedRevision,
          viewer: viewerOf(req),
        });
        res.json({ applied: 0, closed: store.isClosed(tab.id), titleKept, tab: libraryMeta(tab) });
        return;
      }
      const { tab, applied, closed, titleKept } = store.patchHtml(req.params.id, {
        edits: noEdits ? undefined : parseHtmlEdits(rawEdits),
        html,
        title,
        activate: req.body?.activate,
        expectedRevision,
        viewer: viewerOf(req),
      });
      agentRewrote(req, tab.id);
      res.json({ applied, closed, titleKept, tab: libraryMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      const status = message.startsWith("tab not found") ? 404 : err instanceof RevisionConflictError ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  /**
   * The agent guide of the template a page was made from; the MCP hands it to the agent once per
   * session. For a Scribe chat's MCP, deliver=1 also says whether that chat already has it (its
   * prompt may have carried it) and records it as given; force=1 records it without asking.
   */
  app.get("/api/tabs/:id/guide", (req, res) => {
    const tab = store.get(req.params.id, viewerOf(req));
    if (!tab) {
      res.status(404).json({ error: `tab not found: ${req.params.id}` });
      return;
    }
    const guide = (tab.templateId && store.templateGuide(tab.templateId)) || null;
    const thread = req.get(THREAD_HEADER)?.slice(0, 60);
    if (!guide || !thread || req.query.deliver !== "1") {
      res.json({ guide });
      return;
    }
    const sent = req.query.force !== "1" && guideSent(thread, guide);
    markGuideSent(thread, guide);
    res.json({ guide, sent });
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
      eventCursor: tab.eventSeq,
      ...(tab.templateId
        ? {
            templateId: tab.templateId,
            templateCompatible: tab.templateCompatible !== false,
            templateValues: tab.templateValues ?? {},
            ...(tab.templateIncompatibleReason
              ? { templateIncompatibleReason: tab.templateIncompatibleReason }
              : {}),
          }
        : {}),
    });
  });

  /** Log an event (a page's signal, or an agent's note), after any state ops sent with it. */
  app.post("/api/tabs/:id/events", (req, res) => {
    try {
      const by = !isContentHost(req) && viewerOf(req) === "agent" ? "agent" : "user";
      const { event, tab, write } = store.logEvent(req.params.id, {
        name: String(req.body?.name ?? ""),
        data: req.body?.data,
        by,
        ops: Array.isArray(req.body?.ops) ? req.body.ops : undefined,
        client: optionalString(req.body?.client),
        writeId: optionalString(req.body?.writeId),
      });
      res.json({
        event,
        stateRevision: tab.stateRevision,
        ...(write?.ok ? { fromRevision: write.fromRevision, applied: write.applied, skipped: write.skipped } : {}),
      });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/wait", (req, res) => {
    handleWait(req, res, req.body?.events ?? req.body?.names, req.body?.after, req.body?.timeoutMs, req.body?.where);
  });

  app.get("/api/tabs/:id/wait", (req, res) => {
    handleWait(req, res, req.query.events ?? req.query.names, req.query.after, req.query.timeoutMs, req.query.where);
  });

  /**
   * Write state as ops (see stateOps.ts). Pages send lenient writes; agents strict ones. The reply
   * carries the ops that applied, never the whole state: viewers get the same ops as a delta.
   */
  app.put("/api/tabs/:id/state", (req, res) => {
    try {
      const assetFiles = parseAssetInputs(req.body?.assets);
      // Reading local files is for the agent; a page must not be able to pull files off the disk.
      if (assetFiles.length && isContentHost(req)) {
        res.status(403).json({ error: "pages save assets with scribe.saveAsset, not file paths" });
        return;
      }
      if (!Array.isArray(req.body?.ops)) {
        res.status(400).json({ error: "send ops: an array of state ops (see the scribe skill)" });
        return;
      }
      const result = store.writeState(req.params.id, {
        ops: req.body.ops,
        lenient: req.body?.lenient === true,
        ...(assetFiles.length ? { assets: assetFiles } : {}),
        expectedRevision:
          typeof req.body?.expectedRevision === "number" ? req.body.expectedRevision : undefined,
        client: optionalString(req.body?.client),
        writeId: optionalString(req.body?.writeId),
        resolveIncompatibility: req.body?.resolveIncompatibility === true,
      });
      if (!result.ok) {
        res.status(409).json({ error: "stale expectedRevision", conflict: true, stateRevision: result.stateRevision });
        return;
      }
      res.json({
        fromRevision: result.fromRevision,
        stateRevision: result.tab.stateRevision,
        applied: result.applied,
        skipped: result.skipped,
        ...(result.assets ? { assets: result.assets.map(assetView), usage: store.pageAssetUsageOf(result.tab.id) } : {}),
      });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  /** Run a template action (see src/actions). Agents through page_action; pages through scribe.action. */
  app.post("/api/tabs/:id/action", (req, res) => {
    try {
      const { result, stateRevision } = store.runAction(req.params.id, String(req.body?.action ?? ""), req.body?.args, callerOf(req), (id) =>
        agentHost ? agentHost.runInfo(id) : { exists: false }
      );
      res.json({ result: result ?? null, stateRevision });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  /** Per-viewer page state (scribe.local). Never broadcast and never shown to agents. */
  app.get("/api/tabs/:id/local", (req, res) => {
    const viewer = viewerIdOf(req.query.viewer);
    const tab = store.get(req.params.id);
    if (!tab || !viewer) {
      res.status(tab ? 400 : 404).json({ error: tab ? "viewer is required" : `tab not found: ${req.params.id}` });
      return;
    }
    res.json({ state: store.getLocal(tab.id, viewer) });
  });

  app.put("/api/tabs/:id/local", (req, res) => {
    try {
      const viewer = viewerIdOf(req.query.viewer ?? req.body?.viewer);
      if (!viewer) {
        res.status(400).json({ error: "viewer is required" });
        return;
      }
      store.setLocal(req.params.id, viewer, req.body?.state);
      res.json({ ok: true });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  /** Page code saves blobs here (board.saveAsset). The body is the raw bytes; the type rides in a header. */
  app.post("/api/tabs/:id/assets", readAssetBody, (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "expected the asset bytes as an application/octet-stream body" });
        return;
      }
      const result = store.savePageAsset(req.params.id, {
        name: decodeHeader(req.get("x-asset-name")),
        mimeType: req.get("x-asset-type"),
        data: req.body,
      });
      res.status(201).json({ asset: assetView(result.asset), usage: result.usage });
    } catch (err) {
      sendAssetError(res, err);
    }
  });

  app.get("/api/tabs/:id/assets", (req, res) => {
    try {
      const result = store.listPageAssets(req.params.id);
      res.json({ assets: result.assets.map(assetView), usage: result.usage });
    } catch (err) {
      sendAssetError(res, err);
    }
  });

  /** JSON for agents: metadata always, base64 bytes when the blob is a small raster image. */
  app.get("/api/tabs/:id/assets/:assetId", (req, res) => {
    try {
      const { meta, data } = store.readTabPageAsset(req.params.id, req.params.assetId);
      const skipped = skipInlinePageImage(meta.mimeType, meta.bytes);
      res.json({
        id: meta.id,
        name: meta.name,
        mimeType: meta.mimeType,
        bytes: meta.bytes,
        url: pageAssetUrl(meta.id),
        ...(skipped ? { skipped } : { data: data.toString("base64") }),
      });
    } catch (err) {
      sendAssetError(res, err);
    }
  });

  app.delete("/api/tabs/:id/assets/:assetId", (req, res) => {
    try {
      res.json({ usage: store.deletePageAsset(req.params.id, req.params.assetId) });
    } catch (err) {
      sendAssetError(res, err);
    }
  });

  /** Ids are random and never reused, so the bytes behind one never change. */
  app.get("/blob/:assetId", (req, res) => {
    const found = store.readPageAsset(req.params.assetId);
    if (!found) {
      res.status(404).type("text").send("asset not found");
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (found.meta.mimeType !== "application/pdf") {
      // Stored bytes are arbitrary; opened directly they must not run script on the content origin.
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    }
    res.type(found.meta.mimeType).send(found.data);
  });

  app.post("/api/tabs/:id/focus", (req, res) => {
    try {
      const tab = store.focus(req.params.id);
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/tabs/:id/reorder", (req, res) => {
    try {
      const raw = req.body?.before;
      let before: string | null = null;
      if (raw === null || raw === undefined) {
        before = null;
      } else if (typeof raw === "string" && raw.trim()) {
        before = raw.trim();
      } else {
        throw new Error("before must be a tab id or null");
      }
      const tab = store.reorderTab(req.params.id, before);
      const viewer = viewerOf(req);
      res.json({ tab: toMeta(tab), tabs: store.list(viewer), activeId: store.getActiveId(viewer) });
    } catch (err) {
      const message = (err as Error).message;
      const missing = message.startsWith("tab not found");
      res.status(missing ? 404 : 400).json({ error: message });
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
      const { tab } = store.restoreLast();
      res.json({ tab: tab ? toMeta(tab) : null });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message === "nothing to restore" ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/open", (req, res) => {
    try {
      const rawBefore = req.body?.before;
      const before = rawBefore === null ? null : typeof rawBefore === "string" && rawBefore.trim() ? rawBefore.trim() : undefined;
      const tab = store.openPage(req.params.id, { activate: req.body?.activate !== false, before });
      res.json({ tab: libraryMeta(tab), closedCount: store.closedCount(viewerOf(req)) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/tabs/:id", (req, res) => {
    const viewer = viewerOf(req);
    try {
      const permanent = req.query.permanent === "true" || req.query.permanent === "1";
      if (permanent) {
        const tab = store.deletePermanent(req.params.id);
        res.json({ deleted: [tab.id], closedCount: store.closedCount(viewer) });
        return;
      }
      const tab = store.closeTab(req.params.id);
      if (store.isClosed(tab.id)) {
        res.json({ closed: [tab.id], closedCount: store.closedCount(viewer) });
        return;
      }
      res.json({ deleted: [tab.id], closedCount: store.closedCount(viewer) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/tabs", (req, res) => {
    const viewer = viewerOf(req);
    const permanent = req.query.permanent === "true" || req.query.permanent === "1";
    const filter = req.query.filter === "all" ? "all" : "unpinned";
    if (permanent) {
      const ids = store.list(viewer).filter((tab) => filter === "all" || !tab.pinned).map((tab) => tab.id);
      const deleted = store.deleteMany(ids).map((tab) => tab.id);
      res.json({ deleted, closedCount: store.closedCount(viewer) });
      return;
    }
    const closed = store.closeMany(filter, viewer);
    res.json({ closed, closedCount: store.closedCount(viewer) });
  });

  app.get("/api/folders", (_req, res) => {
    res.json({ folders: store.listFolders() });
  });

  app.get("/api/folders/tree", (req, res) => {
    res.json({ folders: store.folderTree(viewerOf(req)) });
  });

  app.post("/api/folders", (req, res) => {
    try {
      const folder = store.createFolder({
        name: String(req.body?.name ?? ""),
        parentId: parseFolderRef(req.body?.parentId),
        index: optionalNumber(req.body?.index),
      });
      res.status(201).json({ folder });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.patch("/api/folders/:fid", (req, res) => {
    try {
      res.json({ folder: store.renameFolder(req.params.fid, String(req.body?.name ?? "")) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/folders/:fid/move", (req, res) => {
    try {
      const folder = store.moveFolder(
        req.params.fid,
        parseFolderRef(req.body?.parentId),
        optionalNumber(req.body?.index) ?? 0
      );
      res.json({ folder });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.delete("/api/folders/:fid", (req, res) => {
    try {
      const mode: FolderDeleteMode = req.query.mode === "delete" ? "delete" : "lift";
      const { deleted, moved } = store.deleteFolder(req.params.fid, mode);
      res.json({ deleted: deleted.map((tab) => tab.id), moved: moved.map((tab) => tab.id) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/folders/:fid/open", (req, res) => {
    try {
      res.json({ opened: store.openFolder(req.params.fid).map((tab) => tab.id) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/folders/:fid/close", (req, res) => {
    try {
      res.json({ closed: store.closeFolder(req.params.fid).map((tab) => tab.id) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.get("/api/trash", (req, res) => {
    res.json({ batches: store.listTrash(viewerOf(req)) });
  });

  app.post("/api/trash/:id/restore", (req, res) => {
    try {
      const { tabs, folders } = store.restoreFromTrash(req.params.id);
      res.json({ restored: tabs.map((tab) => tab.id), folders: folders.map((folder) => folder.id) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/trash/:id", (req, res) => {
    try {
      res.json({ purged: store.purgeFromTrash(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/trash", (_req, res) => {
    res.json({ purged: store.emptyTrash() });
  });

  /** Library "Clean up tabs": `dryRun` lists what would go; otherwise deletes it as one undoable batch. */
  app.post("/api/library/cleanup", (req, res) => {
    try {
      const opts: CleanupOptions = {
        days: optionalNumber(req.body?.days) ?? 30,
        basis: (optionalString(req.body?.basis) as CleanupBasis | undefined) ?? "activity",
        includeOpen: req.body?.includeOpen === true,
        includePinned: req.body?.includePinned === true,
      };
      if (req.body?.dryRun === true) {
        const pages = store.cleanupCandidates(opts);
        res.json({ pages: pages.map((tab) => ({ id: tab.id, title: tab.title, pinned: tab.pinned, open: tab.closedAt === undefined })) });
        return;
      }
      res.json({ deleted: store.cleanup(opts).map((tab) => tab.id) });
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.post("/api/tabs/:id/agent-hidden", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the board UI can change whether the agent sees a tab" });
      return;
    }
    if (typeof req.body?.hidden !== "boolean") {
      res.status(400).json({ error: "hidden must be true or false" });
      return;
    }
    try {
      const tab = store.setAgentHidden(req.params.id, req.body.hidden);
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Page permissions are the user's: agents can neither read nor change them, and tab pages
  // can't reach these routes (contentOriginGate). The board UI asks and checks for the page.
  app.get("/api/tabs/:id/permissions", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the Scribe UI can read page permissions" });
      return;
    }
    try {
      res.json({ permissions: permissionViews(store.pagePermissions(req.params.id)) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/tabs/:id/permissions/check", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the Scribe UI can check page permissions" });
      return;
    }
    try {
      const grants = store.pagePermissions(req.params.id);
      const need = { perm: String(req.body?.perm ?? ""), folder: optionalString(req.body?.folder), approval: optionalString(req.body?.approval) };
      res.json({ result: checkPermission(grants, need) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.put("/api/tabs/:id/permissions", (req, res) => {
    if (viewerOf(req) === "agent") {
      res.status(403).json({ error: "Only the Scribe UI can change page permissions" });
      return;
    }
    const value = req.body?.value;
    if (!isPermissionValue(value)) {
      res.status(400).json({ error: "value must be allow, deny, or ask" });
      return;
    }
    try {
      const grants = store.setPagePermission(req.params.id, String(req.body?.perm ?? ""), value, req.body?.folders);
      res.json({ permissions: permissionViews(grants) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.get("/api/templates", (req, res) => {
    res.json({ templates: store.listTemplates(viewerOf(req)), builtins: store.listBuiltinTemplates() });
  });

  app.get("/api/templates/:id", (req, res) => {
    const found = store.findTemplate(req.params.id);
    if (!found) {
      res.status(404).json({ error: `template not found: ${req.params.id}` });
      return;
    }
    const { template, builtIn } = found;
    const meta = builtIn
      ? store.listBuiltinTemplates().find((item) => item.id === template.id)
      : store.templateMeta(template, instanceCount(template, viewerOf(req)));
    const guide = store.templateGuide(template.id);
    res.json({
      template: {
        ...meta,
        html: template.html,
        ...(template.initialState ? { initialState: template.initialState } : {}),
        ...(guide ? { guide: guide.text } : {}),
      },
    });
  });

  app.post("/api/templates/:id/copy", (req, res) => {
    try {
      const { template, created } = store.copyBuiltinTemplate(req.params.id);
      res.status(created ? 201 : 200).json({ created, template: store.templateMeta(template, instanceCount(template, viewerOf(req))) });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post("/api/templates", (req, res) => {
    try {
      const { template, created } = store.upsertTemplate({
        id: optionalString(req.body?.id),
        key: optionalString(req.body?.key),
        title: String(req.body?.title ?? ""),
        description: optionalString(req.body?.description),
        html: String(req.body?.html ?? ""),
        fields: req.body?.fields,
        titleTemplate: optionalString(req.body?.titleTemplate),
        initialState: isPlainObject(req.body?.initialState) ? req.body.initialState : undefined,
        stateVersion: typeof req.body?.stateVersion === "number" ? req.body.stateVersion : undefined,
        guide: typeof req.body?.guide === "string" ? req.body.guide : undefined,
        syncedWithBuiltin: req.body?.syncedWithBuiltin === true,
      });
      if (!created && viewerOf(req) === "agent") {
        store.resetTemplatePermissions(template.id);
      }
      res.status(created ? 201 : 200).json({
        created,
        template: {
          ...store.templateMeta(template, instanceCount(template, viewerOf(req))),
          html: template.html,
          ...(template.initialState ? { initialState: template.initialState } : {}),
        },
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/templates/:id", (req, res) => {
    try {
      const template = store.deleteTemplate(req.params.id);
      res.json({ deleted: template.id, key: template.key });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("template not found") ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/templates/:id/open", (req, res) => {
    try {
      const { tab, template, copiedBuiltin } = store.openFromTemplate(req.params.id, req.body?.values ?? {}, {
        activate: req.body?.activate !== false,
        agentHidden: viewerOf(req) === "user" && req.body?.agentHidden === true,
      });
      res.status(201).json({ tab: toMeta(tab), template: { id: template.id, key: template.key }, copiedBuiltin });
    } catch (err) {
      const message = (err as Error).message;
      const missing = message.startsWith("template not found");
      res.status(missing ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/template-values", (req, res) => {
    try {
      const tab = store.setTemplateValues(req.params.id, req.body?.values ?? {});
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      const missing = message.startsWith("tab not found") || message.startsWith("template not found");
      res.status(missing ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/tabs/:id/template-incompatible", (req, res) => {
    try {
      const tab = store.reportIncompatible(req.params.id, optionalString(req.body?.reason));
      res.json({ tab: toMeta(tab) });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
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
    res.type("html").send(injectBoardRuntime(tab, viewerIdOf(req.query.viewer)));
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

  app.get("/api/export/folder/:fid", (req, res) => {
    try {
      const file = store.exportFile({ folderId: req.params.fid });
      const name = store.folderPath(req.params.fid) ?? "folder";
      res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(name.replaceAll("/", " - "))}"`);
      res.type("json").send(JSON.stringify(file));
    } catch (err) {
      sendStoreError(res, err);
    }
  });

  app.get("/api/export/:id", (req, res) => {
    try {
      const file = store.exportFile({ id: req.params.id });
      const title = file.pages[0]?.title ?? "page";
      res.setHeader("Content-Disposition", `attachment; filename="${exportFilename(title)}"`);
      res.type("json").send(JSON.stringify(file));
    } catch (err) {
      const message = (err as Error).message;
      res.status(message.startsWith("tab not found") ? 404 : 400).json({ error: message });
    }
  });

  app.get("/api/export", (_req, res) => {
    try {
      const file = store.exportFile();
      res.setHeader("Content-Disposition", `attachment; filename="${exportAllFilename(file.exportedAt)}"`);
      res.type("json").send(JSON.stringify(file));
    } catch (err) {
      const message = (err as Error).message;
      res.status(message === "nothing to export" ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/import", express.raw({ type: "application/octet-stream", limit: MAX_IMPORT_BYTES }), (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "expected a file body" });
        return;
      }
      const destination = parseImportDestination(req.query.destination);
      const parsed = parseImport(req.body, importFilename(req));
      const result = store.importBoard(parsed, destination);
      res.status(201).json({
        kind: parsed.kind,
        imported: result.tabs.map((tab) => toMeta(tab)),
        opened: result.opened,
        closed: result.closed,
        focusedId: result.focusedId,
        templatesCreated: result.templatesCreated,
        templatesReused: result.templatesReused,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/shutdown", (_req, res) => {
    res.json({ ok: true });
    try {
      agentHost?.dispose();
    } catch {
      /* ignore */
    }
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
    send(socket, { type: "snapshot", version: VERSION, ...store.snapshot() });
    socket.on("message", (raw) => {
      let msg: {
        type?: string;
        selectedId?: string | null;
        lastInteractedAt?: unknown;
        lastEditAt?: unknown;
        hidden?: unknown;
      };
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
        hidden: msg.hidden,
      });
    });
    socket.on("close", () => {
      sockets.delete(socket);
      viewers.remove(socket);
    });
  });

  store.on("tab_upserted", (tab: TabMeta, index?: number, notice?: UpsertNotice) => {
    broadcast({ type: "tab_upserted", tab, index, structural: notice?.structural !== false });
    if (notice?.activate && notice.structural) {
      requestAgentFocus(tab.id);
    }
  });
  store.on("tab_deleted", (id: string) => broadcast({ type: "tab_deleted", id }));
  store.on("folders", (folders: Folder[]) => broadcast({ type: "folders", folders }));
  store.on("trash", () => broadcast({ type: "trash" }));
  store.on("tab_state", (tab: Tab, delta: { fromRevision: number; ops: StateOp[]; client?: string; writeId?: string }) =>
    broadcast({
      type: "tab_state",
      id: tab.id,
      fromRevision: delta.fromRevision,
      stateRevision: tab.stateRevision,
      ops: delta.ops,
      ...(delta.client ? { client: delta.client } : {}),
      ...(delta.writeId ? { writeId: delta.writeId } : {}),
    })
  );
  store.on("tab_event", (tab: Tab, event: PageEvent) => broadcast({ type: "tab_event", id: tab.id, event }));
  store.on("template_upserted", (template: TemplateMeta) => broadcast({ type: "template_upserted", template }));
  store.on("template_deleted", (id: string) => broadcast({ type: "template_deleted", id }));
  store.on("builtin_templates", (templates: BuiltinTemplateMeta[]) => broadcast({ type: "builtin_templates", templates }));
  store.on("page_asset_warning", (tab: Tab, usage: PageAssetUsage) =>
    broadcast({ type: "page_asset_warning", id: tab.id, title: tab.title, usage })
  );
  store.on("persist_error", (error: string) => broadcast({ type: "persist_error", error }));
  store.on("persist_ok", () => broadcast({ type: "persist_ok" }));

  // Covers receiving the request (large imports), not a slow response, so it does not bound page_wait.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  contentServer.requestTimeout = REQUEST_TIMEOUT_MS;

  await listen(server, PORT, HOST);
  await listen(contentServer, PORT, CONTENT_HOST);

  log(`Scribe listening on ${baseUrl()} (tab pages on ${contentBaseUrl()})`);
  return server;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** TabMeta plus the page's Library folder path for agents and search results. */
function libraryMeta(tab: Tab): TabMeta & { open: boolean; folder: string | null } {
  return { ...toMeta(tab), open: !tab.closedAt, folder: store.folderPath(tab.folderId) };
}

function parseFolderRef(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("folderId must be a folder id or null");
  }
  return value;
}

const rawAssetBody = express.raw({ type: "application/octet-stream", limit: MAX_PAGE_ASSET_BYTES });

/** express.raw, but a body over the limit answers in JSON like the rest of the API. */
function readAssetBody(req: express.Request, res: express.Response, next: express.NextFunction): void {
  rawAssetBody(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }
    const tooLarge = (err as { type?: string }).type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? `asset is too large (max ${MAX_PAGE_ASSET_BYTES} bytes)` : (err as Error).message,
    });
  });
}

function assetView(asset: PageAssetMeta): PageAssetMeta & { url: string } {
  return { ...asset, url: pageAssetUrl(asset.id) };
}

function sendAssetError(res: express.Response, err: unknown): void {
  const message = (err as Error).message;
  const missing = message.startsWith("tab not found") || message.startsWith("asset not found");
  const full = message.startsWith("page asset");
  res.status(missing ? 404 : full ? 413 : 400).json({ error: message });
}

function decodeHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sendStoreError(res: express.Response, err: unknown): void {
  const message = (err as Error).message;
  const missing = message.startsWith("tab not found") || message.startsWith("folder not found");
  res.status(missing ? 404 : 400).json({ error: message });
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
  namesInput: unknown,
  afterInput: unknown,
  timeoutInput: unknown,
  whereInput: unknown
): void {
  let names: string[];
  let where: ReturnType<typeof parseWhere>;
  try {
    names = parseEventNames(namesInput);
    where = parseWhere(whereInput);
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

  waitForEvents({
    idOrKey: req.params.id,
    names,
    after: parseCursor(typeof afterInput === "string" ? Number(afterInput) : afterInput),
    timeoutMs,
    viewer: viewerOf(req),
    abort: abort.signal,
    ...(where ? { where } : {}),
  })
    .then((result) => {
      if (!res.writableEnded) {
        res.json(result);
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

/** Last request from each MCP session, for telling a live agent's claims from an abandoned one's. */
const sessionSeen = new Map<string, number>();

function noteAgentSession(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  const session = req.get(SESSION_HEADER);
  if (session && !isContentHost(req)) {
    sessionSeen.set(session.slice(0, 40), Date.now());
  }
  next();
}

function callerOf(req: express.Request): ActionCaller {
  if (isContentHost(req) || viewerOf(req) !== "agent") {
    return { by: "user", label: "user" };
  }
  const session = req.get(SESSION_HEADER)?.slice(0, 40);
  const thread = req.get(THREAD_HEADER)?.slice(0, 60);
  const chat = thread && agentHost ? agentHost.getThread(thread) : null;
  const label = chat ? `Scribe chat: ${chat.title}` : req.get(AGENT_LABEL_HEADER)?.slice(0, 60) || "agent";
  return { by: "agent", label, ...(chat?.provider ? { provider: chat.provider } : {}), ...(session ? { session } : {}), ...(thread ? { thread } : {}) };
}

let sweepQueued: NodeJS.Timeout | null = null;

/** Release or flag claims whose agent stopped. Debounced: turn ends come in bursts. */
function scheduleSweep(delayMs: number): void {
  if (sweepQueued) {
    return;
  }
  sweepQueued = setTimeout(() => {
    sweepQueued = null;
    store.sweepActions({
      now: Date.now(),
      thread: (id) => (agentHost ? agentHost.runInfo(id) : { exists: false }),
      sessionSeenAt: (session) => sessionSeen.get(session),
    });
  }, delayMs);
  sweepQueued.unref?.();
}

/** A viewer id from the page's boot (set per desktop app or browser by the Scribe UI). */
function viewerIdOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
}

function isContentHost(req: express.Request): boolean {
  return req.hostname === CONTENT_HOST;
}

const STATE_PATH = /^\/api\/tabs\/[^/]+\/state$/;
const EVENTS_PATH = /^\/api\/tabs\/[^/]+\/events$/;
const LOCAL_PATH = /^\/api\/tabs\/[^/]+\/local$/;
const ACTION_PATH = /^\/api\/tabs\/[^/]+\/action$/;
const TEMPLATE_INCOMPATIBLE_PATH = /^\/api\/tabs\/[^/]+\/template-incompatible$/;
const ASSETS_PATH = /^\/api\/tabs\/[^/]+\/assets$/;
const ASSET_PATH = /^\/api\/tabs\/[^/]+\/assets\/[^/]+$/;
const BLOB_PATH = /^\/blob\/[^/]+$/;

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
    if (req.method === "POST" && (EVENTS_PATH.test(req.path) || ACTION_PATH.test(req.path))) {
      next();
      return;
    }
    if ((req.method === "GET" || req.method === "PUT") && LOCAL_PATH.test(req.path)) {
      next();
      return;
    }
    if (req.method === "POST" && TEMPLATE_INCOMPATIBLE_PATH.test(req.path)) {
      next();
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && ASSETS_PATH.test(req.path)) {
      next();
      return;
    }
    if ((req.method === "GET" || req.method === "DELETE") && ASSET_PATH.test(req.path)) {
      next();
      return;
    }
    if (req.method === "GET" && BLOB_PATH.test(req.path)) {
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
  if (req.path === "/view" || req.path.startsWith("/view/") || req.path.startsWith("/blob/")) {
    res.status(404).type("text").send("Tab pages are served from the content origin.");
    return;
  }
  next();
}

const SHELL_PATHS = new Set(["/", "/index.html", "/app.js", "/app.css", "/library.js", "/hovercard.js", "/views.js", "/agent.js", "/agent.css", "/agent-render.js"]);

function noStoreShell(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (SHELL_PATHS.has(req.path)) {
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

const BOARD_CHROME_INJECT = `<style data-scribe-scroll>${BOARD_SCROLLBAR_CSS}</style>
<script data-scribe-keys>
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
      parent.postMessage({ type: "scribe-download" }, "*");
      return;
    }
    if (key === "h" && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-help" }, "*");
      return;
    }
    if (key === "z" && !event.shiftKey && !typing(event.target)) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-undo" }, "*");
      return;
    }
    if (key === "d" && !event.shiftKey) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-palette" }, "*");
    }
  }, true);
  // Bubble phase: a page that handles Esc itself (closing its own menu) keeps it.
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      parent.postMessage({ type: "scribe-escape" }, "*");
      return;
    }
    // Agent chat: Ctrl+K floating chat, Ctrl+Shift+K new thread, Ctrl+L sidebar, Ctrl+Shift+L full window,
    // Ctrl+J threads, Ctrl+' next favourite model, Ctrl+Alt+' next reasoning level, Ctrl+Shift+' next mode.
    // Pages that use them keep them.
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return;
    var chatKey = event.key.toLowerCase();
    // The apostrophe key: by character (" with Shift), or by position on Nordic layouts (the '* key next to Enter).
    var quote = event.key === "'" || event.key === '"' || (event.code === "Backslash" && event.key !== "\\\\" && event.key !== "|");
    var action = quote ? (event.shiftKey ? (event.altKey ? "" : "mode") : event.altKey ? "effort" : "model")
      : event.altKey ? ""
      : chatKey === "k" ? (event.shiftKey ? "new" : "dock")
      : chatKey === "l" ? (event.shiftKey ? "full" : "side")
      : chatKey === "j" && !event.shiftKey ? "threads" : "";
    if (action) {
      event.preventDefault();
      parent.postMessage({ type: "scribe-chat-key", action: action }, "*");
    }
  });
})();
</script>`;

function injectBoardRuntime(tab: Tab, viewer: string | null): string {
  const html = injectBoardKeys(rewriteAssetRefs(tab.html, tab.id));
  if (html.includes("data-scribe-bridge")) {
    return html;
  }
  const boot = jsonForScript({
    id: tab.id,
    state: tab.state,
    stateRevision: tab.stateRevision,
    viewer,
    local: viewer ? store.getLocal(tab.id, viewer) : {},
    template: tab.templateId
      ? {
          id: tab.templateId,
          values: tab.templateValues ?? {},
          revision: tab.templateStateVersion ?? 0,
          compatible: tab.templateCompatible !== false,
        }
      : null,
  });
  const snippet = `<style data-scribe-bridge>${BOARD_STALE_CSS}</style>
<script>window.__SCRIBE_BOOT__=${boot};
${BOARD_BRIDGE_JS}
</script>`;
  return injectIntoHead(html, snippet);
}

function injectBoardKeys(html: string): string {
  if (html.includes("data-scribe-keys")) {
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

function parseImportDestination(value: unknown): ImportDestination {
  if (value === undefined || value === null || value === "" || value === "meta") {
    return "meta";
  }
  if (value === "closed") {
    return "closed";
  }
  throw new Error("destination must be meta or closed");
}

function instanceCount(template: Template, viewer: Viewer): number {
  return store.listTemplates(viewer).find((item) => item.id === template.id)?.instanceCount ?? 0;
}

/** A page's risky permissions were granted to the code the user saw; an agent rewriting it resets them. */
function agentRewrote(req: express.Request, tabId: string): void {
  if (viewerOf(req) === "agent") {
    store.resetRiskyPermissions(tabId);
  }
}

function viewerOf(req: express.Request): Viewer {
  return req.get(CLIENT_HEADER) === AGENT_CLIENT ? "agent" : "user";
}

function importFilename(req: express.Request): string {
  const raw = req.get("x-filename") || "import";
  return path.basename(raw).slice(0, 180) || "import";
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
