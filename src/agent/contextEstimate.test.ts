import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// The chat's context estimate lives in the browser script; take its two pure functions out to run them here.
const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
const fn = (name: string) => {
  const match = new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  \\}\\n`).exec(source);
  assert.ok(match, `${name} not found in agent.js`);
  return match[0];
};
type Detail = { items: Array<Record<string, unknown>>; turns: Map<string, { id: string; seq: number }> };
const estimateContext = new Function(`${fn("itemContextChars")}${fn("estimateContext")}return estimateContext;`)() as (detail: Detail | null, measured: { seq: number } | null) => number;

const turn = (seq: number) => ({ id: `t${seq}`, seq });
const detail = (items: Detail["items"]): Detail => ({ items, turns: new Map([turn(1), turn(2)].map((t) => [t.id, t])) });

test("the context estimate counts what the model reads, at four characters a token", () => {
  const items = [
    { kind: "user", turnId: "t1", text: "a".repeat(400) },
    { kind: "reasoning", turnId: "t1", text: "r".repeat(4000) },
    { kind: "tool", turnId: "t1", input: { command: "x".repeat(86) }, output: "o".repeat(300) },
    { kind: "text", turnId: "t1", text: "b".repeat(200), parentToolId: "sub" },
    { kind: "text", turnId: "t2", text: "c".repeat(800) },
    { kind: "user", turnId: null, text: "d".repeat(40) },
    { kind: "user", turnId: null, text: "dropped".repeat(40), dropped: true },
  ];
  // Nothing measured: the whole chat, without reasoning, subagent items and dropped messages.
  assert.equal(estimateContext(detail(items), null), (400 + 100 + 300 + 800 + 40) / 4);
  // Turn 1 reported its context: only later turns and queued messages are estimated.
  assert.equal(estimateContext(detail(items), turn(1)), (800 + 40) / 4);
  assert.equal(estimateContext(detail(items), turn(2)), 40 / 4);
  assert.equal(estimateContext(null, null), 0);
});

test("without a provider count, the estimate starts over after the conversation was summarized", () => {
  const items = [
    { kind: "text", turnId: "t1", text: "a".repeat(4000) },
    { kind: "notice", turnId: "t1", level: "info", text: "Cursor summarized the conversation to make room." },
    { kind: "text", turnId: "t2", text: "b".repeat(80) },
  ];
  assert.equal(estimateContext(detail(items), null), 20);
});
