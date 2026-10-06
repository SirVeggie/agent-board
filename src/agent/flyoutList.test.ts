import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FLYOUT_CAP,
  FLYOUT_HOLD_MS,
  FLYOUT_SOFT_CAP,
  flyoutRows,
  syncFlyoutHold,
  type FlyoutHold,
  type FlyoutThread,
} from "./flyoutList.js";

const now = 1_700_000_000_000;

function t(id: string, over: Partial<FlyoutThread> = {}): FlyoutThread {
  return { id, status: "idle", unread: true, activityAt: now, ...over };
}

function hold(over: Partial<FlyoutHold> = {}): FlyoutHold {
  return { checkedAt: new Map(), listed: new Set(), ...over };
}

function ids(rows: { thread: FlyoutThread }[]): string[] {
  return rows.map((r) => r.thread.id);
}

test("unread idle threads are listed; reading them holds them as checked", () => {
  const h = hold();
  const unread = [t("a")];
  syncFlyoutHold(unread, h, now);
  assert.deepEqual([...h.listed], ["a"]);
  syncFlyoutHold([t("a", { unread: false })], h, now + 1000);
  assert.equal(h.listed.size, 0);
  assert.equal(h.checkedAt.get("a"), now + 1000);
});

test("a checked thread stays in the orb list, dim, above live rows", () => {
  const h = hold({ checkedAt: new Map([["a", now]]) });
  const { rows } = flyoutRows([t("a", { unread: false }), t("b", { status: "running" })], h, { now, from: "orb" });
  assert.deepEqual(ids(rows), ["a", "b"]);
  assert.equal(rows[0].checked, true);
  assert.equal(rows[1].checked, false);
});

test("checked threads leave after five minutes", () => {
  const h = hold();
  syncFlyoutHold([t("a")], h, now);
  syncFlyoutHold([t("a", { unread: false })], h, now + 10);
  const expired = now + 10 + FLYOUT_HOLD_MS;
  const next = syncFlyoutHold([t("a", { unread: false })], h, expired);
  assert.equal(h.checkedAt.size, 0);
  assert.equal(next, null);
  const { rows } = flyoutRows([t("a", { unread: false })], h, { now: expired, from: "orb" });
  assert.deepEqual(ids(rows), []);
});

test("waiting, running and unread stay even when the list is over the soft cap", () => {
  const live = [
    ...Array.from({ length: 6 }, (_, i) => t(`w${i}`, { status: "waiting", activityAt: now + i })),
    ...Array.from({ length: 6 }, (_, i) => t(`r${i}`, { status: "running", activityAt: now + i })),
  ];
  assert.equal(live.length, 12);
  assert.ok(live.length > FLYOUT_SOFT_CAP);
  const { rows, hidden, waiting, running } = flyoutRows(live, hold(), { now, from: "orb" });
  assert.equal(waiting, 6);
  assert.equal(running, 6);
  assert.equal(rows.length, FLYOUT_CAP);
  assert.equal(hidden, 2);
  assert.ok(rows.every((r) => !r.checked));
});

test("over the soft cap, older checked threads drop first; unread and running stay", () => {
  const live = [
    t("run", { status: "running" }),
    ...Array.from({ length: 8 }, (_, i) => t(`u${i}`, { activityAt: now + i })),
  ];
  const checkedAt = new Map<string, number>([
    ["old", now - 4000],
    ["mid", now - 2000],
    ["new", now - 1000],
  ]);
  const threads = [...live, t("old", { unread: false }), t("mid", { unread: false }), t("new", { unread: false })];
  const { rows } = flyoutRows(threads, hold({ checkedAt }), { now, from: "orb" });
  const checked = rows.filter((r) => r.checked).map((r) => r.thread.id);
  assert.deepEqual(checked, ["new"]);
  assert.ok(rows.some((r) => r.thread.id === "run"));
  assert.ok(rows.some((r) => r.thread.id.startsWith("u")));
});

test("all checked drop when live threads already fill the soft cap", () => {
  const live = Array.from({ length: FLYOUT_SOFT_CAP }, (_, i) => t(`u${i}`, { activityAt: now + i }));
  const checkedAt = new Map([["seen", now - 1000]]);
  const { rows } = flyoutRows([...live, t("seen", { unread: false })], hold({ checkedAt }), { now, from: "orb" });
  assert.ok(rows.every((r) => !r.checked));
  assert.ok(!ids(rows).includes("seen"));
});

test("orb order: oldest checked at the top, newest waiting at the bottom", () => {
  const h = hold({
    checkedAt: new Map([
      ["c1", now - 2000],
      ["c2", now - 1000],
    ]),
  });
  const threads = [
    t("c1", { unread: false }),
    t("c2", { unread: false }),
    t("u", { activityAt: now + 1 }),
    t("r", { status: "running", activityAt: now + 2 }),
    t("w-old", { status: "waiting", activityAt: now + 3 }),
    t("w-new", { status: "waiting", activityAt: now + 4 }),
  ];
  const { rows } = flyoutRows(threads, h, { now, from: "orb" });
  assert.deepEqual(ids(rows), ["c1", "c2", "u", "r", "w-old", "w-new"]);
});

test("button order puts newest waiting nearest the pointer (top)", () => {
  const h = hold({ checkedAt: new Map([["c", now]]) });
  const threads = [t("c", { unread: false }), t("u"), t("w", { status: "waiting", activityAt: now + 1 })];
  const { rows } = flyoutRows(threads, h, { now, from: "button" });
  assert.deepEqual(ids(rows), ["w", "u", "c"]);
});

test("display cap keeps the rows nearest the pointer", () => {
  const live = Array.from({ length: 12 }, (_, i) => t(`w${i}`, { status: "waiting", activityAt: now + i }));
  const orb = flyoutRows(live, hold(), { now, from: "orb", cap: 4 });
  assert.deepEqual(ids(orb.rows), ["w8", "w9", "w10", "w11"]);
  assert.equal(orb.hidden, 8);
  const button = flyoutRows(live, hold(), { now, from: "button", cap: 4 });
  assert.deepEqual(ids(button.rows), ["w11", "w10", "w9", "w8"]);
});

test("page-owned unread threads stay out of the flyout", () => {
  const { rows } = flyoutRows([t("page", { fromPage: true })], hold(), { now, from: "orb" });
  assert.deepEqual(ids(rows), []);
});

test("a live run clears a previous checked hold", () => {
  const h = hold();
  syncFlyoutHold([t("a")], h, now);
  syncFlyoutHold([t("a", { unread: false })], h, now + 1);
  syncFlyoutHold([t("a", { status: "running", unread: false })], h, now + 2);
  assert.equal(h.checkedAt.size, 0);
});

test("gone threads leave the hold", () => {
  const h = hold();
  syncFlyoutHold([t("a")], h, now);
  syncFlyoutHold([t("a", { unread: false })], h, now + 1);
  syncFlyoutHold([], h, now + 2);
  assert.equal(h.checkedAt.size, 0);
  assert.equal(h.listed.size, 0);
});
