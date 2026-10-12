import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { DecideResult, MlAnswer } from "../ml/types.js";
import { CEILING_QUESTIONS, LIFT_OPTION, ceilingFrom, ceilingReason, classifyCeiling, lowerApproval, lowered } from "./ceiling.js";
import type { ApprovalRequest, RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { ApprovalPolicy, Item, ProviderId, Thread, Turn } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-ceiling-"));
process.env.SCRIBE_HOME = dir;
process.env.SCRIBE_FAKE_AGENTS = "1";
process.env.SCRIBE_FAKE_AGENT_DELAY = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
const { permissionModeFor } = await import("./providers/claude.js");
const { sandboxFor, threadOptions } = await import("./providers/codex.js");
const { wantsHostShell } = await import("./providers/cursor.js");

type Internals = {
  fakes: Record<string, unknown>;
  runs: Map<string, unknown>;
  queues: Map<string, unknown[]>;
  threads: Map<string, Thread>;
  loadItems(threadId: string): Item[];
  loadTurns(threadId: string): Turn[];
};

const PROVIDERS: ProviderId[] = ["claude", "codex", "cursor", "pi"];
const command: ApprovalRequest = {
  toolId: "t1",
  tool: "execute",
  title: "Run command",
  detail: "npm test",
  options: [
    { id: "allow", label: "Allow", kind: "allow_once" },
    { id: "deny", label: "Deny", kind: "reject_once" },
  ],
};
const edit: ApprovalRequest = { ...command, toolId: "t2", tool: "edit", title: "Edit a.txt", detail: undefined, paths: ["a.txt"] };

let host: InstanceType<typeof AgentHost>;
/** The approval level each session was handed, in order. */
let levels: ApprovalPolicy[] = [];
let turn: (sink: RunSink) => Promise<TurnResult> = async () => ({ status: "done" });
/** What the fake classifier says the message needs, or how it fails. */
let classifier: { answer?: MlAnswer; fail?: boolean; delayMs?: number; calls: number; state?: unknown } = { calls: 0 };

const internals = () => host as unknown as Internals;
const items = (id: string) => internals().loadItems(id);
const lastTurn = (id: string) => internals().loadTurns(id).at(-1);
const pendingApproval = (id: string) => items(id).find((it): it is Extract<Item, { kind: "approval" }> => it.kind === "approval" && it.status === "pending");

async function until<T>(read: () => T | undefined | null | false, what: string, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const idle = (id: string) => until(() => !internals().runs.has(id) && !internals().queues.get(id)?.length, "the turn to end");

function needs(choice: string, sure = 0.95): MlAnswer {
  const rest = (1 - sure) / 4;
  const probabilities = Object.fromEntries(["answer", "pages", "web", "edit", "run"].map((name) => [name, name === choice ? sure : rest]));
  return { type: "choice", choice, probabilities, confidence: sure };
}

function ok(answer: MlAnswer): DecideResult {
  return { ok: true, answers: { need: answer }, source: "fake", model: "fake", ms: 1, cached: false, usage: { inputTokens: 0, outputTokens: 0 } };
}

function thread(provider: ProviderId, approval: ApprovalPolicy = "full", cwd: string | null = null): string {
  return host.createThread({ provider, mode: "code", approval, cwd, scope: { kind: "global", ref: null } }).id;
}

before(() => {
  store.load();
  host = new AgentHost(() => {});
  // Sessions that only record the level they were given and run the test's turn.
  for (const id of PROVIDERS) {
    internals().fakes[id] = {
      id,
      label: id,
      status: async () => ({ id, label: id, available: true }),
      models: async () => [],
      complete: async () => "",
      prewarm: () => {},
      dispose: () => {},
      createSession: (_thread: Thread) => ({
        warm: async () => {},
        update: (t: Thread) => levels.push(t.approval),
        commands: async () => [],
        dispose: () => {},
        cancel: async () => {},
        run: (_input: TurnInput, sink: RunSink) => turn(sink),
      }),
    };
  }
  host.hookBackend = {
    maySend: () => true,
    decide: async (state) => {
      classifier.calls += 1;
      classifier.state = state;
      if (classifier.delayMs) await new Promise((resolve) => setTimeout(resolve, classifier.delayMs));
      if (classifier.fail || !classifier.answer) return { ok: false, error: "unavailable", message: "down", ms: 1 };
      return ok(classifier.answer);
    },
  };
  host.setPrefs({ lowerPermissions: true });
});

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  host.dispose();
  store.closeDb();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // left for the OS to clean up
  }
});

function reset(answer?: MlAnswer): void {
  levels = [];
  turn = async () => ({ status: "done" });
  classifier = { answer, calls: 0 };
}

test("lowerApproval follows ask < edits < auto < full", () => {
  assert.equal(lowerApproval("full", "ask"), "ask");
  assert.equal(lowerApproval("edits", "auto"), "edits");
  assert.equal(lowerApproval("ask", "full"), "ask");
  assert.equal(lowerApproval("auto", "auto"), "auto");
});

test("ceilingFrom lowers only on a sure answer", () => {
  assert.deepEqual(ceilingFrom(needs("answer")), { approval: "ask", need: "answer" });
  assert.deepEqual(ceilingFrom(needs("pages")), { approval: "ask", need: "pages" });
  assert.deepEqual(ceilingFrom(needs("web")), { approval: "ask", need: "web" });
  assert.deepEqual(ceilingFrom(needs("edit")), { approval: "edits", need: "edit" });
  assert.equal(ceilingFrom(needs("run")), null);
  // A question that may well need a command: left alone.
  assert.equal(ceilingFrom({ type: "choice", choice: "answer", probabilities: { answer: 0.6, run: 0.4 }, confidence: 0.3 }), null);
  // A question that may need an edit, but hardly a command: edits.
  assert.deepEqual(ceilingFrom({ type: "choice", choice: "answer", probabilities: { answer: 0.6, edit: 0.38, run: 0.02 }, confidence: 0.3 }), { approval: "edits", need: "answer" });
  assert.equal(ceilingFrom({ type: "choice", choice: "something else", probabilities: {}, confidence: 1 }), null);
  assert.equal(ceilingFrom({ type: "yesno", yes: 1 }), null);
  assert.equal(ceilingFrom(undefined), null);
});

test("classifyCeiling asks only where a thread could be lowered, and fails open", async () => {
  let calls = 0;
  const decide = (answer: MlAnswer) => async () => {
    calls += 1;
    return ok(answer);
  };
  assert.deepEqual(await classifyCeiling(decide(needs("answer")), "What does this do?", { mode: "code", approval: "full" }), { approval: "ask", from: "full", need: "answer" });
  assert.deepEqual(await classifyCeiling(decide(needs("edit")), "Fix the typo", { mode: "code", approval: "auto" }), { approval: "edits", from: "auto", need: "edit" });
  // Already at or below what the message needs.
  assert.equal(await classifyCeiling(decide(needs("edit")), "Fix the typo", { mode: "code", approval: "edits" }), null);
  assert.equal(calls, 3);
  assert.equal(await classifyCeiling(decide(needs("answer")), "What does this do?", { mode: "code", approval: "ask" }), null);
  assert.equal(await classifyCeiling(decide(needs("answer")), "What does this do?", { mode: "plan", approval: "full" }), null);
  assert.equal(await classifyCeiling(decide(needs("answer")), "  ", { mode: "code", approval: "full" }), null);
  assert.equal(calls, 3);
  const full = { mode: "code", approval: "full" } as const;
  assert.equal(await classifyCeiling(async () => ({ ok: false, error: "timeout", message: "slow", ms: 500 }), "Why?", full), null);
  assert.equal(await classifyCeiling(async () => Promise.reject(new Error("boom")), "Why?", full), null);
  const started = Date.now();
  assert.equal(await classifyCeiling(() => new Promise<DecideResult>((resolve) => setTimeout(() => resolve(ok(needs("answer"))), 400).unref()), "Why?", full, 30), null);
  assert.ok(Date.now() - started < 300, "the turn waits no longer than the budget");
  assert.deepEqual(Object.keys(CEILING_QUESTIONS), ["need"]);
});

test("a lowered thread maps to each provider's lower level, and stays live otherwise", () => {
  const real = { id: "th_1", mode: "code", approval: "full", web: "off", model: "default", effort: null, nativeId: null } as unknown as Thread;
  const ask = lowered(real, "ask");
  const edits = lowered(real, "edits");
  // Claude: the permission mode, which changes on the running process.
  assert.equal(permissionModeFor(real), "bypassPermissions");
  assert.equal(permissionModeFor(ask), "default");
  assert.equal(permissionModeFor(edits), "acceptEdits");
  // Codex: the sandbox comes back and it asks again.
  assert.equal(sandboxFor(real), "danger-full-access");
  assert.equal(sandboxFor(ask), "workspace-write");
  assert.equal(threadOptions(real, dir).approvalPolicy, "never");
  assert.equal(threadOptions(ask, dir).approvalPolicy, "on-request");
  assert.equal(threadOptions(edits, dir).approvalsReviewer, "user");
  // Cursor: Auto-review instead of none, and the host shell when the user has it on.
  assert.equal(wantsHostShell(real, true), false);
  assert.equal(wantsHostShell(ask, true), true);
  assert.equal(wantsHostShell(ask, false), false);
  // Everything else is the thread itself, also in a copy and after a later change.
  assert.equal({ ...ask }.approval, "ask");
  assert.equal(JSON.parse(JSON.stringify(ask)).approval, "ask");
  real.nativeId = "native-1";
  assert.equal(ask.nativeId, "native-1");
  assert.equal(real.approval, "full");
});

test("ceilingReason says why the turn asks", () => {
  assert.equal(ceilingReason({ approval: "ask", need: "answer" }), "This turn started read-only because your message looked like a question.");
  assert.match(ceilingReason({ approval: "ask", need: "pages" }), /only needs pages/);
  assert.match(ceilingReason({ approval: "edits", need: "edit" }), /file edits only/);
});

for (const provider of PROVIDERS) {
  test(`${provider}: a question on a Full-access thread runs as Ask, and asks with the reason`, async () => {
    reset(needs("answer"));
    const id = thread(provider);
    let decision: Promise<unknown> | undefined;
    turn = async (sink) => {
      decision = sink.approval(command);
      await decision;
      return { status: "done" };
    };
    host.send(id, { text: "What does the build script do?" });
    const approval = await until(() => pendingApproval(id), "the approval");
    assert.deepEqual(levels, ["ask"]);
    assert.deepEqual(lastTurn(id)?.ceiling, { approval: "ask", from: "full", need: "answer" });
    assert.equal(approval.detail, "npm test\n\nThis turn started read-only because your message looked like a question.");
    assert.deepEqual(approval.options.map((o) => o.id), ["allow", LIFT_OPTION, "deny"]);
    assert.equal(approval.options[1].label, "Allow for this turn");
    host.resolveApproval(approval.requestId, "allow");
    assert.deepEqual(await decision, { optionId: "allow", note: undefined });
    await idle(id);
    // The thread's own setting is untouched, and the turn says it ran lowered.
    assert.equal(internals().threads.get(id)?.approval, "full");
    assert.equal(lastTurn(id)?.ceiling?.lifted, undefined);
    assert.equal((classifier.state as { content: string }).content, "What does the build script do?");
  });

  test(`${provider}: Allow for this turn puts the thread's own level back`, async () => {
    reset(needs("answer"));
    const id = thread(provider);
    const answers: string[] = [];
    turn = async (sink) => {
      answers.push((await sink.approval(command)).optionId);
      // Under Full access again: answered without asking.
      answers.push((await sink.approval({ ...command, toolId: "t3", detail: "npm run build" })).optionId);
      return { status: "done" };
    };
    host.send(id, { text: "What does the build script do?" });
    const approval = await until(() => pendingApproval(id), "the approval");
    host.resolveApproval(approval.requestId, LIFT_OPTION);
    await idle(id);
    // The provider gets its own allow, never Scribe's option.
    assert.deepEqual(answers, ["allow", "allow"]);
    assert.deepEqual(levels, ["ask", "full"]);
    assert.deepEqual(lastTurn(id)?.ceiling, { approval: "ask", from: "full", need: "answer", lifted: true });
    assert.equal(items(id).filter((it) => it.kind === "approval").length, 1);
    // The next turn is judged on its own.
    reset(needs("run"));
    host.send(id, { text: "Run the tests" });
    await idle(id);
    assert.deepEqual(levels, ["full"]);
    assert.equal(lastTurn(id)?.ceiling, undefined);
  });
}

test("an edit request runs as Auto-edit: edits in the workspace pass, commands ask", async () => {
  reset(needs("edit"));
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "a.txt"), "a");
  const id = thread("codex", "full", workspace);
  const answers: string[] = [];
  turn = async (sink) => {
    answers.push((await sink.approval(edit)).optionId);
    answers.push((await sink.approval(command)).optionId);
    return { status: "done" };
  };
  host.send(id, { text: "Fix the typo in a.txt" });
  const approval = await until(() => pendingApproval(id), "the approval");
  assert.deepEqual(answers, ["allow"]);
  assert.deepEqual(levels, ["edits"]);
  assert.equal(approval.title, "Run command");
  assert.match(approval.detail ?? "", /file edits only because your message did not look like it needs commands/);
  host.resolveApproval(approval.requestId, "deny");
  await idle(id);
  assert.deepEqual(answers, ["allow", "deny"]);
});

test("the thread's own level applies when the classifier fails, is slow, or sees a command", async () => {
  for (const state of [{ fail: true }, { answer: needs("answer"), delayMs: 900 }, { answer: needs("run") }, { answer: { type: "choice", choice: "answer", probabilities: { answer: 0.6, run: 0.4 }, confidence: 0.3 } as MlAnswer }]) {
    reset();
    classifier = { ...state, calls: 0 };
    const id = thread("claude");
    const answers: string[] = [];
    turn = async (sink) => {
      answers.push((await sink.approval(command)).optionId);
      return { status: "done" };
    };
    const started = Date.now();
    host.send(id, { text: "What does the build script do?" });
    await idle(id);
    assert.ok(Date.now() - started < 800, "the turn does not wait past the gating budget");
    assert.equal(classifier.calls, 1);
    assert.deepEqual(levels, ["full"]);
    assert.deepEqual(answers, ["allow"]);
    assert.equal(lastTurn(id)?.ceiling, undefined);
    assert.equal(items(id).some((it) => it.kind === "approval"), false);
  }
});

test("nothing is asked with the setting off, on an Ask thread, for a slash command, or for a message Scribe sent", async () => {
  const run = async (id: string, input: Parameters<typeof host.send>[1]) => {
    reset(needs("answer"));
    host.send(id, input);
    await idle(id);
    assert.equal(classifier.calls, 0);
    assert.equal(lastTurn(id)?.ceiling, undefined);
  };
  await run(thread("claude", "ask"), { text: "What does this do?" });
  await run(thread("claude"), { text: "/review the build" });
  await run(thread("claude"), { text: "A page sent this.", from: "page" });
  host.setPrefs({ lowerPermissions: false });
  try {
    assert.equal(host.prefs().lowerPermissions, false);
    await run(thread("claude"), { text: "What does this do?" });
  } finally {
    host.setPrefs({ lowerPermissions: true });
  }
});

test("a helper's thread is left alone: nobody watches it", async () => {
  reset(needs("answer"));
  const id = thread("claude");
  internals().threads.get(id)!.helperOf = thread("claude");
  host.send(id, { text: "What does this do?" });
  await idle(id);
  assert.equal(classifier.calls, 0);
  assert.deepEqual(levels, ["full"]);
});

test("picking a level while the turn runs lowered lifts the ceiling", async () => {
  reset(needs("answer"));
  const id = thread("claude");
  const answers: string[] = [];
  let go: () => void = () => {};
  const picked = new Promise<void>((resolve) => (go = resolve));
  turn = async (sink) => {
    await picked;
    answers.push((await sink.approval(edit)).optionId);
    return { status: "done" };
  };
  host.send(id, { text: "What does this do?" });
  await until(() => lastTurn(id)?.ceiling, "the ceiling");
  host.updateThread(id, { approval: "auto" });
  assert.equal(lastTurn(id)?.ceiling?.lifted, true);
  assert.deepEqual(levels, ["ask", "auto", "auto"]);
  host.updateThread(id, { approval: "full" });
  go();
  await idle(id);
  assert.deepEqual(answers, ["allow"]);
});

test("a call that needs a human anyway is asked without the turn option", async () => {
  reset(needs("answer"));
  const id = thread("codex");
  turn = async (sink) => {
    await sink.approval({ ...command, humanOnly: true });
    return { status: "done" };
  };
  host.send(id, { text: "What does this do?" });
  const approval = await until(() => pendingApproval(id), "the approval");
  assert.deepEqual(approval.options.map((o) => o.id), ["allow", "deny"]);
  assert.equal(approval.detail, "npm test");
  host.resolveApproval(approval.requestId, "deny");
  await idle(id);
});
