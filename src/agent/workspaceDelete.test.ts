import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Item, Turn } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-wsdel-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;
const gone = path.join(dir, "gone");
const kept = path.join(dir, "kept");

before(() => {
  fs.mkdirSync(gone);
  fs.mkdirSync(kept);
  store.load();
  host = new AgentHost(() => {});
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A thread in `cwd` with one finished turn: a typed message, an answer and a tool call. */
function threadWithTurn(cwd: string): string {
  const thread = host.createThread({ provider: "pi", mode: "code", scope: { kind: "global", ref: null }, cwd });
  const turn: Turn = {
    id: `tu_${thread.id}`,
    threadId: thread.id,
    seq: 1,
    status: "done",
    model: "m",
    effort: null,
    mode: "code",
    startedAt: 1000,
    endedAt: 3000,
    usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20, costUsd: 0.25 },
    files: [{ path: "secret.ts", status: "M", added: 3, removed: 1 }],
  };
  const base = { threadId: thread.id, turnId: turn.id, createdAt: 1000 };
  const items = [
    { ...base, id: `u_${thread.id}`, seq: 1, kind: "user", text: "the secret plan" },
    { ...base, id: `t_${thread.id}`, seq: 2, kind: "text", text: "a private answer" },
    { ...base, id: `x_${thread.id}`, seq: 3, kind: "tool", toolId: "x", name: "`cat secret.ts`", tool: "execute", title: "cat secret.ts", status: "done", output: "x".repeat(40), startedAt: 1000, endedAt: 1500 },
    { ...base, id: `y_${thread.id}`, seq: 4, kind: "tool", toolId: "y", name: "`rm secret.ts`", tool: "execute", title: "rm secret.ts", status: "error", startedAt: 1500, endedAt: 1600 },
  ] as Item[];
  const internals = host as unknown as { turns: Map<string, Turn[]>; items: Map<string, Item[]> };
  internals.turns.get(thread.id)?.push(turn);
  internals.items.get(thread.id)?.push(...items);
  return thread.id;
}

test("hiding a workspace takes it out of the recent ones, and starting a thread there shows it again", () => {
  host.createThread({ provider: "pi", scope: { kind: "global", ref: null }, cwd: kept });
  assert.equal(host.prefs().recentWorkspaces[0], kept);
  const prefs = host.setWorkspaceHidden(kept, true);
  assert.deepEqual(prefs.hiddenWorkspaces, [kept]);
  assert.equal(prefs.recentWorkspaces.includes(kept), false);
  // Hiding twice keeps one entry.
  assert.deepEqual(host.setWorkspaceHidden(kept.toUpperCase(), true).hiddenWorkspaces.length, 1);
  // A page's own threads (board workers) leave the choice alone.
  host.createThread({ provider: "pi", scope: { kind: "global", ref: null }, cwd: kept }, { remember: false });
  assert.equal(host.prefs().hiddenWorkspaces.length, 1);
  host.createThread({ provider: "pi", scope: { kind: "global", ref: null }, cwd: kept });
  assert.deepEqual(host.prefs().hiddenWorkspaces, []);
  host.setWorkspaceHidden(kept, true);
  assert.deepEqual(host.setWorkspaceHidden(kept, false).hiddenWorkspaces, []);
});

test("deleting a workspace removes its threads and keeps their numbers", async () => {
  const stay = threadWithTurn(kept);
  const a = threadWithTurn(gone);
  const helper = threadWithTurn(kept);
  (host as unknown as { threads: Map<string, { helperOf?: string }> }).threads.get(helper)!.helperOf = a;
  host.setWorkspaceHidden(gone, true);
  const before = host.harnessStats(null);

  const result = await host.deleteWorkspace(gone);
  assert.equal(result.threads, 2);
  assert.deepEqual(result.prefs.hiddenWorkspaces, []);
  assert.equal(result.prefs.recentWorkspaces.includes(gone), false);
  const left = host.listThreads().map((t) => t.id);
  assert.equal(left.includes(a), false);
  assert.equal(left.includes(helper), false);
  assert.equal(left.includes(stay), true);
  assert.equal(fs.existsSync(gone), true);

  const stats = host.deletedThreadStats();
  assert.deepEqual(stats.map((s) => s.id).sort(), [a, helper].sort());
  const one = stats.find((s) => s.id === a)!;
  assert.equal(one.workspace, gone);
  assert.equal(one.provider, "pi");
  assert.equal(one.usage?.costUsd, 0.25);
  assert.deepEqual(one.messages.user, { count: 1, chars: 15 });
  assert.deepEqual(one.messages.text, { count: 1, chars: 16 });
  assert.deepEqual(one.turns.map((t) => [t.files, t.added, t.removed, t.endedAt]), [[1, 3, 1, 3000]]);
  assert.deepEqual(one.tools, [{ turnId: `tu_${a}`, name: "(shell command)", tool: "execute", calls: 2, errors: 1, inputChars: 0, outputChars: 40, outputTokens: 10, ms: 600 }]);
  assert.equal(stats.find((s) => s.id === helper)!.helperOf, a);
  // Nothing anyone wrote is kept.
  assert.doesNotMatch(JSON.stringify(stats), /secret|private/);

  // The usage totals still count them; only the list of threads to open drops them.
  const now = host.harnessStats(null);
  assert.deepEqual(now.totals, before.totals);
  assert.equal(now.threads, before.threads);
  assert.deepEqual(now.toolKinds, before.toolKinds);
  assert.deepEqual(now.heavy.map((h) => h.id), [stay]);
});
