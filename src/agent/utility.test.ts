import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { AgentHost } from "./host.js";
import { DEFAULT_PREFS } from "./prefs.js";

function fixture(options: { unavailable?: string[]; limits?: Record<string, unknown>; failures?: Record<string, Error>; primary?: string } = {}) {
  const calls: { provider: string; model: string }[] = [];
  const host = Object.assign(Object.create(AgentHost.prototype), {
    prefs: () => ({ ...DEFAULT_PREFS, summarizer: { provider: options.primary || "pi", model: "main" },
      models: { ...DEFAULT_PREFS.models, pi: "native-chat" },
      forkSummarizers: { cursor: "cursor-small", claude: "haiku", codex: "mini" } }),
    liveLimits: () => options.limits || {},
    cachedModels: () => [],
    agent: (provider: string) => ({
      status: async () => ({ available: !options.unavailable?.includes(provider) }),
      complete: async (_prompt: string, model: string) => {
        calls.push({ provider, model });
        if (options.failures?.[provider]) throw options.failures[provider];
        return "Answer";
      },
    }),
  });
  return { host, calls };
}

test("utility completion keeps the saved primary choice", async () => {
  const { host, calls } = fixture();
  assert.deepEqual(await host.summarize("Question"), { text: "Answer", model: "main" });
  assert.deepEqual(calls, [{ provider: "pi", model: "main" }]);
});

test("regular summaries dispatch cross-provider choices from Summary models", async () => {
  const { host, calls } = fixture();
  host.prefs = () => ({ ...DEFAULT_PREFS, summarizer: { provider: "codex", model: "large" },
    forkSummarizers: { codex: { provider: "pi", model: "local-summary" } } });
  await host.summarize("Summarize this");
  assert.deepEqual(calls, [{ provider: "pi", model: "local-summary" }]);
});

test("usage failures follow Cursor, Claude, Codex, Native with summary models", async () => {
  const { host, calls } = fixture({ primary: "cursor", failures: {
    cursor: new Error("Out of usage"), claude: new Error("Usage limit reached"), codex: new Error("429 rate limit"),
  } });
  await host.summarize("Question");
  assert.deepEqual(calls, [
    { provider: "cursor", model: "cursor-small" }, { provider: "claude", model: "haiku" },
    { provider: "codex", model: "mini" }, { provider: "pi", model: "native-chat" },
  ]);
});

test("fallback starts at Cursor even when primary is Native", async () => {
  const { host, calls } = fixture({ failures: { pi: new Error("insufficient_quota") } });
  await host.summarize("Question");
  assert.deepEqual(calls[1], { provider: "cursor", model: "cursor-small" });
});

test("unavailable providers and known exhausted usage are skipped", async () => {
  const { host, calls } = fixture({ unavailable: ["pi", "cursor"], limits: {
    claude: { windows: [{ id: "five_hour", utilization: 1 }] },
  } });
  await host.summarize("Question");
  assert.deepEqual(calls, [{ provider: "codex", model: "mini" }]);
});

test("a model-specific limit does not exclude another model on that provider", async () => {
  const { host, calls } = fixture({ unavailable: ["pi", "cursor"], limits: {
    claude: { windows: [{ id: "seven_day_opus", utilization: 1 }] },
  } });
  await host.summarize("Question");
  assert.deepEqual(calls, [{ provider: "claude", model: "haiku" }]);
});

test("unrelated errors and cancellation do not fall back", async () => {
  for (const error of [new Error("Network unavailable"), new DOMException("Stopped", "AbortError")]) {
    const { host, calls } = fixture({ failures: { pi: error } });
    await assert.rejects(host.summarize("Question"), (actual) => actual === error);
    assert.equal(calls.length, 1);
  }
  const { host, calls } = fixture();
  await assert.rejects(host.summarize("Question", AbortSignal.abort()));
  assert.equal(calls.length, 0);
});

test("all exhausted providers return the last usage error", async () => {
  const error = new Error("usage limit reached");
  const { host, calls } = fixture({ failures: { pi: error, cursor: error, claude: error, codex: error } });
  await assert.rejects(host.summarize("Question"), (actual) => actual === error);
  assert.equal(calls.length, 4);
});

test("Claude one-shot completion preserves SDK error details for fallback", async () => {
  const source = fs.readFileSync(new URL("./providers/claude.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async complete(");
  const end = source.indexOf("\n  createSession(", start);
  const method = source.slice(start, end).replace(
    "async complete(prompt: string, model: string, signal?: AbortSignal): Promise<string>",
    "async complete(prompt, model, signal)");
  for (const result of [
    { type: "result", subtype: "success", is_error: true, result: "Usage limit reached" },
    { type: "result", subtype: "error_during_execution", errors: ["Usage limit reached"] },
    { type: "result", subtype: "success", is_error: false, result: "Answer" },
  ]) {
    let closed = false;
    const complete = vm.runInNewContext(`({${method}}).complete`, {
      AbortController, loadSdk: async () => ({ query: () => ({
        async *[Symbol.asyncIterator]() { yield result; },
        close() { closed = true; },
      }) }),
    });
    if (result.result === "Answer") assert.equal(await complete("Question", "haiku"), "Answer");
    else await assert.rejects(complete("Question", "haiku"), /Usage limit reached/);
    assert.equal(closed, true);
  }
});
