// npm run build && node tools/bench-page-search.mjs <pre-change git revision>
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import ts from "typescript";
import { htmlToText } from "../dist/pageText.js";
import { searchPages } from "../dist/pageSearch.js";
import { searchLibrary } from "../dist/librarySearch.js";

const ref = process.argv[2];
if (!ref) throw new Error("Pass a pre-change git revision");
function before(file) {
  const source = execFileSync("git", ["show", `${ref}:src/${file}.ts`], { encoding: "utf8" });
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({ htmlToText }) });
  return exports;
}
const oldPages = before("pageSearch").searchPages;
const oldLibrary = before("librarySearch").searchLibrary;
const tabs = Array.from({ length: 116 }, (_, i) => ({
  id: `t_${i}`, key: `scribe:fixture-${i}`, title: `Fixture ${i}`, revision: 1, stateRevision: 1, updatedAt: i,
  html: `<p>${"Page content and deployment notes. ".repeat(150)}</p>`,
  state: i ? { note: "Small page data" } : {
    cards: Array.from({ length: 800 }, (_, n) => ({ id: `c_${n}`, title: `Task ${n}`, description: "Review deployment and session behavior. ".repeat(12), comments: [{ text: "User comment about the checklist. ".repeat(6) }] })),
    settings: { workerLog: Array.from({ length: 800 }, () => ({ text: "Worker started a task and recorded bookkeeping. ".repeat(2) })) },
  },
}));
const queries = ["deployment", "session", "unmatchedneedle", "checklist"];
console.log(JSON.stringify({ pages: tabs.length, htmlCharacters: tabs.reduce((n, t) => n + t.html.length, 0), largeStateCharacters: JSON.stringify(tabs[0].state).length }));
function measure(fn, rounds) {
  for (let i = 0; i < 12; i++) fn(queries[i % queries.length]);
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    fn(queries[i % queries.length]);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return Number(samples[Math.floor(samples.length / 2)].toFixed(3));
}
for (const [name, old, current] of [
  ["palette", q => oldPages(tabs, [], q), q => searchPages(tabs, [], q)],
  ["library", q => oldLibrary(tabs, q, 0, 20), q => searchLibrary(tabs, q, 0, 20)],
]) console.log(JSON.stringify({ search: name, medianMsBefore: measure(old, 120), medianMsAfterWarmCache: measure(current, 120) }));
