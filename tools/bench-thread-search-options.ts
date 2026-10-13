/** #602 investigation only. Run: node --import tsx tools/bench-thread-search-options.ts [message-count]
 * Creates only a disposable synthetic DB. No app migrations or user history reads.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { AgentDb } from "../src/agent/db.js";
import { likePatterns, matchMessages, searchWords, type MessageRow } from "../src/agent/threadSearch.js";
import type { Item, Thread } from "../src/agent/types.js";

const count = Number(process.argv[2] ?? 50_000);
assert(Number.isSafeInteger(count) && count >= 100 && count <= 1_000_000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-search-options-"));
const file = path.join(dir, "synthetic.sqlite");
const agent = new AgentDb(file);
const db = new DatabaseSync(file);
const round = (n: number) => +n.toFixed(2);
const size = () => Number(db.prepare("PRAGMA page_count").get()!.page_count) *
  Number(db.prepare("PRAGMA page_size").get()!.page_size);
function timing(fn: () => unknown) {
  fn(); fn();
  const times = Array.from({ length: 7 }, () => {
    const start = performance.now(); fn(); return performance.now() - start;
  }).sort((a, b) => a - b);
  return { medianMs: round(times[3]), maxMs: round(times[6]) };
}
const eligible = "json_extract(data, '$.kind') IN ('user', 'text') AND json_extract(data, '$.dropped') IS NOT 1 AND json_extract(data, '$.parentToolId') IS NULL AND typeof(json_extract(data, '$.text')) = 'text'";
const rows = (sql: string, params: string[]) => db.prepare(sql).iterate(...params) as IterableIterator<MessageRow>;
// Decoded text needs literal LIKE escaping, not the production JSON-string escaping.
const textPatterns = (word: string) => [...new Set(/[^\x00-\x7f]/.test(word) ? [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1)] : [word])]
  .map(form => `%${form.replace(/[!%_]/g, "!$&")}%`);
try {
  const fixtureStart = performance.now();
  for (let start = 0; start < count; start += 50) {
    const threadId = String(start / 50).padStart(6, "0");
    agent.saveThread({ id: threadId, title: "Synthetic thread", activityAt: start } as Thread);
    agent.saveItems(Array.from({ length: Math.min(50, count - start) }, (_, seq) => {
      const i = start + seq;
      const marker = i % 100 === 0 ? 'llama.cpp H2O x 50% a_b "quoted" C:\\models Ääni 🙂🙂🙂' : "ordinary discussion";
      // Split words across messages; include excluded kinds and metadata-only matches.
      return { id: String(i), threadId, seq, turnId: "turn", kind: i % 17 === 0 ? "tool" : i % 2 ? "text" : "user",
        dropped: i % 23 === 0 || undefined, parentToolId: i % 29 === 0 ? "parent" : undefined,
        text: `${marker} ${seq === 1 ? "splitneedle" : ""} ${seq === 2 ? "otherneedle" : ""} Message ${i}. ${"Some ordinary conversation about the project. ".repeat(45)}`,
      } as Item;
    }));
  }
  const baseBytes = size();
  const fixtureMs = round(performance.now() - fixtureStart);
  const projectionStart = performance.now();
  db.exec("CREATE TABLE search_text (id INTEGER PRIMARY KEY, thread_id TEXT, seq INTEGER, text TEXT, normalized TEXT); BEGIN");
  const insert = db.prepare("INSERT INTO search_text VALUES (?, ?, ?, ?, ?)");
  for (const row of db.prepare(`SELECT rowid AS id, thread_id, seq, json_extract(data, '$.text') AS text FROM items WHERE ${eligible}`).iterate()) {
    const text = row.text as string;
    insert.run(row.id, row.thread_id, row.seq, text, text.toLowerCase());
  }
  db.exec("CREATE INDEX search_text_order ON search_text(thread_id, seq); COMMIT");
  const projectionMs = round(performance.now() - projectionStart);
  const projectionBytes = size() - baseBytes;
  const indexStart = performance.now();
  db.exec(`CREATE VIRTUAL TABLE search_tri USING fts5(normalized, content='search_text', content_rowid='id', tokenize='trigram case_sensitive 1');
    INSERT INTO search_tri(search_tri) VALUES ('rebuild');`);
  const indexMs = round(performance.now() - indexStart);
  const indexBytes = size() - baseBytes - projectionBytes;
  const allText = [...rows("SELECT thread_id AS threadId, text FROM search_text ORDER BY thread_id, seq", [])];
  const normalizedScan = (words: string[]) => rows(`SELECT thread_id AS threadId, text FROM search_text WHERE ${words.map(() => "instr(normalized, ?) > 0").join(" OR ")} ORDER BY thread_id, seq`, words);
  const hybrid = (words: string[]) => {
    const long = words.filter(w => [...w].length >= 3);
    const short = words.filter(w => [...w].length < 3);
    const branches: string[] = [], params: string[] = [];
    if (long.length) {
      branches.push("SELECT rowid AS id FROM search_tri WHERE search_tri MATCH ?");
      params.push(long.map(w => '"' + w.replace(/"/g, '""') + '"').join(" OR "));
    }
    if (short.length) {
      branches.push(`SELECT id FROM search_text WHERE ${short.map(() => "instr(normalized, ?) > 0").join(" OR ")}`);
      params.push(...short);
    }
    // UNION deduplicates; OR preserves words split across messages and title/message combinations.
    return rows(`SELECT thread_id AS threadId, text FROM search_text WHERE id IN (${branches.join(" UNION ")}) ORDER BY thread_id, seq`, params);
  };
  console.log(JSON.stringify({ node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS v").get()!.v,
    messages: count, eligible: allText.length, fixtureMs, baseMiB: round(baseBytes / 2 ** 20),
    projectionMs, projectionMiB: round(projectionBytes / 2 ** 20), indexMs, indexMiB: round(indexBytes / 2 ** 20) }));
  const queries = ["llama.cpp h2o", "x", "h2", "project", "missingneedle", "splitneedle otherneedle", "x llama.cpp", "50%", "a_b", '"quoted"', "c:\\models", "ääni", "🙂🙂🙂"];
  for (const q of queries) {
    const words = searchWords(q);
    const options = {
      currentJson: () => agent.searchMessages(words.flatMap(likePatterns)),
      extractedText: () => rows(`SELECT thread_id AS threadId, json_extract(data, '$.text') AS text FROM items WHERE ${eligible} AND (${words.flatMap(textPatterns).map(() => "json_extract(data, '$.text') LIKE ? ESCAPE '!'").join(" OR ")}) ORDER BY thread_id, seq`, words.flatMap(textPatterns)),
      normalizedText: () => normalizedScan(words),
      trigramHybrid: () => hybrid(words),
      memoryText: () => allText,
    };
    const expected = matchMessages(allText, words);
    const results: Record<string, unknown> = {};
    for (const [name, getRows] of Object.entries(options)) {
      assert(JSON.stringify(matchMessages(getRows(), words)) === JSON.stringify(expected), `${name}: ${q}`);
      results[name] = { ...timing(() => matchMessages(getRows(), words)), candidates: [...getRows()].length };
    }
    console.log(JSON.stringify({ q, hits: expected.length, results }));
  }
  console.log(JSON.stringify({ verified: true, queries: queries.length, approaches: 5,
    checks: "hit words, exclusions, cross-message matches and earliest best snippets" }));
} finally {
  db.close(); agent.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
