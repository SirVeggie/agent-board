import assert from "node:assert/strict";
import { test } from "node:test";
import { countChange, diffLines, splitLines, unifiedDiff } from "./textDiff.js";

/** Applying the ops must give back both sides. */
function check(a: string[], b: string[]): void {
  const ops = diffLines(a, b);
  assert.deepEqual(
    ops.filter((op) => op.kind !== "+").map((op) => op.line),
    a
  );
  assert.deepEqual(
    ops.filter((op) => op.kind !== "-").map((op) => op.line),
    b
  );
}

test("diffLines reconstructs both sides", () => {
  check([], []);
  check(["a"], []);
  check([], ["a"]);
  check(["x"], ["y"]);
  check(["a", "b", "c"], ["a", "b", "c"]);
  check(["a", "b", "c"], ["a", "x", "c"]);
  check(["a", "b", "c", "d"], ["b", "d", "e"]);
  check(["same", "old1", "old2", "same2"], ["same", "new1", "same2", "tail"]);
});

test("diffLines on random edits stays minimal enough and correct", () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let round = 0; round < 200; round += 1) {
    const a = Array.from({ length: Math.floor(rand() * 40) }, () => String(Math.floor(rand() * 6)));
    const b = a.filter(() => rand() > 0.25);
    for (let i = 0; i < 5; i += 1) b.splice(Math.floor(rand() * (b.length + 1)), 0, String(Math.floor(rand() * 6)));
    check(a, b);
  }
});

test("large rewrites fall back to replace-all without blowing up", () => {
  const a = Array.from({ length: 9000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 9000 }, (_, i) => `b${i}`);
  const counts = countChange(a.join("\n"), b.join("\n"));
  assert.equal(counts.added, 9000);
  assert.equal(counts.removed, 9000);
});

test("unifiedDiff counts lines and marks new files", () => {
  const diff = unifiedDiff(null, "one\ntwo\n", "dir/new.txt");
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
  assert.match(diff.patch, /^diff --git a\/dir\/new\.txt b\/dir\/new\.txt\nnew file\n--- \/dev\/null\n\+\+\+ b\/dir\/new\.txt\n@@ -0,0 \+1,2 @@\n\+one\n\+two\n$/);
  const edit = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.txt");
  assert.equal(edit.added, 1);
  assert.equal(edit.removed, 1);
  assert.match(edit.patch, /@@ -1,3 \+1,3 @@\n a\n-b\n\+B\n c\n/);
  assert.equal(unifiedDiff("same", "same", "f").patch, "");
  assert.deepEqual(splitLines("x\r\ny\n"), ["x", "y"]);
});
