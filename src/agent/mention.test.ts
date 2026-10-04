import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionAt } from "./mention.js";

test("mentionAt finds @ after start or whitespace", () => {
  assert.deepEqual(mentionAt("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionAt("@todo", 5), { start: 0, end: 5, query: "todo" });
  assert.deepEqual(mentionAt("see @todo now", 9), { start: 4, end: 9, query: "todo" });
  assert.equal(mentionAt("user@host", 9), null);
  assert.equal(mentionAt("see todo", 8), null);
});

test("mentionAt uses the prefix before the caret and replaces the whole token", () => {
  assert.deepEqual(mentionAt("@foobar", 4), { start: 0, end: 7, query: "foo" });
  assert.deepEqual(mentionAt("a @x b", 4), { start: 2, end: 4, query: "x" });
});
