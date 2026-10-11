import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiProvider, builtinTools, isReadOnlyCommand, sourceModelCost, sourceProviderId, splitPiModel } from "./providers/pi.js";
import { migrateOpenaiPrefs, migrateOpenaiThread } from "./legacyOpenai.js";
import type { Prefs } from "./prefs.js";
import type { Thread } from "./types.js";

test("openai threads and prefs move to Pi", () => {
  const thread = { provider: "openai", model: "lmstudio/qwen/qwen3-8b", nativeId: "resp_1" } as unknown as Thread;
  assert.equal(migrateOpenaiThread(thread), true);
  assert.equal(thread.provider, "pi");
  assert.equal(thread.model, "src-lmstudio/qwen/qwen3-8b");
  assert.equal(thread.nativeId, null);
  assert.equal(migrateOpenaiThread({ provider: "claude", model: "a/b", nativeId: "x" } as unknown as Thread), false);
  const saved = {
    provider: "openai",
    models: { openai: "or/gpt-5", claude: "default" },
    summarizer: { provider: "openai", model: "or/mini" },
    favoriteModels: ["openai:or/gpt-5", "claude:opus"],
  } as unknown as Partial<Prefs>;
  assert.deepEqual(migrateOpenaiPrefs(saved), {
    provider: "pi",
    models: { claude: "default", pi: "src-or/gpt-5" },
    summarizer: { provider: "pi", model: "src-or/mini" },
    favoriteModels: ["pi:src-or/gpt-5", "claude:opus"],
  });
  assert.deepEqual(migrateOpenaiPrefs({ provider: "claude" }), { provider: "claude" });
});

test("isReadOnlyCommand lets reads, git queries and tests through", () => {
  for (const cmd of ["ls -la", "git status", "git log --oneline -5", "git diff HEAD~1", "cat a.txt | grep foo", "npm test", "npx tsc --noEmit", "git branch", "git branch -a", "sed -n 1,20p x.ts", "find src -name '*.ts'", "git remote -v"]) {
    assert.equal(isReadOnlyCommand(cmd), true, cmd);
  }
});

test("isReadOnlyCommand refuses writes, chains with writes, redirection and substitution", () => {
  for (const cmd of ["rm -rf x", "git push", "git commit -m x", "ls && rm x", "echo hi > a.txt", "cat $(which node)", "echo `id`", "sed -i s/a/b/ x", "find . -delete", "find . -exec rm {} ;", "git branch -D old", "git remote add x y", "npm install", "", "lsof"]) {
    assert.equal(isReadOnlyCommand(cmd), false, cmd);
  }
});

test("splitPiModel splits at the first slash; model ids keep theirs", () => {
  assert.deepEqual(splitPiModel("openrouter/anthropic/claude-sonnet-5"), { provider: "openrouter", model: "anthropic/claude-sonnet-5" });
  assert.deepEqual(splitPiModel(`${sourceProviderId("lmstudio")}/qwen3-coder`), { provider: "src-lmstudio", model: "qwen3-coder" });
  assert.equal(splitPiModel("default"), null);
  assert.equal(splitPiModel("x/"), null);
});

test("builtinTools: Pages none, Ask and Plan read-only, Code all", () => {
  assert.deepEqual(builtinTools("board"), []);
  assert.ok(!builtinTools("ask").includes("bash"));
  assert.ok(!builtinTools("plan").includes("edit"));
  assert.ok(builtinTools("code").includes("bash") && builtinTools("code").includes("write"));
});

test("DeepSeek source registration prices cached and uncached usage from the SDK catalog", async (t) => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-pi-cost-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, modelsStorePath: path.join(dir, "catalog.json"), refreshOnCreate: false });
  const source = { id: "ds", name: "My API", baseUrl: "https://api.deepseek.com/v1", apiKey: "test-key", models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "unknown"] };
  const provider = new PiProvider(() => [source]);
  provider.runtime = async () => runtime;
  t.after(() => provider.dispose());
  // Avoid availability checks for unrelated built-in credentials on the test machine.
  runtime.getAvailable = async () => runtime.getModels("src-ds").slice();
  const model = await provider.resolveModel("src-ds/deepseek-flash");
  assert.ok(model);
  const catalog = runtime.getModels("deepseek");
  const flash = catalog.find((m) => m.id === "deepseek-flash")!;
  assert.ok(flash.cost.input > 0);
  assert.deepEqual(model.cost, flash.cost);
  assert.deepEqual(runtime.getModel("src-ds", "deepseek-v4-pro")?.cost, catalog.find((m) => m.id === "deepseek-v4-pro")?.cost);
  assert.deepEqual(runtime.getModel("src-ds", "deepseek-v4-flash")?.cost, flash.cost);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(runtime.getModel("src-ds", "unknown")?.cost, zero);
  for (const baseUrl of ["http://localhost:1234/v1", "https://proxy.example/v1", "https://api.deepseek.com.evil.test/v1", "https://api.deepseek.com/anthropic"]) {
    assert.deepEqual(sourceModelCost({ ...source, baseUrl }, "deepseek-flash", catalog), zero);
  }
  assert.deepEqual(sourceModelCost({ ...source, baseUrl: "https://api.deepseek.com" }, "deepseek-flash", catalog), flash.cost);
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.equal(String(url), "https://api.deepseek.com/v1/chat/completions");
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens: 50 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const reply = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.equal(reply.usage.input, 100);
  assert.equal(reply.usage.cacheRead, 900);
  assert.equal(reply.usage.output, 50);
  const expected = (100 * flash.cost.input + 900 * flash.cost.cacheRead + 50 * flash.cost.output) / 1_000_000;
  assert.ok(Math.abs(reply.usage.cost.total - expected) < 1e-12);
});
