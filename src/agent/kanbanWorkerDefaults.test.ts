import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const board = fs.readFileSync(new URL("../../templates/builtin/kanban.html", import.meta.url), "utf8");
const chat = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");

test("page usage snapshots and board preserve Codex reports past reset", () => {
  const now = Date.now();
  const limits = {
    codex: { windows: [{ label: "5 hours", utilization: 1, resetsAt: now - 1000 }], ordinaryUsageAllowed: false },
    claude: { windows: [{ label: "5 hours", utilization: 0.8, resetsAt: now - 1000 }] },
  };
  const context = vm.createContext({
    S: { config: { limits } },
    clamp: (v: number, min: number, max: number) => Math.min(max, Math.max(min, v)),
  });
  vm.runInContext([fn(chat, "liveWindows"), fn(chat, "planLimits"), fn(chat, "pageLimits"), fn(board, "workerQuotaWindow")].join("\n"), context);
  const snapshot = vm.runInContext("pageLimits()", context);
  assert.equal(snapshot.codex.windows[0].utilization, 1);
  assert.equal(snapshot.codex.ordinaryUsageAllowed, false);
  assert.equal(snapshot.claude.windows[0].utilization, 0);
  assert.equal(vm.runInContext("workerQuotaWindow('codex', pageLimits().codex.windows[0]).percent", context), 100);
  assert.match(vm.runInContext("workerQuotaWindow('codex', pageLimits().codex.windows[0]).reset", context), /awaiting update/);
  assert.equal(vm.runInContext("workerQuotaWindow('claude', pageLimits().claude.windows[0]).percent", context), 0);
});

test("usage changes reach subscribed pages and forget closed pages", () => {
  const watch = new Set(["open", "closed"]);
  const events: Array<{ id: string; message: any }> = [];
  const context = vm.createContext({
    pageLimitWatch: watch,
    pageLimits: () => ({ codex: { windows: [{ utilization: 0.5 }] } }),
    app: () => ({ tabs: () => [{ id: "open" }], postToPage: (id: string, message: any) => events.push({ id, message }) }),
  });
  vm.runInContext(fn(chat, "pageLimitsChanged") + "\npageLimitsChanged();", context);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "open");
  assert.equal(events[0].message.type, "scribe-agent-limits");
  assert.equal(events[0].message.limits.codex.windows[0].utilization, 0.5);
  assert.deepEqual([...watch], ["open"]);
});

// Execute the shipped board's launch helpers and the chat's settings resolver together.
function fn(source: string, name: string): string {
  const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  }`, "m"));
  assert.ok(match, name);
  return match[0];
}

test("Continue starts the newly assigned worker, but resumes for the same worker", async () => {
  for (const assignee of ["New", "Old"]) {
    const calls: any[] = [];
    let click: () => void = () => {};
    const c = { id: "card", num: 525, title: "Follow up", col: "review", thread: "earlier", assignee, threadAssignee: "Old" };
    const workers: any = { old: { name: "Old" }, next: { name: "New" } };
    const context = vm.createContext({
      card: () => c,
      worker: (id: string) => workers[id],
      workerIds: () => Object.keys(workers),
      workerIdFor: (name: string) => Object.keys(workers).find(id => workers[id].name === name),
      workerName: (w: any) => w.name,
      workerReady: () => true,
      hasWorkerApi: () => true,
      canRunSolo: () => false, // Review/done cards still allow a comment continuation.
      settings: () => ({}), arr: (v: any) => v || [],
      str: (v: any) => v == null ? "" : String(v),
      soloStarting: {}, threadStatus: {},
      loadAgentOptions: () => Promise.resolve(),
      workerPrompt: (w: any, card: any, fallback: any, solo: boolean) => `${w.name}: ${card.title}, solo=${solo}`,
      workerOpts: (w: any) => ({ model: w.name }),
      workerRun: (id: string) => ({ data: { worker: id } }),
      scribe: { agent: {
        start: async (prompt: string, opts: any) => { calls.push(["start", prompt, opts]); return { ok: true, threadId: "fresh" }; },
        card: async (thread: string) => { calls.push(["resume", thread]); return { ok: true, delivered: "queued" }; },
      } },
      claimForAgent: (card: any, thread: string, name: string) => calls.push(["claim", thread, name]),
      addSolo: (id: string, thread: string) => calls.push(["solo", id, thread]),
      mergeWhenDone: () => calls.push(["merge"]),
      setComment: (id: string, cm: string, fields: any) => calls.push(["comment", fields.followUp]),
      plainLinks: (v: string) => v,
      render: () => {}, setHint: () => {}, appendLog: () => {},
      el: (tag: string, cls: string, text: string) => ({
        dataset: {}, appendChild: () => {},
        addEventListener: (event: string, cb: any) => { if (text === "Continue") click = () => cb({ stopPropagation() {} }); },
      }),
    });
    vm.runInContext(["soloRuns", "changedCommentWorker", "runSolo", "followUpButtons"].map(name => fn(board, name)).join("\n"), context);
    vm.runInContext("followUpButtons(card(), { id: 'comment' })", context);
    click();
    await new Promise(resolve => setImmediate(resolve));
    if (assignee === "New") {
      assert.equal(calls[0][0], "start");
      assert.match(calls[0][1], /New: Follow up, solo=true/);
      assert.equal(calls[0][2].model, "New");
      assert.equal(calls[0][2].run.data.worker, "next");
      assert.ok(calls.some(call => call.join() === "claim,fresh,New"));
      assert.ok(calls.some(call => call.join() === "solo,next,fresh"));
      assert.ok(!calls.some(call => call[0] === "resume"));
    } else {
      assert.deepEqual(calls[0], ["resume", "earlier"]);
      assert.ok(!calls.some(call => call[0] === "start"));
    }
    assert.ok(calls.some(call => call.join() === "comment,continued"));
  }
});

test("Ask uses the default worker and only updates the question comment, including on launch failure", async () => {
  for (const fail of [false, true]) {
    const c = { id: "card", num: 645, title: "Question", assignee: "Person", col: "review", thread: "old", status: { kind: "info", text: "Waiting" } };
    const before = JSON.stringify(c);
    const calls: any[] = [];
    const w = { name: "Default", provider: "codex", model: "chosen-model", mode: "code", cwd: "C:/project", worktree: true };
    const context = vm.createContext({
      card: () => c, settings: () => ({ defaultWorker: "default" }), worker: (id: string) => id === "default" ? w : null,
      hasWorkerApi: () => true, workerMode: (w: any) => w.mode, workerName: (w: any) => w.name,
      FOLDER_MODES: { code: true, plan: true }, str: (v: any) => v == null ? "" : String(v),
      loadAgentOptions: async () => {}, workerOpts: (w: any) => ({ ...w }),
      boardTitle: () => "Board", workerInstructions: () => "Follow shared instructions", cardBrief: () => "Card context",
      askingComments: {}, threadStatus: {}, renderLater: () => {}, setHint: () => {},
      setComment: (card: string, cm: string, fields: any) => calls.push(["comment", fields.followUp]),
      scribe: { id: "board", agent: { start: async (prompt: string, opts: any) => {
        calls.push(["start", prompt, opts]); return fail ? { ok: false, error: "denied" } : { ok: true, threadId: "ask-chat" };
      } } }, launchError: () => "Denied",
    });
    vm.runInContext(["defaultAskWorker", "askPrompt", "askComment"].map(name => fn(board, name)).join("\n"), context);
    assert.equal(await vm.runInContext("askComment('card', 'comment', 'Why does this happen?')", context), !fail);
    assert.equal(JSON.stringify(c), before);
    const [, prompt, opts] = calls[0];
    assert.match(prompt, /Why does this happen\?/);
    assert.match(prompt, /NOT been claimed/);
    assert.match(prompt, /peek:scribe:page-key/);
    assert.equal(opts.model, "chosen-model");
    assert.equal(opts.provider, "codex");
    assert.equal(opts.cwd, "C:/project");
    assert.equal(opts.worktree, false);
    assert.equal(opts.run.merge, false);
    assert.equal(w.worktree, true);
    assert.equal(opts.run.data.ask, true);
    assert.equal(opts.run.data.solo, undefined);
    assert.equal(calls[1][1], fail ? "askOffer" : "asked");
    assert.equal(vm.runInContext("Object.keys(askingComments).length", context), 0);
  }
});

test("comments on a person's card offer Ask only with a default worker, never send to its old chat", () => {
  for (const hasDefault of [false, true]) {
    const calls: any[] = [];
    const context = vm.createContext({
      hasCardApi: () => true, workerIdFor: () => null, defaultAskWorker: () => hasDefault ? "default" : null,
      setComment: (...args: any[]) => calls.push(args),
      scribe: { agent: { card: () => { throw new Error("Must not resume the old chat"); } } },
    });
    vm.runInContext(fn(board, "handOffComment"), context);
    vm.runInContext("handOffComment({ id: 'card', num: 645, thread: 'old', assignee: 'Person' }, 'comment', 'Question')", context);
    assert.equal(calls.length, hasDefault ? 1 : 0);
    if (hasDefault) assert.equal(calls[0][2].followUp, "offer");
  }
});

test("older cards resolve their earlier worker from retained bookkeeping and logs", () => {
  const context = vm.createContext({
    workerIds: () => ["old", "next"],
    worker: (id: string) => id === "old" ? { threadId: "last" } : {},
    settings: () => ({ workerLog: [{ thread: "finished", workerId: "old" }] }),
    arr: (v: any) => v || [],
  });
  vm.runInContext(fn(board, "soloRuns") + "\n" + fn(board, "changedCommentWorker"), context);
  for (const thread of ["last", "finished"]) {
    assert.equal(vm.runInContext(`changedCommentWorker({thread: '${thread}'}, 'next')`, context), true);
    assert.equal(vm.runInContext(`changedCommentWorker({thread: '${thread}'}, 'old')`, context), false);
  }
});

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

test("workers allow helpers by default and retain an explicit off choice", () => {
  const run = harness();
  for (const mode of ["code", "board"]) {
    const worker = { mode, cwd: "C:/project" };
    assert.equal(run(`launch(${JSON.stringify(worker)})`).helpersAllowed, true);
    assert.equal(run(`launch(${JSON.stringify({ ...worker, helpers: true })})`).helpersAllowed, true);
    assert.equal(run(`launch(${JSON.stringify({ ...worker, helpers: false })})`).helpersAllowed, undefined);
  }
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
