import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { searchWords } from "./threadSearch.js";

const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
function client() {
  const requests: string[] = [];
  const threads = new Map();
  const ctx = vm.createContext({
    S: { threads, current: null }, setTimeout, clearTimeout,
    scopeLabel: (scope: any) => ({ text: scope.ref || "Global" }),
    workspaceDir: (t: any) => t.cwd || "",
    hiddenWorkspaceKeys: () => new Set(), inHiddenWorkspace: () => false,
    nestsUnder: () => false,
    api: async (_method: string, url: string) => {
      requests.push(url);
      return { hits: [{ id: "body", words: ["x", "llama.cpp", "h2o"], snippet: "llama.cpp H2O x" }] };
    },
  });
  vm.runInContext(source.slice(source.indexOf("  function threadRank("), source.indexOf("  /** Keep in sync with src/agent/threadList.ts */")) +
    source.slice(source.indexOf("  function searchThreads("), source.indexOf("  function threadTitle(")), ctx);
  const run = (code: string) => vm.runInContext(code, ctx);
  const json = (code: string) => JSON.parse(JSON.stringify(run(code)));
  const add = (id: string, title: string, activityAt = 1, extra = {}) => threads.set(id, { id, title, activityAt, scope: { kind: "global" }, ...extra });
  return { run, json, add, requests };
}

test("client and daemon agree on technical words and stopword dropping", () => {
  const c = client();
  for (const q of ["please show my llama.cpp page", "a", "x", "H2O llama.cpp x", "the my", "", "a b b c"]) {
    assert.deepEqual(c.json(`searchWords(${JSON.stringify(q)})`), searchWords(q));
  }
});

test("short message queries reach the daemon without needing an extra word", async () => {
  const c = client();
  c.add("body", "Model setup");
  assert.equal(await c.run('searchMessages("x")'), true);
  assert.deepEqual(c.requests, ["/thread-search?q=x"]);
  assert.deepEqual(c.json('searchThreads("x").map(t => [t.id, t.snippet])'), [["body", "llama.cpp H2O x"]]);
  assert.equal(await c.run('searchMessages("please show llama.cpp H2O x")'), true);
  assert.deepEqual(c.json('searchThreads("please show llama.cpp H2O x").map(t => t.id)'), ["body"]);
});

test("exact, word, fuzzy, mixed and message matches rank ahead of recency and pinning", () => {
  const c = client();
  c.add("body", "Model setup", 100, { pinned: true });
  c.add("mixed", "llama configuration", 90);
  c.add("scope", "Unrelated", 80, { scope: { ref: "llama h2o" } });
  c.add("fuzzy", "Local language model adapter H2O", 70);
  c.add("title", "Local llama with H2O", 65);
  c.add("words", "h2o with llama", 60);
  c.add("exact", "llama h2o", 1);
  c.run('messageSearch.cache.set("llama h2o", { hits: new Map([ ["body", { words: ["llama", "h2o"], snippet: "body match" }], ["mixed", { words: ["h2o"], snippet: "mixed match" }] ]) })');
  // All-word titles rank ahead of content, even a pinned content hit.
  assert.deepEqual(c.json('searchThreads("llama h2o").map(t => t.id)'), ["exact", "title", "words", "fuzzy", "scope", "mixed", "body"]);
  c.add("sequence", "Lively learning model architecture", 1);
  assert.deepEqual(c.json('searchThreads("llma").map(t => t.id)'), ["mixed", "fuzzy", "title", "words", "exact", "sequence"]);
  assert.equal(c.json('searchThreads("llma").find(t => t.id === "sequence").snippet'), "");
  assert.deepEqual(c.json('searchThreads("please show my llama h2o page").map(t => t.id)'), ["exact", "title", "words", "fuzzy", "scope", "mixed", "body"]);
  assert.deepEqual(c.json('rankedThreads([...S.threads.values()], "llama h2o").map(r => r.thread.id)'), c.json('searchThreads("llama h2o").map(t => t.id)'));
});
