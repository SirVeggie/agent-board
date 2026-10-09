import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const board = fs.readFileSync(new URL("../../templates/builtin/kanban.html", import.meta.url), "utf8");
const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

// Execute the shipped board's launch helpers and the chat's settings resolver together.
function fn(source: string, name: string): string {
  const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  }`, "m"));
  assert.ok(match, name);
  return match[0];
}

function harness(available = ["cursor", "codex", "claude", "pi"]) {
  const context = vm.createContext({
    agentOptions: {
      providers: available.map((id) => ({ id, available: true })),
      // Deliberately disagree with the worker's fixed defaults.
      defaults: { provider: "claude", model: "last-model", approval: "full", web: "on", fast: true },
    },
    FOLDER_MODES: new Set(["code", "plan"]),
    PAGE_MODES: new Set(["board", "ask", "code", "plan"]),
    APPROVALS: ["ask", "edits", "auto", "full"].map((id) => ({ id })),
    prefs: () => ({ provider: "claude", models: { claude: "last-model" }, web: "on" }),
    approvalFor: () => "full",
    modelChoice: () => ({ effort: "high", modelParams: { fast: "true", context: "last-context" } }),
    providerAvailable: (id: string) => available.includes(id),
    modelsOf: () => [],
    modelInfo: () => null,
    S: { config: { providers: available.map((id) => ({ id, available: true })) } },
    workerName: (w: { name?: string }) => w.name || "Sol",
    str: (value: unknown) => value == null ? "" : String(value),
    // workerOpts uses the board's object lookup, pageThreadSettings uses a Set.
    BOARD_FOLDER_MODES: { code: true, plan: true },
  });
  vm.runInContext([
    fn(board, "workerDefaults"),
    'function workerMode(w) { return str(w.mode) || "code"; }',
    fn(board, "workerOpts").replaceAll("FOLDER_MODES[mode]", "BOARD_FOLDER_MODES[mode]"),
    fn(chat, "webMode"),
    fn(chat, "pageThreadSettings"),
    'function launch(w) { return pageThreadSettings(workerOpts(w, { num: 295, title: "Defaults" })); }',
  ].join("\n"), context);
  return (code: string) => JSON.parse(JSON.stringify(vm.runInContext(code, context)));
}

test("worker defaults ignore last-used chat choices through thread creation", () => {
  const run = harness();
  for (const provider of ["cursor", "codex", "claude", "pi"]) {
    const settings = run(`launch({ provider: '${provider}', cwd: 'C:/project' })`);
    assert.equal(settings.provider, provider);
    assert.equal(settings.model, provider === "cursor" ? "composer-2.5" : "default");
    assert.equal(settings.approval, "auto");
    assert.equal(settings.web, "off");
    assert.equal(settings.effort, null);
    assert.deepEqual(settings.modelParams, { fast: "false" });
  }
  assert.equal(run("launch({ cwd: 'C:/project' })").provider, "cursor");
});

test("displayed defaults and launched approval agree for a different provider", () => {
  const run = harness();
  const defaults = run("workerDefaults(agentOptions, 'codex')");
  const launch = run("launch({ provider: 'codex', cwd: 'C:/project' })");
  assert.equal(defaults.approval, launch.approval);
  assert.equal(defaults.web, launch.web);
  assert.equal(defaults.model, launch.model);
});

test("explicit worker settings still win", () => {
  const run = harness();
  const launch = run("launch({ provider: 'codex', model: 'picked', effort: 'low', approval: 'full', web: 'limited', fast: 'true', cwd: 'C:/project', worktree: true })");
  assert.equal(launch.model, "picked");
  assert.equal(launch.effort, "low");
  assert.equal(launch.approval, "full");
  assert.equal(launch.web, "limited");
  assert.deepEqual(launch.modelParams, { fast: "true" });
  assert.equal(launch.useWorktree, true);
  assert.deepEqual(run("launch({ provider: 'claude', fast: 'flex', cwd: 'C:/project' })").modelParams, { fast: "flex" });
});

test("provider fallback is stable and page-only workers also receive fixed defaults", () => {
  const run = harness(["pi", "codex", "claude"]);
  const settings = run("launch({ mode: 'board' })");
  assert.equal(settings.provider, "codex");
  assert.equal(settings.approval, "auto");
  assert.equal(settings.web, "off");
  assert.equal(settings.cwd, null);
});
