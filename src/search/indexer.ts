import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHUNKER_VERSION, chunkPage, type SearchDeclaration, type TextChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import type { Tab } from "../types.js";

export type IndexedChunk = { tab_id: string; chunk_key: string; kind: string; anchor: string | null; heading_id: string | null; label: string; snippet: string; hash: string };
type Row = IndexedChunk & { vec: Uint8Array };
export type IndexSource = { pages(): Tab[]; get(id: string): Tab | undefined; folder(tab: Tab): string | null; declaration(tab: Tab): SearchDeclaration | undefined };
export type ScoredHit = IndexedChunk & { score: number };
const WIDTH = 768;

export function rankVectors(rows: IndexedChunk[], vectors: Float32Array, query: Float32Array, scope: "pages" | "chunks", visible: (id: string) => boolean, limit = 8, cutoff = true): ScoredHit[] {
  const groups = new Map<string, ScoredHit[]>();
  rows.forEach((row, index) => {
    if (!visible(row.tab_id)) return;
    let score = 0;
    for (let d = 0; d < WIDTH; d++) score += vectors[index * WIDTH + d] * query[d];
    if (!Number.isFinite(score)) return;
    const group = groups.get(row.tab_id) ?? [];
    group.push({ ...row, score }); groups.set(row.tab_id, group);
  });
  const hits: ScoredHit[] = [];
  for (const group of groups.values()) {
    const page = group.find(r => r.kind === "page");
    const chunks = group.filter(r => r.kind !== "page").sort((a, b) => b.score - a.score);
    if (scope === "chunks") hits.push(...(chunks.length ? chunks.slice(0, 3) : page ? [page] : []));
    else if (page) {
      const best = chunks[0] ?? page, second = chunks[1] ?? best;
      hits.push({ ...best, score: 0.5 * page.score + 0.3 * best.score + 0.2 * second.score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.tab_id.localeCompare(b.tab_id) || a.chunk_key.localeCompare(b.chunk_key));
  return hits.filter(hit => !cutoff || hit.score >= (hits[0]?.score ?? 0) - 0.08).slice(0, limit);
}

/** Derived storage and a single worker: never retain a library's text or embeddings in a batch. */
export class SearchIndex {
  private db?: DatabaseSync;
  private queue = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private running?: Promise<void>;
  private stopped = false;
  private enabled = false;
  private generation = 0;
  private rows: IndexedChunk[] = [];
  private vectors = new Float32Array();
  private dirty = true;
  private queries = new Map<string, Float32Array>();
  private error: string | null = null;
  constructor(private root: string | (() => string), private source: IndexSource, private embedder: Embedder, private debounceMs = 5000) {}
  start(model: string, dtype: string): void {
    if (this.stopped) return;
    if (!this.db) {
      const root = typeof this.root === "function" ? this.root() : this.root;
      fs.mkdirSync(root, { recursive: true });
      this.db = new DatabaseSync(path.join(root, "search.sqlite"));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, tab_id TEXT NOT NULL, chunk_key TEXT NOT NULL, kind TEXT NOT NULL, anchor TEXT, heading_id TEXT, label TEXT NOT NULL, snippet TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL, UNIQUE(tab_id, chunk_key));
        CREATE INDEX IF NOT EXISTS idx_chunks_tab ON chunks(tab_id);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    }
    const signature = JSON.stringify([model, dtype, CHUNKER_VERSION]);
    const prior = this.db.prepare("SELECT value FROM meta WHERE key='signature'").get() as { value: string } | undefined;
    if (prior?.value !== signature) {
      this.generation++; this.db.exec("DELETE FROM chunks; DELETE FROM meta;"); this.queries.clear(); this.dirty = true;
      const save = this.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
      for (const [key, value] of Object.entries({ signature, model, dtype, chunker: CHUNKER_VERSION })) save.run(key, value);
    }
    const wasEnabled = this.enabled; this.enabled = true;
    if (!wasEnabled || prior?.value !== signature) {
      const pages = this.source.pages().sort((a, b) => Math.max(b.updatedAt, b.stateUpdatedAt) - Math.max(a.updatedAt, a.stateUpdatedAt));
      const ids = new Set(pages.map(p => p.id));
      for (const row of this.db.prepare("SELECT DISTINCT tab_id FROM chunks").all() as { tab_id: string }[]) if (!ids.has(row.tab_id)) this.remove(row.tab_id);
      for (const page of pages) this.queue.add(page.id);
    }
    this.kick();
  }
  pause(): void { this.enabled = false; this.generation++; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
  schedule(id: string): void {
    if (!this.enabled || this.stopped) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => { this.timers.delete(id); this.queue.add(id); this.kick(); }, this.debounceMs);
    timer.unref(); this.timers.set(id, timer);
  }
  remove(id: string): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id); this.queue.delete(id);
    this.db?.prepare("DELETE FROM chunks WHERE tab_id=?").run(id); this.dirty = true;
    this.db?.prepare("DELETE FROM meta WHERE key=?").run(`page:${id}`);
  }
  private kick(): void {
    if (this.running || !this.enabled || this.stopped) return;
    this.running = this.drain().finally(() => { this.running = undefined; if (this.queue.size && this.enabled && !this.stopped && !this.error) this.kick(); });
  }
  private async drain(): Promise<void> {
    this.error = null;
    while (this.enabled && !this.stopped && this.queue.size) {
      const id = this.queue.values().next().value!; this.queue.delete(id);
      try { await this.indexPage(id); }
      catch (err) { this.error = (err as Error).message; this.queue.add(id); break; }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  async idle(): Promise<void> { while (this.running) await this.running; }
  private chunks(tab: Tab): TextChunk[] { return chunkPage(tab, this.source.folder(tab), this.source.declaration(tab)); }
  private async indexPage(id: string): Promise<void> {
    const tab = this.source.get(id);
    if (!tab) { this.remove(id); return; }
    const generation = this.generation;
    const chunks = this.chunks(tab);
    const identity = (cs: TextChunk[]) => JSON.stringify(cs.map(c => [c.key, c.hash, c.label, c.headingId]));
    const snapshot = identity(chunks);
    const prior = this.db!.prepare("SELECT value FROM meta WHERE key=?").get(`page:${id}`) as { value: string } | undefined;
    if (prior?.value === snapshot) return;
    const old = new Map((this.db!.prepare("SELECT chunk_key,hash FROM chunks WHERE tab_id=?").all(id) as { chunk_key: string; hash: string }[]).map(r => [r.chunk_key, r.hash]));
    const changed = chunks.filter(c => old.get(c.key) !== c.hash);
    // IPC batches are bounded; temporary vectors cover only this page's changed chunks.
    const pending = new Map<string, Float32Array>();
    for (let from = 0; from < changed.length; from += 32) {
      if (!this.enabled || this.stopped || generation !== this.generation) return;
      const batch = changed.slice(from, from + 32);
      const vectors = await this.embedder.embedDocuments(batch.map(c => ({ title: c.title, text: c.text })));
      if (vectors.length !== batch.length || vectors.some(v => v.length !== WIDTH || !v.every(Number.isFinite))) throw new Error("Invalid search vector dimensions");
      batch.forEach((c, i) => pending.set(c.key, vectors[i]));
    }
    if (!this.enabled || this.stopped || generation !== this.generation) return;
    const latest = this.source.get(id);
    if (!latest) { this.remove(id); return; }
    if (snapshot !== identity(this.chunks(latest))) { this.queue.add(id); return; }
    const db = this.db!;
    const put = db.prepare("INSERT INTO chunks(tab_id,chunk_key,kind,anchor,heading_id,label,snippet,hash,vec) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tab_id,chunk_key) DO UPDATE SET kind=excluded.kind,anchor=excluded.anchor,heading_id=excluded.heading_id,label=excluded.label,snippet=excluded.snippet,hash=excluded.hash,vec=excluded.vec");
    db.exec("BEGIN");
    try {
      const keys = new Set(chunks.map(c => c.key));
      for (const key of old.keys()) if (!keys.has(key)) db.prepare("DELETE FROM chunks WHERE tab_id=? AND chunk_key=?").run(id, key);
      for (const chunk of chunks) {
        const vec = pending.get(chunk.key);
        if (vec) put.run(id, chunk.key, chunk.kind, chunk.anchor, chunk.headingId ?? null, chunk.label, chunk.snippet, chunk.hash, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
        else db.prepare("UPDATE chunks SET label=?,snippet=?,heading_id=? WHERE tab_id=? AND chunk_key=?").run(chunk.label, chunk.snippet, chunk.headingId ?? null, id, chunk.key);
      }
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(`page:${id}`, snapshot);
      db.exec("COMMIT"); this.dirty = true;
    } catch (err) { db.exec("ROLLBACK"); throw err; }
  }
  private loadVectors(): void {
    if (!this.dirty || !this.db) return;
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const vectors = new Float32Array(count * WIDTH), rows: IndexedChunk[] = [];
    for (const row of this.db.prepare("SELECT * FROM chunks ORDER BY id").iterate() as Iterable<Row>) {
      if (row.vec.byteLength !== WIDTH * 4) continue;
      const { vec, ...meta } = row;
      const copy = Uint8Array.from(vec);
      vectors.set(new Float32Array(copy.buffer), rows.length * WIDTH); rows.push(meta);
    }
    this.rows = rows; this.vectors = vectors; this.dirty = false;
  }
  async query(q: string, scope: "pages" | "chunks", visible: (id: string) => boolean, limit = 8, cutoff = true): Promise<ScoredHit[]> {
    if (!this.enabled || this.stopped) throw new Error("Semantic search is unavailable");
    const generation = this.generation;
    let vec = this.queries.get(q);
    if (!vec) {
      vec = await this.embedder.embedQuery(q);
      if (vec.length !== WIDTH || !vec.every(Number.isFinite)) throw new Error("Invalid query vector");
      if (!this.enabled || this.stopped || generation !== this.generation) throw new Error("Search settings changed");
    }
    this.queries.delete(q); this.queries.set(q, vec);
    if (this.queries.size > 50) this.queries.delete(this.queries.keys().next().value!);
    this.loadVectors();
    return rankVectors(this.rows, this.vectors, vec, scope, visible, limit, cutoff);
  }
  status() {
    const pages = this.source.pages();
    const indexed = this.db ? (this.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'page:%'").get() as { n: number }).n : 0;
    const chunks = this.db ? (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n : 0;
    return { enabled: this.enabled, indexing: !!this.running, indexedPages: indexed, totalPages: pages.length, chunks, pendingPages: this.queue.size + this.timers.size, error: this.error };
  }
  fail(error: unknown): void { this.pause(); this.error = error instanceof Error ? error.message : String(error); }
  async close(): Promise<void> { this.pause(); this.stopped = true; await this.idle(); this.db?.close(); this.db = undefined; }
}
