import assert from "node:assert/strict";
import test from "node:test";
import { activity, counts, samples, type Sample } from "./replay-ceiling.js";
import type { Item, Thread, Turn } from "../src/agent/types.js";

const turn = { id: "turn", mode: "code", status: "done", startedAt: 1 } as Turn;
const tool = (over: Partial<Item>) => ({ kind: "tool", tool: "read", name: "Read", status: "done", turnId: turn.id, ...over }) as Item;
const user = (over: Partial<Item> = {}) => ({ kind: "user", text: "Explain this", turnId: turn.id, ...over }) as Item;
const thread = { id: "thread" } as Thread;
const sample = (over: Partial<Sample> = {}): Sample => ({ text: "Explain", at: 1, steered: false, activity: "read", ms: 50,
  answer: { type: "choice", choice: "answer", probabilities: { answer: .81, edit: .1, run: .09 }, confidence: .5 }, ...over });

test("activity sees nested and denied commands, edits and opaque tools", () => {
  assert.equal(activity(turn, [tool({ tool: "execute", status: "error", parentToolId: "outer" })]), "run");
  assert.equal(activity(turn, [{ kind: "approval", tool: "execute" } as Item]), "run");
  assert.equal(activity({ ...turn, files: [{}] as Turn["files"] }, []), "edit");
  assert.equal(activity(turn, [tool({ tool: "mcp", name: "mcp__scribe__read_file" })]), "read");
  assert.equal(activity(turn, [tool({ tool: "mcp", name: "mcp__other__write" })]), "unknown");
  assert.equal(activity(turn, [tool({ tool: "other", name: "exec" })]), "unknown");
});

test("samples reject automated, incomplete and already lowered turns; isolate steering", () => {
  const collect = (items: Item[], turns = [turn]) => samples([thread], () => turns, () => items);
  assert.equal(collect([user({ from: "page" })]).length, 0);
  assert.equal(collect([user({ card: { num: 1 } })]).length, 0);
  assert.equal(collect([user({ text: "/clear" })]).length, 0);
  assert.equal(collect([user()], [{ ...turn, status: "running" }]).length, 0);
  assert.equal(collect([user()], [{ ...turn, ceiling: { approval: "ask", from: "full", need: "answer" } }]).length, 0);
  assert.equal(collect([user(), user({ steer: "folded", text: "Now edit" })])[0].steered, true);
  assert.equal(collect([user({ steer: "folded" })]).length, 0);
});

test("threshold conflicts use known lowered denominator and exclude steered turns", () => {
  const scored = [sample(), sample({ activity: "run" }), sample({ activity: "unknown" }), sample({ activity: "run", steered: true })];
  assert.deepEqual(counts(scored, .8), { threshold: .8, eligible: 3, late: 0, lowered: 3, ask: 3, edits: 0, unknown: 1, knownLowered: 2, conflicts: 1, conflictRate: .5 });
  // Above .81, the same distribution permits edits, but still conflicts with commands.
  assert.equal(counts(scored, .9).edits, 3);
  assert.equal(counts(scored, .95).lowered, 0);
});

test("live budget excludes late answers instead of treating them as restrictions", () => {
  const scored = [sample({ activity: "run", ms: 2001 }), sample({ ms: 10 })];
  assert.equal(counts(scored, .8).conflicts, 1);
  assert.equal(counts(scored, .8, 2000).conflicts, 0);
  assert.equal(counts(scored, .8, 2000).late, 1);
});
