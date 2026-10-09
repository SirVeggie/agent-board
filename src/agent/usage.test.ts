import assert from "node:assert/strict";
import { test } from "node:test";
import type { Turn } from "./types.js";
import { sumThreadUsage } from "./usage.js";

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
