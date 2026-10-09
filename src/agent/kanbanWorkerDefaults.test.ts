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

// Exercise the actual readiness and prompt helpers against changing board settings.
test("shared instructions enable workers and precede their own instructions in every launch", () => {
  const context = vm.createContext({
    shared: {},
    settings: () => vm.runInContext("shared", context),
    str: (value: unknown) => value == null ? "" : String(value),
    workerName: (w: { name?: string }) => w.name || "",
    FOLDER_MODES: { code: true, plan: true },
    workerMode: (w: { mode?: string }) => w.mode || "code",
    boardTitle: () => "Board",
    scribe: { id: "test-board" },
    cardBrief: () => "Your card: #303 Shared instructions",
  });
  vm.runInContext([fn(board, "workerInstructions"), fn(board, "workerReady"), fn(board, "workerPrompt")].join("\n"), context);
  const run = (code: string) => vm.runInContext(code, context);
  run("w = { name: 'Sol', cwd: 'C:/project', context: 'fresh' }; c = { num: 303, title: 'Shared instructions' }");
  assert.equal(run("workerReady(w)"), false);
  run("shared.workerInstructions = '  Shared rule.  '");
  assert.equal(run("workerReady(w)"), true);
  assert.equal(run("workerReady({ name: 'Sol' })"), false); // Code still needs a folder.
  assert.equal(run("workerReady({ name: 'Sol', mode: 'board' })"), true);
  assert.equal(run("workerReady({ mode: 'board' })"), false); // All workers need a name.
  assert.match(run("workerPrompt(w, c)"), /The user's instructions:\nShared rule\.\n\nYour card/);
  run("w.instructions = '  Worker rule.  '");
  for (const solo of [false, true]) {
    assert.match(run(`workerPrompt(w, c, '', ${solo})`), /Shared rule\.\n\nWorker rule\./);
  }
  run("shared.workerInstructions = 'Changed shared rule.'");
  assert.match(run("workerPrompt(w, c)"), /Changed shared rule\.\n\nWorker rule\./);
  run("delete shared.workerInstructions");
  assert.equal(run("workerReady(w)"), true); // Legacy worker-only setups still run.
  assert.equal(run("workerInstructions(w)"), "Worker rule.");
  run("w.instructions = '  '; shared.workerInstructions = '  '");
  assert.equal(run("workerReady(w)"), false);
  assert.match(run("workerPrompt(w, c, 'Preview placeholder')"), /The user's instructions:\nPreview placeholder/);
});

test("template agent actions ignore last-used chat model through thread creation", () => {
  const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
  const context = vm.createContext({
    S: { config: { providers: ["cursor", "codex", "claude", "pi"].map((id) => ({ id, available: true })) } },
    prefs: () => ({ provider: "claude", models: { claude: "opus-expensive" }, web: "on" }),
    providerAvailable: (id: string) => true,
    modelsOf: () => [{ id: "opus-expensive" }, { id: "default" }],
    modelInfo: () => ({ efforts: [{ id: "high" }] }),
    modelChoice: () => ({ effort: "high", modelParams: { fast: "true" } }),
    approvalFor: () => "full",
    webMode: (w?: string, fallback?: string) => w || fallback || "off",
    PAGE_MODES: new Set(["board", "ask", "code", "plan"]),
    FOLDER_MODES: new Set(["code", "plan"]),
    APPROVALS: ["ask", "edits", "auto", "full"].map((id) => ({ id })),
  });
  const providerPref = chat.match(/^  const AGENT_ACTION_PROVIDER_PREF = .*;/m);
  const agentActionFn = chat.match(/^  function agentActionThreadInput\([^]*?^  }/m);
  const pageThreadFn = chat.match(/^  function pageThreadSettings\([^]*?^  }/m);
  assert.ok(providerPref && agentActionFn && pageThreadFn);
  vm.runInContext([providerPref[0], agentActionFn[0], pageThreadFn[0], 'function launch(thread) { return pageThreadSettings(agentActionThreadInput(thread)); }'].join("\n"), context);
  const run = (code: string) => vm.runInContext(code, context);
  const triage = run('launch({ title: "Triage: Board" })');
  assert.equal(triage.provider, "cursor");
  assert.equal(triage.model, "composer-2.5");
  assert.equal(triage.approval, "auto");
  assert.equal(triage.web, "off");
  assert.equal(triage.modelParams?.fast, "false");
  assert.equal(triage.effort, null);
  const explicit = run('launch({ provider: "claude", model: "picked" })');
  assert.equal(explicit.provider, "claude");
  assert.equal(explicit.model, "picked");
});
