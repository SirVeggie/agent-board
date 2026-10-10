import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chunkPage, parseSearchDeclaration, splitText, type SearchDeclaration } from "./chunker.js";
import { SearchIndex, rankVectors, type IndexedChunk } from "./indexer.js";
import { loadBuiltinTemplates } from "../builtinTemplates.js";
import { BoardStore } from "../store.js";
import { parseImport, serializeExport } from "../boardExport.js";
import type { Embedder, EmbedDocument } from "./embedder.js";
import type { Tab } from "../types.js";

const builtins = loadBuiltinTemplates();
const kanban = builtins.find(t => t.key === "kanban")!.search!;
const todo = builtins.find(t => t.key === "todo-list")!.search!;
const vector = (value = 1) => { const v = new Float32Array(768); v[0] = value; return v; };
function page(id: string, state: Tab["state"] = {}, html = "<h1 id='one'>Heading</h1><p>" + "Useful visible information. ".repeat(20) + "</p>"): Tab {
  return { id, key: `scribe:${id}`, title: id, state, html, updatedAt: 1, stateUpdatedAt: 1 } as Tab;
}
class StubEmbedder implements Embedder {
  calls: EmbedDocument[][] = [];
  queries = 0;
  async embedDocuments(items: EmbedDocument[]) { this.calls.push(items); return items.map(() => vector()); }
  async embedQuery() { this.queries++; return vector(); }
  async embedImage() { return vector(); }
}
function fixture(pages: Tab[], declaration?: SearchDeclaration, embedder = new StubEmbedder()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-semantic-"));
  const tabs = new Map(pages.map(p => [p.id, p]));
  const source = { pages: () => [...tabs.values()], get: (id: string) => tabs.get(id), folder: () => "Apps", declaration: () => declaration };
  const index = new SearchIndex(root, source, embedder, 10);
  const cleanup = async () => { await index.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, tabs, source, index, embedder, cleanup };
}

test("heading sections strip scripts, merge small neighbours and keep heading anchors", () => {
  const p = page("Document", {}, "<script><h1>Secret</h1>secret script</script><style>secret style</style><h2 id='intro'>Intro</h2><p>Brief introduction.</p><h3 id='detail'>Details</h3><p>" + "Visible information. ".repeat(20) + "</p>");
  const cs = chunkPage(p);
  assert.equal(cs.filter(c => c.kind === "section").length, 1);
  const s = cs.find(c => c.kind === "section")!;
  assert.equal(s.headingId, "detail"); assert.match(s.text, /Brief introduction.*Visible information/s);
  assert.ok(cs.every(c => !/secret/i.test(c.text)));
  assert.equal(chunkPage(page("New page", {}, "<p>Hi</p>")).length, 0);
});

test("length splits have a hard cap and repeat the last sentence without losing content", () => {
  const text = Array.from({ length: 200 }, (_, i) => `Sentence ${i} contains useful information.`).join(" ");
  const parts = splitText(text);
  assert.ok(parts.length > 2); assert.ok(parts.every(p => p.length <= 2000));
  for (let i = 1; i < parts.length; i++) {
    const sentence = parts[i - 1].match(/[^.!?]+[.!?]/g)!.at(-1)!.trim();
    assert.ok(parts[i].startsWith(sentence));
  }
  for (let i = 0; i < 200; i++) assert.ok(parts.some(p => p.includes(`Sentence ${i} contains`)));
  assert.ok(splitText("x".repeat(10000)).every(p => p.length <= 2000));
});

test("template declarations index cards and todos with stable identities and clean page summaries", () => {
  const state = { cards: [
    { id: "c_a", num: 12, title: "Task", description: "Deep searchable description ".repeat(5), checklist: [{ text: "Check things" }], comments: [{ text: "A comment" }], images: [{ data: "asset:secret.png" }], color: "#abcdef" },
    { num: 13, title: "Archived secret", description: "Archived information", archived: true },
  ], settings: { workerLog: ["internal secret"] } };
  const cs = chunkPage(page("Board", state), "Apps", kanban);
  const record = cs.find(c => c.kind === "record")!;
  assert.equal(record.anchor, "12"); assert.equal(record.label, "#12 Task");
  assert.equal(record.title, "Board › Task"); assert.match(record.text, /Check things\nA comment/);
  assert.ok(cs.every(c => !/secret|abcdef/.test(c.text)));
  assert.equal(cs.find(c => c.kind === "page")!.text, "Folder: Apps.\nTask");
  const changed = chunkPage(page("Board", { ...state, cards: state.cards.map((c, i) => i === 0 ? { ...c, description: "Changed description" } : c) }), "Apps", kanban);
  assert.equal(cs[0].hash, changed[0].hash); assert.equal(record.key, changed[1].key); assert.notEqual(record.hash, changed[1].hash);
  const list = chunkPage(page("List", { todos: [{ id: "t_a", text: "Get groceries", description: "Buy plenty of vegetables for the whole week" }] }), null, todo);
  assert.equal(list[1].anchor, "t_a"); assert.equal(list[1].title, "List"); assert.match(list[1].text, /vegetables/);
});

test("long cards separate comments, all content remains bounded and searchable", () => {
  const cs = chunkPage(page("Board", { cards: [{ num: 12, title: "Task", description: "Description sentence. ".repeat(150), comments: [{ text: "Comment sentence. ".repeat(150) }] }] }), null, kanban);
  const records = cs.filter(c => c.kind === "record");
  assert.ok(records.length > 2); assert.ok(records.every(c => c.text.length <= 2000));
  assert.ok(records.some(c => c.text.includes("Description"))); assert.ok(records.some(c => c.text.includes("Comment")));
  assert.ok(records.every(c => !(c.text.includes("Description") && c.text.includes("Comment"))));
});

test("generic fallback traverses arrays with ids and drops machine fields", () => {
  const cs = chunkPage(page("Generic", { settings: { notes: "secret" }, data: { entries: [{ id: "i_a", title: "A useful record", description: "Detailed relevant information".repeat(5), url: "https://secret.test", color: "#abcdef", images: [{ data: "asset:secret" }] }] } }));
  const r = cs.find(c => c.kind === "record")!;
  assert.equal(r.anchor, "i_a"); assert.ok(cs.every(c => !/secret|abcdef|i_a/.test(c.text)));
  assert.throws(() => parseSearchDeclaration({ records: [{ path: "cards", title: "title", text: "description", anchor: "id" }] }));
});

test("incremental indexing re-embeds only one edited card; restart reuses stored vectors", async () => {
  const p = page("Board", { cards: [{ num: 1, title: "One", description: "Description one ".repeat(10) }, { num: 2, title: "Two", description: "Description two ".repeat(10) }] });
  const f = fixture([p], kanban);
  let reopened: SearchIndex | undefined;
  try {
    assert.equal(fs.existsSync(path.join(f.root, "search.sqlite")), false);
    f.index.start("model", "q8"); await f.index.idle();
    assert.equal(f.embedder.calls.flat().length, 3);
    f.embedder.calls = [];
    (p.state.cards as { description: string }[])[0].description = "New card description";
    f.index.schedule(p.id); f.index.schedule(p.id); await delay(25); await f.index.idle();
    assert.equal(f.embedder.calls.flat().length, 1);
    assert.equal(f.embedder.calls[0][0].text, "New card description");
    assert.equal(f.index.status().indexedPages, 1);
    await f.index.close(); f.embedder.calls = [];
    reopened = new SearchIndex(f.root, f.source, f.embedder);
    reopened.start("model", "q8"); await reopened.idle();
    assert.equal(f.embedder.calls.length, 0);
    const db = new DatabaseSync(path.join(f.root, "search.sqlite"), { readOnly: true });
    assert.equal((db.prepare("SELECT length(vec) AS n FROM chunks LIMIT 1").get() as { n: number }).n, 3072); db.close();
    reopened.start("different model", "q8"); await reopened.idle();
    assert.equal(f.embedder.calls.flat().length, 3);
    f.tabs.delete(p.id); reopened.remove(p.id);
    assert.equal(reopened.status().chunks, 0); assert.equal(reopened.status().indexedPages, 0);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test("newest-first backfill, bounded batches, deletion and resumable failed pages", async () => {
  const many = Array.from({ length: 90 }, (_, num) => ({ num, title: `Task ${num}`, description: "Useful description. ".repeat(150) }));
  const older = page("Older", { cards: many }), newer = page("Newer", { cards: [{ num: 1, title: "Latest task", description: "Latest useful information. ".repeat(10) }] });
  newer.updatedAt = 10;
  const embedder = new StubEmbedder(); let fail = true;
  const attempts: EmbedDocument[][] = [];
  const original = embedder.embedDocuments.bind(embedder);
  embedder.embedDocuments = async items => { attempts.push(items); if (fail) { fail = false; throw new Error("Temporary failure"); } return original(items); };
  const f = fixture([older, newer], kanban, embedder);
  try {
    f.index.start("model", "q8"); await f.index.idle(); assert.equal(f.index.status().error, "Temporary failure");
    assert.equal(attempts[0][0].title, "Newer");
    f.index.start("model", "q8"); await f.index.idle();
    assert.ok(embedder.calls.every(items => items.length <= 32 && items.every(i => i.text.length <= 3020)));
    assert.equal(f.index.status().indexedPages, 2); assert.equal(f.index.status().error, null);
    (older.state.cards as unknown[]).pop(); f.index.schedule(older.id); await delay(25); await f.index.idle();
    const hits = await f.index.query("query", "chunks", id => id === newer.id);
    assert.ok(hits.length); assert.ok(hits.every(h => h.tab_id === newer.id));
    await f.index.query("query", "chunks", () => true); assert.equal(embedder.queries, 1);
    for (let i = 0; i < 50; i++) await f.index.query(`other${i}`, "pages", () => true);
    await f.index.query("query", "pages", () => true); assert.equal(embedder.queries, 52);
    f.index.pause(); await assert.rejects(f.index.query("query", "pages", () => true), /unavailable/);
  } finally { await f.cleanup(); }
});

test("deleted or changed pages cannot commit stale embeddings", async () => {
  const p = page("Page"); const embedder = new StubEmbedder();
  let resolve!: (vectors: Float32Array[]) => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  embedder.embedDocuments = async items => { entered(); return new Promise(r => { resolve = r; }); };
  const f = fixture([p], undefined, embedder);
  try {
    f.index.start("model", "q8"); await started;
    f.tabs.delete(p.id); f.index.remove(p.id); resolve([vector(), vector()]); await f.index.idle();
    assert.equal(f.index.status().chunks, 0);
  } finally { await f.cleanup(); }
});

test("ranking blends page and best two chunks, limits content per page and applies cutoff after viewer filtering", () => {
  const rows: IndexedChunk[] = [];
  const vs: number[] = [];
  const add = (tab: string, kind: string, score: number) => { rows.push({ tab_id: tab, kind, chunk_key: `${tab}:${rows.length}`, anchor: null, heading_id: null, label: kind, snippet: "text", hash: "hash" }); vs.push(...vector(score)); };
  add("hidden", "page", 1); add("A", "page", 0.8); add("A", "section", 0.9); add("A", "record", 0.7); add("A", "section", 0.65); add("A", "section", 0.64);
  add("B", "page", 0.83); add("B", "record", 0.85); add("C", "page", 0.4);
  const ranked = rankVectors(rows, Float32Array.from(vs), vector(), "pages", id => id !== "hidden");
  assert.deepEqual(ranked.map(h => h.tab_id), ["B", "A"]);
  assert.ok(Math.abs(ranked[0].score - 0.84) < 0.00001); assert.ok(Math.abs(ranked[1].score - 0.81) < 0.00001);
  const chunks = rankVectors(rows, Float32Array.from(vs), vector(), "chunks", () => true, 100, false);
  assert.equal(chunks.filter(h => h.tab_id === "A").length, 3);
});

test("custom template search persists, exports, imports and falls back to a built-in's declaration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-search-template-"));
  const prev = process.env.SCRIBE_HOME; process.env.SCRIBE_HOME = root;
  const store = new BoardStore(), reopened = new BoardStore();
  try {
    store.load();
    const { template } = store.upsertTemplate({ title: "Custom", html: "<p>Custom</p>", search: kanban });
    const tab = store.openFromTemplate(template.id, {}).tab;
    assert.deepEqual(store.searchDeclaration(tab), kanban);
    const imported = parseImport(serializeExport(store.exportFile({ id: tab.id })));
    assert.deepEqual(imported.templates![0].search, kanban);
    const copy = store.copyBuiltinTemplate("kanban").template;
    delete copy.search;
    const board = store.openFromTemplate(copy.id, { title: "Board" }).tab;
    assert.deepEqual(store.searchDeclaration(board), kanban);
    store.closeDb(); reopened.load();
    assert.deepEqual(reopened.getTemplate(template.id)!.search, kanban);
  } finally { store.closeDb(); reopened.closeDb(); if (prev === undefined) delete process.env.SCRIBE_HOME; else process.env.SCRIBE_HOME = prev; fs.rmSync(root, { recursive: true, force: true }); }
});
