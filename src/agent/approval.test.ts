import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { RunSink, ApprovalRequest } from "./providers/provider.js";
import type { ApprovalPolicy, ThreadMode } from "./types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-approval-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");
let host: InstanceType<typeof AgentHost>;
before(() => { store.load(); host = new AgentHost(() => {}); });
after(() => { host.dispose(); store.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

function running(approval: ApprovalPolicy, mode: ThreadMode = "code") {
  const thread = host.createThread({ provider: "codex", approval, mode, scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode, startedAt: Date.now() };
  const run = { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null };
  const internal = host as unknown as { runs: Map<string, unknown>; turns: Map<string, unknown[]>; makeSink(id: string, run: unknown): RunSink };
  internal.turns.get(thread.id)?.push(turn);
  internal.runs.set(thread.id, run);
  return { id: thread.id, sink: internal.makeSink(thread.id, run) };
}

const request: ApprovalRequest = { tool: "edit", title: "Override native denial", humanOnly: true,
  options: [{ id: "retry", label: "Approve one retry", kind: "allow_once" }, { id: "deny", label: "Keep denied", kind: "reject_once" }] };

test("native denial overrides require a human in every approval policy", async () => {
  for (const policy of ["ask", "edits", "auto", "full"] as const) {
    const { id, sink } = running(policy);
    const pending = sink.approval(request);
    const item = host.threadDetail(id)?.items.find((it) => it.kind === "approval");
    assert.ok(item && item.kind === "approval");
    assert.equal(item.status, "pending");
    assert.equal(host.listThreads().find((t) => t.id === id)?.status, "waiting");
    host.resolveApproval(item.requestId, "retry");
    assert.deepEqual(await pending, { optionId: "retry", note: undefined });
  }
});

test("human-only overrides retain Pages tool refusals and ordinary Full/Edits grants", async () => {
  const board = running("full", "board");
  assert.equal((await board.sink.approval(request)).optionId, "deny");
  assert.equal(host.threadDetail(board.id)?.items.some((it) => it.kind === "approval"), false);
  for (const policy of ["full", "edits"] as const) {
    const { id, sink } = running(policy);
    assert.equal((await sink.approval({ ...request, humanOnly: false })).optionId, "retry");
    assert.equal(host.threadDetail(id)?.items.some((it) => it.kind === "approval"), false);
  }
});
