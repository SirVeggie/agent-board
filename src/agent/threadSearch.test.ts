import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AgentDb } from "./db.js";
import { likePatterns, matchMessages, searchWords } from "./threadSearch.js";
import type { Item, Thread } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-thread-search-"));
const db = new AgentDb(path.join(dir, "agent.sqlite"));

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const item = (threadId: string, body: Record<string, unknown>): Item => ({ id: `i${++seq}`, threadId, turnId: "turn", seq, ...body }) as unknown as Item;

const search = (q: string) => {
  const words = searchWords(q);
  return matchMessages(db.searchMessages(words.flatMap(likePatterns)), words);
};

test("thread search reads the user's messages and the agent's replies, word by word", () => {
  for (const id of ["a", "b", "c"]) db.saveThread({ id, title: id, activityAt: 1 } as unknown as Thread);
  db.saveItems([
    item("a", { kind: "user", text: "How do I Install\nllama.cpp here?" }),
    item("a", { kind: "text", text: "Use the H2O model: it is 100% \"ready\" for snake_case names." }),
    item("b", { kind: "tool", name: "shell", title: "h2o install", output: "h2o install" }),
    item("b", { kind: "text", text: "A subagent said h2o.", parentToolId: "tool" }),
    item("b", { kind: "user", text: "Dropped h2o message", dropped: true }),
    item("b", { kind: "text", text: "Nothing to install here." }),
    item("c", { kind: "user", text: "Älä unohda ääkkösiä" }),
  ]);

  // Words may sit in different messages, in any order and case.
  const both = search("h2o install");
  assert.deepEqual(both.map((hit) => [hit.id, [...hit.words].sort()]), [["a", ["h2o", "install"]], ["b", ["install"]]]);
  assert.equal(both[0].snippet, "How do I Install llama.cpp here?");

  // Tool calls, subagent text and dropped messages are not searched.
  assert.deepEqual(search("h2o").map((hit) => hit.id), ["a"]);

  // LIKE wildcards and JSON-escaped characters in a word are matched as written.
  assert.deepEqual(search("100%").map((hit) => hit.id), ["a"]);
  assert.deepEqual(search('"ready"').map((hit) => hit.id), ["a"]);
  assert.deepEqual(search("snake_case").map((hit) => hit.id), ["a"]);
  assert.deepEqual(search("snakeXcase"), []);
  assert.deepEqual(search("10_%"), []);

  // Letters outside ASCII match whatever their case.
  assert.deepEqual(search("älä ÄÄKKÖSIÄ").map((hit) => hit.words.length), [2]);
  assert.deepEqual(search(""), []);
});
