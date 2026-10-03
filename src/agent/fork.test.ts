import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, forkBlock } from "./fork.js";

test("forkBlock carries the first and last messages and the summary", () => {
  const text = forkBlock("Fix the parser", "Claude", { first: "Fix it", middle: "User: more\nAgent: done", last: "Ship it", reply: "Shipped.", summary: "Fixed two bugs." });
  assert.match(text, /^<earlier_conversation>\n/);
  assert.match(text, /forked from the thread “Fix the parser”, which ran with Claude/);
  assert.match(text, /First message from the user:\nFix it/);
  assert.match(text, /Summary of the conversation in between:\nFixed two bugs\./);
  assert.doesNotMatch(text, /Agent: done/);
  assert.match(text, /Last message from the user:\nShip it/);
  assert.match(text, /The agent's last reply:\nShipped\.\n<\/earlier_conversation>\n\n$/);
});

test("forkBlock sends the middle as it was, cut to its end, when there is no summary", () => {
  const middle = `${"a".repeat(30_000)}END`;
  const text = forkBlock("T", "Cursor", { first: "x", middle, last: "", reply: "y" });
  assert.match(text, /The conversation in between:\n…a+END/);
  assert.ok(text.length < 26_000);
  assert.doesNotMatch(text, /Last message from the user/);
});

test("forkBlock leaves out the middle when the thread had one or two turns", () => {
  const text = forkBlock("T", "Cursor", { first: "x", middle: "", last: "z", reply: "y" });
  assert.doesNotMatch(text, /in between/);
});

test("clip keeps the start", () => {
  assert.equal(clip("abcdef", 3), "abc…");
  assert.equal(clip("abc", 3), "abc");
});
