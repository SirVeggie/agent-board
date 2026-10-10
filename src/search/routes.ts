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

const MAX_QUERY_IMAGE_BYTES = 20 * 1024 * 1024;

export function searchRouter(): Router {
  const router = Router();
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
    if (!q || q.length > 500 || !["pages", "chunks", "images"].includes(String(scope)) || !Number.isInteger(limit) || limit < 1 || limit > 8) {
      res.status(400).json({ error: "Use q (1–500 characters), scope=pages|chunks|images and limit=1–8" }); return;
    }
    try {
      refreshSearchIndex();
      if (!searchIndex.status().enabled) { res.status(503).json({ error: "Semantic search is unavailable", ...status() }); return; }
      const viewer = viewerOf(req);
      const visible = (id: string) => !!store.get(id, viewer);
      const hits = scope === "images" ? await searchIndex.queryImages(q, visible, limit) : await searchIndex.query(q, scope as "pages" | "chunks", visible, limit);
      res.json({ hits: hits.flatMap(hit => hitView(hit, viewer)), index: searchIndex.status() });
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
      const child = spawn(command, [folder], { stdio: "ignore", detached: true, windowsHide: true });
      child.once("error", err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
      child.once("spawn", () => { child.unref(); res.json({ ok: true }); });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });
  return router;
}
