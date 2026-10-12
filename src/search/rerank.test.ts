import assert from "node:assert/strict";
import { test } from "node:test";
import { MlService } from "../ml/service.js";
import { memoryStore } from "../ml/settings.js";
import { fakeAdapter } from "../ml/adapters/fake.js";
import { RERANK_FEATURE, RERANK_TOP_K, rerankHits, type RerankDecide } from "./rerank.js";

function setup() {
  const adapter = fakeAdapter();
  const ml = new MlService({ store: memoryStore(), adapter, log: () => {} });
  ml.saveSource(undefined, { name: "Fake", baseUrl: "http://127.0.0.1:9" });
  ml.update({ features: { [RERANK_FEATURE]: true } });
  const decide: RerankDecide = (...args) => ml.decide(...args);
  return { adapter, ml, decide };
}
const yes = (value: number) => ({ type: "yesno" as const, yes: value });

test("rerank orders hits by tenths of yes, keeps vector order inside a tenth and drops what does not fit", async () => {
  const { adapter, decide } = setup();
  adapter.answers = { h0: yes(0.52), h1: yes(0.05), h2: yes(0.97), h3: yes(0.49), h4: yes(0.93) };
  const { hits, info } = await rerankHits("query", ["a", "b", "c", "d", "e"], (hit) => `text of ${hit}`, decide, { timeoutMs: 1000 });
  // c rounds to ten tenths and e to nine; a and d share five and keep their vector order.
  assert.deepEqual(hits, ["c", "e", "a", "d"]);
  assert.deepEqual(info, { applied: true, ms: info.ms, asked: 5, dropped: 1, cached: false });
  const call = adapter.calls[0];
  assert.deepEqual(call.state, { search: "query" });
  assert.deepEqual(Object.keys(call.questions), ["h0", "h1", "h2", "h3", "h4"]);
  assert.ok(call.questions.h1.instructions.endsWith("Passage: text of b"));
});

test("rerank asks about the top K only and leaves later hits after them", async () => {
  const { adapter, decide } = setup();
  const all = Array.from({ length: RERANK_TOP_K + 3 }, (_, i) => i);
  adapter.answers = { h0: yes(0), [`h${RERANK_TOP_K - 1}`]: yes(1) };
  const { hits, info } = await rerankHits("query", all, String, decide, { timeoutMs: 1000 });
  assert.equal(Object.keys(adapter.calls[0].questions).length, RERANK_TOP_K);
  assert.deepEqual(hits, [RERANK_TOP_K - 1, ...all.slice(1, RERANK_TOP_K - 1), ...all.slice(RERANK_TOP_K)]);
  assert.equal(info.applied && info.dropped, 1);
});

test("rerank returns the vector ranking when the classifier is slow, off or has no source", async () => {
  const { adapter, ml, decide } = setup();
  const hits = ["a", "b", "c"];
  adapter.answers = { h0: yes(0) };
  adapter.delayMs = 200;
  const slow = await rerankHits("slow", hits, String, decide, { timeoutMs: 20 });
  assert.deepEqual(slow.hits, hits); assert.equal(slow.info.applied, false); assert.equal(!slow.info.applied && slow.info.reason, "timeout");
  assert.ok(slow.info.ms < 150);
  adapter.delayMs = 0;
  ml.update({ features: { [RERANK_FEATURE]: false } });
  const off = await rerankHits("off", hits, String, decide, { timeoutMs: 1000 });
  assert.deepEqual(off.hits, hits); assert.equal(!off.info.applied && off.info.reason, "disabled");
  assert.equal(ml.ready(RERANK_FEATURE, ["toolResults"]), false);
  ml.update({ features: { [RERANK_FEATURE]: true } });
  assert.equal(ml.ready(RERANK_FEATURE, ["toolResults"]), true);
  ml.update({ send: { toolResults: false } });
  assert.equal(ml.ready(RERANK_FEATURE, ["toolResults"]), false);
  ml.update({ send: { toolResults: true } });
  ml.deleteSource(ml.view().sources[0].id);
  assert.equal(ml.ready(RERANK_FEATURE, ["toolResults"]), false);
  const none = await rerankHits("none", hits, String, decide, { timeoutMs: 1000 });
  assert.deepEqual(none.hits, hits); assert.equal(!none.info.applied && none.info.reason, "no_source");
});
