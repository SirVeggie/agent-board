import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { CodexRpc, type RpcMessage } from "./providers/codexRpc.js";
import { CodexSession, readCodexPlanUsage, syncAuthFiles } from "./providers/codex.js";
import type { RunSink, SessionContext } from "./providers/provider.js";
import { FALLBACK_MODELS, loginEnv, loginUrlFromOutput, mapCodexModels, mapUsage, mcpConfig, sandboxFor, threadOptions, turnStartOverrides } from "./providers/codex.js";
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

test("threadOptions maps app-server model, sandbox, web and interactive approvals", () => {
  const code = threadOptions(thread(), "/work");
  assert.equal(code.model, "gpt-5-codex");
  assert.equal(code.sandbox, "workspace-write");
  assert.equal(code.cwd, "/work");
  assert.equal((code.config as Record<string, unknown>).model_reasoning_effort, "medium");
  assert.equal(code.approvalPolicy, "on-request");
  assert.equal((code.config as Record<string, unknown>).web_search, "live");
  assert.equal((code.config as Record<string, unknown>)["sandbox_workspace_write.network_access"], true);

  const pages = threadOptions(thread({ model: "default", effort: null, mode: "board", web: "off" }), "/scratch");
  assert.equal(pages.model, undefined);
  assert.equal(pages.sandbox, "read-only");
  assert.equal((pages.config as Record<string, unknown>).web_search, "disabled");
  assert.equal((pages.config as Record<string, unknown>)["sandbox_workspace_write.network_access"], false);
  assert.equal((pages.config as Record<string, unknown>).model_reasoning_effort, undefined);
  assert.equal(threadOptions(thread({ approval: "full" }), "/work").approvalPolicy, "never");
  assert.equal((threadOptions(thread({ web: "limited" }), "/work").config as Record<string, unknown>).web_search, "disabled");
});

test("turnStartOverrides always send model and effort; Default is JSON null", () => {
  assert.deepEqual(turnStartOverrides(thread()), { model: "gpt-5-codex", effort: "medium" });
  assert.deepEqual(turnStartOverrides(thread({ model: "gpt-6.1-sol", effort: "ultra" })), { model: "gpt-6.1-sol", effort: "ultra" });
  assert.deepEqual(turnStartOverrides(thread({ model: "default", effort: null })), { model: null, effort: null });
  assert.deepEqual(turnStartOverrides(thread({ model: "", effort: "unknown" })), { model: null, effort: null });
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

test("Codex approval modes select the native reviewer without widening the mode sandbox", () => {
  for (const mode of ["code", "ask", "plan", "board"] as const) {
    for (const approval of ["ask", "edits", "auto", "full"] as const) {
      const opts = threadOptions(thread({ mode, approval }), "/work");
      assert.equal(opts.approvalsReviewer, approval === "auto" ? "auto_review" : "user");
      assert.equal(opts.approvalPolicy, approval === "full" ? "never" : "on-request");
      assert.equal(opts.sandbox, mode !== "code" ? "read-only" : approval === "full" ? "danger-full-access" : "workspace-write");
    }
  }
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
  assert.equal((opts.config as Record<string, unknown>).model_reasoning_effort, "ultra");
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

function rpcFixture(onMessage: (message: RpcMessage) => void, onClose: (error: Error) => void) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const sent: RpcMessage[] = [];
  child.stdin.on("data", (data: Buffer) => { sent.push(JSON.parse(data.toString())); });
  const rpc = new CodexRpc(child as unknown as ChildProcess, onMessage, onClose);
  return { rpc, child, sent, emit(message: unknown) { child.stdout.write(JSON.stringify(message) + "\n"); } };
}

test("Codex RPC separates server requests from responses with the same id and decodes split UTF-8", async () => {
  const incoming: RpcMessage[] = [];
  const f = rpcFixture((message) => incoming.push(message), () => {});
  const result = f.rpc.call("initialize");
  f.emit({ id: 1, method: "item/fileChange/requestApproval", params: {} });
  assert.equal(incoming.length, 1);
  f.rpc.reply(1, { decision: "decline" });
  f.emit({ id: 1, result: { ready: true } });
  assert.deepEqual(await result, { ready: true });
  const data = Buffer.from(JSON.stringify({ method: "warning", params: { text: "🙂" } }) + "\n");
  const split = data.indexOf(Buffer.from("🙂")) + 1;
  f.child.stdout.write(data.subarray(0, split));
  f.child.stdout.write(data.subarray(split));
  assert.equal(incoming[1].params?.text, "🙂");
  f.rpc.close();
});

test("Codex RPC rejects outstanding calls on process exit", async () => {
  let closed = "";
  const f = rpcFixture(() => {}, (error) => { closed = error.message; });
  const result = f.rpc.call("thread/start");
  f.child.emit("exit", 1);
  await assert.rejects(result, /exited/);
  assert.match(closed, /exited/);
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function sessionFixture(nativeId: string | null = null, approval: Thread["approval"] = "ask", limits?: SessionContext["limits"]) {
  let f: ReturnType<typeof rpcFixture>;
  const reviews: unknown[] = [];
  const session = new CodexSession({ ...thread({ approval }), id: "scribe-thread", nativeId, cwd: "/work", scope: {} } as Thread,
    { scratchDir: "/scratch", boardMcp: { command: "node", args: [], env: {} }, webAllowlist: () => [], limits } as SessionContext,
    () => {}, (message, close) => { f = rpcFixture(message, close); return f.rpc; }, () => {}, (_message, extra) => { reviews.push(extra); });
  const seen = { text: "", steered: [] as string[], approvals: [] as string[], plans: [] as string[], output: "", tools: [] as string[], reviews, notices: [] as Array<{ level: string; text: string }> };
  const sink: RunSink = {
    nativeId() {}, text(delta) { seen.text += delta; }, reasoning() {}, breakBlock() {}, toolStart(tool) { seen.tools.push(tool.toolId); },
    toolUpdate(_id, patch) { if (patch.output !== undefined) seen.output = patch.output; }, beforeWrite: async () => {},
    approval: async (req) => { seen.approvals.push(req.tool); return { optionId: "decline" }; },
    question: async () => ({ answers: { q: ["Yes"] } }), plan: async (req) => { seen.plans.push(req.text); return { accepted: false }; },
    todos() {}, usage() {}, notice(level, text) { seen.notices.push({ level, text }); }, commands() {}, title() {}, steered(id) { seen.steered.push(id); },
  };
  async function start() {
    const run = session.run({ text: "hello", images: [], documents: [], instructions: "Scribe instructions" }, sink);
    await tick();
    const init = f!.sent.find((message) => message.method === "initialize")!;
    f!.emit({ id: init.id, result: {} });
    await tick();
    assert.ok(f!.sent.some((message) => message.method === "initialized"));
    const start = f!.sent.find((message) => message.method === (nativeId ? "thread/resume" : "thread/start"))!;
    assert.equal(start.params?.approvalPolicy, approval === "full" ? "never" : "on-request");
    assert.equal(start.params?.approvalsReviewer, approval === "auto" ? "auto_review" : "user");
    assert.equal(start.params?.sandbox, approval === "full" ? "danger-full-access" : "workspace-write");
    f!.emit({ id: start.id, result: { thread: { id: "native-thread" } } });
    await tick();
    const turn = f!.sent.find((message) => message.method === "turn/start")!;
    f!.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-1" } } });
    f!.emit({ id: turn.id, result: { turn: { id: "turn-1" } } });
    await tick();
    return { run };
  }
  return { session, seen, sink, start, get f() { return f!; }, complete(status = "completed") {
    f!.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-1", status } } });
  } };
}

test("Codex quota reader checks auth without forcing refresh and reads only account quota", async () => {
  const calls: Array<[string, unknown]> = [];
  const report = { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 25 } } };
  assert.equal(await readCodexPlanUsage(async (method, params) => {
    calls.push([method, params]);
    return method === "account/read" ? { account: { type: "chatgpt" } } : report;
  }), report);
  assert.deepEqual(calls, [["account/read", { refreshToken: false }], ["account/rateLimits/read", undefined]]);
  await assert.rejects(readCodexPlanUsage(async () => ({ account: null })), /authentication required/);
  await assert.rejects(readCodexPlanUsage(async () => ({ account: { type: "apiKey" } })), /ChatGPT login/);
  await assert.rejects(readCodexPlanUsage(async () => { throw new Error("401 expired"); }), /401 expired/);
});

test("Codex account quota notifications are forwarded even between turns", async () => {
  const reports: unknown[] = [];
  const f = sessionFixture(null, "ask", (provider, info) => { assert.equal(provider, "codex"); reports.push(info); });
  const { run } = await f.start();
  const first = { rateLimits: { limitId: "codex", primary: { usedPercent: 30 } } };
  f.f.emit({ method: "account/rateLimits/updated", params: first });
  f.complete();
  await run;
  const second = { rateLimits: { limitId: "other", primary: { usedPercent: 40 } } };
  f.f.emit({ method: "account/rateLimits/updated", params: second });
  assert.deepEqual(reports, [first, second]);
  f.session.dispose();
});

test("Codex app-server streams text once, forwards approval replies and marks steering only on user item", async () => {
  const f = sessionFixture();
  const { run } = await f.start();
  f.f.emit({ method: "item/agentMessage/delta", params: { threadId: "native-thread", turnId: "turn-1", itemId: "a", delta: "Hello" } });
  f.f.emit({ method: "item/completed", params: { threadId: "native-thread", turnId: "turn-1", item: { id: "a", type: "agentMessage", text: "Hello world" } } });
  assert.equal(f.seen.text, "Hello world");
  f.f.emit({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "native-thread", turnId: "turn-1", itemId: "shell", command: "echo hello" } });
  await tick();
  assert.deepEqual(f.seen.approvals, ["execute"]);
  assert.deepEqual(f.f.sent.find((message) => message.id === "approval")?.result, { decision: "decline" });
  const id = f.session.steer({ text: "focus on tests", images: [], documents: [] });
  await tick();
  const steer = f.f.sent.find((message) => message.method === "turn/steer")!;
  assert.equal(steer.params?.expectedTurnId, "turn-1");
  f.f.emit({ id: steer.id, result: { turnId: "turn-1" } });
  await tick();
  assert.deepEqual(f.seen.steered, []);
  f.f.emit({ method: "item/started", params: { threadId: "native-thread", turnId: "turn-1", item: { id: "u", type: "userMessage", clientId: id } } });
  assert.deepEqual(f.seen.steered, [id]);
  f.complete();
  assert.deepEqual(await run, { status: "done" });
  f.session.dispose();
});

test("Codex allowed reviews stay out of chat while normal tool activity and full diagnostics remain", async () => {
  const f = sessionFixture(null, "auto");
  const { run } = await f.start();
  const params = { threadId: "native-thread", turnId: "turn-1", reviewId: "r1", targetItemId: "mcp",
    action: { type: "mcpToolCall", server: "scribe", toolName: "page_action" } };
  f.f.emit({ method: "item/started", params: { threadId: "native-thread", turnId: "turn-1",
    item: { id: "mcp", type: "mcpToolCall", server: "scribe", tool: "page_action", arguments: {}, status: "inProgress" } } });
  const started = { ...params, review: { status: "inProgress" } };
  const approved = { ...params, review: { status: "approved", rationale: "Routine page update", riskLevel: "low", userAuthorization: "high" } };
  const warning = { threadId: "native-thread", message: "Approved: Routine page update. Risk: low; authorization: high." };
  f.f.emit({ method: "item/autoApprovalReview/started", params: started });
  f.f.emit({ method: "guardianWarning", params: warning });
  f.f.emit({ method: "item/autoApprovalReview/completed", params: approved });
  assert.deepEqual(f.seen.notices, []);
  assert.deepEqual(f.seen.tools, ["mcp"]);
  assert.deepEqual(f.seen.reviews, [
    { scribeThreadId: "scribe-thread", method: "item/autoApprovalReview/started", ...started },
    { scribeThreadId: "scribe-thread", method: "guardianWarning", ...warning },
    { scribeThreadId: "scribe-thread", method: "item/autoApprovalReview/completed", ...approved },
  ]);
  assert.deepEqual(f.seen.approvals, []);
  assert.equal(f.f.sent.filter((message) => message.result && !message.method).length, 0);
  f.complete();
  assert.equal((await run).status, "done");
  f.session.dispose();
});

test("Codex denials and review failures show one compact notice per review without granting access", async () => {
  const f = sessionFixture(null, "auto");
  const { run } = await f.start();
  const params = { threadId: "native-thread", turnId: "turn-1", targetItemId: "shell",
    action: { type: "command", command: "echo hello", cwd: "/work" } };
  const reason = "Explicit permission required.\n" + "Risk and authorization detail. ".repeat(40);
  const denied = { ...params, reviewId: "denied", review: { status: "denied", rationale: reason } };
  f.f.emit({ method: "item/autoApprovalReview/started", params: denied });
  f.f.emit({ method: "guardianWarning", params: { threadId: "native-thread", message: reason } });
  f.f.emit({ method: "item/autoApprovalReview/completed", params: denied });
  f.f.emit({ method: "item/autoApprovalReview/completed", params: denied });
  for (const status of ["timedOut", "aborted", "futureStatus"]) {
    const payload = { ...params, reviewId: status, review: { status } };
    f.f.emit({ method: "item/autoApprovalReview/completed", params: payload });
    f.f.emit({ method: "item/autoApprovalReview/completed", params: payload });
  }
  f.f.emit({ method: "item/autoApprovalReview/completed", params: { ...params, reviewId: "network", targetItemId: null,
    action: { type: "networkAccess", target: "example.com:443" }, review: { status: "denied" } } });
  const count = f.seen.notices.length;
  const logCount = f.seen.reviews.length;
  f.f.emit({ method: "item/autoApprovalReview/completed", params: { ...denied, threadId: "other" } });
  f.f.emit({ method: "item/autoApprovalReview/completed", params: { ...denied, turnId: "old" } });
  assert.equal(f.seen.notices.length, count);
  assert.equal(f.seen.reviews.length, logCount);
  assert.deepEqual(f.seen.notices.map((n) => n.level), ["warn", "error", "error", "error", "warn"]);
  assert.match(f.seen.notices[0].text, /denied: echo hello: Explicit permission required/);
  assert.ok(f.seen.notices[0].text.length < 350);
  assert.ok(!f.seen.notices[0].text.includes("\n"));
  assert.deepEqual(f.seen.reviews[2], { scribeThreadId: "scribe-thread", method: "item/autoApprovalReview/completed", ...denied });
  assert.match(f.seen.notices[1].text, /timed out.*Retry/);
  assert.match(f.seen.notices[2].text, /aborted/);
  assert.match(f.seen.notices[3].text, /failed.*diagnostic log/);
  assert.match(f.seen.notices[4].text, /denied: example.com:443/);
  assert.deepEqual(f.seen.approvals, []);
  assert.equal(f.f.sent.filter((message) => message.result && !message.method).length, 0);
  f.complete();
  assert.equal((await run).status, "done");
  // Deduplication is scoped to one run, even if the server reuses a review id.
  const next = f.session.run({ text: "again", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
  await tick();
  const turn = f.f.sent.filter((m) => m.method === "turn/start").at(-1)!;
  f.f.emit({ id: turn.id, result: { turn: { id: "turn-2" } } });
  await tick();
  f.f.emit({ method: "item/autoApprovalReview/completed", params: { ...denied, turnId: "turn-2" } });
  assert.equal(f.seen.notices.length, count + 1);
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  assert.equal((await next).status, "done");
  f.session.dispose();
});

test("Codex start and resume retain Auto-review and Full policies", async () => {
  for (const nativeId of [null, "native-thread"]) {
    for (const approval of ["auto", "full"] as const) {
      const f = sessionFixture(nativeId, approval);
      const { run } = await f.start();
      f.complete();
      assert.equal((await run).status, "done");
      f.session.dispose();
    }
  }
});

test("Codex rejected steer remains unacknowledged for host requeue, and pending approval aborts on completion", async () => {
  const f = sessionFixture();
  let aborted = false;
  f.sink.approval = (_req, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  });
  const { run } = await f.start();
  f.f.emit({ id: "approval", method: "item/fileChange/requestApproval", params: { threadId: "native-thread", turnId: "turn-1", itemId: "edit" } });
  const id = f.session.steer({ text: "new input", images: [], documents: [] });
  await tick();
  const steer = f.f.sent.find((message) => message.method === "turn/steer")!;
  f.f.emit({ id: steer.id, error: { message: "No active turn" } });
  f.complete();
  assert.equal((await run).status, "done");
  assert.deepEqual(f.seen.steered, []);
  assert.equal(aborted, true);
  assert.equal(await f.session.withdrawSteer(id), false);
  f.session.dispose();
});

test("Codex interruption sends the active turn id and returns cancelled", async () => {
  const f = sessionFixture();
  const { run } = await f.start();
  const cancel = f.session.cancel();
  const interrupt = f.f.sent.find((message) => message.method === "turn/interrupt")!;
  assert.equal(interrupt.params?.turnId, "turn-1");
  f.f.emit({ id: interrupt.id, result: {} });
  f.complete("interrupted");
  await cancel;
  assert.equal((await run).status, "cancelled");
  f.session.dispose();
});

test("Codex resumes an existing SDK thread and reuses the connection for subsequent turns", async () => {
  const f = sessionFixture("native-thread");
  const first = await f.start();
  assert.equal(f.f.sent.find((message) => message.method === "thread/resume")?.params?.threadId, "native-thread");
  f.complete();
  await first.run;
  const next = f.session.run({ text: "continue", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
  await tick();
  assert.equal(f.f.sent.filter((message) => message.method === "initialize").length, 1);
  const turn = f.f.sent.filter((message) => message.method === "turn/start").at(-1)!;
  // Completion can precede the turn/start response on the same transport.
  f.f.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-2" } } });
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  f.f.emit({ id: turn.id, result: { turn: { id: "turn-2" } } });
  assert.equal((await next).status, "done");
  f.session.dispose();
});

test("Codex applies a same-session model change on the next turn/start without reconnecting", async () => {
  const f = sessionFixture();
  const first = await f.start();
  const opened = f.f.sent.find((message) => message.method === "turn/start")!;
  assert.equal(opened.params?.model, "gpt-5-codex");
  assert.equal(opened.params?.effort, "medium");
  f.complete();
  await first.run;

  f.session.update({ ...thread({ model: "gpt-5.2-codex", effort: "high" }), id: "scribe-thread", nativeId: "native-thread", cwd: "/work", scope: {} } as Thread);
  const next = f.session.run({ text: "continue", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
  await tick();
  const changed = f.f.sent.filter((message) => message.method === "turn/start").at(-1)!;
  assert.equal(f.f.sent.filter((message) => message.method === "initialize").length, 1);
  assert.equal(changed.params?.model, "gpt-5.2-codex");
  assert.equal(changed.params?.effort, "high");
  f.f.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-2" } } });
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-2", status: "completed" } } });
  f.f.emit({ id: changed.id, result: { turn: { id: "turn-2" } } });
  assert.equal((await next).status, "done");

  f.session.update({ ...thread({ model: "default", effort: null }), id: "scribe-thread", nativeId: "native-thread", cwd: "/work", scope: {} } as Thread);
  const reset = f.session.run({ text: "reset", images: [], documents: [], instructions: "Scribe instructions" }, f.sink);
  await tick();
  const cleared = f.f.sent.filter((message) => message.method === "turn/start").at(-1)!;
  assert.equal(f.f.sent.filter((message) => message.method === "initialize").length, 1);
  assert.equal(cleared.params?.model, null);
  assert.equal(cleared.params?.effort, null);
  f.f.emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: "turn-3" } } });
  f.f.emit({ method: "turn/completed", params: { threadId: "native-thread", turn: { id: "turn-3", status: "completed" } } });
  f.f.emit({ id: cleared.id, result: { turn: { id: "turn-3" } } });
  assert.equal((await reset).status, "done");
  f.session.dispose();
});

test("Codex user input answers include freeform notes; unsupported permission grants fail closed", async () => {
  const f = sessionFixture();
  f.sink.question = async () => ({ answers: { q: ["Yes"] }, notes: { q: "Use the small scope" } });
  const { run } = await f.start();
  f.f.emit({ id: "q", method: "item/tool/requestUserInput", params: { threadId: "native-thread", turnId: "turn-1", questions: [{ id: "q", question: "Proceed?", options: [{ label: "Yes" }] }] } });
  f.f.emit({ id: "permissions", method: "item/permissions/requestApproval", params: { threadId: "native-thread", turnId: "turn-1", permissions: { network: { enabled: true } } } });
  await tick();
  assert.deepEqual(f.f.sent.find((message) => message.id === "q")?.result, { answers: { q: { answers: ["Yes", "Use the small scope"] } } });
  assert.deepEqual(f.f.sent.find((message) => message.id === "permissions")?.result, { permissions: {}, scope: "turn" });
  f.complete();
  await run;
  f.session.dispose();
});

test("syncAuthFiles keeps the newer Codex login in both places", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  const user = path.join(dir, "user.json");
  const scribe = path.join(dir, "scribe.json");
  const login = (token: string, at: string) => JSON.stringify({ tokens: { refresh_token: token }, last_refresh: at });
  try {
    assert.equal(syncAuthFiles(user, scribe), "none");

    fs.writeFileSync(user, login("a", "2026-01-01T00:00:00Z"));
    assert.equal(syncAuthFiles(user, scribe), "toScribe");
    assert.equal(fs.readFileSync(scribe, "utf8"), login("a", "2026-01-01T00:00:00Z"));
    assert.equal(syncAuthFiles(user, scribe), "none");

    // Scribe's app-server refreshed: the CLI gets the rotated token instead of overwriting it.
    fs.writeFileSync(scribe, login("b", "2026-01-02T00:00:00Z"));
    assert.equal(syncAuthFiles(user, scribe), "toUser");
    assert.equal(fs.readFileSync(user, "utf8"), login("b", "2026-01-02T00:00:00Z"));

    // A fresh `codex login` or CLI refresh is newer again and wins.
    fs.writeFileSync(user, login("c", "2026-01-03T00:00:00Z"));
    assert.equal(syncAuthFiles(user, scribe), "toScribe");
    assert.equal(fs.readFileSync(scribe, "utf8"), login("c", "2026-01-03T00:00:00Z"));

    // A broken Scribe copy is replaced; a broken CLI file is never copied over a good login.
    fs.writeFileSync(scribe, "{");
    assert.equal(syncAuthFiles(user, scribe), "toScribe");
    fs.writeFileSync(user, "{");
    assert.equal(syncAuthFiles(user, scribe), "toUser");
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
