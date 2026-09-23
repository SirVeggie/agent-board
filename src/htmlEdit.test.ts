import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, HtmlEditError, parseHtmlEdits } from "./htmlEdit.js";

test("replaces a unique snippet once", () => {
  const result = applyEdits("<p>Status: in progress</p>", [
    { oldString: "<p>Status: in progress</p>", newString: "<p>Status: ready</p>" },
  ]);
  assert.equal(result.html, "<p>Status: ready</p>");
  assert.equal(result.applied, 1);
});

test("applies edits in order so later edits see earlier results", () => {
  const result = applyEdits("<p>alpha</p>", [
    { oldString: "alpha", newString: "beta" },
    { oldString: "beta", newString: "gamma" },
  ]);
  assert.equal(result.html, "<p>gamma</p>");
  assert.equal(result.applied, 2);
});

test("replaceAll changes every non-overlapping match", () => {
  const result = applyEdits("<i>x</i><i>x</i>", [
    { oldString: "<i>x</i>", newString: "<b>x</b>", replaceAll: true },
  ]);
  assert.equal(result.html, "<b>x</b><b>x</b>");
  assert.equal(result.applied, 2);
});

test("rejects a non-unique snippet unless replaceAll is set", () => {
  assert.throws(
    () => applyEdits("<i>x</i><i>x</i>", [{ oldString: "<i>x</i>", newString: "<b>x</b>" }]),
    (err: unknown) => err instanceof HtmlEditError && /matched 2 times/.test(err.message)
  );
});

test("rejects a missing snippet", () => {
  assert.throws(
    () => applyEdits("<p>hello</p>", [{ oldString: "goodbye", newString: "ok" }]),
    (err: unknown) => err instanceof HtmlEditError && /oldString not found/.test(err.message)
  );
});

test("a miss reports where the stored text diverges from oldString", () => {
  const html = "<style>\n.item.done { opacity: .5 }\n.handle { cursor: grab }\n</style>";
  const oldString = ".item.done { opacity: .5 }\n.item { color: red }";
  assert.throws(
    () => applyEdits(html, [{ oldString, newString: "" }]),
    (err: unknown) =>
      err instanceof HtmlEditError &&
      err.message.includes("The first 28 of 47 chars match at line 3") &&
      err.message.includes('Stored text continues: "handle { cursor: grab }') &&
      err.message.includes('oldString expects:     "item { color: red }"')
  );
});

test("a miss with no useful prefix says the snippet is not on the page", () => {
  assert.throws(
    () => applyEdits("<p>hello</p>", [{ oldString: "something else entirely", newString: "" }]),
    (err: unknown) => err instanceof HtmlEditError && /No meaningful part of it/.test(err.message)
  );
});

test("a miss notes when the matching prefix appears in several places", () => {
  const html = "<li class=\"row\">a</li><li class=\"row\">b</li>";
  assert.throws(
    () => applyEdits(html, [{ oldString: "<li class=\"row\">c</li>", newString: "" }]),
    (err: unknown) => err instanceof HtmlEditError && /first of 2 places/.test(err.message)
  );
});

test("rejects an empty oldString", () => {
  assert.throws(
    () => applyEdits("<p>hello</p>", [{ oldString: "", newString: "x" }]),
    (err: unknown) => err instanceof HtmlEditError && /must not be empty/.test(err.message)
  );
});

test("rejects a patch that would leave the page empty", () => {
  assert.throws(
    () => applyEdits("<p>only</p>", [{ oldString: "<p>only</p>", newString: "   " }]),
    (err: unknown) => err instanceof HtmlEditError && /leave the page empty/.test(err.message)
  );
});

test("allows deleting a snippet by replacing it with empty", () => {
  const result = applyEdits("<h1>Hi</h1><p>gone</p>", [{ oldString: "<p>gone</p>", newString: "" }]);
  assert.equal(result.html, "<h1>Hi</h1>");
  assert.equal(result.applied, 1);
});

test("does not mutate the input string when a later edit fails", () => {
  const html = "<p>alpha</p>";
  assert.throws(() =>
    applyEdits(html, [
      { oldString: "alpha", newString: "beta" },
      { oldString: "missing", newString: "nope" },
    ])
  );
  assert.equal(html, "<p>alpha</p>");
});

test("parseHtmlEdits accepts a well-formed list", () => {
  assert.deepEqual(
    parseHtmlEdits([{ oldString: "a", newString: "b", replaceAll: true }]),
    [{ oldString: "a", newString: "b", replaceAll: true }]
  );
});

test("parseHtmlEdits rejects an empty list", () => {
  assert.throws(
    () => parseHtmlEdits([]),
    (err: unknown) => err instanceof HtmlEditError && /edits is required/.test(err.message)
  );
});

test("parseHtmlEdits rejects a malformed entry", () => {
  assert.throws(
    () => parseHtmlEdits([{ oldString: "a" }]),
    (err: unknown) => err instanceof HtmlEditError && /newString must be a string/.test(err.message)
  );
});
