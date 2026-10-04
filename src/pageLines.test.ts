import assert from "node:assert/strict";
import { test } from "node:test";
import { GrepError, grepLines, numberLines, outline, readWindow } from "./pageLines.js";

const PAGE = ["<main>", "<h1>Title</h1>", "<p>one</p>", "<p>two</p>", "<p>three</p>", "</main>"].join("\n");

test("reads a numbered line window", () => {
  const win = readWindow(PAGE, { offset: 2, limit: 2 });
  assert.deepEqual([win.startLine, win.endLine, win.totalLines], [2, 3, 6]);
  assert.equal(win.text, "2\t<h1>Title</h1>\n3\t<p>one</p>");
});

test("window stops at the end and can be unnumbered", () => {
  const win = readWindow(PAGE, { offset: 5, limit: 10, numbered: false });
  assert.equal(win.endLine, 6);
  assert.equal(win.text, "<p>three</p>\n</main>");
});

test("offset past the end is an error", () => {
  assert.throws(() => readWindow(PAGE, { offset: 7 }), /past the end/);
});

test("numbers are padded to the widest line number", () => {
  assert.equal(numberLines(["a", "b"], 9), " 9\ta\n10\tb");
});

test("CRLF pages split into the same lines", () => {
  assert.equal(readWindow("a\r\nb", { offset: 2, numbered: false }).text, "b");
});

test("outline lists headings with text and landmarks with ids", () => {
  const html = ['<section id="intro">', "<h2>Intro <b>bold</b></h2>", "<p>x</p>", "<script>", "</script>"].join("\n");
  const { entries, more } = outline(html);
  assert.deepEqual(entries, [
    { line: 1, text: "<section#intro>" },
    { line: 2, text: "<h2> Intro bold" },
    { line: 4, text: "<script>" },
  ]);
  assert.equal(more, 0);
});

test("grep returns numbered matches", () => {
  const found = grepLines(PAGE, "<p>t");
  assert.equal(found.matches, 2);
  assert.equal(found.text, "4:<p>two</p>\n5:<p>three</p>");
});

test("grep context merges overlapping hunks and separates distant ones", () => {
  const lines = Array.from({ length: 12 }, (_, i) => (i === 1 || i === 2 || i === 9 ? `hit ${i + 1}` : `line ${i + 1}`));
  const found = grepLines(lines.join("\n"), "hit", { context: 1 });
  assert.equal(
    found.text,
    [" 1-line 1", " 2:hit 2", " 3:hit 3", " 4-line 4", "--", " 9-line 9", "10:hit 10", "11-line 11"].join("\n")
  );
});

test("grep literal, ignoreCase and maxMatches", () => {
  assert.equal(grepLines("a.b\naxb", "a.b", { literal: true }).matches, 1);
  assert.equal(grepLines("Hello", "hello", { ignoreCase: true }).matches, 1);
  const capped = grepLines("x\nx\nx", "x", { maxMatches: 2 });
  assert.equal(capped.matches, 3);
  assert.equal(capped.omitted, 1);
  assert.equal(capped.text, "1:x\n2:x");
});

test("grep rejects a bad regex with a hint", () => {
  assert.throws(() => grepLines("x", "("), (err: unknown) => err instanceof GrepError && /literal: true/.test(err.message));
});
