import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BoardStore } from "./store.js";
import { toMeta } from "./types.js";

let dir = "";
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.AGENT_BOARD_HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-board-"));
  process.env.AGENT_BOARD_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.AGENT_BOARD_HOME;
  } else {
    process.env.AGENT_BOARD_HOME = prevHome;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function loaded(): BoardStore {
  const store = new BoardStore();
  store.load();
  return store;
}

function titles(store: BoardStore): string[] {
  return store.list().map((tab) => tab.title);
}

test("open tabs sort pinned first, then strip_seq", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.update("c", { pin: true, activate: false });
  assert.deepEqual(titles(store), ["C", "A", "B"]);
  store.update("c", { pin: false, activate: false });
  assert.deepEqual(titles(store), ["C", "A", "B"]);
  store.closeDb();
});

test("persists strip order across reload", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.update("a", { pin: true, activate: false });
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["A", "B"]);
  again.closeDb();
});

test("Ctrl+Z keeps strip_seq so the tab returns to its hole", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.archiveTab("b");
  assert.deepEqual(titles(store), ["A", "C"]);
  store.restoreLast();
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  store.closeDb();
});

test("restore from archive assigns a new seq and appends", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.archiveTab("b");
  store.restore("b", { placement: "append", activate: false });
  assert.deepEqual(titles(store), ["A", "C", "B"]);
  store.closeDb();
});

test("focus does not change strip order", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.focus("a");
  assert.deepEqual(titles(store), ["A", "B"]);
  store.closeDb();
});

test("toMeta omits stripSeq", () => {
  const store = loaded();
  const { tab } = store.upsert({ title: "A", html: "<p>a</p>" });
  assert.equal("stripSeq" in toMeta(tab), false);
  assert.equal(typeof tab.stripSeq, "number");
  store.closeDb();
});

test("unpin seq does not collide with an archived tab", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.archiveTab("a");
  store.update("c", { pin: true, activate: false });
  store.update("c", { pin: false, activate: false });
  store.restoreLast();
  const seqs = store.listOpenTabs().map((tab) => tab.stripSeq);
  assert.equal(new Set(seqs).size, seqs.length);
  store.closeDb();
});

test("migrates state.json once into board.sqlite", () => {
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      activeId: "t_aaa",
      tabs: [
        {
          id: "t_aaa",
          key: "alpha",
          title: "Alpha",
          html: "<p>a</p>",
          pinned: true,
          createdAt: 1,
          updatedAt: 1,
          revision: 1,
          state: {},
          stateRevision: 0,
          stateUpdatedAt: 0,
          signalRevision: 0,
          signal: null,
          assets: [],
        },
        {
          id: "t_bbb",
          key: "beta",
          title: "Beta",
          html: "<p>b</p>",
          pinned: false,
          createdAt: 2,
          updatedAt: 2,
          revision: 1,
          state: {},
          stateRevision: 0,
          stateUpdatedAt: 0,
          signalRevision: 0,
          signal: null,
          assets: [],
        },
      ],
    })
  );
  const store = loaded();
  assert.deepEqual(titles(store), ["Alpha", "Beta"]);
  assert.equal(fs.existsSync(path.join(dir, "board.sqlite")), true);
  assert.equal(fs.existsSync(path.join(dir, "state.json.bak")), true);
  assert.equal(fs.existsSync(path.join(dir, "state.json")), false);
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["Alpha", "Beta"]);
  again.closeDb();
});

test("closing welcome discards it instead of archiving", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  store.archiveTab("welcome");
  assert.deepEqual(titles(store), ["A"]);
  assert.equal(store.archiveCount(), 0);
  assert.equal(store.get("welcome"), undefined);
  assert.throws(() => store.restoreLast(), /nothing to restore/);
  store.closeDb();
});

test("Ctrl+Z after closing welcome restores a real archived tab", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  store.archiveTab("a");
  store.archiveTab("welcome");
  assert.equal(store.archiveCount(), 1);
  store.restoreLast();
  assert.deepEqual(titles(store), ["A"]);
  store.closeDb();
});

test("Clear discards welcome and archives other unpinned tabs", () => {
  const store = loaded();
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  store.upsert({ title: "A", html: "<p>a</p>" });
  const archived = store.archiveMany("unpinned");
  assert.equal(store.get("welcome"), undefined);
  assert.equal(archived.length, 1);
  assert.equal(store.archiveCount(), 1);
  assert.equal(store.listArchiveTabs()[0].title, "A");
  assert.equal(store.listArchiveTabs()[0].id, archived[0]);
  store.closeDb();
});

test("load drops archived welcome tabs", () => {
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      activeId: "t_aaa",
      tabs: [
        {
          id: "t_aaa",
          key: "alpha",
          title: "Alpha",
          html: "<p>a</p>",
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
          revision: 1,
          state: {},
          stateRevision: 0,
          stateUpdatedAt: 0,
          signalRevision: 0,
          signal: null,
          assets: [],
        },
      ],
      archive: [
        {
          tab: {
            id: "t_www",
            key: "welcome",
            title: "Welcome",
            html: "<p>help</p>",
            pinned: false,
            createdAt: 2,
            updatedAt: 2,
            revision: 1,
            state: {},
            stateRevision: 0,
            stateUpdatedAt: 0,
            signalRevision: 0,
            signal: null,
            assets: [],
          },
        },
      ],
    })
  );
  const store = loaded();
  assert.deepEqual(titles(store), ["Alpha"]);
  assert.equal(store.archiveCount(), 0);
  store.closeDb();
  const again = loaded();
  assert.equal(again.archiveCount(), 0);
  assert.equal(again.get("welcome"), undefined);
  again.closeDb();
});
