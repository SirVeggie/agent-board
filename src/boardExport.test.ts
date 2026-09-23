import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPORT_FORMAT,
  buildExport,
  exportAllFilename,
  exportFilename,
  parseImport,
  serializeExport,
  titleFromFilename,
  titleFromHtml,
} from "./boardExport.js";
import type { Tab } from "./types.js";

function fakeTab(partial: Partial<Tab> & Pick<Tab, "key" | "title" | "html">): Tab {
  return {
    id: "t_aaaa",
    pinned: false,
    createdAt: 10,
    updatedAt: 20,
    stripSeq: 1,
    revision: 1,
    state: {},
    stateRevision: 0,
    stateUpdatedAt: 0,
    signalRevision: 0,
    signal: null,
    assets: [],
    ...partial,
  };
}

test("parseImport reads a saved HTML document", () => {
  const html = "<!DOCTYPE html><html><head><title>Notes</title></head><body><p>hi</p></body></html>";
  const parsed = parseImport(html, "ignored.json");
  assert.equal(parsed.kind, "html");
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.pages[0].title, "Notes");
  assert.equal(parsed.pages[0].html, html);
  assert.equal(parsed.pages[0].state, undefined);
});

test("parseImport uses the filename when HTML has no title", () => {
  const parsed = parseImport("<p>bare</p>", "My-Page.html");
  assert.equal(parsed.kind, "html");
  assert.equal(parsed.pages[0].title, "My Page");
});

test("parseImport reads a single-page export including state and assets", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const file = buildExport([
    {
      tab: fakeTab({
        key: "todos",
        title: "Todos",
        html: "<!DOCTYPE html><html><body>list</body></html>",
        pinned: true,
        archivedAt: 99,
        state: { items: [1] },
      }),
      assets: [{ name: "dot.png", mimeType: "image/png", buffer: png }],
    },
  ]);
  const parsed = parseImport(serializeExport(file), "todos.board.json");
  assert.equal(parsed.kind, "export");
  assert.equal(parsed.pages.length, 1);
  const page = parsed.pages[0];
  assert.equal(page.key, "todos");
  assert.equal(page.title, "Todos");
  assert.equal(page.pinned, true);
  assert.equal(page.archivedAt, 99);
  assert.deepEqual(page.state, { items: [1] });
  assert.equal(page.assets?.length, 1);
  assert.equal(page.assets?.[0].name, "dot.png");
  assert.equal(page.assets?.[0].buffer.equals(png), true);
});

test("parseImport reads a multi-page export", () => {
  const file = buildExport([
    { tab: fakeTab({ key: "a", title: "A", html: "<!DOCTYPE html><html><body>a</body></html>" }), assets: [] },
    { tab: fakeTab({ key: "b", title: "B", html: "<!DOCTYPE html><html><body>b</body></html>" }), assets: [] },
  ]);
  const parsed = parseImport(serializeExport(file));
  assert.equal(parsed.kind, "export");
  assert.deepEqual(
    parsed.pages.map((page) => page.title),
    ["A", "B"]
  );
});

test("parseImport rejects random JSON", () => {
  assert.throws(() => parseImport('{"hello":true}'), /not an Agent Board export/);
});

test("parseImport rejects an unsupported version", () => {
  assert.throws(
    () => parseImport(JSON.stringify({ format: EXPORT_FORMAT, version: 2, pages: [] })),
    /unsupported export version/
  );
});

test("parseImport rejects empty or unknown files", () => {
  assert.throws(() => parseImport("   "), /empty/);
  assert.throws(() => parseImport("just text"), /not a recognized/);
});

test("title helpers", () => {
  assert.equal(titleFromHtml("<title>  Hello &amp; Co </title>", "x"), "Hello & Co");
  assert.equal(titleFromFilename("Notes.board.json"), "Notes");
  assert.equal(exportFilename("My Page"), "My-Page.board.json");
  assert.match(exportAllFilename(Date.UTC(2026, 8, 23)), /^agent-board-\d{4}-\d{2}-\d{2}\.json$/);
});
