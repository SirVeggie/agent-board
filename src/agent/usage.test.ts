import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import type { Turn } from "./types.js";
import { sumThreadUsage, sumUsageTree } from "./usage.js";

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: over.id || "t",
  threadId: "th",
  seq: over.seq ?? 1,
  status: over.status || "done",
  model: "m",
  effort: null,
  mode: "board",
  startedAt: 1,
  ...over,
});

test("helper trees normalize providers, include live/nested helpers, and mark mixed costs partial", () => {
  const threads = [
    { id: "main", provider: "codex" as const },
    { id: "helper", helperOf: "main", provider: "claude" as const },
    { id: "nested", helperOf: "helper", provider: "pi" as const },
    { id: "unrelated", provider: "claude" as const },
  ];
  const turns: Record<string, Turn[]> = {
    main: [turn({ usage: { inputTokens: 100, cacheReadTokens: 60, outputTokens: 10 } })],
    helper: [turn({ usage: { inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5, outputTokens: 8, costUsd: 0.1 } })],
    nested: [turn({ status: "running", usage: { inputTokens: 3, cacheReadTokens: 7, outputTokens: 2, costUsd: 0.02 } })],
    unrelated: [turn({ usage: { inputTokens: 9999 } })],
  };
  const usage = sumUsageTree("main", threads, (id) => turns[id])!;
  assert.equal(usage.inputTokens, 215);
  assert.equal(usage.promptTokens, 215);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.main?.inputTokens, 100);
  assert.equal(usage.main?.cacheReadTokens, 60);
  assert.equal(usage.helpers?.threads, 2);
  assert.equal(usage.helpers?.inputTokens, 115);
  assert.ok(Math.abs(usage.helpers!.costUsd! - 0.12) < 1e-10);
  assert.equal(usage.helpers?.costPartial, undefined);
  assert.ok(Math.abs(usage.costUsd! - 0.12) < 1e-10);
  assert.equal(usage.costPartial, true);
  delete turns.nested[0].usage!.costUsd;
  assert.equal(sumUsageTree("main", threads, (id) => turns[id])!.helpers?.costPartial, true);
});

test("Kanban usage survives compaction and displays normalized totals and partial helper costs", () => {
  const html = fs.readFileSync(new URL("../../templates/builtin/kanban.html", import.meta.url), "utf8");
  const script = html.slice(html.indexOf("  function fmtTokens("), html.indexOf("  function applyCardUsage("));
  const ctx = vm.createContext({});
  vm.runInContext(script, ctx);
  const value = {
    turns: 2, inputTokens: 100, promptTokens: 100, cacheReadTokens: 50, outputTokens: 10,
    costUsd: 0.1, costPartial: true,
    main: { turns: 1, inputTokens: 20, promptTokens: 20 },
    helpers: { threads: 1, turns: 1, inputTokens: 80, outputTokens: 10, costUsd: 0.1 },
  };
  ctx.value = value;
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(compactUsage(value))", ctx)), value);
  const formatted = vm.runInContext("formatUsage(value)", ctx);
  assert.match(formatted, /^100 in/);
  assert.match(formatted, /\$0.10 partial/);
  assert.match(formatted, /helpers: 1, 80 in, 10 out/);
  assert.match(vm.runInContext("usageTip(value)", ctx), /Main: 20 in/);
});

test("continued chats count a helper once and recompute its cumulative usage", () => {
  const threads = [{ id: "main", provider: "codex" as const }, { id: "h", helperOf: "main", provider: "cursor" as const }];
  const turns: Record<string, Turn[]> = {
    main: [turn({ usage: { inputTokens: 10 } })],
    h: [turn({ usage: { inputTokens: 20, cacheReadTokens: 15 } })],
  };
  assert.equal(sumUsageTree("main", threads, (id) => turns[id])!.inputTokens, 30);
  turns.main.push(turn({ id: "m2", usage: { inputTokens: 5 } }));
  turns.h.push(turn({ id: "h2", usage: { inputTokens: 8 } }));
  const usage = sumUsageTree("main", threads, (id) => turns[id])!;
  assert.equal(usage.inputTokens, 43);
  assert.equal(usage.helpers?.threads, 1);
  assert.equal(usage.helpers?.turns, 2);
  assert.equal(usage.helpers?.costUsd, undefined);
  assert.equal(usage.costUsd, undefined);
  assert.deepEqual(sumUsageTree("main", [...threads, threads[1]], (id) => turns[id]), usage);
});

test("sumThreadUsage totals tokens and skips reverted turns", () => {
  assert.equal(sumThreadUsage([]), undefined);
  assert.equal(sumThreadUsage([turn({ reverted: true, usage: { inputTokens: 9 } })]), undefined);

  const none = sumThreadUsage([turn({ id: "a" }), turn({ id: "b", seq: 2 })]);
  assert.deepEqual(none, { turns: 2 });

  const mixed = sumThreadUsage([
    turn({ id: "a", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 } }),
    turn({ id: "b", seq: 2, status: "error", usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.02 } }),
    turn({ id: "c", seq: 3, reverted: true, usage: { inputTokens: 999, outputTokens: 999, costUsd: 9 } }),
    turn({ id: "d", seq: 4, usage: { cacheWriteTokens: 3, reasoningTokens: 7 } }),
  ]);
  assert.deepEqual(mixed, {
    turns: 3,
    inputTokens: 150,
    outputTokens: 30,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    reasoningTokens: 7,
    costUsd: 0.02,
  });
});
