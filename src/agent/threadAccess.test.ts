import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { allowedGrants, canReadThread, itemText, requestableScopes, scopeCovers, type ScopeLookup } from "./threadAccess.js";
import type { Item, ItemBody, Thread, ThreadScope } from "./types.js";

// The host and the store keep their data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-threads-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => {});
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Folders: f_root > f_sub; page p_a in f_sub, p_b at the root.
const lookup: ScopeLookup = {
  pageFolder: (id) => ({ p_a: "f_sub" })[id] ?? null,
  folderInside: (folder, root) => folder === root || (folder === "f_sub" && root === "f_root"),
};

type T = Pick<Thread, "id" | "cwd" | "worktree" | "scope" | "threadGrants">;
const t = (id: string, scope: ThreadScope, cwd: string | null = null, extra: Partial<T> = {}): T => ({ id, scope, cwd, worktree: null, ...extra });
const ws = path.resolve(dir, "repo");

test("a thread may ask for its workspace and its page or folder; a global thread for everything", () => {
  assert.deepEqual(requestableScopes(t("a", { kind: "page", ref: "p_a" }, ws)), [
    { kind: "workspace", path: process.platform === "win32" ? ws.toLowerCase() : ws },
    { kind: "page", id: "p_a" },
  ]);
  assert.deepEqual(requestableScopes(t("b", { kind: "folder", ref: "f_root" })), [{ kind: "folder", id: "f_root" }]);
  assert.deepEqual(requestableScopes(t("c", { kind: "global", ref: null })), [{ kind: "all" }]);
});

test("a folder scope covers threads on pages and folders inside it; a workspace covers folders below it", () => {
  const folder = { kind: "folder" as const, id: "f_root" };
  assert.equal(scopeCovers(folder, t("x", { kind: "page", ref: "p_a" }), lookup), true);
  assert.equal(scopeCovers(folder, t("x", { kind: "folder", ref: "f_sub" }), lookup), true);
  assert.equal(scopeCovers(folder, t("x", { kind: "page", ref: "p_b" }), lookup), false);
  assert.equal(scopeCovers({ kind: "page", id: "p_a" }, t("x", { kind: "page", ref: "p_a" }), lookup), true);
  const [space] = requestableScopes(t("a", { kind: "global", ref: null }, ws));
  assert.equal(scopeCovers(space, t("x", { kind: "global", ref: null }, path.join(ws, "src")), lookup), true);
  assert.equal(scopeCovers(space, t("x", { kind: "global", ref: null }, path.resolve(dir, "repo-other")), lookup), false);
  const worktree = { home: ws, repo: ws, path: path.resolve(dir, "wt"), branch: "b", base: "master", baseCommit: "c", links: [], createdAt: 0 };
  assert.equal(scopeCovers(space, t("x", { kind: "global", ref: null }, path.resolve(dir, "wt"), { worktree }), lookup), true);
});

test("only granted scopes the thread can still ask for count, and never itself", () => {
  const reader = t("r", { kind: "page", ref: "p_a" }, null, { threadGrants: [{ kind: "page", id: "p_a" }, { kind: "all" }] });
  assert.deepEqual(allowedGrants(reader, reader.threadGrants!), [{ kind: "page", id: "p_a" }]);
  assert.equal(canReadThread(reader, t("o", { kind: "page", ref: "p_a" }), lookup), true);
  assert.equal(canReadThread(reader, t("o", { kind: "page", ref: "p_b" }), lookup), false);
  assert.equal(canReadThread(reader, t("r", { kind: "page", ref: "p_a" }), lookup), false);
  assert.equal(canReadThread({ ...reader, threadGrants: [] }, t("o", { kind: "page", ref: "p_a" }), lookup), false);
});

test("itemText clips long tool output unless full", () => {
  const base = { id: "i", threadId: "t", turnId: null, seq: 1, createdAt: 0 };
  const tool = { ...base, kind: "tool", toolId: "x", name: "Bash", tool: "execute", title: "npm test", status: "done", exitCode: 1, output: "y".repeat(5000), startedAt: 0 } as Item;
  assert.match(itemText(tool)!, /^\[tool Bash exit 1\] npm test\n--- output\ny+… \(3500 more chars\)$/);
  assert.equal(itemText(tool, { full: true })!.includes("more chars"), false);
  assert.equal(itemText({ ...base, kind: "user", text: "hi", dropped: true } as Item), null);
});

type Internals = {
  runs: Map<string, unknown>;
  turns: Map<string, unknown[]>;
  addItem(threadId: string, turnId: string | null, body: ItemBody): unknown;
};

function running(threadId: string): void {
  const turn = { id: `tu_${threadId}`, threadId, seq: 1, status: "running", model: "m", effort: null, mode: "code", startedAt: Date.now() };
  const internals = host as unknown as Internals;
  internals.turns.get(threadId)?.push(turn);
  internals.runs.set(threadId, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null });
}

function pendingApprovals(threadId: string) {
  return (host.threadDetail(threadId)?.items ?? []).filter((it) => it.kind === "approval" && it.status === "pending");
}

async function answer(threadId: string, optionId: string) {
  for (let i = 0; i < 50 && !pendingApprovals(threadId).length; i += 1) await new Promise((r) => setImmediate(r));
  const [item] = pendingApprovals(threadId);
  assert.ok(item && item.kind === "approval");
  host.resolveApproval(item.requestId || item.id, optionId);
  return item;
}

test("thread_list asks first, then lists and searches threads in the workspace; thread_read pages the transcript", async () => {
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  const other = host.createThread({ provider: "claude", scope: { kind: "workspace", ref: ws } });
  const outside = host.createThread({ provider: "claude", scope: { kind: "workspace", ref: dir } });
  const internals = host as unknown as Internals;
  internals.addItem(other.id, null, { kind: "user", text: "Fix the flaky test" });
  internals.addItem(other.id, null, { kind: "tool", toolId: "t1", name: "Bash", tool: "execute", title: "npm test", status: "done", exitCode: 0, output: "all green", startedAt: 0 } as ItemBody);
  internals.addItem(other.id, null, { kind: "text", text: "Done: the timer is mocked now." });

  const reader = host.createThread({ provider: "claude", scope: { kind: "workspace", ref: ws } });
  running(reader.id);
  const listing = host.listReadableThreads(reader.id, { q: "npm test" });
  const asked = await answer(reader.id, "all");
  assert.match(asked.kind === "approval" ? asked.title : "", /workspace/);
  const listed = await listing;
  assert.deepEqual(listed.threads.map((row) => row.id), [other.id]);
  assert.equal(listed.threads[0].hits, 1);
  assert.match(String(listed.threads[0].match), /npm test/);

  const read = await host.readOtherThread(reader.id, { thread: other.id, limit: 2 });
  assert.equal(read.total, 3);
  const items = read.items as Array<{ seq: number; text: string }>;
  assert.equal(items.length, 2);
  assert.match(items[0].text, /all green/);
  assert.ok(read.earlier);
  const tools = await host.readOtherThread(reader.id, { thread: other.id, kinds: ["tool"] });
  assert.equal(tools.total, 1);

  await assert.rejects(host.readOtherThread(reader.id, { thread: outside.id }), /outside the scopes/);
});

test("a denied request refuses listing", async () => {
  const reader = host.createThread({ provider: "claude", scope: { kind: "global", ref: null } });
  running(reader.id);
  const listing = host.listReadableThreads(reader.id, {});
  await answer(reader.id, "deny");
  await assert.rejects(listing, /denied/);
});
