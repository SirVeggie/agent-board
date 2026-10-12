import express, { Router } from "express";
import { shellOrigins } from "../config.js";
import { mlService, type MlService } from "./service.js";

/**
 * Changes must come from the board shell: JSON (a cross-origin form cannot send it without a
 * preflight) and, when the browser says where it came from, one of the shell's origins. A source's
 * key never appears in a response; tab pages are kept out of /api/ml by the content origin gate.
 */
function shellOnly(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  const origin = req.get("origin");
  if (origin && !shellOrigins().includes(origin)) {
    res.status(403).json({ error: "Classifier settings can only be changed from the board" });
    return;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Classifier requests must be JSON" });
    return;
  }
  next();
}

/** /api/ml/* for the Settings dialog: sources, switches, the Test button and today's usage. */
export function mlRouter(service: MlService = mlService()): Router {
  const router = Router();
  router.use(shellOnly);
  const guarded = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
    try {
      res.json(fn(req) ?? { ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };
  router.get("/settings", (_req, res) => res.json(service.view()));
  router.put("/settings", guarded((req) => service.update(req.body)));
  router.get("/usage", (_req, res) => res.json(service.usage()));
  router.post("/sources", guarded((req) => ({ source: service.saveSource(undefined, req.body), ...service.view() })));
  router.put("/sources/:source", guarded((req) => ({ source: service.saveSource(req.params.source, req.body), ...service.view() })));
  router.delete("/sources/:source", guarded((req) => {
    service.deleteSource(req.params.source);
    return service.view();
  }));
  /** One real question through the source. Always 200: a failure is the result ({ ok: false, error, message }). */
  router.post("/sources/:source/test", async (req, res) => {
    res.json(await service.test(req.params.source));
  });
  return router;
}
