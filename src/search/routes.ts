import fs from "node:fs";
import { spawn } from "node:child_process";
import express, { Router } from "express";
import { detectSearchPack, searchEnabled, searchPackDir, setSearchEnabled } from "./pack.js";
import { searchEmbedder } from "./embedder.js";
import { refreshSearchIndex, searchIndex } from "./service.js";
import { store } from "../store.js";
import { AGENT_CLIENT, CLIENT_HEADER } from "../config.js";
import { assetUrl } from "../assets.js";
import { pageAssetUrl } from "../pageAssets.js";
import type { ImageHit, ScoredHit } from "./indexer.js";
import { chunkPage } from "./chunker.js";
import { chunkDigest } from "../aiSearch.js";
import { mlService, type MlService } from "../ml/service.js";
import { RERANK_BUDGET_MS, RERANK_FEATURE, RERANK_TOP_K, rerankHits, type RerankInfo } from "./rerank.js";

const MAX_QUERY_IMAGE_BYTES = 20 * 1024 * 1024;
/** The palette asks for 8; an agent's library_search may ask for more. */
const MAX_HITS = 30;

export function searchRouter(ml: () => MlService = mlService): Router {
  const router = Router();
  /** What the classifier reads for each hit: page, folder, the section or item, then the passage's own text (the index keeps a snippet only). */
  const passages = (viewer: "agent" | "user") => {
    const texts = new Map<string, Map<string, string>>();
    return (hit: ScoredHit): string => {
      const tab = store.get(hit.tab_id, viewer);
      if (!tab) return hit.snippet;
      const folder = store.folderPath(tab.folderId);
      let byKey = texts.get(tab.id);
      if (!byKey) texts.set(tab.id, byKey = new Map(chunkPage(tab, folder, store.searchDeclaration(tab)).map(chunk => [chunk.key, chunk.text])));
      return chunkDigest({ title: tab.title || tab.key, folder }, { kind: hit.kind, label: hit.label, text: byKey.get(hit.chunk_key) ?? hit.snippet });
    };
  };
  const status = () => {
    const pack = detectSearchPack();
    const { pack: manifest, ...view } = pack;
    return { ...view, version: manifest?.version, model: manifest?.model, dtype: manifest?.dtype, enabled: searchEnabled() && pack.status === "ready" };
  };
  const viewerOf = (req: express.Request) => req.get(CLIENT_HEADER) === AGENT_CLIENT ? "agent" as const : "user" as const;
  /** A hit as the palette and agents see it. An image hit carries its URL and the card, item or section it sits on. */
  const hitView = (hit: ScoredHit | ImageHit, viewer: "agent" | "user") => {
    const tab = store.get(hit.tab_id, viewer);
    if (!tab) return [];
    const view = { id: tab.id, key: tab.key, title: tab.title, folder: store.folderPath(tab.folderId), kind: hit.kind, anchor: hit.anchor, headingId: hit.heading_id, label: hit.label, snippet: hit.snippet };
    if (!("ownerRow" in hit) || !hit.anchor) return [view];
    const owner = hit.ownerRow;
    return [{ ...view, image: hit.anchor.startsWith("asset:") ? assetUrl(tab.id, hit.anchor.slice(6)) : pageAssetUrl(hit.anchor), owner: owner && owner.kind !== "page" ? { kind: owner.kind, anchor: owner.anchor, headingId: owner.heading_id } : null }];
  };
  router.get("/status", (_req, res) => res.json(status()));
  router.get("/index/status", (_req, res) => {
    refreshSearchIndex();
    res.json(searchIndex.status());
  });
  router.get("/semantic", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const scope = req.query.scope ?? "pages";
    const limit = req.query.limit === undefined ? 8 : Number(req.query.limit);
    const folderPath = typeof req.query.folder === "string" ? req.query.folder.trim() : "";
    if (!q || q.length > 500 || !["pages", "chunks", "images"].includes(String(scope)) || !Number.isInteger(limit) || limit < 1 || limit > MAX_HITS) {
      res.status(400).json({ error: `Use q (1–500 characters), scope=pages|chunks|images and limit=1–${MAX_HITS}` }); return;
    }
    try {
      refreshSearchIndex();
      if (!searchIndex.status().enabled) { res.status(503).json({ error: "Semantic search is unavailable", ...status() }); return; }
      const viewer = viewerOf(req);
      let visible = (id: string) => !!store.get(id, viewer);
      if (folderPath) {
        const folderId = folderPath === "/" ? null : store.findFolderPath(folderPath);
        if (folderId === undefined) { res.status(404).json({ error: `folder not found: ${folderPath}` }); return; }
        const inFolder = new Set(store.searchLibrary("", { folderId, viewer, limit: Number.MAX_SAFE_INTEGER }).hits.map(hit => hit.tab.id));
        visible = id => inFolder.has(id);
      }
      if (scope === "images") {
        const hits = await searchIndex.queryImages(q, visible, limit);
        res.json({ hits: hits.flatMap(hit => hitView(hit, viewer)), index: searchIndex.status() }); return;
      }
      // rerank=0 asks for the vector ranking alone (the eval compares the two).
      const rerank = req.query.rerank !== "0" && ml().ready(RERANK_FEATURE, ["toolResults"]);
      const found = await searchIndex.query(q, scope as "pages" | "chunks", visible, rerank ? Math.max(limit, RERANK_TOP_K) : limit);
      let hits = found, info: RerankInfo | undefined;
      if (rerank && found.length) ({ hits, info } = await rerankHits(q, found, passages(viewer), (...args) => ml().decide(...args), { timeoutMs: RERANK_BUDGET_MS[viewer] }));
      res.json({ hits: hits.slice(0, limit).flatMap(hit => hitView(hit, viewer)), index: searchIndex.status(), ...(info ? { rerank: info } : {}) });
    } catch (err) { res.status(503).json({ error: (err as Error).message }); }
  });
  /** An image as the query: the body is its bytes. Returns the indexed images that look most like it. */
  router.post("/semantic/image", express.raw({ type: () => true, limit: MAX_QUERY_IMAGE_BYTES }), async (req, res) => {
    const limit = req.query.limit === undefined ? 8 : Number(req.query.limit);
    if (!Buffer.isBuffer(req.body) || !req.body.length || !Number.isInteger(limit) || limit < 1 || limit > 8) {
      res.status(400).json({ error: "Send the image bytes as the body, and limit=1–8" }); return;
    }
    try {
      refreshSearchIndex();
      if (!searchIndex.status().enabled) { res.status(503).json({ error: "Semantic search is unavailable", ...status() }); return; }
      const viewer = viewerOf(req);
      const hits = await searchIndex.queryImages(req.body, id => !!store.get(id, viewer), limit);
      res.json({ hits: hits.flatMap(hit => hitView(hit, viewer)), index: searchIndex.status() });
    } catch (err) { res.status(503).json({ error: (err as Error).message }); }
  });
  router.post("/settings", (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") throw new Error("enabled must be a boolean");
      setSearchEnabled(req.body.enabled);
      if (!req.body.enabled) searchEmbedder.stop();
      refreshSearchIndex();
      res.json(status());
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
  router.post("/open-folder", (_req, res) => {
    try {
      const folder = searchPackDir();
      fs.mkdirSync(folder, { recursive: true });
      const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      // This is a user-requested folder window; hiding Explorer hides the window too.
      const child = spawn(command, [folder], { stdio: "ignore", detached: true, windowsHide: false });
      child.once("error", err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      child.once("spawn", () => { child.unref(); res.json({ ok: true }); });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  return router;
}
