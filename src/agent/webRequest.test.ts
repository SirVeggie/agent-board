import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import type { ItemBody } from "./types.js";

// The host and the store keep their data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-web-"));
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

type Internals = {
  runs: Map<string, unknown>;
  turns: Map<string, unknown[]>;
  addItem(threadId: string, turnId: string | null, body: ItemBody): unknown;
};

/** A thread with web off and a running turn; fromPage makes it look like a board worker's chat. */
function runningThread(fromPage = false): string {
  const thread = host.createThread({ provider: "claude", web: "off", scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
  const internals = host as unknown as Internals;
  internals.turns.get(thread.id)?.push(turn);
  internals.runs.set(thread.id, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null });
  if (fromPage) internals.addItem(thread.id, turn.id, { kind: "user", text: "Take card #1", from: "page" } as ItemBody);
  return thread.id;
}

function pendingApprovals(threadId: string) {
  return (host.threadDetail(threadId)?.items ?? []).filter((it) => it.kind === "approval" && it.status === "pending");
}

/** Wait until the request shows in the chat, then answer it. */
async function answer(threadId: string, optionId: string): Promise<void> {
  for (let i = 0; i < 50 && !pendingApprovals(threadId).length; i += 1) await new Promise((r) => setImmediate(r));
  const [item] = pendingApprovals(threadId);
  assert.ok(item && item.kind === "approval");
  host.resolveApproval(item.requestId || item.id, optionId);
}

test("web off asks with once, domain, thread and deny; a domain answer covers later calls there", async () => {
  const threadId = runningThread();
  const first = host.requestWeb(threadId, { kind: "fetch", url: "https://www.example.com/a" });
  await new Promise((r) => setImmediate(r));
  const [item] = pendingApprovals(threadId);
  assert.ok(item && item.kind === "approval");
  assert.deepEqual(
    item.options.map((o) => o.id),
    ["once", "domain", "session", "deny"]
  );
  assert.match(item.options[1].label, /example\.com/);
  host.resolveApproval(item.requestId || item.id, "domain");
  assert.deepEqual(await first, { allowed: true });
  assert.deepEqual(await host.requestWeb(threadId, { kind: "fetch", url: "https://docs.example.com/b" }), { allowed: true });
  assert.equal(pendingApprovals(threadId).length, 0);

  const other = host.requestWeb(threadId, { kind: "fetch", url: "https://elsewhere.org/" });
  await answer(threadId, "deny");
  const refused = await other;
  assert.equal(refused.allowed, false);
  assert.match(refused.message ?? "", /denied/);
});

test("allowing for the thread covers every call, searches too", async () => {
  const threadId = runningThread();
  const first = host.requestWeb(threadId, { kind: "search", query: "node test runner" });
  await answer(threadId, "session");
  assert.equal((await first).allowed, true);
  assert.equal((await host.requestWeb(threadId, { kind: "fetch", url: "https://anything.dev/" })).allowed, true);
  assert.equal(host.getThread(threadId)?.webGrants?.all, true);

  // The chat lists the grant and can take it back; the next call asks again.
  assert.throws(() => host.revokeGrant(threadId, "web:example.com"), /no such permission/);
  assert.equal(host.revokeGrant(threadId, "web:*").grants, undefined);
  const again = host.requestWeb(threadId, { kind: "fetch", url: "https://anything.dev/" });
  await answer(threadId, "deny");
  assert.equal((await again).allowed, false);
});

test("web_request's allow once lets the next matching call through, once", async () => {
  const threadId = runningThread();
  const ahead = host.preRequestWeb(threadId, { kind: "fetch", url: "https://example.net/x" }, { importance: "important", reason: "Read the docs" });
  await new Promise((r) => setImmediate(r));
  const [item] = pendingApprovals(threadId);
  assert.ok(item && item.kind === "approval");
  assert.match(item.detail ?? "", /important/);
  assert.match(item.detail ?? "", /Read the docs/);
  host.resolveApproval(item.requestId || item.id, "once");
  assert.equal((await ahead).allowed, true);
  assert.equal((await host.requestWeb(threadId, { kind: "fetch", url: "https://example.net/y" })).allowed, true);
  const again = host.requestWeb(threadId, { kind: "fetch", url: "https://example.net/z" });
  await answer(threadId, "deny");
  assert.equal((await again).allowed, false);
});

test("in a board worker's chat an unanswered request is refused after its importance's wait", async () => {
  const threadId = runningThread(true);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const trivial = host.requestWeb(threadId, { kind: "fetch", url: "https://slow.example/" }, { importance: "trivial" });
    await new Promise((r) => setImmediate(r));
    const [item] = pendingApprovals(threadId);
    assert.ok(item && item.kind === "approval");
    assert.match(item.detail ?? "", /Refused if not answered by/);
    mock.timers.tick(2 * 60 * 1000);
    const result = await trivial;
    assert.equal(result.allowed, false);
    assert.match(result.message ?? "", /in time/);
    assert.equal(pendingApprovals(threadId).length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("a necessary request in a worker's chat, and any request in a user's chat, has no deadline", async () => {
  const worker = runningThread(true);
  const necessary = host.requestWeb(worker, { kind: "fetch", url: "https://a.example/" }, { importance: "necessary" });
  const user = runningThread();
  const useful = host.requestWeb(user, { kind: "fetch", url: "https://b.example/" }, { importance: "trivial" });
  await new Promise((r) => setImmediate(r));
  for (const id of [worker, user]) {
    const [item] = pendingApprovals(id);
    assert.ok(item && item.kind === "approval");
    assert.doesNotMatch(item.detail ?? "", /Refused if not answered/);
  }
  await answer(worker, "once");
  await answer(user, "once");
  assert.equal((await necessary).allowed, true);
  assert.equal((await useful).allowed, true);
});
