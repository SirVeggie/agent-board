import fs from "node:fs";
import path from "node:path";
import express from "express";
import { listPermissions, setRules } from "./permissions.js";
import type { AgentHost } from "./host.js";
import { baseUrl } from "../config.js";
import { browserInput, browserViews, closeThreadBrowser, watchBrowser, type BrowserInput } from "../browser.js";
import { diffPatch, findRepo, workingChanges } from "./git.js";
import { searchWorkspaceFiles } from "./workspaceFiles.js";
import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_IMAGE_BYTES, MAX_MESSAGE_BYTES, filePath, guessMimeType, isTextFile } from "./attachments.js";
import type { ChatFile, ChatImage, ContextChip, ProviderId, Thread, ThreadScope } from "./types.js";
import { isPlainRecord, isProviderId } from "./types.js";
import { parseWebAccess } from "./webAccess.js";

/** /api/agent/* for the board shell. The content origin gate keeps tab pages out of these. */
export function agentRouter(host: AgentHost): express.Router {
  const router = express.Router();
  router.use(shellOnly);
  // Room for a message's files as base64 (MAX_MESSAGE_BYTES, plus a third).
  router.use(express.json({ limit: "80mb" }));

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
      models: { claude: host.cachedModels("claude"), cursor: host.cachedModels("cursor"), codex: host.cachedModels("codex"), pi: host.cachedModels("pi") },
      limits: host.limits(),
    }))
  );

  // Cursor's browser login (the SDK's Cursor.auth.login); the URL also opens in the system browser.
  router.post("/cursor/login", wrap(() => host.cursorLogin()));
  // Codex's ChatGPT login (bundled `codex login`); the URL also opens in the system browser.
  router.post("/codex/login", wrap(() => host.codexLogin()));

  // The providers' own allow / deny / ask lists (Claude Code settings, Cursor CLI config).
  router.get("/permissions", wrap((req) => ({ sets: listPermissions(typeof req.query.cwd === "string" ? req.query.cwd : null) })));

  router.put(
    "/permissions",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const provider = body.provider === "cursor" ? "cursor" : body.provider === "claude" ? "claude" : null;
      if (!provider) throw new Error("Unknown provider");
      const scope = body.scope === "project" || body.scope === "local" ? body.scope : "user";
      const kind = body.kind === "deny" || body.kind === "ask" ? body.kind : "allow";
      return { set: setRules({ provider, scope, kind, cwd: typeof body.cwd === "string" ? body.cwd : null, rules: body.rules }) };
    })
  );

  router.put(
    "/prefs",
    wrap((req) => host.setPrefs(isPlainRecord(req.body) ? (req.body as never) : {}))
  );

  router.post(
    "/prefs/remember",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return {
        prefs: host.rememberDraft({
          ...threadPatch(body),
          ...(body.scope ? { scope: parseScope(body.scope) } : {}),
        }),
      };
    })
  );

  router.get(
    "/models",
    wrap(async (req) => {
      const provider = parseProvider(req.query.provider);
      return { provider, models: await host.models(provider, req.query.refresh === "1") };
    })
  );

  // Native harness model sources (OpenAI-compatible endpoints). API keys go in, never out: the list only says whether one is set.
  router.get("/model-sources", wrap(() => ({ sources: host.modelSourceViews() })));
  router.post("/model-sources", wrap((req) => ({ source: host.saveModelSource(null, req.body) })));
  router.put("/model-sources/:id", wrap((req) => ({ source: host.saveModelSource(req.params.id, req.body) })));
  router.delete(
    "/model-sources/:id",
    wrap((req) => {
      host.deleteModelSource(req.params.id);
      return { ok: true };
    })
  );

  router.get("/threads", wrap(() => ({ threads: host.listThreads() })));

  router.get("/commands", wrap((req) => ({ commands: host.providerCommands(parseProvider(req.query.provider)) })));

  router.post(
    "/threads",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return {
        thread: host.createThread(
          {
            ...threadPatch(body),
            ...(body.scope ? { scope: parseScope(body.scope) } : {}),
          },
          { remember: body.remember !== false }
        ),
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
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      // revokeGrant: a key from the thread's grants, taken back before the other fields apply.
      const patch = threadPatch(body);
      if (typeof body.revokeGrant === "string") {
        const thread = host.revokeGrant(req.params.id, body.revokeGrant);
        if (!Object.keys(patch).length) return { thread };
      }
      return { thread: host.updateThread(req.params.id, patch) };
    })
  );

  router.delete(
    "/threads/:id",
    wrap(async (req) => {
      await host.deleteThread(req.params.id);
      return { ok: true };
    })
  );

  router.post(
    "/threads/:id/fork",
    wrap((req) => {
      const patch = threadPatch(isPlainRecord(req.body) ? req.body : {});
      return { thread: host.fork(req.params.id, { provider: patch.provider, model: patch.model, mode: patch.mode }) };
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
      const files: ChatFile[] = Array.isArray(body.files)
        ? body.files
            .filter(isPlainRecord)
            .map((file) => {
              const name = String(file.name ?? "file");
              return { name, mimeType: guessMimeType(name, String(file.mimeType ?? "")), data: String(file.data ?? "") };
            })
            .filter((file) => file.data)
        : [];
      if (images.length + files.length > MAX_FILES_PER_MESSAGE) throw new Error(`Up to ${MAX_FILES_PER_MESSAGE} files per message`);
      let total = 0;
      for (const file of [...images, ...files]) {
        const bytes = Math.floor((file.data.length * 3) / 4);
        const max = file.mimeType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        if (bytes > max) throw new Error(`${file.name} is over ${max / 1024 / 1024} MB`);
        total += bytes;
      }
      if (total > MAX_MESSAGE_BYTES) throw new Error(`A message's files must add up to under ${MAX_MESSAGE_BYTES / 1024 / 1024} MB`);
      const context = Array.isArray(body.context) ? (body.context.filter(isPlainRecord) as ContextChip[]) : [];
      // The board sends from: "page" for messages a page's own code sent through board.agent.
      return host.send(req.params.id, { text: String(body.text ?? ""), images, files, context, ...(body.from === "page" ? { from: "page" as const } : {}) });
    })
  );

  // A Kanban board's card comment for the thread working on the card, or Continue for the one that worked on it.
  router.post(
    "/threads/:id/card-message",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const num = Number(body.num);
      const board = String(body.board ?? "").trim();
      if (!Number.isInteger(num) || num < 1 || !board) throw new Error("A card number and board are required");
      const title = String(body.title ?? "").trim().slice(0, 200);
      const boardKey = String(body.boardKey ?? "").trim();
      const card = { num, board: board.slice(0, 200), ...(title ? { title } : {}), ...(boardKey ? { boardKey } : {}), ...(body.resume === true ? { resume: true } : {}) };
      return host.cardMessage(req.params.id, card, String(body.text ?? ""));
    })
  );

  // A file sent with a message, for the chat's previews. Shown inline; download is the viewer's choice.
  router.get(
    "/threads/:id/files/:fileId",
    wrap(async (req, res) => {
      const full = filePath(req.params.id, req.params.fileId);
      if (!full) throw new Error("File not found");
      const name = path.basename(full);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Text and HTML come back as plain text, so a preview never runs a sent file's scripts.
      res.type(isTextFile(name, "") ? "text/plain; charset=utf-8" : path.extname(name) || "application/octet-stream");
      await new Promise<void>((resolve, reject) => res.sendFile(full, (err) => (err ? reject(err) : resolve())));
    })
  );

  router.post(
    "/threads/:id/cancel",
    wrap(async (req) => {
      await host.cancel(req.params.id);
      return { ok: true };
    })
  );

  // Back to just before a message of the user's; the reply carries the message for editing or sending again.
  router.post(
    "/threads/:id/rewind",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      return host.rewind(req.params.id, String(body.itemId ?? ""), { keepChanges: body.keepChanges === true });
    })
  );

  // A subagent or background command, by the id of the tool item that started it.
  router.post(
    "/threads/:id/tasks/:itemId/stop",
    wrap(async (req) => {
      await host.stopTask(req.params.id, req.params.itemId);
      return { ok: true };
    })
  );
  router.post("/threads/:id/tasks/:itemId/background", wrap((req) => host.backgroundTask(req.params.id, req.params.itemId)));

  // Enter on an empty composer while a turn runs: steer the first queued message in (again: send it now).
  router.post(
    "/threads/:id/steer",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const itemId = typeof body.itemId === "string" && body.itemId ? body.itemId : undefined;
      return host.steer(req.params.id, itemId);
    })
  );

  // Up on an empty composer: take the latest queued (or waiting steered) message back for editing.
  router.post("/threads/:id/withdraw", wrap((req) => host.withdraw(req.params.id, typeof req.body?.itemId === "string" ? req.body.itemId : undefined)));
  router.post("/threads/:id/queued/:itemId/edit", wrap((req) => host.beginQueuedEdit(req.params.id, req.params.itemId, req.body?.recover === true)));
  router.post("/threads/:id/queued/:itemId/edit-finish", wrap((req) => {
    if (typeof req.body?.token !== "string" || (req.body.text !== undefined && typeof req.body.text !== "string")) throw new Error("Invalid edit");
    host.finishQueuedEdit(req.params.id, req.params.itemId, req.body.token, req.body.text);
    return { ok: true };
  }));

  router.post(
    "/threads/:id/send-now",
    wrap(async (req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      const itemId = typeof body.itemId === "string" && body.itemId ? body.itemId : undefined;
      await host.sendNow(req.params.id, itemId);
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

  router.get("/threads/:id/worktree", wrap((req) => host.worktreeInfo(req.params.id)));

  // The thread's agent browser, watched and driven from the chat (the agent drives it over MCP).
  router.get("/browsers", wrap(async () => ({ browsers: await browserViews() })));
  router.get("/threads/:id/browser/live", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const stop = watchBrowser(
      req.params.id,
      (frame) => send("frame", frame),
      (view) => send("view", view)
    );
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      stop();
    });
  });
  router.post("/threads/:id/browser/input", wrap((req) => browserInput(req.params.id, req.body as BrowserInput)));
  router.post("/threads/:id/browser/close", wrap(async (req) => {
    await closeThreadBrowser(req.params.id);
    return { ok: true };
  }));

  // Finish a thread's worktree: merge its branch into the base, or leave the branch for later.
  router.post(
    "/threads/:id/worktree",
    wrap((req) => {
      const body = isPlainRecord(req.body) ? req.body : {};
      if (body.action !== "merge" && body.action !== "leave") throw new Error("action must be merge or leave");
      return host.finishWorktree(req.params.id, body.action);
    })
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
      // A worktree thread compares against the commit its branch started from, so its commits show too.
      const base = typeof req.query.base === "string" && /^[0-9a-f]{40,64}$/.test(req.query.base) ? req.query.base : undefined;
      const changes = await workingChanges(repo, base);
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

  /** Files under a workspace for the composer's @-mention picker. */
  router.get(
    "/fs/files",
    wrap(async (req) => {
      const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
      const query = typeof req.query.query === "string" ? req.query.query : "";
      const raw = Number(req.query.limit);
      const limit = Number.isFinite(raw) ? raw : undefined;
      return { files: await searchWorkspaceFiles(cwd, query, limit) };
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
  if (isProviderId(value)) return value;
  throw new Error("provider must be claude, cursor, codex, or pi");
}

function parseScope(value: unknown): ThreadScope {
  if (!isPlainRecord(value)) return { kind: "global", ref: null };
  const kind = value.kind;
  if (kind === "workspace" || kind === "folder" || kind === "page") {
    const ref = typeof value.ref === "string" && value.ref ? value.ref : null;
    // A workspace scope is a thread with no Scribe scope; with no folder it has no workspace either.
    if (kind === "workspace") return { kind, ref: ref ? path.normalize(ref) : null };
    if (!ref) throw new Error(`${kind} scope needs a ref`);
    return { kind, ref };
  }
  return { kind: "global", ref: null };
}

function threadPatch(body: Record<string, unknown>): Partial<Thread> {
  const patch: Partial<Thread> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (isProviderId(body.provider)) patch.provider = body.provider;
  if (typeof body.model === "string" && body.model) patch.model = body.model;
  if (body.effort === null || typeof body.effort === "string") patch.effort = (body.effort as string | null) || null;
  if (isPlainRecord(body.modelParams)) {
    patch.modelParams = Object.fromEntries(Object.entries(body.modelParams).map(([k, v]) => [k, String(v)]));
  }
  if (body.mode === "code" || body.mode === "ask" || body.mode === "plan" || body.mode === "board") patch.mode = body.mode;
  if (body.approval === "ask" || body.approval === "edits" || body.approval === "auto" || body.approval === "full") patch.approval = body.approval;
  const web = parseWebAccess(body.web);
  if (web) patch.web = web;
  if (typeof body.useWorktree === "boolean") patch.useWorktree = body.useWorktree;
  if (body.cwd === null || typeof body.cwd === "string") {
    const cwd = (body.cwd as string | null) || null;
    if (cwd && !fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    patch.cwd = cwd;
  }
  if (body.scope !== undefined) patch.scope = parseScope(body.scope);
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.archived === "boolean") patch.archived = body.archived;
  if (body.draft === null) patch.draft = null;
  else if (isPlainRecord(body.draft) && typeof body.draft.text === "string") {
    const context = Array.isArray(body.draft.context) ? (body.draft.context.filter(isPlainRecord) as ContextChip[]) : [];
    patch.draft = { text: body.draft.text.slice(0, MAX_DRAFT_TEXT), ...(context.length ? { context } : {}) };
  }
  return patch;
}

/** Most unsent composer text a thread keeps. */
const MAX_DRAFT_TEXT = 200_000;
