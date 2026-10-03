import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStateOps } from "../stateOps.js";
import { kanbanActions } from "./kanban.js";
import type { ActionContext, SweepContext, ThreadRunInfo } from "./types.js";

const board = () => ({
  columns: [
    { id: "in", title: "Inbox" },
    { id: "ready", title: "Ready for agent", role: "agent" },
    { id: "work", title: "Agent working", role: "working" },
    { id: "rev", title: "Needs review", role: "review" },
    { id: "done", title: "Done", role: "done" },
  ],
  labels: [{ id: "lb1", name: "Bug" }],
  cards: [
    { id: "c1", num: 1, col: "ready", title: "One", comments: [], createdAt: 1, movedAt: 1 },
    { id: "c2", num: 2, col: "ready", title: "Two", comments: [], createdAt: 1, movedAt: 1 },
    { id: "c3", num: 3, col: "done", title: "Three", comments: [], createdAt: 1, movedAt: 1, doneAt: 1 },
  ],
  nextNum: 4,
});

const agent = (over: Partial<ActionContext["caller"]> = {}): ActionContext => ({
  caller: { by: "agent", label: "Claude Code", session: "s1", ...over },
  now: 1000,
  values: {},
});

function run(state: Record<string, unknown>, name: string, args: Record<string, unknown>, ctx = agent()) {
  const outcome = kanbanActions.actions[name].run(state, args, ctx);
  return { state: applyStateOps(state, outcome.ops), result: outcome.result as Record<string, unknown> };
}

const card = (state: Record<string, unknown>, num: number) =>
  (state.cards as Array<Record<string, unknown>>).find((c) => c.num === num)!;
const order = (state: Record<string, unknown>) => (state.cards as Array<{ num: number }>).map((c) => c.num);

test("claim moves a card to working, records the holder, and refuses a second agent", () => {
  const { state } = run(board(), "claim", { card: "#2", text: "Fixing it" });
  const c = card(state, 2);
  assert.equal(c.col, "work");
  assert.equal(c.assignee, "agent");
  assert.deepEqual(c.status, { kind: "working", text: "Fixing it" });
  assert.equal((c.claim as { holder: string }).holder, "Claude Code");
  assert.throws(() => run(state, "claim", { card: 2 }, agent({ session: "s2" })), /held by Claude Code/);
  // The same session may claim again.
  run(state, "claim", { card: 2 }, agent());
});

test("finish comments, clears the claim, and hands the card to review", () => {
  const claimed = run(board(), "claim", { card: 1 }).state;
  const { state } = run(claimed, "finish", { card: 1, summary: "Done, see commit abc." });
  const c = card(state, 1);
  assert.equal(c.col, "rev");
  assert.equal(c.claim, undefined);
  assert.equal(c.status, undefined);
  assert.equal((c.comments as Array<{ by: string; text: string }>).at(-1)?.text, "Done, see commit abc.");
  assert.equal((c.comments as Array<{ by: string }>).at(-1)?.by, "agent");
});

test("get returns the comments themselves, not just their count", () => {
  const commented = run(board(), "comment", { card: 1, text: "First **note**" }).state;
  const { result } = run(commented, "get", { card: 1 });
  const comments = result.comments as Array<{ by: string; text: string }>;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "First **note**");
  assert.equal(comments[0].by, "agent");
  assert.equal(result.lastComment, undefined);
  assert.equal(result.column, "Ready for agent");
});

test("moving into done sets doneAt and puts the card on top; moving out clears it", () => {
  let { state } = run(board(), "move", { card: 1, to: "done" });
  assert.deepEqual(order(state), [2, 1, 3]);
  assert.equal(card(state, 1).doneAt, 1000);
  ({ state } = run(state, "move", { card: 1, to: "Inbox" }));
  assert.equal(card(state, 1).doneAt, undefined);
  assert.equal(card(state, 1).col, "in");
  assert.throws(() => run(state, "move", { card: 1, to: "nowhere" }), /no column "nowhere". Columns: Inbox/);
});

test("create numbers the card, resolves labels, and lands at the column's end", () => {
  const { state, result } = run(board(), "create", { title: "New", column: "agent", labels: ["bug"] });
  assert.equal(result.num, 4);
  assert.equal(state.nextNum, 5);
  assert.deepEqual(order(state), [1, 2, 4, 3]);
  assert.deepEqual(card(state, 4).labels, ["lb1"]);
  assert.throws(() => run(board(), "create", { title: "x", labels: ["nope"] }), /no label "nope"/);
});

test("list gives compact rows and column counts", () => {
  const { result } = run(board(), "list", { column: "agent" });
  assert.deepEqual((result.cards as Array<{ num: number }>).map((c) => c.num), [1, 2]);
  assert.equal((result.columns as Array<{ cards: number }>)[1].cards, 2);
});

test("the sweep releases a card whose thread failed and flags one whose thread went quiet", () => {
  let state: Record<string, unknown> = board();
  state = run(state, "claim", { card: 1 }, agent({ session: undefined, thread: "th_fail" })).state;
  state = run(state, "claim", { card: 2 }, agent({ session: undefined, thread: "th_idle" })).state;
  const threads: Record<string, ThreadRunInfo> = {
    th_fail: { exists: true, running: false, title: "A", lastTurn: { status: "error", endedAt: 2000, error: "credit balance too low" } },
    th_idle: { exists: true, running: false, title: "B", lastTurn: { status: "done", endedAt: 2000 } },
  };
  const ctx = (now: number): SweepContext => ({ now, thread: (id) => threads[id] ?? { exists: false }, sessionSeenAt: () => undefined });
  const first = kanbanActions.sweep!(state, ctx(3000))!;
  state = applyStateOps(state, first.ops);
  assert.equal(card(state, 1).col, "ready");
  assert.equal(card(state, 1).claim, undefined);
  assert.match((card(state, 1).status as { text: string }).text, /failed: credit balance too low/);
  assert.equal(card(state, 2).col, "work");
  assert.deepEqual(first.events?.map((e) => e.name), ["claim_lost"]);
  const later = kanbanActions.sweep!(state, ctx(2000 + 31 * 60 * 1000))!;
  state = applyStateOps(state, later.ops);
  assert.equal((card(state, 2).claim as { stale?: boolean }).stale, true);
  assert.deepEqual(later.events?.map((e) => e.name), ["claim_stale"]);
  assert.equal(kanbanActions.sweep!(state, ctx(2000 + 40 * 60 * 1000)), null);
});

test("the sweep keeps a claim whose thread id is unknown while its MCP session is still live", () => {
  const state = run(board(), "claim", { card: 1 }, agent({ session: "s1", thread: "th_draft" })).state;
  const live: SweepContext = {
    now: 10_000,
    thread: () => ({ exists: false }),
    sessionSeenAt: (session) => (session === "s1" ? 9000 : undefined),
  };
  assert.equal(kanbanActions.sweep!(state, live), null);
  const gone: SweepContext = {
    now: 10_000 + 61 * 60 * 1000,
    thread: () => ({ exists: false }),
    sessionSeenAt: (session) => (session === "s1" ? 9000 : undefined),
  };
  const lost = kanbanActions.sweep!(state, gone)!;
  assert.equal(card(state, 1).col, "work");
  const next = applyStateOps(state, lost.ops);
  assert.equal(card(next, 1).col, "ready");
  assert.equal(card(next, 1).claim, undefined);
  assert.match((card(next, 1).status as { text: string }).text, /was deleted/);
  assert.deepEqual(lost.events?.map((e) => e.name), ["claim_lost"]);
});
