import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseWhere } from "./signal.js";
import { BoardStore } from "./store.js";
import { eventMatches, waitForEvents } from "./wait.js";

let dir = "";
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.SCRIBE_HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-wait-"));
  process.env.SCRIBE_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.SCRIBE_HOME;
  } else {
    process.env.SCRIBE_HOME = prevHome;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function loaded(): BoardStore {
  const store = new BoardStore();
  store.load();
  return store;
}

function board(store: BoardStore) {
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>", state: { cards: [] } });
}

test("parseWhere keeps scalar fields and accepts a JSON string", () => {
  assert.equal(parseWhere(undefined), undefined);
  assert.equal(parseWhere({}), undefined);
  assert.deepEqual(parseWhere({ column: "grok issues", n: 2, ok: true, skip: { nested: true } }), {
    column: "grok issues",
    n: 2,
    ok: true,
  });
  assert.deepEqual(parseWhere('{"column":"claude issues"}'), { column: "claude issues" });
  assert.throws(() => parseWhere("not-json"), /JSON object/);
  assert.throws(() => parseWhere(["x"]), /object/);
});

test("eventMatches requires every where field on data", () => {
  const ev = { seq: 1, name: "card_ready", data: { card: "c1", num: 12, column: "grok issues" }, at: 1, by: "user" as const };
  assert.equal(eventMatches(ev, ["card_ready"]), true);
  assert.equal(eventMatches(ev, ["card_ready"], { column: "grok issues" }), true);
  assert.equal(eventMatches(ev, ["card_ready"], { column: "claude issues" }), false);
  assert.equal(eventMatches(ev, ["comment"], { column: "grok issues" }), false);
  assert.equal(eventMatches({ ...ev, data: null }, ["card_ready"], { column: "grok issues" }), false);
});

test("wait where ignores card_ready for another column until its own arrives", async () => {
  const store = loaded();
  board(store);
  const pending = waitForEvents({
    idOrKey: "page",
    names: ["card_ready"],
    timeoutMs: 2000,
    viewer: "agent",
    where: { column: "grok issues" },
    store,
  });
  store.logEvent("page", {
    name: "card_ready",
    data: { card: "c1", num: 1, column: "claude issues", columnId: "col_c" },
    by: "user",
  });
  store.logEvent("page", {
    name: "card_ready",
    data: { card: "c2", num: 2, column: "grok issues", columnId: "col_g" },
    by: "user",
  });
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(result.events.length, 1);
  assert.equal((result.events[0].data as { card: string }).card, "c2");
  assert.equal(result.cursor, 2);
  store.closeDb();
});

test("wait where timeout still advances the cursor past non-matching events", async () => {
  const store = loaded();
  board(store);
  const pending = waitForEvents({
    idOrKey: "page",
    names: ["card_ready"],
    timeoutMs: 40,
    viewer: "agent",
    where: { column: "grok issues" },
    store,
  });
  store.logEvent("page", {
    name: "card_ready",
    data: { card: "c1", num: 1, column: "claude issues" },
    by: "user",
  });
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.events.length, 0);
  assert.equal(result.cursor, 1);
  store.closeDb();
});
