import fs from "node:fs";
import { spawn } from "node:child_process";
import { Router } from "express";
import { detectSearchPack, searchEnabled, searchPackDir, setSearchEnabled } from "./pack.js";
import { searchEmbedder } from "./embedder.js";

export function searchRouter(): Router {
  const router = Router();
  const status = () => {
    const pack = detectSearchPack();
    const { pack: manifest, ...view } = pack;
    return { ...view, version: manifest?.version, model: manifest?.model, dtype: manifest?.dtype, enabled: searchEnabled() && pack.status === "ready" };
  };
  router.get("/status", (_req, res) => res.json(status()));
  router.post("/settings", (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") throw new Error("enabled must be a boolean");
      setSearchEnabled(req.body.enabled);
      if (!req.body.enabled) searchEmbedder.stop();
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
