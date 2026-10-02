import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { AgentHost } from "./host.js";
import { baseUrl } from "../config.js";
import { diffPatch, findRepo, workingChanges } from "./git.js";
import type { ChatImage, ContextChip, ProviderId, Thread, ThreadScope } from "./types.js";
import { isPlainRecord } from "./types.js";

/** /api/agent/* for the board shell. The content origin gate keeps tab pages out of these. */
export function agentRouter(host: AgentHost): express.Router {
  const router = express.Router();
  router.use(shellOnly);
  router.use(express.json({ limit: "40mb" }));

  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
    (req: express.Request, res: express.Response) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .then((result) => {
          if (!res.headersSent) res.json(result ?? { ok: true });
        })
        .catch((err: Error) => {
          if (res.headersSent) return;
          const status = /not found/.test(err.message) ? 404 : 400;
          res.status(status).json({ error: err.message });
        });
    };

  router.get(
    "/config",
    wrap(async () => ({
      providers: await host.providerStatus(),
      prefs: host.prefs(),
      models: { claude: host.cachedModels("claude"), cursor: host.cachedModels("cursor") },
    }))
  );

  router.put(
    "/prefs",
    wrap((req) => host.setPrefs(isPlainRecord(req.body) ? (req.body as never) : {}))
  );

  router.get(
    "/models",
    wrap(async (req) => {
      const provider = parseProvider(req.query.provider);
      return { provider, models: await host.models(provider, req.query.refresh === "1") };
    })
  );

  router.get("/threads", wrap(() => ({ threads: host.listThreads() })));

  router.get("/commands", wrap((req) => ({ commands: host.providerCommands(parseProvider(req.query.provider)) })));

  router.post(
    "/threads",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return {
        thread: host.createThread({
          ...threadPatch(body),
          ...(body.scope ? { scope: parseScope(body.scope) } : {}),
        }),
      };
    })
  );

  router.post(
    "/warm",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      host.warmDraft({ ...threadPatch(body), ...(body.scope ? { scope: parseScope(body.scope) } : {}) });
      return { ok: true };
    })
  );

  router.post(
    "/threads/:id/warm",
    wrap(async (req) => {
      await host.warm(req.params.id);
      return { ok: true };
    })
  );

  router.get(
    "/threads/:id",
    wrap((req) => {
      const detail = host.threadDetail(req.params.id);
      if (!detail) throw new Error(`thread not found: ${req.params.id}`);
      return detail;
    })
  );

  router.patch(
    "/threads/:id",
    wrap((req) => ({ thread: host.updateThread(req.params.id, threadPatch(isPlainRecord(req.body) ? req.body : {})) }))
  );

  router.delete(
    "/threads/:id",
    wrap(async (req) => {
      await host.deleteThread(req.params.id);
      return { ok: true };
    })
  );

  router.post(
    "/threads/:id/read",
    wrap((req) => {
      host.markRead(req.params.id);
      return { ok: true };
    })
  );

  router.post(
    "/threads/:id/messages",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const images: ChatImage[] = Array.isArray(body.images)
        ? body.images
            .filter(isPlainRecord)
            .map((img) => ({ name: String(img.name ?? "image"), mimeType: String(img.mimeType ?? "image/png"), data: String(img.data ?? "") }))
            .filter((img) => img.data && /^image\//.test(img.mimeType))
        : [];
      const context = Array.isArray(body.context) ? (body.context.filter(isPlainRecord) as ContextChip[]) : [];
      return host.send(req.params.id, { text: String(body.text ?? ""), images, context });
    })
  );

  router.post(
    "/threads/:id/cancel",
    wrap(async (req) => {
      await host.cancel(req.params.id);
      return { ok: true };
    })
  );

  // Enter on an empty composer while a turn runs: steer the first queued message in (again: send it now).
  router.post("/threads/:id/steer", wrap((req) => host.steer(req.params.id)));

  // Up on an empty composer: take the latest queued (or waiting steered) message back for editing.
  router.post("/threads/:id/withdraw", wrap((req) => host.withdraw(req.params.id)));

  router.post(
    "/threads/:id/send-now",
    wrap(async (req) => {
      await host.sendNow(req.params.id);
      return { ok: true };
    })
  );

  router.get("/threads/:id/commands", wrap(async (req) => ({ commands: await host.commands(req.params.id) })));

  router.get(
    "/threads/:id/changes",
    wrap((req) => host.changes(req.params.id, typeof req.query.turn === "string" && req.query.turn ? req.query.turn : undefined))
  );

  router.get(
    "/threads/:id/patch",
    wrap((req) =>
      host.patch(
        req.params.id,
        typeof req.query.turn === "string" && req.query.turn ? req.query.turn : undefined,
        typeof req.query.path === "string" && req.query.path ? req.query.path : undefined
      )
    )
  );

  router.post("/threads/:id/turns/:turnId/revert", wrap((req) => host.revertTurn(req.params.id, req.params.turnId)));
  router.post("/threads/:id/turns/:turnId/revert-page", wrap((req) => host.revertPage(req.params.id, req.params.turnId)));

  router.post(
    "/approvals/:requestId",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      host.resolveApproval(req.params.requestId, String(body.optionId ?? ""), typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined);
      return { ok: true };
    })
  );

  router.post(
    "/questions/:requestId",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      if (body.skip === true) {
        host.resolveQuestion(req.params.requestId, { skipped: true, reason: typeof body.reason === "string" ? body.reason : undefined });
      } else {
        const answers: Record<string, string[]> = {};
        if (isPlainRecord(body.answers)) {
          for (const [key, value] of Object.entries(body.answers)) {
            answers[key] = Array.isArray(value) ? value.map(String) : [String(value)];
          }
        }
        const notes: Record<string, string> = {};
        if (isPlainRecord(body.notes)) {
          for (const [key, value] of Object.entries(body.notes)) {
            if (typeof value === "string" && value.trim()) notes[key] = value.trim();
          }
        }
        host.resolveQuestion(req.params.requestId, { answers, ...(Object.keys(notes).length ? { notes } : {}) });
      }
      return { ok: true };
    })
  );

  router.post(
    "/plans/:requestId",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      host.resolvePlan(req.params.requestId, { accepted: body.accepted === true, note: typeof body.note === "string" ? body.note : undefined });
      return { ok: true };
    })
  );

  router.get(
    "/git",
    wrap(async (req) => {
      const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
      const repo = await findRepo(cwd);
      if (!repo) return { repo: null, files: [] };
      const changes = await workingChanges(repo);
      return changes ? { repo, ...changes } : { repo, files: [], error: "Could not read the working copy" };
    })
  );

  router.get(
    "/git/patch",
    wrap(async (req) => {
      const repo = await findRepo(typeof req.query.repo === "string" ? req.query.repo : "");
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      if (!repo || !/^[0-9a-f]{40,64}$/.test(from) || !/^[0-9a-f]{40,64}$/.test(to)) throw new Error("repo, from and to are required");
      const file = typeof req.query.path === "string" && req.query.path ? [req.query.path] : [];
      return diffPatch(repo, from, to, file);
    })
  );

  /** Folder browser for the workspace picker. */
  router.get(
    "/fs",
    wrap(async (req) => {
      const raw = typeof req.query.path === "string" ? req.query.path.trim() : "";
      if (!raw) {
        if (process.platform === "win32") {
          const drives = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((d) => `${d}:\\`).filter((d) => fs.existsSync(d));
          return { path: "", parent: null, dirs: drives.map((d) => ({ name: d, path: d })), repo: null };
        }
        return listDir("/");
      }
      return listDir(raw);
    })
  );

  return router;
}

/**
 * Writes must come from the board shell: JSON (a cross-origin form cannot send it without a
 * preflight) and, when the browser says where it came from, the shell's own origin. Tab pages
 * live on another origin, so this also keeps a page from starting or answering agent runs.
 */
function shellOnly(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  const origin = req.get("origin");
  if (origin && origin !== baseUrl()) {
    res.status(403).json({ error: "Agent requests must come from the board" });
    return;
  }
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Agent requests must be JSON" });
    return;
  }
  next();
}

async function listDir(dir: string): Promise<{ path: string; parent: string | null; dirs: Array<{ name: string; path: string }>; repo: string | null; exists: boolean }> {
  // "C:" alone means the current directory on C:, not its root.
  const abs = path.resolve(/^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir);
  let entries: fs.Dirent[] = [];
  let exists = true;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    exists = false;
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && !entry.name.startsWith("$"))
    .map((entry) => ({ name: entry.name, path: path.join(abs, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, 500);
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? "" : parent, dirs, repo: exists ? await findRepo(abs) : null, exists };
}

function parseProvider(value: unknown): ProviderId {
  if (value === "claude" || value === "cursor") return value;
  throw new Error("provider must be claude or cursor");
}

function parseScope(value: unknown): ThreadScope {
  if (!isPlainRecord(value)) return { kind: "global", ref: null };
  const kind = value.kind;
  if (kind === "workspace" || kind === "folder" || kind === "page") {
    const ref = typeof value.ref === "string" && value.ref ? value.ref : null;
    if (!ref) throw new Error(`${kind} scope needs a ref`);
    return { kind, ref: kind === "workspace" ? path.normalize(ref) : ref };
  }
  return { kind: "global", ref: null };
}

function threadPatch(body: Record<string, unknown>): Partial<Thread> {
  const patch: Partial<Thread> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (body.provider === "claude" || body.provider === "cursor") patch.provider = body.provider;
  if (typeof body.model === "string" && body.model) patch.model = body.model;
  if (body.effort === null || typeof body.effort === "string") patch.effort = (body.effort as string | null) || null;
  if (isPlainRecord(body.modelParams)) {
    patch.modelParams = Object.fromEntries(Object.entries(body.modelParams).map(([k, v]) => [k, String(v)]));
  }
  if (body.mode === "code" || body.mode === "ask" || body.mode === "plan" || body.mode === "board") patch.mode = body.mode;
  if (body.approval === "ask" || body.approval === "edits" || body.approval === "auto" || body.approval === "full") patch.approval = body.approval;
  if (typeof body.web === "boolean") patch.web = body.web;
  if (body.cwd === null || typeof body.cwd === "string") {
    const cwd = (body.cwd as string | null) || null;
    if (cwd && !fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    patch.cwd = cwd;
  }
  if (body.scope !== undefined) patch.scope = parseScope(body.scope);
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  return patch;
}
