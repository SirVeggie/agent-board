import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecideOptions, DecideResult, MlAnswer, MlAnswers, MlQuestion, MlQuestions } from "../ml/types.js";
import {
  clip,
  earlyEnd,
  holdsAll,
  hookCoverage,
  HookPipeline,
  isGating,
  normalizeRules,
  ruleDetector,
  ruleDetectors,
  toolCallText,
  verdict,
} from "./hooks.js";
import type { Action, Chunk, Detector, Finding, HookDecide, HookDeps, HookEvent, HookRule } from "./hooks.js";

const chunk = (event: HookEvent, text: string, extra: Partial<Chunk> = {}): Chunk => ({
  event,
  threadId: "th",
  turnId: "tu",
  text,
  provider: "claude",
  mode: "code",
  worker: false,
  ...extra,
});

/** One rule as saved and normalized. */
const one = (raw: Record<string, unknown>): HookRule => normalizeRules([raw])[0]!;

const questionRule = (id: string, extra: Record<string, unknown> = {}): HookRule =>
  one({ id, match: "question", pattern: "Is it rude?", event: "text", action: "flag", ...extra });

const pipelineFor = (rules: HookRule[], deps: Omit<HookDeps, "detectors"> = {}) =>
  new HookPipeline({ detectors: () => ruleDetectors(rules), ...deps });

const runRules = (detectors: Detector[], c: Chunk) => new HookPipeline({ detectors: () => detectors }).rules(c);

type Call = { state: unknown; questions: MlQuestions; options: DecideOptions };

/** A decide that answers every question it is sent, and records each call. */
function fakeDecide(answer: (question: MlQuestion) => MlAnswer = () => ({ type: "yesno", yes: 0.9 })) {
  const calls: Call[] = [];
  const decide: HookDecide = async (state, questions, options) => {
    calls.push({ state, questions, options });
    const answers: MlAnswers = {};
    for (const [id, question] of Object.entries(questions)) answers[id] = answer(question);
    return { ok: true, answers, source: "s", model: "m", ms: 1, cached: false, usage: { inputTokens: 1, outputTokens: 0 } };
  };
  return { decide, calls };
}

const of = (action: Action): Finding => ({ detector: "d", label: "d", action });

// ---------- normalizeRules ----------

test("normalizeRules: a non-array gives no rules", () => {
  assert.deepEqual(normalizeRules(undefined), []);
  assert.deepEqual(normalizeRules("rm -rf"), []);
  assert.deepEqual(normalizeRules({ pattern: "x", action: "flag" }), []);
});

test("normalizeRules: a valid rule keeps its fields", () => {
  assert.deepEqual(
    normalizeRules([{ id: "r1", enabled: true, match: "regex", pattern: "rm\\s+-rf", event: "tool_call", action: "block", text: "No deletes" }]),
    [{ id: "r1", enabled: true, match: "regex", pattern: "rm\\s+-rf", event: "tool_call", action: "block", text: "No deletes" }],
  );
});

test("normalizeRules: a missing match is a keyword rule", () => {
  assert.equal(one({ pattern: "deploy", action: "flag" }).match, "keyword");
});

test("normalizeRules: a missing or unknown event means any", () => {
  assert.equal(one({ pattern: "x", action: "flag" }).event, "any");
  assert.equal(one({ pattern: "x", action: "flag", event: "sometime" }).event, "any");
});

test("normalizeRules: enabled defaults to true, and false is kept", () => {
  assert.equal(one({ pattern: "x", action: "flag" }).enabled, true);
  assert.equal(one({ pattern: "x", action: "flag", enabled: false }).enabled, false);
});

test("normalizeRules: throws a message for the form on an empty pattern, a missing action, a bad regex or context without text", () => {
  assert.throws(() => normalizeRules([{ pattern: "  ", action: "flag" }]), /needs a pattern/);
  assert.throws(() => normalizeRules([{ pattern: "x" }]), /pick what the rule does/);
  assert.throws(() => normalizeRules([{ pattern: "x", action: "explode" }]), /pick what the rule does/);
  assert.throws(() => normalizeRules([{ pattern: "(", match: "regex", action: "flag" }]), /not a valid regular expression/);
  assert.throws(() => normalizeRules([{ pattern: "x", action: "context" }]), /say what the agent should be told/);
});

test("normalizeRules: a tool rule with event any or text watches tool calls", () => {
  assert.equal(one({ match: "tool", pattern: "Bash", event: "any", action: "flag" }).event, "tool_call");
  assert.equal(one({ match: "tool", pattern: "Bash", event: "text", action: "flag" }).event, "tool_call");
});

test("normalizeRules: a tool rule on tool results stays on tool results", () => {
  assert.equal(one({ match: "tool", pattern: "Bash", event: "tool_result", action: "flag" }).event, "tool_result");
});

test("normalizeRules: a valid id is kept, and missing or duplicate ids get unique generated ones", () => {
  const rules = normalizeRules([
    { id: "keep-me", pattern: "a", action: "flag" },
    { id: "keep-me", pattern: "b", action: "flag" },
    { pattern: "c", action: "flag" },
    { id: "bad id!", pattern: "d", action: "flag" },
  ]);
  const ids = rules.map((rule) => rule.id);
  assert.equal(ids[0], "keep-me");
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(ids[1], "keep-me");
  assert.match(ids[2]!, /^rule-/);
  assert.match(ids[3]!, /^rule-/);
});

test("normalizeRules: a question threshold is kept only for questions, clamped to 0.5..1", () => {
  assert.equal(one({ match: "question", pattern: "Angry?", action: "flag", threshold: 0.2 }).threshold, 0.5);
  assert.equal(one({ match: "question", pattern: "Angry?", action: "flag", threshold: 3 }).threshold, 1);
  assert.equal(one({ match: "question", pattern: "Angry?", action: "flag", threshold: 0.8 }).threshold, 0.8);
  assert.equal(one({ match: "question", pattern: "Angry?", action: "flag" }).threshold, undefined);
  assert.equal("threshold" in one({ match: "keyword", pattern: "x", action: "flag", threshold: 0.9 }), false);
});

// ---------- rule detectors ----------

test("keyword rule matches case-insensitively and yields its action", () => {
  const detector = ruleDetector(one({ id: "k", match: "keyword", pattern: "Drop Table", event: "any", action: "block", text: "No drops" }));
  assert.deepEqual(runRules([detector], chunk("text", "we should DROP table users")).found, [
    { detector: "rule:k", label: "Drop Table", action: { kind: "block", reason: "No drops" } },
  ]);
  assert.deepEqual(runRules([detector], chunk("text", "nothing to see")).found, []);
});

test("regex rule matches its pattern on the text", () => {
  const detectors = ruleDetectors([one({ id: "rm", match: "regex", pattern: "rm\\s+-rf", event: "any", action: "flag" })]);
  assert.equal(runRules(detectors, chunk("text", "then rm   -rf build")).found.length, 1);
  assert.equal(runRules(detectors, chunk("text", "rm file.txt")).found.length, 0);
});

test("tool rule matches the tool's name, not the text", () => {
  const detectors = ruleDetectors([one({ id: "bash", match: "tool", pattern: "bash", event: "any", action: "ask", text: "Check this" })]);
  const call = chunk("tool_call", "nothing about the tool here", { tool: { name: "Bash", kind: "execute" } });
  const found = runRules(detectors, call).found;
  assert.deepEqual(found.map((f) => f.action), [{ kind: "ask" }]);
  assert.equal(found[0]!.reason, "Check this");
  assert.equal(runRules(detectors, chunk("tool_call", "Bash", { tool: { name: "Read", kind: "read" } })).found.length, 0);
  assert.equal(runRules(detectors, chunk("text", "Bash")).found.length, 0);
});

test("a rule with event tool_call does not fire on text, and an any rule fires on prompt and text", () => {
  const toolOnly = ruleDetectors([one({ id: "t", match: "keyword", pattern: "rm", event: "tool_call", action: "flag" })]);
  assert.equal(runRules(toolOnly, chunk("text", "rm")).found.length, 0);
  assert.equal(runRules(toolOnly, chunk("tool_call", "rm")).found.length, 1);
  const anyEvent = ruleDetectors([one({ id: "a", match: "keyword", pattern: "rm", event: "any", action: "flag" })]);
  assert.equal(runRules(anyEvent, chunk("prompt", "rm")).found.length, 1);
  assert.equal(runRules(anyEvent, chunk("text", "rm")).found.length, 1);
});

test("ruleDetectors leaves out disabled rules", () => {
  const rules = normalizeRules([
    { id: "on", pattern: "a", action: "flag" },
    { id: "off", pattern: "b", action: "flag", enabled: false },
  ]);
  assert.deepEqual(ruleDetectors(rules).map((detector) => detector.id), ["rule:on"]);
});

test("signal uses the text as its name, falling back to the rule id", () => {
  const actionOf = (raw: Record<string, unknown>) =>
    runRules(ruleDetectors([one({ id: "m", match: "keyword", pattern: "hello", event: "any", ...raw })]), chunk("text", "hello there")).found[0]?.action;
  assert.deepEqual(actionOf({ action: "signal", text: "greeting" }), { kind: "signal", name: "greeting" });
  assert.deepEqual(actionOf({ action: "signal" }), { kind: "signal", name: "m" });
});

test("block has a reason: the text when given, otherwise a non-empty one", () => {
  const actionOf = (raw: Record<string, unknown>) =>
    runRules(ruleDetectors([one({ id: "m", match: "keyword", pattern: "hello", event: "any", ...raw })]), chunk("text", "hello there")).found[0]?.action;
  assert.deepEqual(actionOf({ action: "block", text: "Stop" }), { kind: "block", reason: "Stop" });
  const bare = actionOf({ action: "block" });
  assert.ok(bare && bare.kind === "block" && bare.reason.length > 0);
});

test("context carries the text, and flag carries the label only when text is given", () => {
  const actionOf = (raw: Record<string, unknown>) =>
    runRules(ruleDetectors([one({ id: "m", match: "keyword", pattern: "hello", event: "any", ...raw })]), chunk("text", "hello there")).found[0]?.action;
  assert.deepEqual(actionOf({ action: "context", text: "Be polite" }), { kind: "context", text: "Be polite" });
  assert.deepEqual(actionOf({ action: "flag", text: "Greeting" }), { kind: "flag", label: "Greeting" });
  assert.deepEqual(actionOf({ action: "flag" }), { kind: "flag" });
  assert.deepEqual(actionOf({ action: "ask" }), { kind: "ask" });
});

test("where filters a detector by provider and worker", () => {
  const detector = (where: NonNullable<Detector["where"]>): Detector => ({ id: "w", on: ["text"], where, rule: () => ({ actions: [{ kind: "flag" }] }) });
  const claude = chunk("text", "x");
  assert.equal(runRules([detector({ providers: ["codex"] })], claude).found.length, 0);
  assert.equal(runRules([detector({ providers: ["claude"] })], claude).found.length, 1);
  assert.equal(runRules([detector({ worker: true })], claude).found.length, 0);
  assert.equal(runRules([detector({ worker: false })], claude).found.length, 1);
});

test("a detector without early skips a text opening; one with early runs on it", () => {
  let plain = 0;
  let early = 0;
  const detectors: Detector[] = [
    {
      id: "plain",
      on: ["text"],
      rule: () => {
        plain++;
        return null;
      },
    },
    {
      id: "early",
      on: ["text"],
      early: true,
      rule: () => {
        early++;
        return null;
      },
    },
  ];
  runRules(detectors, chunk("text", "Sure.", { early: true }));
  assert.equal(plain, 0);
  assert.equal(early, 1);
  runRules(detectors, chunk("text", "Sure, here is the whole block."));
  assert.equal(plain, 1);
  assert.equal(early, 2);
});

test("a rule that throws counts as no match and does not throw the pipeline", () => {
  const logged: string[] = [];
  const pipeline = new HookPipeline({
    detectors: () => [
      {
        id: "bad",
        on: ["text"],
        rule: () => {
          throw new Error("boom");
        },
      },
      { id: "good", on: ["text"], rule: () => ({ actions: [{ kind: "flag" }] }) },
    ],
    log: (message) => logged.push(message),
  });
  const { found, open } = pipeline.rules(chunk("text", "x"));
  assert.deepEqual(found.map((f) => f.detector), ["good"]);
  assert.deepEqual(open, []);
  assert.match(logged[0]!, /bad failed: boom/);
});

// ---------- the classifier path ----------

test("a question rule flags when the classifier's yes reaches its threshold", async () => {
  const { decide } = fakeDecide(() => ({ type: "yesno", yes: 0.9 }));
  const pipeline = pipelineFor([questionRule("rude", { threshold: 0.7 })], { decide });
  const found = await pipeline.evaluate(chunk("text", "hello"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.confidence, 0.9);
  assert.deepEqual(found[0]!.action, { kind: "flag" });
});

test("a question rule gives nothing when the classifier's yes is under its threshold", async () => {
  const { decide } = fakeDecide(() => ({ type: "yesno", yes: 0.4 }));
  const pipeline = pipelineFor([questionRule("rude", { threshold: 0.7 })], { decide });
  assert.deepEqual(await pipeline.evaluate(chunk("text", "hello")), []);
});

test("two question rules on one chunk share exactly one decide call", async () => {
  const { decide, calls } = fakeDecide();
  const pipeline = pipelineFor([questionRule("a", { pattern: "Q one?" }), questionRule("b", { pattern: "Q two?" })], { decide });
  await pipeline.evaluate(chunk("text", "hello"));
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!.questions).sort(), ["d0.q", "d1.q"]);
  assert.deepEqual(calls[0]!.questions["d1.q"], { type: "yesno", instructions: "Q two?" });
});

test("a detector whose rule returns a Hit or pass is not sent to the classifier", async () => {
  const { decide, calls } = fakeDecide();
  const ask = (): MlQuestions => ({ q: { type: "yesno", instructions: "Is it?" } });
  const hit: Detector = { id: "hit", on: ["text"], rule: () => ({ actions: [{ kind: "signal", name: "x" }] }), ask, decide: () => null };
  const passing: Detector = { id: "pass", on: ["text"], rule: () => "pass", ask, decide: () => null };
  await new HookPipeline({ detectors: () => [hit, passing], decide }).evaluate(chunk("text", "x"));
  assert.equal(calls.length, 0);
});

test("a detector whose rule returns null is sent to the classifier", async () => {
  const { decide, calls } = fakeDecide();
  const unsettled: Detector = {
    id: "null",
    on: ["text"],
    rule: () => null,
    ask: (): MlQuestions => ({ q: { type: "yesno", instructions: "Is it?" } }),
    decide: () => null,
  };
  await new HookPipeline({ detectors: () => [unsettled], decide }).evaluate(chunk("text", "x"));
  assert.equal(calls.length, 1);
});

test("evaluate does not ask the classifier once a rule blocks", async () => {
  const { decide, calls } = fakeDecide();
  const blocker = one({ id: "stop", match: "keyword", pattern: "rm -rf", event: "any", action: "block", text: "No" });
  const found = await pipelineFor([blocker, questionRule("q")], { decide }).evaluate(chunk("text", "run rm -rf now"));
  assert.deepEqual(found.map((f) => f.action.kind), ["block"]);
  assert.equal(calls.length, 0);
});

test("a classifier that fails or throws gives no findings", async () => {
  const failing: HookDecide = async () => ({ ok: false, error: "unavailable", message: "x", ms: 1 });
  const throwing: HookDecide = async () => {
    throw new Error("boom");
  };
  for (const decide of [failing, throwing]) {
    assert.deepEqual(await pipelineFor([questionRule("q")], { decide }).evaluate(chunk("text", "hello")), []);
  }
});

test("a classifier that never answers gives no findings within the budget", async () => {
  const hang: HookDecide = () => new Promise<DecideResult>(() => {});
  const pipeline = pipelineFor([questionRule("q")], { decide: hang });
  const { open } = pipeline.rules(chunk("text", "hello"));
  const started = Date.now();
  assert.deepEqual(await pipeline.classify(chunk("text", "hello"), open, 30), []);
  assert.ok(Date.now() - started < 500);
});

test("maySend refusing the kind keeps the chunk away from the classifier", async () => {
  const { decide, calls } = fakeDecide();
  const pipeline = pipelineFor([questionRule("q")], { decide, maySend: () => false });
  assert.deepEqual(await pipeline.evaluate(chunk("text", "hello")), []);
  assert.equal(calls.length, 0);
});

test("decide runs for the hooks feature, with the send kind of each event", async () => {
  const cases: Array<[HookEvent, string]> = [
    ["prompt", "messages"],
    ["text", "agentText"],
    ["tool_call", "toolCalls"],
    ["tool_result", "toolResults"],
  ];
  for (const [event, kind] of cases) {
    const { decide, calls } = fakeDecide();
    await pipelineFor([questionRule("q", { event: "any" })], { decide }).evaluate(chunk(event, "hello"));
    assert.equal(calls[0]!.options.feature, "hooks");
    assert.deepEqual(calls[0]!.options.sends, [kind]);
  }
});

test("the state sent carries the chunk text, and the user's message when the event is not prompt", async () => {
  const { decide, calls } = fakeDecide();
  const pipeline = pipelineFor([questionRule("q", { event: "any" })], { decide });
  await pipeline.evaluate(chunk("text", "I will build it.", { lastUser: "Please build a page" }));
  const state = calls[0]!.state as Record<string, unknown>;
  assert.equal(state.content, "I will build it.");
  assert.equal(state.userMessage, "Please build a page");
  assert.deepEqual(calls[0]!.options.sends, ["agentText", "messages"]);

  await pipeline.evaluate(chunk("prompt", "Build a page", { lastUser: "earlier" }));
  assert.equal("userMessage" in (calls[1]!.state as object), false);
  assert.equal((calls[1]!.state as Record<string, unknown>).content, "Build a page");
});

test("the state names the tool when the chunk is a tool call", async () => {
  const { decide, calls } = fakeDecide();
  await pipelineFor([questionRule("q", { event: "any" })], { decide }).evaluate(chunk("tool_call", "rm -rf dist", { tool: { name: "Bash", kind: "execute" } }));
  assert.equal((calls[0]!.state as Record<string, unknown>).tool, "Bash");
});

// ---------- helpers ----------

const signal: Finding = of({ kind: "signal", name: "s" });
const flag: Finding = of({ kind: "flag" });
const ask: Finding = of({ kind: "ask" });
const block: Finding = of({ kind: "block", reason: "no" });

test("verdict: block wins over ask, ask alone asks, and nothing gating gives null", () => {
  assert.deepEqual(verdict([ask, block]), { kind: "block", finding: block });
  assert.deepEqual(verdict([ask]), { kind: "ask", finding: ask });
  assert.equal(verdict([signal, flag]), null);
  assert.equal(verdict([]), null);
});

test("isGating is true only for ask and block", () => {
  assert.equal(isGating(ask), true);
  assert.equal(isGating(block), true);
  assert.equal(isGating(signal), false);
  assert.equal(isGating(flag), false);
  assert.equal(isGating(of({ kind: "context", text: "t" })), false);
});

test("toolCallText carries the name, title, detail and input", () => {
  const text = toolCallText({ name: "Bash", title: "Remove build", detail: "clean up", input: { command: "rm -rf dist" } });
  assert.match(text, /Bash/);
  assert.match(text, /Remove build/);
  assert.match(text, /clean up/);
  assert.match(text, /rm -rf dist/);
});

test("toolCallText cuts a long input short", () => {
  const text = toolCallText({ name: "Write", input: "x".repeat(10_000) });
  assert.ok(text.length < 5_000);
  assert.ok(text.includes("…"));
});

test("clip leaves text under the limit unchanged", () => {
  assert.equal(clip("short"), "short");
  assert.equal(clip("abcdef", 6), "abcdef");
});

test("clip keeps the head and the tail of long text", () => {
  assert.equal(clip("head-" + "x".repeat(100) + "-tail", 20), "head-xxxxx\n…\nxxxxx-tail");
});

test("earlyEnd is null for short text without a sentence end", () => {
  assert.equal(earlyEnd("Sure, one moment"), null);
});

test("earlyEnd ends after the first sentence", () => {
  const text = "I'll build you a page for that. More text";
  assert.equal(earlyEnd(text), text.indexOf(".") + 1);
  assert.equal(earlyEnd(text), 31);
});

test("earlyEnd is 200 characters when there is no punctuation", () => {
  assert.equal(earlyEnd("a".repeat(300)), 200);
});

test("hookCoverage has a row per provider: claude and pi hold every call, codex and cursor only some", () => {
  const rows = hookCoverage();
  assert.deepEqual(rows.map((row) => row.provider), ["claude", "pi", "codex", "cursor"]);
  for (const row of rows.slice(0, 2)) {
    assert.equal(row.hold, "all");
    assert.equal(row.observed, "");
  }
  for (const row of rows.slice(2)) {
    assert.equal(row.hold, "some");
    assert.notEqual(row.observed, "");
  }
});

test("holdsAll is true for claude and pi, false for codex and cursor", () => {
  assert.equal(holdsAll("claude"), true);
  assert.equal(holdsAll("pi"), true);
  assert.equal(holdsAll("codex"), false);
  assert.equal(holdsAll("cursor"), false);
});
