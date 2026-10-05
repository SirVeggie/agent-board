import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { paginateAgentDocuments, paginateCheckpointBlobIds, paginateRunDocuments } from "@cursor/sdk";
import { SqliteCursorStore } from "./providers/cursorStore.js";

const paging = { paginateAgentDocuments, paginateRunDocuments, paginateCheckpointBlobIds };

function tempStore(): { dir: string; store: SqliteCursorStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-store-"));
  return { dir, store: new SqliteCursorStore(path.join(dir, "store.sqlite"), paging) };
}

const agent = (agentId: string, cwd = "C:/work") => ({ agentId, cwd, status: "idle" as const, createdAt: 1, updatedAt: 1 });
const run = (agentId: string, runId: string, turnNumber: number) => ({ agentId, runId, turnNumber, status: "finished" as const, createdAt: 1, updatedAt: 1 });

test("agents, runs and checkpoints keep the JSONL store's rules", async () => {
  const { store } = tempStore();
  await store.agents.create({ agent: agent("agent-a") });
  await assert.rejects(store.agents.create({ agent: agent("agent-a") }), /already exists/);
  await store.agents.update({ agent: { ...agent("agent-a"), status: "running", activeRunId: "r1" } });
  assert.equal((await store.agents.get({ agentId: "agent-a" }))?.activeRunId, "r1");
  await assert.rejects(store.agents.update({ agent: agent("agent-x") }), /not found/);
  await store.agents.create({ agent: agent("agent-b", "C:/other") });
  assert.deepEqual((await store.agents.list({ filter: { cwd: "C:/other" } })).items.map((a) => a.agentId), ["agent-b"]);

  await store.runs.create({ run: run("agent-a", "r2", 2) });
  await store.runs.create({ run: run("agent-a", "r1", 1) });
  assert.deepEqual((await store.runs.list({ filter: { agentIds: ["agent-a"] } })).items.map((r) => r.runId), ["r1", "r2"]);

  await store.checkpoints.create({ agentId: "agent-a", blobId: "b1", data: new Uint8Array([1, 2, 3]) });
  await assert.rejects(store.checkpoints.create({ agentId: "agent-a", blobId: "b1", data: new Uint8Array([9]) }), /already exists/);
  await store.checkpoints.update({ agentId: "agent-a", blobId: "b1", data: new Uint8Array([4, 5]) });
  assert.deepEqual([...((await store.checkpoints.get({ agentId: "agent-a", blobId: "b1" })) ?? [])], [4, 5]);
  assert.equal(await store.checkpoints.get({ agentId: "agent-b", blobId: "b1" }), null);
  assert.deepEqual((await store.checkpoints.list({ filter: { agentIds: ["agent-a"] } })).items, ["b1"]);

  await store.agents.delete({ filter: { agentIds: ["agent-b"] } });
  await assert.rejects(store.agents.delete({ filter: { agentIds: ["agent-b"] } }), /No agents matched/);
  store.close();
});

test("run events number per run, dedupe by key, and page by offset", async () => {
  const { store } = tempStore();
  const first = await store.runEvents.append({ runId: "r1", eventType: "a", payload: { n: 1 }, idempotencyKey: "k1" });
  assert.equal(first.seq, 1);
  assert.equal((await store.runEvents.append({ runId: "r1", eventType: "a", payload: { n: 99 }, idempotencyKey: "k1" })).seq, 1);
  await store.runEvents.append({ runId: "r1", eventType: "b" });
  await store.runEvents.append({ runId: "r2", eventType: "c" });
  await store.runEvents.append({ runId: "r1", eventType: "d" });
  const page = await store.runEvents.list({ runId: "r1", limit: 2 });
  assert.deepEqual(page.items.map((e) => [e.seq, e.eventType]), [[1, "a"], [2, "b"]]);
  assert.deepEqual(page.items[0].payload, { n: 1 });
  assert.equal(page.nextOffset, "2");
  const rest = await store.runEvents.list({ runId: "r1", afterOffset: page.nextOffset, limit: 2 });
  assert.deepEqual(rest.items.map((e) => e.eventType), ["d"]);
  assert.equal(rest.nextOffset, undefined);

  await store.runs.create({ run: run("agent-a", "r1", 1) });
  await store.runs.delete({ filter: { runIds: ["r1"] } });
  assert.deepEqual((await store.runEvents.list({ runId: "r1" })).items, []);
  assert.equal((await store.runEvents.list({ runId: "r2" })).items.length, 1);
  store.close();
});

test("importJsonl brings in an old JSONL store once and renames its files", async () => {
  const { dir, store } = tempStore();
  fs.writeFileSync(path.join(dir, "agents.ndjson"), `${JSON.stringify(agent("agent-a"))}\n`);
  fs.writeFileSync(path.join(dir, "runs.ndjson"), `${JSON.stringify(run("agent-a", "r1", 1))}\n`);
  fs.writeFileSync(
    path.join(dir, "run_events.ndjson"),
    `${JSON.stringify({ runId: "r1", seq: 1, offset: "1", eventType: "a", payload: { x: 1 }, payloadRef: null, idempotencyKey: null, createdAt: "2026-10-01T00:00:00.000Z" })}\n`
  );
  // A torn last line, as a crash mid-rewrite leaves.
  fs.writeFileSync(path.join(dir, "checkpoints.ndjson"), `${JSON.stringify({ agentId: "agent-a", blobId: "b1", dataBase64: Buffer.from([7, 8]).toString("base64") })}\n{"agentId":`);
  await store.importJsonl(dir);
  assert.equal((await store.agents.get({ agentId: "agent-a" }))?.cwd, "C:/work");
  assert.equal((await store.runs.get({ agentId: "agent-a", runId: "r1" }))?.turnNumber, 1);
  const [event] = (await store.runEvents.list({ runId: "r1" })).items;
  assert.equal(event.createdAt, Date.parse("2026-10-01T00:00:00.000Z"));
  assert.equal((await store.runEvents.append({ runId: "r1", eventType: "b" })).seq, 2);
  assert.deepEqual([...((await store.checkpoints.get({ agentId: "agent-a", blobId: "b1" })) ?? [])], [7, 8]);
  assert.ok(fs.existsSync(path.join(dir, "checkpoints.ndjson.imported")));
  assert.ok(!fs.existsSync(path.join(dir, "agents.ndjson")));
  await store.importJsonl(dir);
  store.close();
});
