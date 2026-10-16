import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import type { HookRule } from "./hooks.js";
import type { ApprovalRequest, RunSink } from "./providers/provider.js";
import type { ItemBody } from "./types.js";

// A hook's ask in a chat nobody watches (a board worker's) is refused after a wait, like a web request.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-hook-ask-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => {});
  host.setPrefs({ hookRules: [{ id: "r1", enabled: true, match: "keyword", event: "tool_call", pattern: "deploy", action: "ask" }] as HookRule[] });
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
  makeSink(threadId: string, run: unknown): RunSink;
};
const internals = () => host as unknown as Internals;

/** A thread with a running turn; fromPage makes it look like a board worker's chat. */
function runningThread(fromPage: boolean): string {
  const thread = host.createThread({ provider: "codex", approval: "full", scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
  internals().turns.get(thread.id)?.push(turn);
  internals().runs.set(thread.id, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null, hooks: { lastUser: "", dock: false, called: new Set(), gated: new Set(), approved: new Set(), waiting: new Map(), told: new Set(), earlyItem: null } });
  if (fromPage) internals().addItem(thread.id, turn.id, { kind: "user", text: "Take card #1", from: "page" } as ItemBody);
  return thread.id;
}

function pendingApprovals(threadId: string) {
  return (host.threadDetail(threadId)?.items ?? []).filter((it) => it.kind === "approval" && it.status === "pending");
}

async function shown(threadId: string) {
  for (let i = 0; i < 50 && !pendingApprovals(threadId).length; i += 1) await new Promise((r) => setImmediate(r));
  const [item] = pendingApprovals(threadId);
  assert.ok(item && item.kind === "approval");
  return item;
}

const WAIT = 15 * 60 * 1000;
const request: ApprovalRequest = {
  toolId: "c1",
  tool: "execute",
  title: "Run command",
  detail: "deploy prod",
  options: [
    { id: "accept", label: "Allow once", kind: "allow_once" },
    { id: "decline", label: "Decline", kind: "reject_once" },
  ],
};

test("a held call's ask in a worker's chat is refused once nobody answers in time", async () => {
  const threadId = runningThread(true);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const gate = host.toolGate(threadId, { toolId: "b1", name: "Bash", tool: "execute", title: "deploy prod" });
    const item = await shown(threadId);
    assert.match(item.detail ?? "", /Refused if not answered by/);
    mock.timers.tick(WAIT);
    const result = await gate;
    assert.equal(result.allowed, false);
    assert.match(result.allowed ? "" : result.reason ?? "", /in time/);
    assert.equal(pendingApprovals(threadId).length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("an approval a hook asks about in a worker's chat is declined once nobody answers in time", async () => {
  const threadId = runningThread(true);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sink = internals().makeSink(threadId, internals().runs.get(threadId));
    const decision = sink.approval(request);
    const item = await shown(threadId);
    assert.match(item.detail ?? "", /Refused if not answered by/);
    mock.timers.tick(WAIT);
    const answer = await decision;
    assert.equal(answer.optionId, "decline");
    assert.match(answer.note ?? "", /in time/);
  } finally {
    mock.timers.reset();
  }
});

test("in a user's chat a hook's ask waits for the user", async () => {
  const threadId = runningThread(false);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const gate = host.toolGate(threadId, { toolId: "b1", name: "Bash", tool: "execute", title: "deploy prod" });
    const item = await shown(threadId);
    assert.doesNotMatch(item.detail ?? "", /Refused if not answered/);
    mock.timers.tick(WAIT * 4);
    await new Promise((r) => setImmediate(r));
    assert.equal(pendingApprovals(threadId).length, 1);
    host.resolveApproval(item.requestId || item.id, "allow");
    assert.deepEqual(await gate, { allowed: true });
  } finally {
    mock.timers.reset();
  }
});
