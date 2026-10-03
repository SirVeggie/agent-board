import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, applyStateOps, diffState, filterItems, getAt } from "./stateOps.js";

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

test("test op guards a write", () => {
  const state = board();
  assert.throws(
    () => applyStateOps(state, [{ op: "test", path: "cards/c1/assignee", value: null }, { op: "test", path: "cards/c2/col", value: "todo" }]),
    /ops\[1\] \(test cards\/c2\/col\): test failed: cards\/c2\/col is "done"/
  );
  const next = applyStateOps(state, [
    { op: "test", path: "cards/c1/assignee", value: null },
    { op: "merge", path: "cards/c1", value: { assignee: "agent" } },
  ]);
  assert.equal((getAt(next, "cards/c1") as Record<string, unknown>).assignee, "agent");
});

test("lenient apply skips failing ops and keeps the rest", () => {
  const result = applyOps(board(), [
    { op: "merge", path: "cards/c9", value: { title: "gone" } },
    { op: "merge", path: "cards/c1", value: { title: "kept" } },
    { op: "move", path: "cards/c1", after: "c_missing" },
  ], { lenient: true });
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].index, 0);
  assert.equal(result.applied.length, 2);
  assert.deepEqual((result.state.cards as { id: string }[]).map((c) => c.id), ["c2", "c3", "c1"]);
  assert.equal((getAt(result.state, "cards/c1") as { title: string }).title, "kept");
});

test("paths escape slashes, and the empty path sets the whole state", () => {
  const next = applyStateOps({ "a/b": { x: 1 } }, [{ op: "merge", path: "a~1b", value: { y: 2 } }]);
  assert.deepEqual(next, { "a/b": { x: 1, y: 2 } });
  assert.deepEqual(applyStateOps(next, [{ op: "set", path: "", value: { fresh: true } }]), { fresh: true });
  assert.throws(() => applyStateOps(next, [{ op: "remove", path: "" }]), /empty path/);
});

test("diff turns a whole-array rewrite into item ops", () => {
  const before = board();
  const after = board();
  after.cards[1].title = "Two edited";
  after.cards.splice(2, 1);
  after.cards.unshift({ id: "c4", num: 4, col: "todo", title: "Four", comments: [] });
  after.cards[1].comments.push({ id: "m1", text: "hi" });
  const ops = diffState(before, after);
  assert.deepEqual(ops.map((op) => `${op.op} ${op.path}`), [
    "remove cards/id=c3",
    "insert cards",
    "insert cards/id=c1/comments",
    "merge cards/id=c2",
  ]);
  assert.deepEqual(applyStateOps(before, ops), after);
});

test("diff ops rebase onto someone else's change to another item", () => {
  const base = board();
  const mine = board();
  mine.cards[0].title = "Mine";
  const ops = diffState(base, mine, ["cards"]);
  const theirs = applyStateOps(base, [{ op: "merge", path: "cards/c3", value: { title: "Theirs" } }]);
  const merged = applyOps(theirs, ops, { lenient: true }).state;
  assert.equal((getAt(merged, "cards/c1") as { title: string }).title, "Mine");
  assert.equal((getAt(merged, "cards/c3") as { title: string }).title, "Theirs");
});

test("diff then apply reproduces random edits", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 300; round += 1) {
    const ids = Array.from({ length: rand(8) }, (_, i) => `i${i}`);
    const before = { list: ids.map((id) => ({ id, v: rand(3), tags: [rand(2)] })), n: rand(4), obj: { a: rand(2), b: "x" } };
    const after = JSON.parse(JSON.stringify(before));
    for (let k = 0; k < 4; k += 1) {
      const pick = rand(6);
      if (pick === 0 && after.list.length) after.list.splice(rand(after.list.length), 1);
      if (pick === 1) after.list.splice(rand(after.list.length + 1), 0, { id: `n${round}_${k}`, v: rand(3), tags: [] });
      if (pick === 2 && after.list.length) {
        const [item] = after.list.splice(rand(after.list.length), 1);
        after.list.splice(rand(after.list.length + 1), 0, item);
      }
      if (pick === 3 && after.list.length) after.list[rand(after.list.length)].v = rand(9);
      if (pick === 4) after.obj = rand(2) ? { a: rand(5) } : { a: 1, b: "x", c: null };
      if (pick === 5) after.n = rand(9);
    }
    const ops = diffState(before, after);
    assert.deepEqual(applyStateOps(before, ops), after, JSON.stringify({ before, after, ops }));
  }
});

test("diff removes keys that are gone", () => {
  assert.deepEqual(diffState({ a: 1, b: 2 }, { a: 1 }, ["a", "b"]), [{ op: "remove", path: "b" }]);
  assert.deepEqual(diffState({}, { a: [1] }), [{ op: "set", path: "a", value: [1] }]);
});

test("the page bridge's embedded engine runs in a bare scope", async () => {
  // Under tsx, function sources carry esbuild's __name(...) calls; the page has no such helper.
  const { ENGINE_JS } = await import("./bridge.js");
  const engine = new Function(`return ${ENGINE_JS};`)();
  const state = engine.apply({ cards: [{ id: "c1", title: "One" }] }, [{ op: "set", path: "cards/c1/title", value: "Uno" }]).state;
  assert.deepEqual(state, { cards: [{ id: "c1", title: "Uno" }] });
  assert.deepEqual(engine.diff({ a: 1 }, { a: 2 }), [{ op: "set", path: "a", value: 2 }]);
});
