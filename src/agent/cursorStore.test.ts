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
  return { dir, store: new SqliteCursorStore(path.join(dir, "store.sqlite"), async () => paging) };
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

test("prune drops agents no thread keeps, and the checkpoints of idle ones", async () => {
  const { dir, store } = tempStore();
  for (const id of ["agent-kept", "agent-idle", "agent-gone", "agent-new", "agent-open"]) {
    await store.agents.create({ agent: agent(id) });
    await store.runs.create({ run: run(id, `run-${id}`, 1) });
    await store.runEvents.append({ runId: `run-${id}`, eventType: "a" });
    await store.checkpoints.create({ agentId: id, blobId: "root", data: new Uint8Array(4096) });
    await store.agents.update({ agent: { ...agent(id), latestCheckpoint: { rootBlobId: "root" } } as never });
  }
  // Rows a crash left without their agent.
  await store.checkpoints.create({ agentId: "agent-lost", blobId: "b", data: new Uint8Array([1]) });
  assert.ok(store.resumable("agent-idle"));
  assert.ok(!store.resumable("agent-missing"));

  const hour = 60 * 60 * 1000;
  const now = Date.now() + 4 * 24 * hour;
  // agent-new ran ten minutes ago: too fresh to drop though nothing keeps it (a spare, a one-off answer).
  const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  db.prepare("UPDATE agents SET touched_at = ? WHERE agent_id = ?").run(now - 10 * 60 * 1000, "agent-new");
  db.prepare("UPDATE agents SET touched_at = ? WHERE agent_id = ?").run(now - hour, "agent-kept");
  const result = store.prune((id) => id === "agent-kept" || id === "agent-idle", { graceMs: hour, idleMs: 3 * 24 * hour, open: (id) => id === "agent-open", now });
  assert.deepEqual(result, { agents: 2, expired: 1 });

  assert.equal(await store.agents.get({ agentId: "agent-gone" }), null);
  assert.deepEqual((await store.runs.list({ filter: { agentIds: ["agent-gone"] } })).items, []);
  assert.deepEqual((await store.runEvents.list({ runId: "run-agent-gone" })).items, []);
  assert.deepEqual((await store.checkpoints.list({ filter: { agentIds: ["agent-gone"] } })).items, []);
  assert.deepEqual((await store.checkpoints.list({ filter: { agentIds: ["agent-lost"] } })).items, []);

  // Idle but kept: the agent and its runs stay, its checkpoints and events go, and it cannot resume.
  assert.ok(await store.agents.get({ agentId: "agent-idle" }));
  assert.equal((await store.runs.list({ filter: { agentIds: ["agent-idle"] } })).items.length, 1);
  assert.deepEqual((await store.checkpoints.list({ filter: { agentIds: ["agent-idle"] } })).items, []);
  assert.deepEqual((await store.runEvents.list({ runId: "run-agent-idle" })).items, []);
  assert.ok(!store.resumable("agent-idle"));

  for (const id of ["agent-kept", "agent-new", "agent-open"]) assert.ok(store.resumable(id), id);
  assert.equal((db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum, 2);
  assert.deepEqual(store.prune(() => true, { graceMs: hour, idleMs: 3 * 24 * hour, open: (id) => id === "agent-open", now }), { agents: 0, expired: 0 });
  store.close();
  // The column added to an older file survives reopening.
  const again = new SqliteCursorStore(path.join(dir, "store.sqlite"), async () => paging);
  assert.ok(again.resumable("agent-kept"));
  again.close();
});
