import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_LIST_PAGE, THREAD_LIST_RECENT_MS, pageOwned, windowThreadGroup, type ListThread } from "./threadList.js";

const WEEK = THREAD_LIST_RECENT_MS;
const now = 1_700_000_000_000;

function t(id: string, over: Partial<ListThread> = {}): ListThread {
  return { id, when: now - 60_000, ...over };
}

test("pageOwned is false with no messages or only user-typed ones", () => {
  assert.equal(pageOwned([]), false);
  assert.equal(pageOwned([{ kind: "user", text: "hi" }]), false);
  assert.equal(pageOwned([{ kind: "approval", text: "ok" }]), false);
});

test("pageOwned is true while every user turn came from the page", () => {
  assert.equal(pageOwned([{ kind: "user", from: "page", text: "do the card" }]), true);
  assert.equal(
    pageOwned([
      { kind: "user", from: "page", text: "start" },
      { kind: "text", text: "working" },
      { kind: "user", from: "page", text: "continue" },
    ]),
    true
  );
});

test("a typed user message makes a page thread a user thread", () => {
  assert.equal(
    pageOwned([
      { kind: "user", from: "page", text: "start" },
      { kind: "user", text: "also do this" },
    ]),
    false
  );
});

test("approvals, dropped messages, and whitespace do not count as typed", () => {
  assert.equal(
    pageOwned([
      { kind: "user", from: "page", text: "start" },
      { kind: "approval" },
      { kind: "question" },
      { kind: "user", text: "   " },
      { kind: "user", dropped: true, text: "never sent" },
    ]),
    true
  );
});

test("windowThreadGroup keeps at most 10 recent threads", () => {
  const threads = Array.from({ length: 15 }, (_, i) => t(`r${i}`, { when: now - i * 1000 }));
  const { visible, hidden } = windowThreadGroup(threads, { now });
  assert.equal(visible.length, THREAD_LIST_PAGE);
  assert.equal(hidden, 5);
  assert.deepEqual(
    visible.map((x) => x.id),
    threads.slice(0, 10).map((x) => x.id)
  );
});

test("threads older than 7 days stay hidden until extra is raised", () => {
  const threads = [t("new"), t("old", { when: now - WEEK - 1 })];
  const first = windowThreadGroup(threads, { now });
  assert.deepEqual(
    first.visible.map((x) => x.id),
    ["new"]
  );
  assert.equal(first.hidden, 1);
  const next = windowThreadGroup(threads, { now, extra: 10 });
  assert.deepEqual(
    next.visible.map((x) => x.id),
    ["new", "old"]
  );
  assert.equal(next.hidden, 0);
});

test("Show 10 more reveals 10 from the remainder, recent first then older", () => {
  const recent = Array.from({ length: 5 }, (_, i) => t(`r${i}`, { when: now - i * 1000 }));
  const older = Array.from({ length: 20 }, (_, i) => t(`o${i}`, { when: now - WEEK - 1 - i }));
  const { visible, hidden } = windowThreadGroup([...recent, ...older], { now, extra: 10 });
  assert.equal(visible.length, 15);
  assert.equal(hidden, 10);
  assert.deepEqual(
    visible.map((x) => x.id),
    [...recent.map((x) => x.id), ...older.slice(0, 10).map((x) => x.id)]
  );
});

test("pinned and current threads stay visible even when old or beyond the cap", () => {
  const threads = [
    t("pin", { pinned: true, when: now - WEEK * 2 }),
    ...Array.from({ length: 12 }, (_, i) => t(`r${i}`, { when: now - i * 1000 })),
    t("open", { when: now - WEEK * 2 }),
  ];
  const { visible } = windowThreadGroup(threads, { now, currentId: "open" });
  assert.ok(visible.some((x) => x.id === "pin"));
  assert.ok(visible.some((x) => x.id === "open"));
  assert.equal(visible.length, 12);
});

test("hidePage drops page-owned threads unless pinned, current, or searching", () => {
  const threads = [t("page", { fromPage: true }), t("user"), t("pin", { fromPage: true, pinned: true })];
  const hidden = windowThreadGroup(threads, { now, hidePage: true });
  assert.deepEqual(
    hidden.visible.map((x) => x.id),
    ["user", "pin"]
  );
  const open = windowThreadGroup(threads, { now, hidePage: true, currentId: "page" });
  assert.ok(open.visible.some((x) => x.id === "page"));
  const search = windowThreadGroup(threads, { now, hidePage: true, searching: true });
  assert.deepEqual(
    search.visible.map((x) => x.id),
    ["page", "user", "pin"]
  );
  assert.equal(search.hidden, 0);
});
