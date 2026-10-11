import assert from "node:assert/strict";
import { test } from "node:test";
import { threadActivity } from "./activity.js";
import type { Item } from "./types.js";

let seq = 0;
function it(body: Record<string, unknown>): Item {
  seq++;
  return { id: `it_${seq}`, threadId: "th", turnId: "tu", seq, createdAt: seq, ...body } as Item;
}

test("idle threads the user has read have no activity", () => {
  assert.equal(threadActivity([it({ kind: "text", text: "done" })], "idle", false), undefined);
});

test("a running thread shows its latest step and the latest message", () => {
  const items = [
    it({ kind: "user", text: "go" }),
    it({ kind: "text", text: "I'll **check** the tests.\n\nRunning them now." }),
    it({ kind: "tool", tool: "execute", title: "Run", detail: "npm test", status: "running", toolId: "x", name: "Bash", startedAt: 1 }),
    it({ kind: "tool", tool: "read", title: "Read a.ts", status: "done", toolId: "y", name: "Read", startedAt: 1, parentToolId: "x" }),
  ];
  assert.deepEqual(threadActivity(items, "running", false), { line: "$ npm test", lastText: "I'll check the tests. Running them now." });
});

test("an agent_run step names the helper and its model, not the tool", () => {
  const call = (extra: Record<string, unknown>) => [it({ kind: "tool", tool: "mcp", title: "Scribe: agent_run", status: "running", toolId: "h", name: "mcp__scribe__agent_run", startedAt: 1, ...extra })];
  const started = call({ input: { task: "Audit the **files**\nIn detail.", provider: "codex", model: "gpt" } });
  assert.equal(threadActivity(started, "running", false)?.line, "Helper · Audit the files · gpt");
  const linked = call({ input: { thread: "th_h" }, helper: "th_h" });
  const lookup = (id: string) => (id === "th_h" ? { title: "Helper: Audit the files", model: "gpt-mini" } : undefined);
  assert.equal(threadActivity(linked, "running", false, lookup)?.line, "Helper · Audit the files · gpt-mini");
  assert.equal(threadActivity(linked, "running", false)?.line, "Helper");
});

test("a new turn with no steps yet reads as working, not the last turn's step", () => {
  const items = [it({ kind: "tool", tool: "read", title: "Read a.ts", status: "done", toolId: "y", name: "Read", startedAt: 1 }), it({ kind: "user", text: "next" })];
  assert.deepEqual(threadActivity(items, "running", false), { line: "Working…" });
});

test("an unread idle thread says its reply is ready and keeps a long message short", () => {
  const act = threadActivity([it({ kind: "user", text: "q" }), it({ kind: "text", text: "x".repeat(400) })], "idle", true);
  assert.equal(act?.line, "Reply ready");
  assert.equal(act?.lastText?.length, 240);
  assert.ok(act?.lastText?.endsWith("…"));
});
