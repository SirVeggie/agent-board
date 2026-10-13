/** Synthetic, warm-cache comparison. Run: node --import tsx tools/bench-thread-search.ts <baseline-ref> */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { performance } from "node:perf_hooks";
import { AgentDb } from "../src/agent/db.js";
import { likePatterns, matchMessages, searchWords } from "../src/agent/threadSearch.js";
import type { Item, Thread } from "../src/agent/types.js";

const baseline = process.argv[2] || "HEAD^";
const oldFile = (name: string) => execFileSync("git", ["show", `${baseline}:${name}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
const oldContext = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(oldFile("src/agent/threadSearch.ts")).replace(/export /g, ""), oldContext);
const oldMatch = vm.runInContext("matchMessages", oldContext) as typeof matchMessages;

function median(fn: () => unknown) {
  for (let i = 0; i < 2; i++) fn();
  const times = Array.from({ length: 7 }, () => {
    const start = performance.now(); fn(); return performance.now() - start;
  }).sort((a, b) => a - b);
  return +times[3].toFixed(2);
}

function palette(source: string) {
  const threads = new Map();
  for (let i = 0; i < 10_000; i++) threads.set(String(i), {
    id: String(i), title: i % 10 === 0 ? "llama H2O configuration" : `Work on project ${i}`,
    activityAt: i, scope: { text: "Workspace" }, cwd: "C:/Projects/models",
  });
  const ctx = vm.createContext({ S: { threads }, scopeLabel: (s: any) => s,
    workspaceDir: (t: any) => t.cwd, nestsUnder: () => false,
    hiddenWorkspaceKeys: () => new Set(), inHiddenWorkspace: () => false });
  vm.runInContext(source.slice(source.indexOf("  function threadRank("), source.indexOf("  /** Keep in sync with src/agent/threadList.ts */")) +
    source.slice(source.indexOf("  function searchThreads("), source.indexOf("  function threadTitle(")), ctx);
  return (q: string) => vm.runInContext(`searchThreads(${JSON.stringify(q)})`, ctx);
}

const oldPalette = palette(oldFile("public/agent.js"));
const newPalette = palette(fs.readFileSync(new URL("../public/agent.js", import.meta.url), "utf8"));
console.log("10,000 threads; client filtering + ranking + top 40 (ms, median of 7):");
for (const q of ["llama h2o", "project", "missing"]) console.log(JSON.stringify({ q, before: median(() => oldPalette(q)), after: median(() => newPalette(q)) }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-search-bench-"));
const db = new AgentDb(path.join(dir, "agent.sqlite"));
try {
  // 1,000 threads, 50 messages each, roughly 2 KB per message. No user data is read.
  for (let t = 0; t < 1000; t++) {
    const threadId = String(t).padStart(4, "0");
    db.saveThread({ id: threadId, title: "Model setup", activityAt: 1 } as unknown as Thread);
    db.saveItems(Array.from({ length: 50 }, (_, seq) => ({
      id: `${threadId}-${seq}`, threadId, turnId: "turn", seq, kind: "user",
      text: `${t % 10 === 0 ? "llama.cpp H2O x " : "ordinary project discussion "}${"Some ordinary conversation about the project. ".repeat(45)}`,
    } as Item)));
  }
  console.log("50,000 messages (~2 KB each); same query semantics before/after; ms, median of 7:");
  for (const q of ["llama.cpp h2o", "x", "project", "missing"]) {
    const words = searchWords(q), patterns = words.flatMap(likePatterns);
    const rows = [...db.searchMessages(patterns)];
    assert.equal(JSON.stringify(matchMessages(rows, words)), JSON.stringify(oldMatch(rows, words)));
    console.log(JSON.stringify({ q, candidateRows: rows.length,
      matchBefore: median(() => oldMatch(rows, words)), matchAfter: median(() => matchMessages(rows, words)),
      totalBefore: median(() => oldMatch(db.searchMessages(patterns), words)),
      totalAfter: median(() => matchMessages(db.searchMessages(patterns), words)),
    }));
  }
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
