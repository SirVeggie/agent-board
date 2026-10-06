import assert from "node:assert/strict";
import { test } from "node:test";
import { contextBlock, contextChipKey, freshContext, guidesBlock, pageKeysIn, threadInstructions } from "./prompt.js";
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

test("contextBlock names pages, folders, files and selections", () => {
  const text = contextBlock([page("t1", "Todo"), folder("f1"), file("src/a.ts"), sel("hello")]);
  assert.match(text, /Scribe page: "Todo" \(key: scribe:t1\)/);
  assert.match(text, /Library folder: Folder\/f1/);
  assert.match(text, /File: src\/a\.ts/);
  assert.match(text, /Selected text:\n"""\nhello\n"""/);
  assert.equal(contextBlock([]), "");
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

test("every thread is told to check a message that looks meant for another thread", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "cursor", mode: "board", cwd: null, scope: { kind: "global", ref: null }, ...over }) as Thread;
  for (const t of [thread({}), thread({ mode: "code", cwd: "/work" }), thread({ provider: "claude", mode: "ask" })]) {
    assert.match(threadInstructions(t, {}), /Wrong thread: .*ask in one short line whether it was meant for this thread/);
  }
});

test("worktree threads with a linked node_modules are told how to change dependencies", () => {
  const wt = (links: string[]) =>
    ({ provider: "claude", mode: "code", cwd: "/wt", scope: { kind: "global", ref: null }, worktree: { home: "/repo", repo: "/repo", path: "/wt", branch: "agent/x", base: "master", baseCommit: "abc", links, createdAt: 0 } }) as Thread;
  assert.match(threadInstructions(wt(["node_modules"]), {}), /npm install --package-lock-only/);
  assert.doesNotMatch(threadInstructions(wt([]), {}), /package-lock-only/);
});

test("threadInstructions includes folder instruction pages, parents first", () => {
  const thread = {
    provider: "claude",
    mode: "board",
    cwd: null,
    scope: { kind: "page", ref: "t1" },
  } as Thread;
  const text = threadInstructions(thread, {
    page: { id: "t1", key: "scribe:notes", title: "Notes", folder: "Work/Releases" },
    folderInstructions: [
      { folder: null, key: "scribe:root-instructions", title: "Instructions", text: "Root rule." },
      { folder: "Work/Releases", key: "scribe:release-rules", title: "Rules", text: "Release rule." },
    ],
  });
  assert.match(text, /Folder instructions \(Library pages for this folder and its parents\)/);
  const rootAt = text.indexOf('folder="Library root"');
  const nestedAt = text.indexOf('folder="Work/Releases"');
  assert.ok(rootAt >= 0 && nestedAt > rootAt);
  assert.match(text, /Root rule\./);
  assert.match(text, /Release rule\./);
  assert.doesNotMatch(threadInstructions(thread, { page: { id: "t1", key: "scribe:notes", title: "Notes", folder: "Work" } }), /Folder instructions/);
});

test("guidesBlock sends each guide once, naming every page it covers", () => {
  const kanban = { id: "tpl_kanban", title: "Kanban board", text: "Use page_action." };
  const todo = { id: "tpl_todo", title: "Todo list", text: "Items live in todos." };
  const block = guidesBlock([
    { key: "scribe:a", guide: kanban, given: false },
    { key: "scribe:b", guide: kanban, given: false },
    { key: "scribe:c", guide: todo, given: true },
  ]);
  assert.equal(block.match(/Use page_action\./g)?.length, 1);
  assert.match(block, /<page_guide template="Kanban board" pages="scribe:a, scribe:b">/);
  assert.match(block, /<page_guide template="Todo list" pages="scribe:c">Given earlier/);
  assert.doesNotMatch(block, /Items live in todos/);
  assert.equal(guidesBlock([]), "");
});

test("pageKeysIn finds scribe: keys without trailing punctuation or repeats", () => {
  assert.deepEqual(pageKeysIn("See [[scribe:agent-todo]] and scribe:Notes.v2. Also scribe:agent-todo, not xscribe:nope."), ["scribe:agent-todo", "scribe:notes.v2"]);
});

test("threads with no Scribe scope are told they have no page tools", () => {
  const thread = (over: Partial<Thread>): Thread =>
    ({ provider: "claude", mode: "board", web: "on", cwd: null, scope: { kind: "workspace", ref: null }, ...over }) as Thread;
  const none = threadInstructions(thread({}), {});
  assert.match(none, /no access to Scribe pages/);
  assert.match(none, /Mode: Chat\./);
  assert.doesNotMatch(none, /page_show/);
  const global = threadInstructions(thread({ scope: { kind: "global", ref: null } }), {});
  assert.match(global, /page_show/);
  assert.match(global, /Mode: Pages\./);
});
