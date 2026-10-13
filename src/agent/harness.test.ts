import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverSkills, harnessStats, instructionSections, mcpCall, promptTokens, skillFrontmatter } from "./harness.js";
import type { Item, Thread, Turn } from "./types.js";
import { launchChromium } from "../chromium.js";

test("harness lists older workspaces and refreshes them without losing the selection", async (t) => {
  let browser;
  try { browser = await launchChromium({ headless: true, args: [], purpose: "Harness workspace picker test" }); }
  catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const recent = Array.from({ length: 12 }, (_, i) => `C:/recent/${i}`);
    const threads = [
      { cwd: "C:/trunk", scope: { kind: "global" } },
      { cwd: "c:\\TRUNK\\", scope: { kind: "global" } },
      { cwd: "C:/worktrees/task", worktree: { home: "C:/checkout" } },
      { scope: { kind: "workspace", ref: "C:/scope" } },
    ];
    const skillRequests: Array<string | null> = [];
    await page.route("http://workspace.test/**", async (route) => {
      const url = new URL(route.request().url());
      let data: any = {};
      if (url.pathname.endsWith("/config")) data = { prefs: { recentWorkspaces: recent, scopeWorkspaces: { "page:one": "C:/default" } } };
      else if (url.pathname.endsWith("/threads")) data = { threads };
      else if (url.pathname.endsWith("/context")) data = { thread: route.request().postDataJSON() };
      else if (url.pathname.endsWith("/skills")) {
        skillRequests.push(url.searchParams.get("cwd"));
        data = { skills: [], folders: [] };
      } else if (url.pathname.endsWith("/stats")) data = { totals: {}, toolKinds: [], tools: [], skills: [] };
      else if (url.pathname.endsWith("/memories")) data = { memories: [] };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("http://workspace.test/");
    await page.addScriptTag({ content: fs.readFileSync(new URL("../../public/harness.js", import.meta.url), "utf8") });
    await page.evaluate(() => (window as any).scribeHarness.open("skills"));
    const picker = page.getByRole("combobox", { name: "Workspace", exact: true });
    await picker.locator('option[value="C:/trunk"]').waitFor({ state: "attached" });
    assert.deepEqual(await picker.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)),
      ["", ...recent, "C:/default", "C:/trunk", "C:/checkout", "C:/scope"]);
    await picker.selectOption("C:/trunk");
    await page.waitForFunction(() => !document.querySelector(".agent-harness.loading"));
    assert.equal(skillRequests.at(-1), "C:/trunk");
    threads.push({ cwd: "C:/added", scope: { kind: "global" } });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await picker.locator('option[value="C:/added"]').waitFor({ state: "attached" });
    assert.equal(await picker.inputValue(), "C:/trunk");
    assert.equal(skillRequests.at(-1), "C:/trunk");
  } finally { await browser.close(); }
});

test("harness keeps content while filters load and ignores superseded responses", async (t) => {
  let browser;
  try { browser = await launchChromium({ headless: true, args: [], purpose: "Harness filter test" }); }
  catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const pending = new Map<string, () => Promise<void>>();
    const waitForRequest = async (key: string) => {
      const deadline = Date.now() + 5000;
      while (!pending.has(key) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(pending.has(key), `request ${key} arrived`);
    };
    let hold = false;
    await page.route("http://harness.test/**", async (route) => {
      const url = new URL(route.request().url());
      const endpoint = url.pathname;
      let data: any = {};
      let key = "";
      if (endpoint.endsWith("/stats")) {
        key = url.searchParams.get("days") || "all";
        data = { totals: { toolCalls: 1 }, toolKinds: [], tools: [{ name: `tool-${key}`, provider: "claude", calls: 1 }], skills: [] };
      } else if (endpoint.endsWith("/context")) {
        data = { thread: route.request().postDataJSON() };
        key = data.thread.provider;
      } else if (endpoint.endsWith("/skills")) {
        data = { skills: [{ name: "Kept skill", providers: ["claude"], scope: "user", indexTokens: 1, bodyTokens: 1, files: 0 }], folders: [] };
      } else if (endpoint.endsWith("/memories")) data = { memories: [] };
      const fulfill = () => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      if (hold && key) pending.set(key, fulfill);
      else await fulfill();
    });
    await page.goto("http://harness.test/");
    await page.addScriptTag({ content: fs.readFileSync(new URL("../../public/harness.js", import.meta.url), "utf8") });
    await page.evaluate(() => (window as any).scribeHarness.open("tools"));
    await page.getByText("tool-30", { exact: true }).waitFor();
    hold = true;
    await page.getByRole("button", { name: "7 days", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Range"] [aria-pressed="true"]')?.textContent === "7 days");
    assert.equal(await page.getByText("tool-30", { exact: true }).count(), 1);
    assert.equal(await page.locator(".hx-body").getByText("Loading…", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "90 days", exact: true }).click();
    await waitForRequest("7");
    await waitForRequest("90");
    await pending.get("90")!();
    await page.getByText("tool-90", { exact: true }).waitFor();
    await pending.get("7")!();
    await page.waitForFunction(() => !document.querySelector(".agent-harness.loading"));
    assert.equal(await page.getByText("tool-90", { exact: true }).count(), 1);

    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByText("Kept skill", { exact: true }).waitFor();
    await page.evaluate(() => { (window as any).keptCard = document.querySelector(".hx-body .hx-card"); });
    await page.getByRole("group", { name: "Provider", exact: true }).getByRole("button", { name: "Codex", exact: true }).click();
    assert.equal(await page.getByText("Kept skill", { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector(".hx-body .hx-card") === (window as any).keptCard), true);
    assert.equal(await page.locator(".hx-body .hx-card").first().evaluate(node => (node as HTMLElement).inert), true);
    await waitForRequest("codex");
    await pending.get("codex")!();
    await page.waitForFunction(() => !document.querySelector(".hx-body .hx-card[inert]"));
    assert.equal(await page.getByText("For Codex Code threads", { exact: true }).count(), 1);
  } finally { await browser.close(); }
});

const thread = (id: string, over: Partial<Thread> = {}): Thread =>
  ({ id, title: id, provider: "claude", model: "opus", mode: "code", scope: { kind: "global", ref: null }, ...over }) as Thread;

test("memory editor preserves Native source on edit and keeps the chosen scope for new memories", async (t) => {
  let browser;
  try { browser = await launchChromium({ headless: true, args: [], purpose: "Memory scope editor test" }); }
  catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const writes: any[] = [];
    const memories = [{ id: "private", text: "Local source rule", scope: "provider", provider: "pi", source: "src-local", by: "user", updatedAt: 1 }];
    await page.route("http://memory.test/**", async (route) => {
      const request = route.request();
      const endpoint = new URL(request.url()).pathname;
      let data: any = {};
      if (endpoint.includes("/memories")) {
        if (request.method() !== "GET") {
          const body = request.postDataJSON();
          writes.push(body);
          if (request.method() === "PUT") Object.assign(memories[0], body);
        }
        data = { memories, targets: [{ provider: "codex", label: "Codex" }, { provider: "pi", source: "src-local", label: "Native: Local" }] };
      } else if (endpoint.endsWith("/context")) data = { thread: request.postDataJSON() };
      else if (endpoint.endsWith("/stats")) data = { totals: {}, toolKinds: [], tools: [], skills: [] };
      else if (endpoint.endsWith("/skills")) data = { skills: [], folders: [] };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("http://memory.test/");
    await page.addScriptTag({ content: fs.readFileSync(new URL("../../public/harness.js", import.meta.url), "utf8") });
    await page.evaluate(() => (window as any).scribeHarness.open("memories"));
    await page.getByText("Local source rule", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = page.locator(".ag-perm-set .ag-mem-form");
    assert.equal(await edit.getByRole("combobox", { name: "Applies to" }).inputValue(), 'provider:["pi","src-local"]');
    await edit.getByRole("textbox", { name: "Memory", exact: true }).fill("Updated local rule");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Updated local rule", { exact: true }).waitFor();
    assert.deepEqual(writes[0], { text: "Updated local rule", scope: "provider", provider: "pi", source: "src-local" });
    const add = page.locator(".ag-mem-form");
    await add.getByRole("combobox", { name: "Applies to" }).selectOption({ label: "Codex only" });
    await add.getByRole("textbox", { name: "Memory", exact: true }).fill("Codex helper rule");
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".ag-mem-input")?.value === "");
    assert.deepEqual(writes[1], { text: "Codex helper rule", scope: "provider", provider: "codex" });
    assert.equal(await add.getByRole("combobox", { name: "Applies to" }).inputValue(), 'provider:["codex",""]');
  } finally { await browser.close(); }
});
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
