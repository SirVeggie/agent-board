import fs from "node:fs";
import { spawn } from "node:child_process";
import { Router } from "express";
import { detectSearchPack, searchEnabled, searchPackDir, setSearchEnabled } from "./pack.js";
import { searchEmbedder } from "./embedder.js";
import { refreshSearchIndex, searchIndex } from "./service.js";
import { store } from "../store.js";
import { AGENT_CLIENT, CLIENT_HEADER } from "../config.js";

export function searchRouter(): Router {
  const router = Router();
  const status = () => {
    const pack = detectSearchPack();
    const { pack: manifest, ...view } = pack;
    return { ...view, version: manifest?.version, model: manifest?.model, dtype: manifest?.dtype, enabled: searchEnabled() && pack.status === "ready" };
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
    if (!q || q.length > 500 || !["pages", "chunks"].includes(String(scope)) || !Number.isInteger(limit) || limit < 1 || limit > 8) {
      res.status(400).json({ error: "Use q (1–500 characters), scope=pages|chunks and limit=1–8" }); return;
    }
    try {
      refreshSearchIndex();
      if (!searchIndex.status().enabled) { res.status(503).json({ error: "Semantic search is unavailable", ...status() }); return; }
      const viewer = req.get(CLIENT_HEADER) === AGENT_CLIENT ? "agent" : "user";
      const hits = await searchIndex.query(q, scope as "pages" | "chunks", id => !!store.get(id, viewer), limit);
      res.json({ hits: hits.flatMap(hit => {
        const tab = store.get(hit.tab_id, viewer);
        return tab ? [{ id: tab.id, key: tab.key, title: tab.title, folder: store.folderPath(tab.folderId), kind: hit.kind, anchor: hit.anchor, headingId: hit.heading_id, label: hit.label, snippet: hit.snippet }] : [];
      }), index: searchIndex.status() });
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
