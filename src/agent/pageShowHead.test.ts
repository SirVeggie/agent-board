import assert from "node:assert/strict";
import { test } from "node:test";
import { pageShowHead } from "./providers/claude.js";

test("a streaming page_show call names its page once the content starts", () => {
  assert.equal(pageShowHead('{"key": "scribe:trip-plan", "title": "Trip'), null);
  assert.deepEqual(pageShowHead('{"key": "scribe:trip-plan", "title": "Trip \\"plan\\"", "html": "<h1'), { key: "scribe:trip-plan", title: 'Trip "plan"' });
  assert.deepEqual(pageShowHead('{"title":"Notes","htmlPath":"C:\\tmp'), { title: "Notes" });
});

test("fields quoted inside the page's HTML are not taken for the call's own", () => {
  const html = `{"html": "<script>const o = {\\"key\\": \\"scribe:other\\", \\"title\\": \\"x\\"};${" ".repeat(400)}`;
  assert.deepEqual(pageShowHead(html), {});
  assert.deepEqual(pageShowHead(`{"id":"t_1",${" ".repeat(400)}`), { id: "t_1" });
});
