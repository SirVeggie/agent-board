import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { RevisionConflictError } from "./htmlEdit.js";
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
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  store.closeDb();
});

test("unpin restores the tab's original strip hole", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.update("b", { pin: true, activate: false });
  assert.deepEqual(titles(store), ["B", "A", "C"]);
  store.update("b", { pin: false, activate: false });
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  store.closeDb();
});

test("pinned tabs follow strip_seq within the pinned group", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.update("c", { pin: true, activate: false });
  store.update("a", { pin: true, activate: false });
  assert.deepEqual(titles(store), ["A", "C", "B"]);
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

test("swapStripSeq reorders two unpinned tabs and persists", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.persist();
  store.swapStripSeq("a", "b");
  assert.deepEqual(titles(store), ["B", "A", "C"]);
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["B", "A", "C"]);
  again.closeDb();
});

test("swapStripSeq reorders two pinned tabs", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.update("a", { pin: true, activate: false });
  store.update("b", { pin: true, activate: false });
  assert.deepEqual(titles(store), ["A", "B", "C"]);
  store.swapStripSeq("a", "b");
  assert.deepEqual(titles(store), ["B", "A", "C"]);
  store.closeDb();
});

test("swapStripSeq rejects a cross-group pair", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.update("a", { pin: true, activate: false });
  assert.throws(() => store.swapStripSeq("a", "b"), /pin groups/);
  assert.deepEqual(titles(store), ["A", "B"]);
  store.closeDb();
});

test("swapStripSeq rejects an archived tab", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.archiveTab("a");
  assert.throws(() => store.swapStripSeq("a", "b"), /archived/);
  store.closeDb();
});

test("reorderTab after persist walks adjacent swaps without unique collisions", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.upsert({ title: "D", html: "<p>d</p>" });
  store.persist();
  store.reorderTab("a", null);
  assert.deepEqual(titles(store), ["B", "C", "D", "A"]);
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["B", "C", "D", "A"]);
  again.closeDb();
});

test("persist remints duplicate strip_seq instead of failing", () => {
  const store = loaded();
  const a = store.upsert({ title: "A", html: "<p>a</p>" });
  const b = store.upsert({ title: "B", html: "<p>b</p>" });
  store.persist();
  b.tab.stripSeq = a.tab.stripSeq;
  store.persist();
  assert.equal(store.snapshot().persistError, null);
  assert.notEqual(a.tab.stripSeq, b.tab.stripSeq);
  store.closeDb();
  const again = loaded();
  assert.deepEqual(titles(again), ["A", "B"]);
  const seqs = again.listOpenTabs().map((tab) => tab.stripSeq);
  assert.equal(new Set(seqs).size, seqs.length);
  again.closeDb();
});

test("reorderTab walks adjacent swaps to the end of the group", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.upsert({ title: "D", html: "<p>d</p>" });
  store.reorderTab("a", null);
  assert.deepEqual(titles(store), ["B", "C", "D", "A"]);
  const seqs = store.listOpenTabs().map((tab) => tab.stripSeq);
  assert.equal(new Set(seqs).size, seqs.length);
  store.closeDb();
});

test("reorderTab stays inside the pinned group", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.upsert({ title: "D", html: "<p>d</p>" });
  store.update("a", { pin: true, activate: false });
  store.update("b", { pin: true, activate: false });
  store.reorderTab("a", null);
  assert.deepEqual(titles(store), ["B", "A", "C", "D"]);
  store.closeDb();
});

test("reorderTab does not steal an archived tab's strip hole", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.upsert({ title: "D", html: "<p>d</p>" });
  store.archiveTab("b");
  store.reorderTab("a", null);
  assert.deepEqual(titles(store), ["C", "D", "A"]);
  store.restoreLast();
  assert.deepEqual(titles(store), ["C", "B", "D", "A"]);
  const seqs = store.listOpenTabs().map((tab) => tab.stripSeq);
  assert.equal(new Set(seqs).size, seqs.length);
  store.closeDb();
});

test("pin does not steal an archived tab's strip_seq", () => {
  const store = loaded();
  store.upsert({ title: "A", html: "<p>a</p>" });
  store.upsert({ title: "B", html: "<p>b</p>" });
  store.upsert({ title: "C", html: "<p>c</p>" });
  store.archiveTab("a");
  store.update("c", { pin: true, activate: false });
  store.update("c", { pin: false, activate: false });
  store.restoreLast();
  assert.deepEqual(titles(store), ["A", "B", "C"]);
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

test("export then import restores html, state, and pin without overwriting", () => {
  const store = loaded();
  const { tab } = store.upsert({
    key: "todos",
    title: "Todos",
    html: "<p>list</p>",
    pin: true,
    state: { items: ["a"] },
  });
  const pack = store.exportFile(tab.id);
  assert.equal(pack.pages.length, 1);
  assert.deepEqual(pack.pages[0].state, { items: ["a"] });
  const copy = store.importPages(
    pack.pages.map((page) => ({
      key: page.key,
      title: page.title,
      html: page.html,
      pinned: page.pinned,
      state: page.state,
    })),
    "meta"
  );
  assert.equal(copy.opened, 1);
  assert.equal(copy.archived, 0);
  const original = store.get("todos");
  const imported = store.get(copy.tabs[0].id);
  assert.ok(original);
  assert.ok(imported);
  assert.notEqual(imported.id, original.id);
  assert.notEqual(imported.key, "todos");
  assert.equal(imported.title, "Todos");
  assert.equal(imported.pinned, true);
  assert.match(imported.html, /<p>list<\/p>/);
  assert.deepEqual(imported.state, { items: ["a"] });
  assert.deepEqual(original.state, { items: ["a"] });
  store.closeDb();
});

test("import destination follows archivedAt unless forced to archive", () => {
  const store = loaded();
  const open = store.importPages([{ title: "Open", html: "<p>o</p>" }], "meta");
  const fromMeta = store.importPages(
    [{ title: "Was archived", html: "<p>a</p>", archivedAt: 50 }],
    "meta"
  );
  const forced = store.importPages([{ title: "Forced", html: "<p>f</p>" }], "archive");
  assert.equal(open.opened, 1);
  assert.equal(fromMeta.archived, 1);
  assert.equal(fromMeta.opened, 0);
  assert.equal(forced.archived, 1);
  assert.equal(store.get(fromMeta.tabs[0].id)?.archivedAt, 50);
  assert.ok(store.get(forced.tabs[0].id)?.archivedAt);
  assert.equal(store.list().some((tab) => tab.title === "Forced"), false);
  store.closeDb();
});

test("export all skips the welcome page", () => {
  const store = loaded();
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  store.upsert({ title: "Keep", html: "<p>k</p>" });
  const pack = store.exportFile();
  assert.deepEqual(
    pack.pages.map((page) => page.title),
    ["Keep"]
  );
  store.closeDb();
});

test("template open creates a pinned bound page and blocks html edits", () => {
  const store = loaded();
  const { template } = store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1><p>{{item}}</p>",
    fields: [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "item", label: "Item", type: "text", default: "task" },
    ],
    titleTemplate: "{{title}}",
    initialState: { todos: [] },
  });
  const { tab } = store.openFromTemplate(template.key, { title: "Shopping" });
  assert.equal(tab.pinned, true);
  assert.equal(tab.title, "Shopping");
  assert.match(tab.html, /Shopping/);
  assert.equal(tab.templateId, template.id);
  assert.deepEqual(tab.state, { todos: [] });
  assert.throws(() => store.upsert({ key: tab.key, title: "X", html: "<p>nope</p>" }), /bound to template/);
  assert.throws(() => store.patchHtml(tab.id, { edits: [{ oldString: "<h1>", newString: "<h2>" }] }), /bound to template/);
  store.closeDb();
});

test("patchHtml with html replaces the body but keeps state and the wait signal", () => {
  const store = loaded();
  const { tab } = store.upsert({ key: "page", title: "Page", html: "<!DOCTYPE html><p>old</p>", state: { n: 1 } });
  store.signal("page", { name: "submitted" });
  const { tab: patched, applied } = store.patchHtml("page", {
    html: "<!DOCTYPE html><p>new</p>",
    expectedRevision: tab.revision,
  });
  assert.equal(applied, 1);
  assert.equal(patched.html, "<!DOCTYPE html><p>new</p>");
  assert.equal(patched.revision, 2);
  assert.deepEqual(patched.state, { n: 1 });
  assert.equal(patched.signal?.name, "submitted");
  store.closeDb();
});

test("patchHtml refuses a stale expectedRevision and changes nothing", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  store.patchHtml("page", { edits: [{ oldString: "<p>a</p>", newString: "<p>b</p>" }] });
  assert.throws(
    () => store.patchHtml("page", { html: "<p>clobber</p>", expectedRevision: 1 }),
    (err: unknown) => err instanceof RevisionConflictError && /since revision 1 \(now 2\)/.test(err.message)
  );
  assert.throws(
    () => store.update("page", { title: "Renamed", expectedRevision: 1 }),
    (err: unknown) => err instanceof RevisionConflictError
  );
  const tab = store.get("page")!;
  assert.match(tab.html, /<p>b<\/p>/);
  assert.equal(tab.title, "Page");
  store.closeDb();
});

test("patchHtml rejects edits and html together", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>a</p>" });
  assert.throws(
    () => store.patchHtml("page", { html: "<p>b</p>", edits: [{ oldString: "a", newString: "c" }] }),
    /either edits or html/
  );
  store.closeDb();
});

test("updating a template re-renders instances and can mark them incompatible", () => {
  const store = loaded();
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
    stateVersion: 1,
  });
  const { tab } = store.openFromTemplate("todo", { title: "A" });
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1><p>v2</p>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
    stateVersion: 2,
  });
  const again = store.get(tab.id);
  assert.ok(again);
  assert.match(again.html, /v2/);
  assert.equal(again.templateCompatible, false);
  const resolved = store.setState(tab.id, { state: { todos: [] }, resolveIncompatibility: true });
  assert.equal(resolved.ok, true);
  assert.equal(store.get(tab.id)?.templateCompatible, true);
  store.closeDb();
});

test("deleting a template unlinks pages and they stay editable", () => {
  const store = loaded();
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
  });
  const { tab } = store.openFromTemplate("todo", { title: "A" });
  store.deleteTemplate("todo");
  const leftover = store.get(tab.id);
  assert.ok(leftover);
  assert.equal(leftover.templateId, undefined);
  const updated = store.update(tab.id, { html: "<p>free</p>", activate: false });
  assert.match(updated.html, /<p>free<\/p>/);
  store.closeDb();
});

test("templates persist across reload", () => {
  const store = loaded();
  store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html: "<h1>{{title}}</h1>",
    fields: [{ key: "title", label: "Title", type: "text", required: true }],
  });
  const { tab } = store.openFromTemplate("todo", { title: "Shop" });
  store.persist();
  store.closeDb();
  const again = loaded();
  assert.equal(again.getTemplate("todo")?.title, "Todo");
  assert.equal(again.get(tab.id)?.templateId, again.getTemplate("todo")?.id);
  assert.equal(again.get(tab.id)?.templateValues?.title, "Shop");
  again.closeDb();
});

test("export all with only welcome throws", () => {
  const store = loaded();
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  assert.throws(() => store.exportFile(), /nothing to export/);
  store.closeDb();
});
