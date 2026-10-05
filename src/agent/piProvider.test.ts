import assert from "node:assert/strict";
import test from "node:test";
import { builtinTools, isReadOnlyCommand, sourceProviderId, splitPiModel } from "./providers/pi.js";
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
