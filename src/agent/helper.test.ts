import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { ApprovalPolicy, Thread } from "./types.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-helper-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;
/** What the stub provider's sessions were asked, and how the next turn ends. */
const asked: Array<{ thread: Thread; input: TurnInput }> = [];
let hang: (() => void) | null = null;
let hanging = false;

type Internals = { providers: Record<string, unknown>; runs: Map<string, unknown>; turns: Map<string, unknown[]>; pending: Map<string, { itemId: string }> };

before(() => {
  store.load();
  host = new AgentHost(() => {});
  // A provider that runs no model: a turn answers with one line, or waits for cancel.
  (host as unknown as Internals).providers.pi = {
    id: "pi",
    label: "Native",
    status: async () => ({ id: "pi", label: "Native", available: true }),
    models: async () => [
      { id: "local/qwen-coder", label: "Qwen Coder", provider: "pi", efforts: [], params: [] },
      { id: "local/qwen-small", label: "Qwen Small", provider: "pi", efforts: [], params: [] },
    ],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    createSession: (thread: Thread) => ({
      warm: async () => {},
      update: () => {},
      commands: async () => [],
      dispose: () => {},
      cancel: async () => hang?.(),
      run: async (input: TurnInput, sink: RunSink): Promise<TurnResult> => {
        asked.push({ thread, input });
        if (hanging) {
          await new Promise<void>((resolve) => (hang = resolve));
          return { status: "cancelled" };
        }
        sink.text(`did: ${input.text.split("\n").at(-1)}`);
        return { status: "done" };
      },
    }),
  };
});

after(async () => {
  // A turn's last bookkeeping (page runs, worktree progress) trails the reply by a tick.
  await new Promise((resolve) => setTimeout(resolve, 100));
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function parent(approval: ApprovalPolicy = "full"): string {
  return host.createThread({ provider: "codex", mode: "ask", approval, cwd: null, scope: { kind: "global", ref: null } }).id;
}

/** Give a thread a running turn, so the user can be asked. */
function running(id: string): void {
  const internals = host as unknown as Internals;
  const turn = { id: `tu_${id}`, threadId: id, seq: 1, status: "running", model: "m", effort: null, mode: "ask", startedAt: Date.now() };
  internals.turns.get(id)?.push(turn);
  internals.runs.set(id, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null });
}

test("helpers are refused until the user turns them on", async () => {
  host.setPrefs({ helpers: false });
  await assert.rejects(host.runHelper(parent(), { task: "x", provider: "pi" }), /turned off/);
  await assert.rejects(host.helperModels(parent()), /turned off/);
});

test("a helper runs the brief on the named model with the caller's settings and returns its reply", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  asked.length = 0;
  const result = await host.runHelper(id, { task: "rename foo to bar", provider: "pi", model: "qwen coder" });
  assert.equal(result.status, "done");
  assert.equal(result.reply, "did: rename foo to bar");
  const helper = host.getThread(String(result.thread))!;
  assert.equal(helper.helperOf, id);
  assert.equal(helper.model, "local/qwen-coder");
  assert.equal(helper.mode, "ask");
  assert.equal(helper.approval, "full");
  assert.deepEqual(helper.scope, { kind: "workspace", ref: null });
  assert.match(asked[0].input.text, /A brief from the agent this helper thread works for/);
  assert.match(asked[0].input.instructions, /Helper thread:/);
  assert.doesNotMatch(asked[0].input.instructions, /agent_run/);
  // A helper's finished turn is not the user's unread reply.
  assert.equal(host.listThreads().find((t) => t.id === helper.id)?.unread, false);

  const again = await host.runHelper(id, { task: "now the tests", thread: helper.id });
  assert.equal(again.thread, helper.id);
  assert.equal(again.reply, "did: now the tests");
});

test("a helper cannot start helpers, and only its own thread can send it on", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  const { thread } = await host.runHelper(id, { task: "one", provider: "pi" });
  await assert.rejects(host.runHelper(String(thread), { task: "two", provider: "pi" }), /cannot start helpers/);
  await assert.rejects(host.runHelper(parent(), { task: "two", thread: String(thread) }), /No helper/);
});

test("an unknown or ambiguous model lists the models to pick from", async () => {
  host.setPrefs({ helpers: true });
  await assert.rejects(host.runHelper(parent(), { task: "x", provider: "pi", model: "qwen" }), /matches several pi models\. Pick one of: local\/qwen-coder, local\/qwen-small/);
  await assert.rejects(host.runHelper(parent(), { task: "x", provider: "pi", model: "gpt" }), /No pi model "gpt"/);
  await assert.rejects(host.runHelper(parent(), { task: "x", provider: "nope" }), /provider is required/);
  const { providers } = await host.helperModels(parent(), "pi");
  assert.deepEqual((providers[0].models as Array<{ id: string }>).map((m) => m.id), ["local/qwen-coder", "local/qwen-small"]);
});

test("without full access the user is asked first, and Allow for this thread sticks", async () => {
  host.setPrefs({ helpers: true });
  const id = parent("ask");
  await assert.rejects(host.runHelper(id, { task: "x", provider: "pi" }), /cannot be asked/);
  running(id);
  const internals = host as unknown as Internals;
  const answer = (optionId: string) =>
    setTimeout(() => {
      const req = [...internals.pending.values()].at(-1)!;
      host.resolveApproval(req.itemId, optionId);
    }, 10);
  answer("deny");
  await assert.rejects(host.runHelper(id, { task: "x", provider: "pi" }), /denied the helper/);
  answer("thread");
  assert.equal((await host.runHelper(id, { task: "x", provider: "pi" })).status, "done");
  assert.equal(host.getThread(id)?.helpersAllowed, true);
  assert.equal((await host.runHelper(id, { task: "y", provider: "pi" })).status, "done");
});

test("stopping the caller stops its helper", async () => {
  host.setPrefs({ helpers: true });
  const id = parent();
  hanging = true;
  try {
    const call = host.runHelper(id, { task: "long", provider: "pi" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await host.cancel(id);
    assert.equal((await call).status, "cancelled");
  } finally {
    hanging = false;
    hang = null;
  }
});
