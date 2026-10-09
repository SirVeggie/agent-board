import assert from "node:assert/strict";
import test from "node:test";
import { FALLBACK_MODELS, loginEnv, loginUrlFromOutput, mapCodexModels, mapUsage, mcpConfig, sandboxFor, threadOptions } from "./providers/codex.js";
import type { Thread } from "./types.js";

const thread = (over: Partial<Thread> = {}): Pick<Thread, "model" | "effort" | "mode" | "approval" | "web"> => ({
  model: "gpt-5-codex",
  effort: "medium",
  mode: "code",
  approval: "ask",
  web: "on",
  ...over,
});

test("sandboxFor: Ask, Plan and Pages are read-only; Full access drops the sandbox", () => {
  assert.equal(sandboxFor(thread({ mode: "ask" })), "read-only");
  assert.equal(sandboxFor(thread({ mode: "plan" })), "read-only");
  assert.equal(sandboxFor(thread({ mode: "board" })), "read-only");
  assert.equal(sandboxFor(thread({ mode: "code", approval: "ask" })), "workspace-write");
  assert.equal(sandboxFor(thread({ mode: "code", approval: "edits" })), "workspace-write");
  assert.equal(sandboxFor(thread({ mode: "code", approval: "auto" })), "workspace-write");
  assert.equal(sandboxFor(thread({ mode: "code", approval: "full" })), "danger-full-access");
});

test("threadOptions maps model, effort, sandbox, web search and never-ask", () => {
  const code = threadOptions(thread(), "/work");
  assert.equal(code.model, "gpt-5-codex");
  assert.equal(code.sandboxMode, "workspace-write");
  assert.equal(code.workingDirectory, "/work");
  assert.equal(code.skipGitRepoCheck, true);
  assert.equal(code.modelReasoningEffort, "medium");
  assert.equal(code.approvalPolicy, "never");
  assert.equal(code.webSearchEnabled, true);
  assert.equal(code.networkAccessEnabled, true);

  const pages = threadOptions(thread({ model: "default", effort: null, mode: "board", web: "off" }), "/scratch");
  assert.equal(pages.model, undefined);
  assert.equal(pages.sandboxMode, "read-only");
  assert.equal(pages.webSearchEnabled, false);
  assert.equal(pages.networkAccessEnabled, false);
  assert.equal(pages.modelReasoningEffort, undefined);
});

test("mcpConfig registers the board server as scribe with the thread id", () => {
  const config = mcpConfig({ boardMcp: { command: "node", args: ["dist/index.js"], env: { SCRIBE_PORT: "4747" } } }, "th_abc", true);
  const server = (config.mcp_servers as { scribe: { command: string; args: string[]; env: Record<string, string> } }).scribe;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["dist/index.js"]);
  assert.equal(server.env.SCRIBE_PORT, "4747");
  assert.equal(server.env.SCRIBE_THREAD, "th_abc");
  assert.equal(server.env.SCRIBE_PAGES, undefined);

  const none = mcpConfig({ boardMcp: { command: "node", args: [], env: {} } }, "th_none", false);
  const env = (none.mcp_servers as { scribe: { env: Record<string, string> } }).scribe.env;
  assert.equal(env.SCRIBE_PAGES, "off");
  assert.equal(env.SCRIBE_THREAD, "th_none");
});

test("mapUsage copies Codex exec token fields", () => {
  assert.deepEqual(
    mapUsage({
      input_tokens: 10,
      cached_input_tokens: 3,
      cache_write_input_tokens: 2,
      output_tokens: 4,
      reasoning_output_tokens: 5,
    }),
    { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 5 }
  );
});

test("fallback models include Default (omit --model) and Codex ids", () => {
  assert.equal(FALLBACK_MODELS[0]?.id, "default");
  assert.ok(FALLBACK_MODELS.some((m) => m.id === "gpt-5-codex"));
  assert.ok(FALLBACK_MODELS.every((m) => m.provider === "codex" && m.efforts.length));
});

test("mapCodexModels keeps the live Plus catalog and drops hidden rows", () => {
  const models = mapCodexModels([
    {
      id: "gpt-reserve",
      model: "gpt-reserve",
      displayName: "GPT-Reserve",
      hidden: true,
      supportedReasoningEfforts: ["low", "medium"],
    },
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      hidden: false,
      isDefault: false,
      description: "Older Sol",
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "low",
    },
    {
      id: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
    },
    { id: "down", model: "down", hidden: false, isCurrentlyUnavailable: true },
  ]);
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-6.1-sol", "gpt-5.6-sol"]
  );
  assert.equal(models[0]?.label, "GPT-6.1-Sol");
  assert.equal(models[0]?.defaultEffort, "low");
  assert.ok(models[0]?.efforts.some((e) => e.id === "ultra" && e.label === "Ultra"));
  assert.equal(models[1]?.description, "Older Sol");
});

test("threadOptions passes a live catalog id such as gpt-6.1-sol", () => {
  const opts = threadOptions(thread({ model: "gpt-6.1-sol", effort: "ultra" }), "/work");
  assert.equal(opts.model, "gpt-6.1-sol");
  assert.equal(opts.modelReasoningEffort, "ultra");
});

test("loginUrlFromOutput picks the ChatGPT HTTPS URL and skips localhost", () => {
  assert.equal(
    loginUrlFromOutput("Starting login server on http://127.0.0.1:1455\nOpening https://auth.openai.com/oauth/authorize?client_id=abc\n"),
    "https://auth.openai.com/oauth/authorize?client_id=abc"
  );
  assert.equal(loginUrlFromOutput("If the browser did not open, visit:\nhttps://chatgpt.com/auth/login?foo=bar.\n"), "https://chatgpt.com/auth/login?foo=bar");
  assert.equal(loginUrlFromOutput("\x1b[32mhttps://auth.openai.com/start\x1b[0m"), "https://auth.openai.com/start");
  assert.equal(loginUrlFromOutput("only http://localhost:1455/callback"), null);
  assert.equal(loginUrlFromOutput("no urls here"), null);
});

test("loginEnv drops CODEX_HOME so ChatGPT auth lands in ~/.codex", () => {
  const env = loginEnv({ PATH: "/bin", CODEX_HOME: "/tmp/scribe" });
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.PATH, "/bin");
});
