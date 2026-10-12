import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { DecideOptions, DecideResult, MlAnswers, MlQuestions } from "../ml/types.js";
import { HookPipeline, type Chunk, type HookEvent } from "./hooks.js";
import { PAGE_HINT_THRESHOLD, PAGE_INTENT_FEATURE, PAGE_INTENT_NOTE, PAGE_INTENT_QUESTION, htmlWriteStage, pageIntentDetectors } from "./pageIntent.js";
import type { RunSink, TurnInput, TurnResult } from "./providers/provider.js";
import type { AgentEvent, Thread } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-page-intent-"));
process.env.SCRIBE_HOME = dir;
process.env.SCRIBE_FAKE_AGENTS = "1";
process.env.SCRIBE_FAKE_AGENT_DELAY = "1";
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

type Intent = Extract<AgentEvent, { type: "agent_intent" }>;
type Internals = { fakes: Record<string, unknown>; runs: Map<string, unknown>; queues: Map<string, unknown[]> };

let host: InstanceType<typeof AgentHost>;
const events: AgentEvent[] = [];
/** What the stub session does in its turn, and the prompts it was given. */
let turn: (sink: RunSink) => Promise<TurnResult> = async () => ({ status: "done" });
const prompts: string[] = [];

const internals = () => host as unknown as Internals;
const intents = () => events.filter((e): e is Intent => e.type === "agent_intent" && e.name === "page_create");

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
const thread = (extra: Partial<Thread> = {}) => host.createThread({ provider: "codex", mode: "code", approval: "full", cwd: null, scope: { kind: "global", ref: null }, ...extra }).id;

const chunk = (event: HookEvent, text: string, extra: Partial<Chunk> = {}): Chunk => ({ event, threadId: "th", turnId: "tu", text, provider: "claude", mode: "code", worker: false, dock: true, ...extra });
const editCall = (paths: string[], cwd?: string) => chunk("tool_call", "Write", { tool: { name: "Write", kind: "edit", paths }, ...(cwd ? { cwd } : {}) });

function yes(value: number, asked: Array<{ state: unknown; questions: MlQuestions; options: DecideOptions }> = []) {
  return async (state: unknown, questions: MlQuestions, options: DecideOptions): Promise<DecideResult> => {
    asked.push({ state, questions, options });
    const answers: MlAnswers = Object.fromEntries(Object.keys(questions).map((q) => [q, { type: "yesno", yes: value }]));
    return { ok: true, answers, source: "fake", model: "fake", ms: 1, cached: false, usage: { inputTokens: 1, outputTokens: 0 } };
  };
}

before(() => {
  store.load();
  host = new AgentHost((event) => events.push(event));
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
      cancel: async () => {},
      run: (input: TurnInput, sink: RunSink) => {
        prompts.push(input.text);
        return turn(sink);
      },
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

test("an HTML file written outside the workspace confirms a page; one inside it is only a hint", () => {
  const tmp = path.join(os.tmpdir(), "scribe-x");
  const work = path.resolve("/projects/app");
  assert.equal(htmlWriteStage(editCall([path.join(tmp, "report.html")], work)), "confirmed");
  assert.equal(htmlWriteStage(editCall([path.resolve("/elsewhere/page.HTM")], work)), "confirmed");
  assert.equal(htmlWriteStage(editCall(["public/index.html"], work)), "hint");
  assert.equal(htmlWriteStage(editCall([path.join(work, "docs", "a.html")], work)), "hint");
  // No workspace: every file is a scratch file.
  assert.equal(htmlWriteStage(editCall(["page.html"])), "confirmed");
  assert.equal(htmlWriteStage(editCall([path.join(work, "src", "a.ts")], work)), null);
  assert.equal(htmlWriteStage(chunk("tool_call", "Read", { tool: { name: "Read", kind: "read", paths: [path.join(tmp, "a.html")] } })), null);
});

test("the detectors watch floating-chat turns only, and never hold a tool call", () => {
  const pipeline = new HookPipeline({ detectors: pageIntentDetectors });
  const call = (extra: Partial<Chunk> = {}) => chunk("tool_call", "page_intent", { tool: { name: "mcp__scribe__page_intent", kind: "mcp", input: { title: " Reading list " } }, ...extra });
  assert.deepEqual(pipeline.rules(call()).found.map((f) => f.action), [{ kind: "signal", name: "page_create", stage: "confirmed", title: "Reading list" }]);
  assert.deepEqual(pipeline.rules(call({ dock: false })).found, []);
  assert.deepEqual(pipeline.rules(call({ worker: true })).found, []);
  // Cursor and Pi title the call; Codex wraps the arguments.
  const titled = chunk("tool_call", "x", { tool: { name: "mcp", kind: "mcp", title: "Scribe: page_intent", input: { arguments: { title: "Plan" } } } });
  assert.deepEqual(pipeline.rules(titled).found.map((f) => f.action), [{ kind: "signal", name: "page_create", stage: "confirmed", title: "Plan" }]);
  assert.deepEqual(pipeline.rules(chunk("tool_call", "x", { tool: { name: "mcp__scribe__page_show", kind: "mcp", input: { title: "Plan" } } })).found, []);
  // A gate has nothing to wait for.
  assert.equal(pipeline.idle("tool_call"), false);
  assert.equal(pipeline.idle("tool_call", true), true);
  assert.deepEqual(pipeline.rules(call(), true), { found: [], open: [] });
});

test("the message question goes to the classifier under its own feature, with the open page's title", async () => {
  const asked: Array<{ state: unknown; questions: MlQuestions; options: DecideOptions }> = [];
  const pipeline = (value: number) => new HookPipeline({ detectors: pageIntentDetectors, decide: yes(value, asked) });
  const prompt = chunk("prompt", "Make me a page that tracks my reading list", { page: "Scribe Todo" });
  const run = async (value: number, c = prompt) => {
    const p = pipeline(value);
    return p.classify(c, p.rules(c).open, 1000);
  };
  const found = await run(0.93);
  assert.deepEqual(found.map((f) => [f.detector, f.action, f.confidence]), [["page-intent:message", { kind: "signal", name: "page_create", stage: "hint" }, 0.93]]);
  assert.deepEqual(Object.values(asked[0].questions), [{ type: "yesno", instructions: PAGE_INTENT_QUESTION }]);
  assert.deepEqual(asked[0].state, { event: "prompt", mode: "code", openPage: "Scribe Todo", content: prompt.text });
  assert.equal(asked[0].options.feature, PAGE_INTENT_FEATURE);
  assert.deepEqual(asked[0].options.sends, ["messages"]);
  assert.deepEqual(await run(PAGE_HINT_THRESHOLD - 0.01), []);
  // Not the floating chat: nothing is asked.
  asked.length = 0;
  assert.deepEqual(await run(0.99, { ...prompt, dock: false }), []);
  assert.equal(asked.length, 0);
});

test("a floating-chat turn: the note, the hint from the message and the agent's own announcement", async () => {
  const real = host.hookBackend;
  host.hookBackend = { decide: yes(0.9), maySend: () => true };
  try {
    turn = async (sink) => {
      sink.toolStart({ toolId: "p1", name: "mcp", tool: "mcp", title: "Scribe: page_intent", input: { title: "Reading list" }, status: "running" });
      sink.toolUpdate("p1", { status: "done", output: "{\"ok\":true}" });
      sink.toolStart({ toolId: "w1", name: "apply_patch", tool: "edit", title: "Write", paths: [path.join(os.tmpdir(), "reading.html")], status: "running" });
      return { status: "done" };
    };
    const id = thread();
    events.length = 0;
    prompts.length = 0;
    const { item } = host.send(id, { text: "Make a reading list page", dock: true });
    await idle(id);
    await until(() => intents().length >= 3, "the three signals");
    assert.ok(prompts[0].startsWith(`<context>\n${PAGE_INTENT_NOTE}\n</context>\n\n`));
    assert.ok(prompts[0].endsWith("Make a reading list page"));
    const turnId = intents()[0].turnId;
    assert.ok(turnId);
    assert.deepEqual(
      intents().map((e) => [e.detector, e.event, e.stage, e.title, e.confidence, e.turnId === turnId]).sort(),
      [
        ["page-intent:announce", "tool_call", "confirmed", "Reading list", undefined, true],
        ["page-intent:html", "tool_call", "confirmed", undefined, undefined, true],
        ["page-intent:message", "prompt", "hint", undefined, 0.9, true],
      ]
    );
    assert.equal(intents().find((e) => e.stage === "hint")?.itemId, item.id);
  } finally {
    host.hookBackend = real;
    turn = async () => ({ status: "done" });
  }
});

test("the same turn outside the floating chat signals nothing and gets no note; neither does a thread with detection off", async () => {
  const real = host.hookBackend;
  let asked = 0;
  host.hookBackend = { decide: (...args) => (asked++, yes(0.99)(...args)), maySend: () => true };
  try {
    turn = async (sink) => {
      sink.toolStart({ toolId: "p1", name: "mcp", tool: "mcp", title: "Scribe: page_intent", input: { title: "Reading list" }, status: "running" });
      return { status: "done" };
    };
    events.length = 0;
    prompts.length = 0;
    let id = thread();
    host.send(id, { text: "Make a reading list page" });
    await idle(id);
    assert.equal(prompts[0], "Make a reading list page");
    // A page's own code cannot pass its message off as typed into the floating chat.
    id = thread();
    host.send(id, { text: "Make a reading list page", from: "page", dock: true });
    await idle(id);
    assert.doesNotMatch(prompts[1], /floating chat/);
    id = thread();
    host.updateThread(id, { hooksOff: true });
    host.send(id, { text: "Make a reading list page", dock: true });
    await idle(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(intents(), []);
    assert.equal(asked, 0);
  } finally {
    host.hookBackend = real;
    turn = async () => ({ status: "done" });
  }
});

test("without a classifier the announcement still confirms the page", async () => {
  const real = host.hookBackend;
  host.hookBackend = { decide: async () => ({ ok: false, error: "no_source", message: "No classifier source", ms: 0 }), maySend: () => true };
  try {
    turn = async (sink) => {
      sink.toolStart({ toolId: "p1", name: "mcp", tool: "mcp", title: "Scribe: page_intent", input: { title: "Plan" }, status: "running" });
      return { status: "done" };
    };
    events.length = 0;
    const id = thread();
    host.send(id, { text: "Plan page please", dock: true });
    await idle(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(intents().map((e) => [e.stage, e.title]), [["confirmed", "Plan"]]);
  } finally {
    host.hookBackend = real;
    turn = async () => ({ status: "done" });
  }
});
