import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStateOps, filterItems, getAt } from "./stateOps.js";

const board = () => ({
  cards: [
    { id: "c1", num: 1, col: "todo", title: "One", comments: [] as unknown[] },
    { id: "c2", num: 2, col: "done", title: "Two", status: { kind: "working" }, comments: [] as unknown[] },
    { id: "c3", num: 3, col: "done", title: "Three", comments: [] as unknown[] },
  ],
  nextNum: 4,
});

test("getAt selects by id, field=value and index", () => {
  const state = board();
  assert.equal((getAt(state, "cards/c2") as { title: string }).title, "Two");
  assert.equal((getAt(state, "cards/num=3") as { title: string }).title, "Three");
  assert.equal((getAt(state, "cards/#0") as { title: string }).title, "One");
  assert.equal(getAt(state, "nextNum"), 4);
  assert.throws(() => getAt(state, "cards/num=9"), /no item matches "num=9" in cards/);
  assert.throws(() => getAt(state, "missing"), /no key "missing"/);
});

test("filterItems keeps matching items", () => {
  assert.deepEqual(
    filterItems(board().cards, { col: "done" }).map((c) => (c as { id: string }).id),
    ["c2", "c3"]
  );
});

test("merge changes one item and null removes a key", () => {
  const before = board();
  const next = applyStateOps(before, [{ op: "merge", path: "cards/num=2", value: { col: "todo", status: null } }]);
  const card = getAt(next, "cards/c2") as Record<string, unknown>;
  assert.equal(card.col, "todo");
  assert.equal("status" in card, false);
  // The input is untouched.
  assert.equal((getAt(before, "cards/c2") as Record<string, unknown>).col, "done");
});

test("insert appends to a nested array and positions items", () => {
  let next = applyStateOps(board(), [
    { op: "insert", path: "cards/c1/comments", value: { id: "m1", by: "agent", text: "hi" } },
    { op: "insert", path: "cards", value: { id: "c4", num: 4, col: "done" }, before: "col=done" },
    { op: "set", path: "nextNum", value: 5 },
  ]);
  assert.deepEqual(getAt(next, "cards/c1/comments"), [{ id: "m1", by: "agent", text: "hi" }]);
  assert.deepEqual((next.cards as { id: string }[]).map((c) => c.id), ["c1", "c4", "c2", "c3"]);
  assert.equal(next.nextNum, 5);
  next = applyStateOps(next, [{ op: "insert", path: "cards", value: { id: "c5", col: "x" }, before: "col=nowhere" }]);
  assert.equal((next.cards as { id: string }[]).at(-1)?.id, "c5");
  assert.throws(() => applyStateOps(next, [{ op: "insert", path: "cards", value: { id: "c1" } }]), /already has an item with id "c1"/);
});

test("move repositions within the array", () => {
  const next = applyStateOps(board(), [{ op: "move", path: "cards/c1", before: "col=done" }]);
  assert.deepEqual((next.cards as { id: string }[]).map((c) => c.id), ["c1", "c2", "c3"]);
  const last = applyStateOps(board(), [{ op: "move", path: "cards/c1", at: "end" }]);
  assert.deepEqual((last.cards as { id: string }[]).map((c) => c.id), ["c2", "c3", "c1"]);
  const after = applyStateOps(board(), [{ op: "move", path: "cards/c3", after: "c1" }]);
  assert.deepEqual((after.cards as { id: string }[]).map((c) => c.id), ["c1", "c3", "c2"]);
});

test("remove deletes an item or a key", () => {
  const next = applyStateOps(board(), [
    { op: "remove", path: "cards/num=2" },
    { op: "remove", path: "nextNum" },
  ]);
  assert.deepEqual((next.cards as { id: string }[]).map((c) => c.id), ["c1", "c3"]);
  assert.equal("nextNum" in next, false);
});

test("a failing op changes nothing and names itself", () => {
  const state = board();
  assert.throws(
    () =>
      applyStateOps(state, [
        { op: "merge", path: "cards/c1", value: { title: "changed" } },
        { op: "merge", path: "cards/c9", value: { title: "x" } },
      ]),
    /ops\[1\] \(merge cards\/c9\): no item matches "c9"/
  );
  assert.equal((getAt(state, "cards/c1") as { title: string }).title, "One");
});
