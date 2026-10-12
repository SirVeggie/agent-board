import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverSkills, harnessStats, instructionSections, mcpCall, promptTokens, skillFrontmatter } from "./harness.js";
import type { Item, Thread, Turn } from "./types.js";

const thread = (id: string, over: Partial<Thread> = {}): Thread =>
  ({ id, title: id, provider: "claude", model: "opus", mode: "code", scope: { kind: "global", ref: null }, ...over }) as Thread;
const turn = (id: string, threadId: string, over: Partial<Turn> = {}): Turn => ({ id, threadId, seq: 1, status: "done", model: "opus", effort: null, mode: "code", startedAt: 1000, ...over });
const tool = (id: string, threadId: string, turnId: string, over: Record<string, unknown> = {}): Item =>
  ({ id, threadId, turnId, seq: 1, createdAt: 1000, kind: "tool", toolId: id, name: "Bash", tool: "execute", title: "Bash", status: "done", startedAt: 1000, endedAt: 1500, ...over }) as Item;

test("promptTokens adds cached input only where the provider reports it apart", () => {
  const usage = { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 };
  assert.equal(promptTokens("claude", usage), 1050);
  assert.equal(promptTokens("pi", usage), 1050);
  assert.equal(promptTokens("codex", usage), 100);
  assert.equal(promptTokens("cursor", undefined), 0);
});

test("mcpCall reads the server and tool from each provider's naming", () => {
  assert.deepEqual(mcpCall({ name: "mcp__scribe__page_action", title: "Scribe: page_action · agent-todo" }), { server: "scribe", tool: "page_action" });
  assert.deepEqual(mcpCall({ name: "mcp_tool_call", title: "Scribe: read_file" }), { server: "scribe", tool: "read_file" });
  assert.deepEqual(mcpCall({ name: "MCP: tool", title: "Board: page_action" }), { server: "scribe", tool: "page_action" });
  assert.deepEqual(mcpCall({ name: "mcp", title: "keeper: start" }), { server: "keeper", tool: "start" });
  assert.equal(mcpCall({ name: "mcp", title: "no server here" }), null);
});

test("instructionSections groups the instructions by topic", () => {
  const text = [
    "You are running inside Scribe.",
    "Code blocks: always give a language.",
    "",
    "Pages: the MCP tools read pages.",
    "Linking pages: keys look like scribe:x.",
    "",
    "Mode: Code. You can edit files.",
    "Web access is off in this thread: WebSearch asks the user first.",
    "To say why and how much you need it, call web_request first.",
    "",
    "Folder instructions (Library pages for this folder). Follow them.",
    "",
    '<folder_instructions folder="Apps" page="scribe:x">',
    "Mode: this line belongs to the folder page.",
    "</folder_instructions>",
    "",
    "Memory: Scribe keeps short notes.",
    "Save one with memory_save.",
    "<memories>",
    "- [m_1] (global) A note: with a colon.",
    "</memories>",
    "",
    "Workspace: C:\code",
    "Shell commands already run in the workspace folder.",
  ].join("\n");
  const sections = instructionSections(text);
  assert.deepEqual(sections.map((s) => s.label), ["Scribe", "Code blocks", "Pages", "Linking pages", "Mode", "Web", "Folder instructions", "Memory", "Workspace"]);
  assert.match(sections[5].text, /web_request/);
  assert.match(sections[6].text, /belongs to the folder page/);
  assert.match(sections[7].text, /m_1/);
  assert.equal(sections.reduce((sum, s) => sum + s.tokens, 0) > 0, true);
});

test("harnessStats totals tokens, tools, MCP calls and no-tool baselines", () => {
  const threads = [thread("a"), thread("b", { provider: "codex", model: "gpt" }), thread("empty")];
  const turns: Record<string, Turn[]> = {
    a: [
      turn("a1", "a", { usage: { inputTokens: 10, cacheReadTokens: 990, outputTokens: 5, costUsd: 0.5 } }),
      turn("a2", "a", { seq: 2, status: "error", usage: { inputTokens: 100, outputTokens: 1 } }),
      turn("a3", "a", { seq: 3, reverted: true, usage: { inputTokens: 9999 } }),
    ],
    b: [turn("b1", "b", { model: "gpt", mode: "board", usage: { inputTokens: 400, cacheReadTokens: 300, outputTokens: 2 } })],
    empty: [],
  };
  const items: Record<string, Item[]> = {
    a: [
      tool("i1", "a", "a2", { output: "x".repeat(40) }),
      tool("i2", "a", "a2", { name: "mcp__scribe__page_action", tool: "mcp", title: "Scribe: page_action", status: "error" }),
      tool("i3", "a", "a2", { name: "Skill", tool: "other", title: "Skill: scribe", input: { skill: "scribe" } }),
      tool("i4", "a", "a3"),
    ],
    b: [],
    empty: [],
  };
  const stats = harnessStats(threads, (id) => turns[id], (id) => items[id]);
  assert.equal(stats.threads, 2);
  assert.equal(stats.totals.turns, 3);
  assert.equal(stats.totals.prompt, 1000 + 100 + 400);
  assert.equal(stats.totals.cached, 1290);
  assert.equal(stats.totals.toolCalls, 3);
  assert.equal(stats.totals.toolErrors, 1);
  assert.deepEqual(stats.outcomes, { done: 2, error: 1, cancelled: 0 });
  assert.deepEqual(stats.mcp, [{ server: "scribe", tool: "page_action", calls: 1, errors: 1, outputTokens: 0, providers: ["claude"] }]);
  assert.deepEqual(stats.skills, [{ name: "scribe", calls: 1 }]);
  assert.equal(stats.toolKinds.find((k) => k.kind === "execute")?.outputTokens, 10);
  // a1 made no tool call; a2 is not a first turn.
  assert.deepEqual(stats.baselines, [
    { provider: "claude", mode: "code", samples: 1, min: 1000, median: 1000 },
    { provider: "codex", mode: "board", samples: 1, min: 400, median: 400 },
  ]);
  assert.equal(stats.heavy[0].id, "a");
  assert.equal(stats.days.length, 1);

  assert.equal(harnessStats(threads, (id) => turns[id], (id) => items[id], 2000).threads, 0);
});

test("skills are found in each provider's folders with their frontmatter", () => {
  assert.deepEqual(skillFrontmatter('---\nname: "x"\ndescription: >\n  First line\n  second line\n---\nBody'), { name: "x", description: "First line second line" });
  assert.deepEqual(skillFrontmatter("no frontmatter"), {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-harness-"));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(root, "home", ".claude", "skills", "keeper", "SKILL.md"), "---\nname: keeper\ndescription: Runs servers\n---\nUse it.");
  write(path.join(root, "home", ".claude", "skills", "keeper", "extra.md"), "more");
  write(path.join(root, "ws", ".agents", "skills", "help", "SKILL.md"), "No frontmatter here.");
  write(path.join(root, "ws", ".agents", "skills", "not-a-skill", "README.md"), "x");
  const skills = discoverSkills(path.join(root, "ws"), path.join(root, "home"), path.join(root, "data"));
  assert.deepEqual(skills.map((s) => [s.name, s.scope, s.providers, s.files]), [
    ["help", "workspace", ["cursor", "codex", "pi"], 0],
    ["keeper", "user", ["claude"], 1],
  ]);
  assert.equal(skills[1].description, "Runs servers");
  fs.rmSync(root, { recursive: true, force: true });
});

test("Harness distinguishes free estimates, provider costs, legacy amounts and incomplete coverage", () => {
  const stats = harnessStats([thread("a")], () => [
    turn("a", "a", { usage: { costUsd: 0, estimatedCostUsd: 0 } }),
    turn("b", "a", { usage: { costUsd: 2, reportedCostUsd: 2 } }),
    turn("c", "a", { usage: { costUsd: 1 } }),
    turn("d", "a", { usage: {} }),
    turn("e", "a", { usage: { costUsd: 0.5, estimatedCostUsd: 0.5, costPartial: true } }),
  ], () => []);
  for (const row of [stats.totals, stats.providers[0], stats.models[0], stats.heavy[0]]) {
    assert.equal(row.costUsd, 3.5);
    assert.equal(row.estimatedCostUsd, 0.5);
    assert.equal(row.reportedCostUsd, 2);
    assert.equal(row.pricedTurns, 4);
    assert.equal(row.unpricedTurns, 1);
    assert.equal(row.costPartial, true);
  }
});
