import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { SteerInput } from "./providers/provider.js";

// The host keeps its data under SCRIBE_HOME; point it at a scratch folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-card-"));
process.env.SCRIBE_HOME = dir;
const { store } = await import("../store.js");
const { AgentHost } = await import("./host.js");

let host: InstanceType<typeof AgentHost>;

before(() => {
  store.load();
  host = new AgentHost(() => {});
});

after(() => {
  host.dispose();
  store.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const card = { num: 12, title: "Fix it", board: "Todo", boardKey: "scribe:todo" };

/** A thread with a running turn, and a session that steers when `steers` (it records what it got). */
function runningThread(steers: boolean): { id: string; steered: SteerInput[] } {
  const thread = host.createThread({ provider: "openai", scope: { kind: "global", ref: null } });
  const turn = { id: `tu_${thread.id}`, threadId: thread.id, seq: 1, status: "running", model: "m", effort: null, mode: thread.mode, startedAt: Date.now() };
  const internals = host as unknown as { runs: Map<string, unknown>; turns: Map<string, unknown[]>; sessions: Map<string, unknown> };
  internals.turns.get(thread.id)?.push(turn);
  internals.runs.set(thread.id, { turn, textItem: null, reasoningItem: null, tools: new Map(), known: new Map(), repo: null, cancelled: false, usage: {}, steer: null });
  const steered: SteerInput[] = [];
  const dispose = () => {};
  internals.sessions.set(thread.id, steers ? { dispose, steer: (input: SteerInput) => (steered.push(input), `s${steered.length}`) } : { dispose });
  return { id: thread.id, steered };
}

const userItems = (threadId: string) => (host.threadDetail(threadId)?.items ?? []).filter((it) => it.kind === "user");

test("a card comment is not sent to an idle thread", () => {
  const thread = host.createThread({ provider: "openai", scope: { kind: "global", ref: null } });
  assert.deepEqual(host.cardMessage(thread.id, card, "please also add tests"), { delivered: null });
  assert.equal(userItems(thread.id).length, 0);
});

test("a card comment is steered into the running turn, worded as the board's", () => {
  const { id, steered } = runningThread(true);
  assert.deepEqual(host.cardMessage(id, card, "please also add tests"), { delivered: "steered" });
  assert.equal(steered.length, 1);
  assert.match(steered[0].text, /A new comment on card #12 "Fix it" of the Kanban board "Todo" \(scribe:todo\)/);
  assert.match(steered[0].text, /<card_comment>\nplease also add tests\n<\/card_comment>$/);
  const [item] = userItems(id);
  assert.ok(item && item.kind === "user");
  assert.equal(item.text, "please also add tests");
  assert.equal(item.steer, "waiting");
  assert.deepEqual(item.card, { num: 12, title: "Fix it" });
});

test("a card comment queues when the provider cannot steer, or something else is queued first", () => {
  const plain = runningThread(false);
  assert.deepEqual(host.cardMessage(plain.id, card, "one"), { delivered: "queued" });
  const busy = runningThread(true);
  host.send(busy.id, { text: "typed first" });
  assert.deepEqual(host.cardMessage(busy.id, card, "two"), { delivered: "queued" });
  assert.equal(busy.steered.length, 0);
});

test("Continue sends the host's own note, never steered", () => {
  const { id, steered } = runningThread(true);
  assert.deepEqual(host.cardMessage(id, { ...card, resume: true }, "ignored"), { delivered: "queued" });
  assert.equal(steered.length, 0);
  const [item] = userItems(id);
  assert.ok(item && item.kind === "user");
  assert.match(item.text, /^Continue the work on card #12\./);
  assert.deepEqual(item.card, { num: 12, title: "Fix it", resume: true });
});
