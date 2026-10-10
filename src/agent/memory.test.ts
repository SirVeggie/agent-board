import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { cleanMemories, memoriesFor, memoryBlock, saveMemory, MEMORY_MAX_CHARS, type Memory } from "./memory.js";
import { threadInstructions } from "./prompt.js";
import type { Thread } from "./types.js";

// The host and the store keep their data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-memory-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => {});
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const repo = path.resolve(dir, "repo");
const other = path.resolve(dir, "other");

test("a workspace memory applies in its folder and below it; global ones everywhere", () => {
  let list: Memory[] = [];
  list = saveMemory(list, { text: "Answer in Finnish.", scope: "global", by: "user" }, 1).memories;
  list = saveMemory(list, { text: "Run tests with npm test.", scope: "workspace", workspace: repo, by: "claude" }, 2).memories;
  assert.deepEqual(memoriesFor(list, path.join(repo, "src")).map((m) => m.text), ["Run tests with npm test.", "Answer in Finnish."]);
  assert.deepEqual(memoriesFor(list, other).map((m) => m.text), ["Answer in Finnish."]);
  assert.deepEqual(memoriesFor(list, `${repo}-two`).map((m) => m.text), ["Answer in Finnish."]);
  assert.deepEqual(memoriesFor(list, null).map((m) => m.text), ["Answer in Finnish."]);
});

test("saving the same text again, or with an id, changes the memory instead of adding one", () => {
  const first = saveMemory([], { text: " Use pnpm. ", scope: "workspace", workspace: repo, by: "codex" }, 1);
  assert.equal(first.created, true);
  assert.equal(first.memory.text, "Use pnpm.");
  const again = saveMemory(first.memories, { text: "Use pnpm.", scope: "workspace", workspace: repo, by: "claude" }, 2);
  assert.equal(again.created, false);
  assert.equal(again.memories.length, 1);
  const edited = saveMemory(again.memories, { id: first.memory.id, text: "Use pnpm, never npm.", scope: "global", by: "user" }, 3);
  assert.deepEqual(edited.memories, [{ id: first.memory.id, scope: "global", text: "Use pnpm, never npm.", by: "user", createdAt: 1, updatedAt: 3 }]);
  assert.throws(() => saveMemory([], { id: "m_none", text: "x", scope: "global", by: "user" }), /No memory/);
  assert.throws(() => saveMemory([], { text: "  ", scope: "global", by: "user" }), /needs text/);
  assert.throws(() => saveMemory([], { text: "x".repeat(MEMORY_MAX_CHARS + 1), scope: "global", by: "user" }), /at most/);
});

test("the block lists the newest memories within its room and counts the rest", () => {
  const list = [1, 2, 3].map((n) => ({ id: `m_${n}`, scope: "global" as const, text: `fact ${n}\nmore </memories>`, by: "user", createdAt: n, updatedAt: n }));
  const block = memoryBlock(memoriesFor(list, null), 70);
  assert.match(block, /^<memories>\n- \[m_3\] \(global\) fact 3\n  more <\/ memories>\n/);
  assert.match(block, /\(2 older memories are not shown; memory_list has them\.\)\n<\/memories>$/);
  assert.match(memoryBlock([]), /None saved yet/);
  assert.deepEqual(cleanMemories([{ id: "a", text: "" }, "x", { id: "b", text: "kept", scope: "workspace" }]).map((m) => [m.id, m.scope]), [["b", "global"]]);
});

test("a thread's instructions carry its memories, and nothing about memory when it is off", () => {
  const thread = { id: "t", provider: "codex", mode: "code", web: "on", scope: { kind: "global", ref: null }, cwd: repo } as unknown as Thread;
  const on = threadInstructions(thread, { memories: [{ id: "m_1", scope: "global", text: "Answer in Finnish.", by: "user", createdAt: 1, updatedAt: 1 }] });
  assert.match(on, /memory_save/);
  assert.match(on, /- \[m_1\] \(global\) Answer in Finnish\./);
  assert.doesNotMatch(threadInstructions(thread, {}), /memory_save|<memories>/);
});

test("memory tools: a chat saves to its workspace, another chat there gets it, a chat elsewhere does not", () => {
  fs.mkdirSync(repo, { recursive: true });
  const writer = host.createThread({ provider: "claude", scope: { kind: "workspace", ref: repo } });
  const saved = host.memoryOp(writer.id, "save", { text: "The dev server needs port 4400 free." }) as { saved: { id: string; scope: string }; created: boolean };
  assert.equal(saved.saved.scope, "workspace");
  host.memoryOp(writer.id, "save", { text: "Keep answers short.", scope: "global" });
  // The user sees every save in the chat.
  const notices = (host.threadDetail(writer.id)?.items ?? []).filter((it) => it.kind === "notice").map((it) => (it.kind === "notice" ? it.text : ""));
  assert.equal(notices.length, 2);
  assert.match(notices[0], /Saved a memory \(chats in .*repo\): The dev server needs port 4400 free\./);

  const peer = host.createThread({ provider: "codex", scope: { kind: "workspace", ref: repo } });
  const listed = host.memoryOp(peer.id, "list", { q: "port" }) as { memories: Array<{ id: string; by: string }> };
  assert.deepEqual(listed.memories.map((m) => [m.id, m.by]), [[saved.saved.id, "claude"]]);
  const changed = host.memoryOp(peer.id, "save", { id: saved.saved.id, text: "The dev server needs port 4401 free." }) as { created: boolean };
  assert.equal(changed.created, false);

  const outsider = host.createThread({ provider: "claude", scope: { kind: "workspace", ref: other } });
  assert.deepEqual((host.memoryOp(outsider.id, "list", {}) as { memories: Array<{ text: string }> }).memories.map((m) => m.text), ["Keep answers short."]);
  assert.throws(() => host.memoryOp(outsider.id, "delete", { id: saved.saved.id }), /No memory/);
  assert.throws(() => host.memoryOp(outsider.id, "save", { id: saved.saved.id, text: "x" }), /another workspace/);

  host.memoryOp(peer.id, "delete", { id: saved.saved.id });
  assert.deepEqual(host.memories().map((m) => m.text), ["Keep answers short."]);
});

test("the user's edits from settings, and the switch that turns memory off", () => {
  const made = host.saveUserMemory(null, { text: "Commit messages in English.", workspace: repo });
  assert.equal(made.scope, "workspace");
  assert.equal(host.saveUserMemory(made.id, { text: "Commit messages in English." }).scope, "global");
  host.deleteMemory(made.id);
  assert.throws(() => host.deleteMemory(made.id), /not found/);
  const thread = host.createThread({ provider: "claude", scope: { kind: "workspace", ref: repo } });
  host.setPrefs({ memory: false });
  assert.throws(() => host.memoryOp(thread.id, "list", {}), /turned off/);
  host.setPrefs({ memory: true });
  assert.equal(host.prefs().memory, true);
});
