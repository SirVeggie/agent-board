import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { DecideResult, MlAnswers, MlQuestions } from "../ml/types.js";
import type { HookRule } from "./hooks.js";
import type { ApprovalDecision, RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { AgentEvent, ApprovalPolicy, Item, ProviderId, Thread } from "./types.js";

// Fake agents on every provider: Claude's and Pi's hold their [fake-run: ...] calls like the real ones.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-hooks-"));
process.env.SCRIBE_HOME = dir;
process.env.SCRIBE_FAKE_AGENTS = "1";
process.env.SCRIBE_FAKE_AGENT_DELAY = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

type Internals = {
  fakes: Record<string, unknown>;
  runs: Map<string, unknown>;
  queues: Map<string, unknown[]>;
  loadItems(threadId: string): Item[];
  loadTurns(threadId: string): Array<{ status: string }>;
};

let host: InstanceType<typeof AgentHost>;
const events: AgentEvent[] = [];
/** What the stub Codex session does in its turn. */
let codexTurn: (sink: RunSink) => Promise<TurnResult> = async () => ({ status: "done" });
let cancelCodex: (() => void) | null = null;

const internals = () => host as unknown as Internals;
const items = (id: string) => internals().loadItems(id);
const tool = (id: string) => items(id).find((it): it is Extract<Item, { kind: "tool" }> => it.kind === "tool" && it.name === "Bash");
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

function rules(...list: Array<Partial<HookRule> & Pick<HookRule, "pattern" | "action">>): void {
  host.setPrefs({ hookRules: list.map((rule, i) => ({ id: `r${i + 1}`, enabled: true, match: "keyword", event: "any", ...rule })) as HookRule[] });
}

function thread(provider: ProviderId = "claude", approval: ApprovalPolicy = "full"): string {
  return host.createThread({ provider, mode: "code", approval, cwd: null, scope: { kind: "global", ref: null } }).id;
}

before(() => {
  store.load();
  host = new AgentHost((event) => events.push(event));
  // A provider that cannot hold its calls: it reports them, and at most asks approval after.
  internals().fakes.codex = {
    id: "codex",
    label: "Codex",
    status: async () => ({ id: "codex", label: "Codex", available: true }),
    models: async () => [],
    complete: async () => "",
    prewarm: () => {},
    dispose: () => {},
    createSession: (_thread: Thread) => ({
      warm: async () => {},
      update: () => {},
      commands: async () => [],
      dispose: () => {},
      cancel: async () => cancelCodex?.(),
      run: (_input: TurnInput, sink: RunSink) => codexTurn(sink),
    }),
  };
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

test("observing hooks flag items and signal the UI without touching the turn", async () => {
  rules({ pattern: "release notes", action: "signal", event: "prompt", text: "release" }, { pattern: "Done.", action: "flag", event: "text", text: "Finished" });
  const id = thread();
  events.length = 0;
  const { item } = host.send(id, { text: "Write the release notes [fake:delay=0]" });
  await idle(id);
  const intent = events.find((e) => e.type === "agent_intent");
  assert.deepEqual(intent, { type: "agent_intent", threadId: id, turnId: item.turnId, itemId: item.id, name: "release", detector: "rule:r1", event: "prompt" });
  const done = items(id).find((it) => it.kind === "text" && it.text === "Done.");
  assert.deepEqual(done?.flags, [{ id: "rule:r2", label: "Finished", action: "flag" }]);
  // The turn's first text does not match, and the turn ran to its end.
  assert.equal(items(id).find((it) => it.kind === "text" && it.text.startsWith("Fake agent"))?.flags, undefined);
  assert.equal(internals().loadTurns(id).at(-1)?.status, "done");
});

test("block denies a held tool call and the turn goes on", async () => {
  rules({ match: "regex", pattern: "rm\\s+-rf", action: "block", event: "tool_call", text: "No recursive deletes." });
  const id = thread("claude", "full");
  host.send(id, { text: "[fake-run: rm -rf build] [fake-run: ls] [fake:delay=0]" });
  await idle(id);
  const calls = items(id).filter((it): it is Extract<Item, { kind: "tool" }> => it.kind === "tool");
  assert.deepEqual(calls.map((it) => [it.title, it.status, it.output]), [
    ["rm -rf build", "error", "No recursive deletes."],
    ["ls", "done", "ran: ls"],
  ]);
  assert.deepEqual(calls[0].flags, [{ id: "rule:r1", label: "rm\\s+-rf", action: "block", reason: "No recursive deletes." }]);
  assert.equal(calls[1].flags, undefined);
  assert.equal(internals().loadTurns(id).at(-1)?.status, "done");
});

test("ask needs the user's approval even under Full access", async () => {
  rules({ pattern: "deploy", action: "ask", event: "tool_call", text: "Deploys need a look." });
  for (const answer of ["allow", "deny"]) {
    const id = thread("pi", "full");
    host.send(id, { text: "[fake-run: deploy prod] [fake:delay=0]" });
    const approval = await until(() => pendingApproval(id), "the approval");
    assert.equal(approval.title, "deploy prod");
    assert.match(approval.detail ?? "", /Deploys need a look\./);
    assert.equal(tool(id)?.status, "running");
    host.resolveApproval(approval.requestId, answer);
    await idle(id);
    assert.equal(tool(id)?.status, answer === "allow" ? "done" : "error");
    assert.equal(tool(id)?.output, answer === "allow" ? "ran: deploy prod" : "The user denied this call.");
    assert.deepEqual(tool(id)?.flags?.map((flag) => flag.action), ["ask"]);
  }
});

test("a thread with detection off is left alone", async () => {
  rules({ pattern: "rm -rf", action: "block" }, { pattern: "Done.", action: "flag" });
  const id = thread();
  host.updateThread(id, { hooksOff: true });
  host.send(id, { text: "[fake-run: rm -rf build] [fake:delay=0]" });
  await idle(id);
  assert.equal(tool(id)?.output, "ran: rm -rf build");
  assert.ok(items(id).every((it) => !it.flags));
});

test("context tells the agent once per turn, and its own note is not detected on", async () => {
  rules({ pattern: "npm", action: "context", text: "This repo uses pnpm, not npm." });
  const id = thread();
  host.send(id, { text: "[fake-run: npm test] [fake-run: npm run build] [fake:delay=0]" });
  await idle(id);
  const notes = items(id).filter((it) => it.kind === "user" && it.from === "hook");
  // Three matches in the first turn (the message and two calls), one note; the note's own turn adds none.
  assert.deepEqual(notes.map((it) => it.kind === "user" && it.text), ["This repo uses pnpm, not npm."]);
  assert.equal(internals().loadTurns(id).length, 2);
});

test("a question rule holds the call for the classifier, and fails open when it is slow or down", async () => {
  rules({ match: "question", pattern: "Does this command delete files?", action: "ask", event: "tool_call" });
  const asked: Array<{ state: unknown; questions: MlQuestions }> = [];
  const answer = (yes: number) => async (state: unknown, questions: MlQuestions): Promise<DecideResult> => {
    asked.push({ state, questions });
    const answers: MlAnswers = Object.fromEntries(Object.keys(questions).map((q) => [q, { type: "yesno", yes }]));
    return { ok: true, answers, source: "fake", model: "fake", ms: 1, cached: false, usage: { inputTokens: 1, outputTokens: 0 } };
  };
  const real = host.hookBackend;
  try {
    host.hookBackend = { decide: answer(0.95), maySend: () => true };
    let id = thread("claude", "full");
    host.send(id, { text: "Clean up [fake-run: del /s build] [fake:delay=0]" });
    const approval = await until(() => pendingApproval(id), "the approval");
    assert.deepEqual(Object.values(asked[0].questions), [{ type: "yesno", instructions: "Does this command delete files?" }]);
    assert.match(JSON.stringify(asked[0].state), /del \/s build/);
    host.resolveApproval(approval.requestId, "allow");
    await idle(id);
    assert.equal(tool(id)?.output, "ran: del /s build");

    host.hookBackend = { decide: answer(0.1), maySend: () => true };
    id = thread("claude", "full");
    host.send(id, { text: "[fake-run: echo hi] [fake:delay=0]" });
    await idle(id);
    assert.equal(tool(id)?.output, "ran: echo hi");

    // Never answers: the call waits out its budget (500 ms) and runs.
    host.hookBackend = { decide: () => new Promise<DecideResult>(() => {}), maySend: () => true };
    id = thread("claude", "full");
    const started = Date.now();
    host.send(id, { text: "[fake-run: echo slow] [fake:delay=0]" });
    await idle(id);
    assert.equal(tool(id)?.output, "ran: echo slow");
    assert.ok(Date.now() - started >= 450, "the call was held for the budget");
    assert.equal(pendingApproval(id), undefined);

    host.hookBackend = { decide: async () => ({ ok: false, error: "unavailable", message: "down", ms: 1 }), maySend: () => true };
    id = thread("claude", "full");
    host.send(id, { text: "[fake-run: echo down] [fake:delay=0]" });
    await idle(id);
    assert.equal(tool(id)?.output, "ran: echo down");
  } finally {
    host.hookBackend = real;
  }
});

test("where a call cannot be held, block stops the turn and ask only marks it", async () => {
  const seen = (sink: RunSink) => {
    sink.toolStart({ toolId: "c1", name: "command_execution", tool: "execute", title: "Bash", detail: "git push --force", status: "running" });
    return new Promise<TurnResult>((resolve) => {
      cancelCodex = () => resolve({ status: "cancelled" });
    });
  };
  rules({ pattern: "--force", action: "block", event: "tool_call", text: "No force pushes." });
  codexTurn = seen;
  let id = thread("codex", "full");
  host.send(id, { text: "push it" });
  await idle(id);
  assert.equal(internals().loadTurns(id).at(-1)?.status, "cancelled");
  const notice = items(id).find((it) => it.kind === "notice" && it.level === "warn");
  assert.match(notice?.kind === "notice" ? notice.text : "", /stopped the turn on the call Bash.*No force pushes\./);

  rules({ pattern: "--force", action: "ask", event: "tool_call" });
  codexTurn = async (sink) => {
    sink.toolStart({ toolId: "c1", name: "command_execution", tool: "execute", title: "Bash", detail: "git push --force", status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    sink.toolUpdate("c1", { status: "done", output: "pushed" });
    return { status: "done" };
  };
  id = thread("codex", "full");
  host.send(id, { text: "push it" });
  await idle(id);
  assert.equal(internals().loadTurns(id).at(-1)?.status, "done");
  const call = items(id).find((it) => it.kind === "tool");
  assert.deepEqual(call?.flags?.map((flag) => flag.action), ["ask"]);
  assert.ok(items(id).some((it) => it.kind === "notice" && /it ran without asking/.test(it.text)));
});

test("a call that asks approval is held there: block denies it, ask reaches the user under Full access", async () => {
  const options = [
    { id: "accept", label: "Allow once", kind: "allow_once" as const },
    { id: "decline", label: "Decline", kind: "reject_once" as const },
  ];
  let decision: ApprovalDecision | null = null;
  codexTurn = async (sink) => {
    sink.toolStart({ toolId: "c2", name: "command_execution", tool: "execute", title: "Bash", detail: "git push --force", status: "running" });
    decision = await sink.approval({ toolId: "c2", tool: "execute", title: "Run command", detail: "git push --force", options });
    sink.toolUpdate("c2", { status: decision.optionId === "accept" ? "done" : "error" });
    return { status: "done" };
  };
  rules({ pattern: "--force", action: "block", event: "tool_call", text: "No force pushes." });
  let id = thread("codex", "full");
  host.send(id, { text: "push it" });
  await idle(id);
  assert.deepEqual(decision, { optionId: "decline", note: "No force pushes." });
  assert.equal(internals().loadTurns(id).at(-1)?.status, "done");

  rules({ pattern: "--force", action: "ask", event: "tool_call" });
  decision = null;
  id = thread("codex", "full");
  host.send(id, { text: "push it" });
  const approval = await until(() => pendingApproval(id), "the approval");
  assert.match(approval.detail ?? "", /A hook \(--force\) wants your approval/);
  host.resolveApproval(approval.requestId, "accept");
  await idle(id);
  assert.deepEqual(decision, { optionId: "accept", note: undefined });

  // No rule matches: Full access answers as before, without asking.
  rules({ pattern: "something else", action: "ask", event: "tool_call" });
  decision = null;
  id = thread("codex", "full");
  host.send(id, { text: "push it" });
  await idle(id);
  assert.deepEqual(decision, { optionId: "accept" });
});

test("hook rules are validated when saved", () => {
  assert.throws(() => host.setPrefs({ hookRules: [{ match: "regex", pattern: "(", action: "flag" }] as never }), /not a valid regular expression/);
  assert.throws(() => host.setPrefs({ hookRules: [{ pattern: "x", action: "context" }] as never }), /what the agent should be told/);
  host.setPrefs({ hookRules: [{ pattern: "x", action: "flag" }] as never });
  assert.deepEqual(host.prefs().hookRules, [{ id: "rule-1", enabled: true, match: "keyword", pattern: "x", event: "any", action: "flag" }]);
  host.setPrefs({ hookRules: [] });
});
