import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { parseImport, serializeExport } from "./boardExport.js";
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
  const copy = store.importBoard(
    {
      templates: [],
      pages: pack.pages.map((page) => ({
        key: page.key,
        title: page.title,
        html: page.html,
        pinned: page.pinned,
        state: page.state,
      })),
    },
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
  const open = store.importBoard({ templates: [], pages: [{ title: "Open", html: "<p>o</p>" }] }, "meta");
  const fromMeta = store.importBoard(
    { templates: [], pages: [{ title: "Was archived", html: "<p>a</p>", archivedAt: 50 }] },
    "meta"
  );
  const forced = store.importBoard({ templates: [], pages: [{ title: "Forced", html: "<p>f</p>" }] }, "archive");
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

function todoTemplate(store: BoardStore, html = "<h1>{{title}}</h1>", stateVersion = 1) {
  return store.upsertTemplate({
    key: "todo",
    title: "Todo",
    html,
    fields: [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "columns", label: "Columns", type: "number", default: 3 },
    ],
    titleTemplate: "{{title}}",
    initialState: { todos: [] },
    stateVersion,
  }).template;
}

function roundTrip(pack: ReturnType<BoardStore["exportFile"]>) {
  return parseImport(serializeExport(pack), "pack.board.json");
}

function otherBoard(): BoardStore {
  process.env.AGENT_BOARD_HOME = fs.mkdtempSync(path.join(dir, "other-"));
  return loaded();
}

test("exporting a templated page includes its template and binding", () => {
  const store = loaded();
  const template = todoTemplate(store);
  store.upsertTemplate({ key: "unused", title: "Unused", html: "<p>u</p>" });
  const { tab } = store.openFromTemplate("todo", { title: "Shop", columns: 4 });
  const single = store.exportFile(tab.id);
  assert.deepEqual(single.templates.map((item) => item.id), [template.id]);
  assert.deepEqual(single.pages[0].template, {
    templateId: template.id,
    values: { title: "Shop", columns: 4 },
    stateVersion: 1,
    compatible: true,
  });
  assert.equal(store.exportFile().templates.length, 2);
  store.closeDb();
});

test("importing a templated page on another board recreates the template and binds the page", () => {
  const source = loaded();
  const template = todoTemplate(source);
  const { tab } = source.openFromTemplate("todo", { title: "Shop", columns: 4 });
  const parsed = roundTrip(source.exportFile(tab.id));
  source.closeDb();

  const target = otherBoard();
  const result = target.importBoard(parsed, "meta");
  assert.equal(result.templatesCreated, 1);
  assert.equal(result.templatesReused, 0);
  const created = target.getTemplate("todo");
  assert.equal(created?.id, template.id);
  const imported = target.get(result.tabs[0].id)!;
  assert.equal(imported.templateId, template.id);
  assert.deepEqual(imported.templateValues, { title: "Shop", columns: 4 });
  assert.throws(() => target.update(imported.id, { html: "<p>x</p>" }), /bound to template/);
  todoTemplate(target, "<h1>{{title}}</h1><p>v2</p>");
  assert.match(target.get(imported.id)!.html, /v2/);
  target.persist();
  target.closeDb();
});

test("importing a template the board already has reuses it, even repeatedly", () => {
  const store = loaded();
  const template = todoTemplate(store);
  const { tab } = store.openFromTemplate("todo", { title: "Shop" });
  const parsed = roundTrip(store.exportFile(tab.id));
  const first = store.importBoard(parsed, "meta");
  const second = store.importBoard(parsed, "meta");
  assert.equal(first.templatesCreated + second.templatesCreated, 0);
  assert.equal(second.templatesReused, 1);
  assert.equal(store.listTemplates().length, 1);
  assert.equal(store.get(second.tabs[0].id)?.templateId, template.id);
  assert.equal(store.listTemplates()[0].instanceCount, 3);
  store.closeDb();
});

test("a same-id template with different content is imported as a separate template once", () => {
  const store = loaded();
  const template = todoTemplate(store);
  const { tab } = store.openFromTemplate("todo", { title: "Shop" });
  const parsed = roundTrip(store.exportFile(tab.id));
  todoTemplate(store, "<h1>{{title}}</h1><p>local edit</p>");

  const first = store.importBoard(parsed, "meta");
  assert.equal(first.templatesCreated, 1);
  const copy = store.get(first.tabs[0].id)!;
  assert.notEqual(copy.templateId, template.id);
  const copyTemplate = store.getTemplate(copy.templateId!)!;
  assert.notEqual(copyTemplate.key, "todo");
  assert.doesNotMatch(copy.html, /local edit/);

  const second = store.importBoard(parsed, "meta");
  assert.equal(second.templatesCreated, 0);
  assert.equal(store.get(second.tabs[0].id)?.templateId, copyTemplate.id);
  assert.equal(store.listTemplates().length, 2);
  store.closeDb();
});

test("import keeps a page's incompatible flag and state version", () => {
  const store = loaded();
  todoTemplate(store);
  const { tab } = store.openFromTemplate("todo", { title: "Shop" });
  todoTemplate(store, "<h1>{{title}}</h1>", 2);
  const parsed = roundTrip(store.exportFile(tab.id));
  const result = store.importBoard(parsed, "meta");
  const imported = store.get(result.tabs[0].id)!;
  assert.equal(imported.templateCompatible, false);
  assert.equal(imported.templateStateVersion, store.get(tab.id)?.templateStateVersion);
  assert.match(imported.templateIncompatibleReason ?? "", /template changed/);
  store.closeDb();
});

test("export all with only templates round-trips to another board", () => {
  const source = loaded();
  todoTemplate(source);
  const parsed = roundTrip(source.exportFile());
  assert.equal(parsed.pages.length, 0);
  source.closeDb();
  const target = otherBoard();
  const result = target.importBoard(parsed, "meta");
  assert.equal(result.templatesCreated, 1);
  assert.equal(result.tabs.length, 0);
  assert.equal(target.getTemplate("todo")?.title, "Todo");
  target.closeDb();
});

test("export all with only welcome throws", () => {
  const store = loaded();
  store.upsert({ key: "welcome", title: "Welcome", html: "<p>help</p>" });
  assert.throws(() => store.exportFile(), /nothing to export/);
  store.closeDb();
});

test("tabs hidden from the agent vanish from every agent listing", () => {
  const store = loaded();
  store.upsert({ key: "open", title: "Open secret", html: "<p>alpha</p>" });
  store.upsert({ key: "shown", title: "Shown", html: "<p>alpha</p>" });
  store.upsert({ key: "old", title: "Old secret", html: "<p>alpha</p>" });
  store.archiveTab("old");
  store.focus("open");
  store.setAgentHidden("open", true);
  store.setAgentHidden("old", true);

  assert.deepEqual(store.list("agent").map((tab) => tab.key), ["shown"]);
  assert.equal(store.list("user").length, 2);
  assert.equal(store.archiveCount("agent"), 0);
  assert.equal(store.archiveCount("user"), 1);
  assert.equal(store.getActiveId("agent"), null);
  assert.equal(store.getActiveId("user"), store.get("open")?.id);
  assert.equal(store.get("open", "agent"), undefined);
  assert.equal(store.get("old", "agent"), undefined);
  assert.deepEqual(store.searchOpen("alpha", "agent").hits.map((hit) => hit.tab.key), ["shown"]);
  assert.equal(store.searchArchive("alpha", 0, 20, "agent").matchCount, 0);
  assert.deepEqual(store.searchPages("alpha", undefined, "agent").hits.map((hit) => hit.tab.key), ["shown"]);
  store.closeDb();
});

test("an agent writing a hidden tab's key gets a separate tab", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Private", html: "<p>mine</p>" });
  store.setAgentHidden("page", true);
  const { tab, created } = store.upsert({ key: "page", title: "Agent", html: "<p>theirs</p>", viewer: "agent" });
  assert.equal(created, true);
  assert.notEqual(tab.key, "page");
  assert.match(store.get("page")!.html, /mine/);
  store.closeDb();
});

test("agent bulk close skips hidden tabs", () => {
  const store = loaded();
  store.upsert({ key: "a", title: "A", html: "<p>a</p>" });
  store.upsert({ key: "b", title: "B", html: "<p>b</p>" });
  store.setAgentHidden("a", true);
  store.archiveMany("all", "agent");
  assert.deepEqual(titles(store), ["A"]);
  store.closeDb();
});

test("hide-from-agent persists and survives export and import", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>p</p>" });
  store.setAgentHidden("page", true);
  store.closeDb();

  const again = loaded();
  assert.equal(again.get("page")?.agentHidden, true);
  const parsed = parseImport(serializeExport(again.exportFile("page")));
  const copy = again.importBoard(parsed, "meta");
  assert.equal(copy.tabs[0].agentHidden, true);
  again.setAgentHidden("page", false);
  assert.equal(again.get("page", "agent")?.key, "page");
  again.closeDb();
});

test("opening a board without tabs.agent_hidden adds the column", () => {
  const store = loaded();
  store.upsert({ key: "page", title: "Page", html: "<p>p</p>" });
  store.closeDb();
  const db = new DatabaseSync(path.join(dir, "board.sqlite"));
  db.exec("ALTER TABLE tabs DROP COLUMN agent_hidden");
  db.close();

  const again = loaded();
  assert.equal(again.get("page")?.agentHidden, undefined);
  again.setAgentHidden("page", true);
  again.closeDb();
  const third = loaded();
  assert.equal(third.get("page")?.agentHidden, true);
  third.closeDb();
});
