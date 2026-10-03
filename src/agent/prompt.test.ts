import assert from "node:assert/strict";
import { test } from "node:test";
import { contextChipKey, freshContext, threadInstructions } from "./prompt.js";
import type { ContextChip, Thread } from "./types.js";

const page = (id: string, title = id): ContextChip => ({ kind: "page", id, key: `scribe:${id}`, title });
const folder = (id: string): ContextChip => ({ kind: "folder", id, path: `Folder/${id}` });
const file = (p: string): ContextChip => ({ kind: "file", path: p });
const sel = (text: string): ContextChip => ({ kind: "selection", text });

test("freshContext drops pages, folders and files the thread already has", () => {
  const already = [page("t1", "Todo"), folder("f1"), file("/a.ts")];
  assert.deepEqual(freshContext([page("t1", "Todo"), page("t2", "Notes")], already), [page("t2", "Notes")]);
  assert.deepEqual(freshContext([folder("f1"), file("/a.ts"), file("/b.ts")], already), [file("/b.ts")]);
  assert.deepEqual(freshContext([page("t1")], already), []);
  assert.deepEqual(freshContext(undefined, already), []);
});

test("freshContext keeps selections and unique chips in one message", () => {
  const chips: ContextChip[] = [page("t1"), page("t1"), sel("hello"), sel("hello")];
  assert.deepEqual(freshContext(chips, []), [page("t1"), sel("hello"), sel("hello")]);
});

test("contextChipKey ignores selections", () => {
  assert.equal(contextChipKey(page("t1")), "page:t1");
  assert.equal(contextChipKey(sel("x")), null);
});

test("threads with a workspace are told their shell already starts there", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "claude", mode: "code", cwd: "/work", scope: { kind: "global", ref: null }, ...over }) as Thread;
  assert.match(threadInstructions(thread({}), {}), /Workspace: \/work\nShell commands already run in the workspace folder/);
  assert.doesNotMatch(threadInstructions(thread({ cwd: null }), {}), /Shell commands/);
  assert.doesNotMatch(threadInstructions(thread({ mode: "board" }), {}), /Shell commands/);
});
