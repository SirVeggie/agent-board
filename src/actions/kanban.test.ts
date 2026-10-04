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
  assert.equal(c.assignee, "Claude Code");
  assert.deepEqual(c.status, { kind: "working", text: "Fixing it" });
  assert.equal((c.claim as { holder: string }).holder, "Claude Code");
  assert.equal(c.from, "ready");
  assert.equal((c.claim as { from?: string }).from, "ready");
  assert.throws(() => run(state, "claim", { card: 2 }, agent({ session: "s2" })), /held by Claude Code/);
  // The same session may claim again.
  run(state, "claim", { card: 2 }, agent());
});

test("claim assignee uses the arg, else Claude/Cursor for in-app threads", () => {
  const named = run(board(), "claim", { card: 1, assignee: "Grok" });
  assert.equal(card(named.state, 1).assignee, "Grok");
  const cursor = run(board(), "claim", { card: 1 }, agent({ label: "Scribe chat: Grok Issues", provider: "cursor" }));
  assert.equal(card(cursor.state, 1).assignee, "Cursor");
  const claude = run(board(), "claim", { card: 1 }, agent({ label: "Scribe chat: Board", provider: "claude" }));
  assert.equal(card(claude.state, 1).assignee, "Claude");
  assert.throws(() => run(board(), "claim", { card: 1, assignee: "  " }), /assignee is empty/);
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

test("a thread's claim records it on the card, and finish keeps it", () => {
  const ctx = agent({ thread: "th_1" });
  const claimed = run(board(), "claim", { card: 1 }, ctx).state;
  assert.equal(card(claimed, 1).thread, "th_1");
  const { state } = run(claimed, "finish", { card: 1, summary: "Done." }, ctx);
  assert.equal(card(state, 1).thread, "th_1");
  assert.equal(card(run(board(), "claim", { card: 1 }, agent({ thread: undefined })).state, 1).thread, undefined);
});

test("finish without a summary hands in the comment posted since the claim, and never doubles it", () => {
  const claimed = run(board(), "claim", { card: 1 }, agent({ session: "s1" }));
  // A comment from before this claim does not count as the hand-in.
  const old = run(board(), "comment", { card: 1, text: "Old note" }).state;
  const reclaimed = run({ ...old }, "claim", { card: 1 }, { ...agent(), now: 2000 }).state;
  assert.throws(() => run(reclaimed, "finish", { card: 1 }, { ...agent(), now: 3000 }), /summary is required/);

  const commented = run(claimed.state, "comment", { card: 1, text: "Done: the filter works.\nRestart the app." }, { ...agent(), now: 1500 }).state;
  const reused = run(commented, "finish", { card: 1 }, { ...agent(), now: 1600 });
  const comments = card(reused.state, 1).comments as Array<{ text: string }>;
  assert.equal(comments.length, 1);
  assert.equal(reused.result.handIn, "your earlier comment");
  assert.equal(card(reused.state, 1).col, "rev");

  // The same text again as the summary is not posted twice; a different summary is.
  const same = run(commented, "finish", { card: 1, summary: "done:  the filter works. restart the app." }, { ...agent(), now: 1600 });
  assert.equal((card(same.state, 1).comments as unknown[]).length, 1);
  const other = run(commented, "finish", { card: 1, summary: "Also fixed the sort." }, { ...agent(), now: 1600 });
  assert.equal((card(other.state, 1).comments as unknown[]).length, 2);
});

test("get returns the comments themselves, not just their count", () => {
  const commented = run(board(), "comment", { card: 1, text: "First **note**" }).state;
  const withImage = {
    ...commented,
    cards: (commented.cards as Array<Record<string, unknown>>).map((c) =>
      c.num === 1
        ? { ...c, images: [{ id: "im_1", name: "shot.png", data: "/blob/pa_aaaaaaaaaaaaaaaaaaaaaaaa" }] }
        : c
    ),
  };
  const { result } = run(withImage, "get", { card: 1 });
  const comments = result.comments as Array<{ by: string; text: string }>;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "First **note**");
  assert.equal(comments[0].by, "agent");
  assert.equal(result.lastComment, undefined);
  assert.equal(result.column, "Ready for agent");
  assert.deepEqual(result.images, [{ id: "im_1", name: "shot.png", data: "/blob/pa_aaaaaaaaaaaaaaaaaaaaaaaa" }]);
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
  assert.equal(card(state, 4).from, "ready");
  assert.throws(() => run(board(), "create", { title: "x", labels: ["nope"] }), /no label "nope"/);
});

test("list gives compact rows and column counts", () => {
  const { result } = run(board(), "list", { column: "agent" });
  assert.deepEqual((result.cards as Array<{ num: number }>).map((c) => c.num), [1, 2]);
  assert.equal((result.columns as Array<{ cards: number }>)[1].cards, 2);
  assert.equal((result.columns as Array<{ stopRequested?: boolean }>)[1].stopRequested, undefined);
});

test("list q matches title, description, comments, and checklist", () => {
  const state = {
    ...board(),
    cards: [
      { id: "c1", num: 1, col: "ready", title: "Alpha", description: "unique-desc-word", comments: [], createdAt: 1, movedAt: 1 },
      {
        id: "c2",
        num: 2,
        col: "ready",
        title: "Beta",
        comments: [{ id: "cm1", by: "user", at: 1, text: "unique-comment-word" }],
        createdAt: 1,
        movedAt: 1,
      },
      {
        id: "c3",
        num: 3,
        col: "ready",
        title: "Gamma",
        checklist: [{ id: "ck1", text: "unique-check-word", done: false }],
        comments: [],
        createdAt: 1,
        movedAt: 1,
      },
      { id: "c4", num: 4, col: "ready", title: "Delta", comments: [], createdAt: 1, movedAt: 1 },
    ],
  };
  const nums = (q: string) => (run(state, "list", { q }).result.cards as Array<{ num: number }>).map((c) => c.num);
  assert.deepEqual(nums("unique-desc-word"), [1]);
  assert.deepEqual(nums("unique-comment-word"), [2]);
  assert.deepEqual(nums("unique-check-word"), [3]);
  assert.deepEqual(nums("alpha unique-desc-word"), [1]);
  assert.deepEqual(nums("nope"), []);
});

const twoAgents = () => ({
  columns: [
    { id: "claude", title: "claude", role: "agent" },
    { id: "grok", title: "grok", role: "agent" },
    { id: "work", title: "Agent working", role: "working" },
    { id: "done", title: "Done", role: "done" },
  ],
  labels: [],
  cards: [
    { id: "c1", num: 1, col: "claude", title: "Claude job", comments: [], createdAt: 1, movedAt: 1 },
    { id: "c2", num: 2, col: "grok", title: "Grok job", comments: [], createdAt: 1, movedAt: 1 },
  ],
  nextNum: 3,
});

test("list by a shared role includes every matching column; id or title still picks one", () => {
  const { result } = run(twoAgents(), "list", { column: "agent" });
  assert.deepEqual((result.cards as Array<{ num: number }>).map((c) => c.num), [1, 2]);
  assert.deepEqual(
    (run(twoAgents(), "list", { column: "grok" }).result.cards as Array<{ num: number }>).map((c) => c.num),
    [2]
  );
  assert.deepEqual(
    (run(twoAgents(), "list", { column: "claude" }).result.cards as Array<{ num: number }>).map((c) => c.num),
    [1]
  );
});

test("create and move refuse a shared role and still accept a unique role, id, or title", () => {
  assert.throws(() => run(twoAgents(), "create", { title: "New", column: "agent" }), /matches more than one column: claude, grok/);
  assert.throws(() => run(twoAgents(), "move", { card: 1, to: "agent" }), /matches more than one column/);
  const created = run(twoAgents(), "create", { title: "New", column: "grok" });
  assert.equal(card(created.state, 3).col, "grok");
  assert.equal(card(run(twoAgents(), "move", { card: 1, to: "working" }).state, 1).col, "work");
  assert.equal(card(run(twoAgents(), "move", { card: 2, to: "claude" }).state, 2).col, "claude");
});

test("list marks a column whose agent worker was asked to stop", () => {
  const state = { ...board(), settings: { workers: { ready: { name: "Opus", stop: true }, in: { name: "Other" } } } };
  const cols = run(state, "list", {}).result.columns as Array<{ id: string; stopRequested?: boolean }>;
  assert.equal(cols.find((c) => c.id === "ready")?.stopRequested, true);
  assert.equal(cols.find((c) => c.id === "in")?.stopRequested, undefined);
});

test("worker_step lets one window at a time move a worker on, once its thread is done", () => {
  const threads: Record<string, ThreadRunInfo> = {
    busy: { exists: true, running: true, title: "Busy" },
    fresh: { exists: true, running: false, title: "Fresh" },
    failed: { exists: true, running: false, title: "Failed", lastTurn: { status: "error", endedAt: 900, error: "rate limited" } },
  };
  const page = (now = 1000): ActionContext => ({ caller: { by: "user", label: "user" }, now, values: {}, thread: (id) => threads[id] ?? { exists: false } });
  const withWorker = (w: Record<string, unknown>) => ({ ...board(), settings: { workers: { ready: { name: "Opus", ...w } } } });
  const workerOf = (state: Record<string, unknown>) => (state.settings as { workers: Record<string, Record<string, unknown>> }).workers.ready;

  assert.throws(() => run(withWorker({}), "worker_step", { column: "ready", from: null, token: "a", start: true }), /board page itself/);
  assert.throws(() => run(withWorker({}), "worker_step", { column: "ready", from: null, token: "a" }, page()), /not running/);

  const started = run(withWorker({ stop: true, error: "old" }), "worker_step", { column: "ready", from: null, token: "a", start: true }, page());
  assert.deepEqual(workerOf(started.state).run, { since: 1000 });
  assert.deepEqual(workerOf(started.state).step, { token: "a", at: 1000 });
  assert.equal(workerOf(started.state).stop, undefined);
  assert.equal(workerOf(started.state).error, undefined);
  assert.throws(() => run(started.state, "worker_step", { column: "ready", from: null, token: "b" }, page()), /another window/);
  assert.throws(() => run(started.state, "worker_step", { column: "ready", from: null, token: "b", start: true }, page()), /already running/);
  run(started.state, "worker_step", { column: "ready", from: null, token: "b" }, page(1000 + 16 * 60 * 1000));
  run(withWorker({ step: { token: "gone", at: 999 } }), "worker_step", { column: "ready", from: null, token: "b", start: true }, page());

  const running = { run: { since: 1 } };
  assert.throws(() => run(withWorker({ ...running, threadId: "busy" }), "worker_step", { column: "ready", from: "busy", token: "a" }, page()), /still working/);
  assert.throws(() => run(withWorker({ ...running, threadId: "fresh" }), "worker_step", { column: "ready", from: "fresh", token: "a" }, page()), /still working/);
  assert.throws(() => run(withWorker({ ...running, threadId: "failed" }), "worker_step", { column: "ready", from: "other", token: "a" }, page()), /moved on/);
  const failed = run(withWorker({ ...running, threadId: "failed" }), "worker_step", { column: "ready", from: "failed", token: "a" }, page());
  assert.deepEqual(failed.result, { ok: true, lastTurn: { status: "error", error: "rate limited" } });
  const gone = run(withWorker({ ...running, threadId: "deleted" }), "worker_step", { column: "ready", from: "deleted", token: "a" }, page());
  assert.deepEqual(gone.result, { ok: true, lastTurn: null });
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

test("claim, release, and sweep return a card to the agent column it came from, not the first one", () => {
  const two = () => ({
    columns: [
      { id: "claude", title: "claude", role: "agent" },
      { id: "grok", title: "grok", role: "agent" },
      { id: "work", title: "Agent working", role: "working" },
      { id: "done", title: "Done", role: "done" },
    ],
    labels: [],
    cards: [
      { id: "c1", num: 1, col: "grok", title: "One", comments: [], createdAt: 1, movedAt: 1 },
      { id: "c2", num: 2, col: "claude", title: "Two", comments: [], createdAt: 1, movedAt: 1 },
    ],
    nextNum: 3,
  });
  const claimed = run(two(), "claim", { card: 1 }, agent({ session: undefined, thread: "th_g" }));
  assert.equal(card(claimed.state, 1).col, "work");
  assert.equal(card(claimed.state, 1).from, "grok");
  assert.equal((card(claimed.state, 1).claim as { from?: string }).from, "grok");

  const released = run(claimed.state, "release", { card: 1 });
  assert.equal(card(released.state, 1).col, "grok");

  const again = run(claimed.state, "claim", { card: 1 }, agent({ session: undefined, thread: "th_g" }));
  assert.equal((card(again.state, 1).claim as { from?: string }).from, "grok");

  const threads: Record<string, ThreadRunInfo> = {
    th_g: { exists: true, running: false, title: "G", lastTurn: { status: "cancelled", endedAt: 2000 } },
  };
  const ctx: SweepContext = { now: 3000, thread: (id) => threads[id] ?? { exists: false }, sessionSeenAt: () => undefined };
  const lost = kanbanActions.sweep!(claimed.state, ctx)!;
  assert.equal(card(applyStateOps(claimed.state, lost.ops), 1).col, "grok");
});

test("sweep with no stored origin still returns via the worker that started the thread", () => {
  const state = {
    columns: [
      { id: "claude", title: "claude", role: "agent" },
      { id: "grok", title: "grok", role: "agent" },
      { id: "work", title: "Agent working", role: "working" },
    ],
    labels: [],
    cards: [
      {
        id: "c1",
        num: 1,
        col: "work",
        title: "One",
        comments: [],
        createdAt: 1,
        movedAt: 1,
        claim: { holder: "Grok", thread: "th_g", at: 1, seenAt: 1 },
      },
    ],
    nextNum: 2,
    settings: { workers: { grok: { threadId: "th_g" }, claude: { threadId: "th_c" } } },
  };
  const threads: Record<string, ThreadRunInfo> = {
    th_g: { exists: true, running: false, title: "G", lastTurn: { status: "error", endedAt: 2000 } },
  };
  const lost = kanbanActions.sweep!(state, {
    now: 3000,
    thread: (id) => threads[id] ?? { exists: false },
    sessionSeenAt: () => undefined,
  })!;
  assert.equal(card(applyStateOps(state, lost.ops), 1).col, "grok");
});

test("sweep falls back to the first agent column when the origin column is gone", () => {
  const claimed = run(
    {
      columns: [
        { id: "claude", title: "claude", role: "agent" },
        { id: "grok", title: "grok", role: "agent" },
        { id: "work", title: "Agent working", role: "working" },
      ],
      labels: [],
      cards: [{ id: "c1", num: 1, col: "grok", title: "One", comments: [], createdAt: 1, movedAt: 1 }],
      nextNum: 2,
    },
    "claim",
    { card: 1 },
    agent({ session: undefined, thread: "th" })
  );
  const gone = {
    ...claimed.state,
    columns: (claimed.state.columns as Array<{ id: string }>).filter((c) => c.id !== "grok"),
  };
  const threads: Record<string, ThreadRunInfo> = {
    th: { exists: true, running: false, title: "A", lastTurn: { status: "error", endedAt: 2000 } },
  };
  const lost = kanbanActions.sweep!(gone, {
    now: 3000,
    thread: (id) => threads[id] ?? { exists: false },
    sessionSeenAt: () => undefined,
  })!;
  assert.equal(card(applyStateOps(gone, lost.ops), 1).col, "claude");
});

test("the sweep keeps a running worker's card claimed while its chat waits out a plan limit", () => {
  const resetsAt = 50_000;
  const limited: ThreadRunInfo = { exists: true, running: false, title: "W", lastTurn: { status: "error", endedAt: 2000, error: "You've hit your limit", limitResetsAt: resetsAt } };
  const claimed = run(board(), "claim", { card: 1 }, agent({ session: undefined, thread: "th_w" })).state;
  const withWorker = (w: Record<string, unknown>) => ({ ...claimed, settings: { workers: { ready: { threadId: "th_w", ...w } } } });
  const ctx = (now: number): SweepContext => ({ now, thread: () => limited, sessionSeenAt: () => undefined });

  const waiting = kanbanActions.sweep!(withWorker({ run: { since: 1 } }), ctx(3000))!;
  const state = applyStateOps(withWorker({ run: { since: 1 } }), waiting.ops);
  assert.equal(card(state, 1).col, "work");
  assert.ok(card(state, 1).claim);
  assert.equal((card(state, 1).status as { kind: string }).kind, "info");
  assert.match((card(state, 1).status as { text: string }).text, /Out of plan usage/);
  assert.equal(waiting.events?.length, 0);
  // The status is set once, not on every sweep.
  assert.equal(kanbanActions.sweep!(state, ctx(4000)), null);

  // Long after the reset, with no one picking it up, the claim goes stale.
  const late = kanbanActions.sweep!(state, ctx(resetsAt + 31 * 60 * 1000))!;
  assert.deepEqual(late.events?.map((e) => e.name), ["claim_stale"]);

  // A stopped worker (or a chat no worker runs) loses the card as before.
  const stopped = kanbanActions.sweep!(withWorker({}), ctx(3000))!;
  assert.deepEqual(stopped.events?.map((e) => e.name), ["claim_lost"]);
});

test("worker_step passes on when a plan limit resets", () => {
  const threads: Record<string, ThreadRunInfo> = {
    limited: { exists: true, running: false, title: "L", lastTurn: { status: "error", endedAt: 900, error: "limit", limitResetsAt: 5000 } },
  };
  const page: ActionContext = { caller: { by: "user", label: "user" }, now: 1000, values: {}, thread: (id) => threads[id] ?? { exists: false } };
  const state = { ...board(), settings: { workers: { ready: { threadId: "limited", run: { since: 1 } } } } };
  const r = run(state, "worker_step", { column: "ready", from: "limited", token: "a" }, page);
  assert.deepEqual(r.result, { ok: true, lastTurn: { status: "error", error: "limit", limitResetsAt: 5000 } });
});
