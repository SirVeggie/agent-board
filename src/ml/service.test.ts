import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeAdapter } from "./adapters/fake.js";
import { MAX_QUESTIONS, MAX_STATE_CHARS, MlService, validateRequest } from "./service.js";
import { memoryStore } from "./settings.js";
import { MlError, type DecideOk, type DecideResult, type MlAdapter, type MlQuestion, type MlQuestions } from "./types.js";

const KEY = "sk-test-secret-123";
const yes: MlQuestion = { type: "yesno", instructions: "Is it a question?" };
const pick: MlQuestion = { type: "choice", instructions: "Which one?", options: { a: null, b: "the second" } };
const scale: MlQuestion = { type: "score", instructions: "How much?", levels: ["low", "mid", "high"] };

function setup() {
  const clock = { at: new Date(2026, 9, 12, 12).getTime() };
  const adapter = fakeAdapter();
  const service = new MlService({ store: memoryStore(), adapter, log: () => {}, now: () => clock.at });
  return { service, adapter, clock };
}

function addSource(service: MlService): string {
  return service.saveSource(undefined, { name: "Jev", baseUrl: "https://jev.example", apiKey: KEY }).id;
}

function kindOf(r: DecideResult): string {
  return r.ok ? "ok" : r.error;
}

async function answered(promise: Promise<DecideResult>): Promise<DecideOk> {
  const r = await promise;
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
}

test("validateRequest takes text, an object or an array as state", () => {
  const questions = { a: yes };
  assert.doesNotThrow(() => validateRequest("hello", questions));
  assert.doesNotThrow(() => validateRequest({ text: "hi" }, questions));
  assert.doesNotThrow(() => validateRequest([{ role: "user" }], questions));
});

test("validateRequest refuses empty state and non-object questions", () => {
  const invalid = (state: unknown, questions: unknown) =>
    assert.throws(() => validateRequest(state, questions), (e) => e instanceof MlError && e.kind === "invalid_request");
  invalid("", { a: yes });
  invalid("   ", { a: yes });
  invalid(null, { a: yes });
  invalid("text", "a");
  invalid("text", []);
  invalid("text", null);
});

test("validateRequest checks the question count, ids and shapes", () => {
  const invalid = (questions: unknown) =>
    assert.throws(() => validateRequest("text", questions), (e) => e instanceof MlError && e.kind === "invalid_request");
  invalid({});
  invalid(Object.fromEntries(Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, yes])));
  invalid({ "bad id!": yes });
  invalid({ a: { type: "maybe", instructions: "x" } });
  invalid({ a: { type: "yesno" } });
  invalid({ a: { type: "choice", instructions: "x", options: { only: null } } });
  invalid({ a: { type: "score", instructions: "x", levels: ["one"] } });
  invalid({ a: { type: "score", instructions: "x", levels: Array.from({ length: 11 }, (_, i) => `l${i}`) } });
});

test("validateRequest reports state over the size limit as input_too_large", () => {
  assert.doesNotThrow(() => validateRequest("x".repeat(MAX_STATE_CHARS), { a: yes }));
  assert.throws(
    () => validateRequest("x".repeat(MAX_STATE_CHARS + 1), { a: yes }),
    (e) => e instanceof MlError && e.kind === "input_too_large",
  );
});

test("decide without any source returns no_source and does not throw", async () => {
  const { service, adapter } = setup();
  const r = await service.decide("text", { a: yes });
  assert.equal(r.ok, false);
  assert.equal(kindOf(r), "no_source");
  assert.equal(adapter.calls.length, 0);
});

test("decide with an unknown source id returns no_source", async () => {
  const { service, adapter } = setup();
  addSource(service);
  const r = await service.decide("text", { a: yes }, { source: "nope" });
  assert.equal(kindOf(r), "no_source");
  assert.equal(adapter.calls.length, 0);
});

test("the first saved source becomes the default", () => {
  const { service } = setup();
  const first = addSource(service);
  service.saveSource(undefined, { name: "Other", baseUrl: "https://other.example", apiKey: "k2" });
  assert.equal(service.view().defaultSource, first);
});

test("the view says whether a key is set and never shows it", () => {
  const { service } = setup();
  const saved = service.saveSource(undefined, { name: "Jev", baseUrl: "https://jev.example", apiKey: KEY });
  assert.equal(saved.hasKey, true);
  assert.equal("apiKey" in saved, false);
  assert.equal(JSON.stringify(service.view()).includes(KEY), false);
});

test("editing a source without sending a key keeps the saved key", async () => {
  const { service, adapter } = setup();
  const id = addSource(service);
  service.saveSource(id, { name: "Renamed" });
  assert.equal(service.view().sources[0].hasKey, true);
  await service.decide("text", { a: yes });
  assert.equal(adapter.calls.at(-1)?.source.apiKey, KEY);
});

test("an empty apiKey clears the saved key", async () => {
  const { service, adapter } = setup();
  const id = addSource(service);
  service.saveSource(id, { apiKey: "" });
  assert.equal(service.view().sources[0].hasKey, false);
  await service.decide("text", { a: yes });
  assert.equal(adapter.calls.at(-1)?.source.apiKey, undefined);
});

test("pointing a source at another host drops the key unless a new one is sent", () => {
  const { service } = setup();
  const id = addSource(service);
  service.saveSource(id, { baseUrl: "https://elsewhere.example" });
  assert.equal(service.view().sources[0].hasKey, false);
});

test("a base URL ending in a version path is cut back", () => {
  const { service } = setup();
  const saved = service.saveSource(undefined, { name: "Local", baseUrl: "http://localhost:1234/v1", apiKey: KEY });
  assert.equal(saved.baseUrl, "http://localhost:1234");
  const edited = service.saveSource(saved.id, { baseUrl: "http://localhost:1234/v1/systemone/" });
  assert.equal(edited.baseUrl, "http://localhost:1234");
  assert.equal(edited.hasKey, true);
});

test("deleting the default source moves the default to the one left", () => {
  const { service } = setup();
  const first = addSource(service);
  const second = service.saveSource(undefined, { name: "B", baseUrl: "https://b.example", apiKey: "k" }).id;
  service.deleteSource(first);
  assert.equal(service.view().defaultSource, second);
});

test("saveSource with an unknown id throws", () => {
  const { service } = setup();
  assert.throws(() => service.saveSource("nope", { name: "x", baseUrl: "https://x.example" }), /No classifier source/);
});

test("decide answers all three kinds of question in one call", async () => {
  const { service, adapter } = setup();
  const id = addSource(service);
  const questions: MlQuestions = { a: yes, b: pick, c: scale };
  const r = await answered(service.decide("the state", questions));
  assert.equal(r.cached, false);
  assert.equal(r.source, id);
  assert.deepEqual(Object.keys(r.answers).sort(), ["a", "b", "c"]);
  assert.equal(r.answers.a.type, "yesno");
  assert.equal(r.answers.b.type, "choice");
  assert.equal(r.answers.c.type, "score");
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].source.id, id);
  assert.equal(adapter.calls[0].source.apiKey, KEY);
});

test("the same request twice reaches the backend once", async () => {
  const { service, adapter } = setup();
  addSource(service);
  const first = await answered(service.decide("text", { a: yes }));
  const second = await answered(service.decide("text", { a: yes }));
  assert.equal(adapter.calls.length, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.ms, 0);
});

test("cache false calls the backend every time", async () => {
  const { service, adapter } = setup();
  addSource(service);
  await service.decide("text", { a: yes }, { cache: false });
  await service.decide("text", { a: yes }, { cache: false });
  assert.equal(adapter.calls.length, 2);
});

test("identical requests in flight at once share one backend call", async () => {
  const { service, adapter } = setup();
  addSource(service);
  adapter.delayMs = 20;
  const results = await Promise.all([service.decide("text", { a: yes }), service.decide("text", { a: yes })]);
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(results.map(kindOf), ["ok", "ok"]);
});

test("usage counts calls, cached answers and tokens for the day", async () => {
  const { service } = setup();
  addSource(service);
  const first = await answered(service.decide("text", { a: yes }));
  await answered(service.decide("text", { a: yes }));
  const third = await answered(service.decide("other", { a: yes }));
  const usage = service.usage();
  assert.equal(usage.calls, 2);
  assert.equal(usage.cached, 1);
  assert.equal(usage.failed, 0);
  assert.equal(usage.inputTokens, first.usage.inputTokens + third.usage.inputTokens);
  assert.ok(usage.latency);
  assert.equal(usage.latency.count, 2);
});

test("a failed call returns its error kind and counts as failed", async () => {
  const { service, adapter } = setup();
  addSource(service);
  adapter.failNext = new MlError("rate_limited", "x");
  const r = await service.decide("text", { a: yes });
  assert.equal(r.ok, false);
  assert.equal(kindOf(r), "rate_limited");
  assert.equal(service.usage().failed, 1);
});

test("the day's counters reset once the local day changes", async () => {
  const { service, clock } = setup();
  addSource(service);
  await answered(service.decide("text", { a: yes }));
  assert.equal(service.usage().calls, 1);
  clock.at += 25 * 60 * 60 * 1000;
  const usage = service.usage();
  assert.equal(usage.calls, 0);
  assert.equal(usage.cached, 0);
  assert.equal(usage.failed, 0);
  assert.equal(usage.inputTokens, 0);
});

test("a call that runs past its timeout returns timeout", async () => {
  const { service, adapter } = setup();
  addSource(service);
  adapter.delayMs = 200;
  const r = await service.decide("text", { a: yes }, { timeoutMs: 20 });
  assert.equal(kindOf(r), "timeout");
});

test("no more than four backend calls run at once", async () => {
  const { service, adapter } = setup();
  addSource(service);
  adapter.delayMs = 30;
  let running = 0;
  let peak = 0;
  const inner = adapter.decide.bind(adapter);
  const tracked: MlAdapter["decide"] = async (source, state, questions, signal) => {
    running += 1;
    peak = Math.max(peak, running);
    try {
      return await inner(source, state, questions, signal);
    } finally {
      running -= 1;
    }
  };
  adapter.decide = tracked;
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => service.decide(`state ${i}`, { a: yes })));
  assert.equal(peak, 4);
  assert.equal(results.filter((r) => r.ok).length, 10);
});

test("a switched-off send kind blocks the call before the backend", async () => {
  const { service, adapter } = setup();
  addSource(service);
  service.update({ send: { toolResults: false } });
  const blocked = await service.decide("text", { a: yes }, { sends: ["toolResults"] });
  assert.equal(kindOf(blocked), "not_allowed");
  assert.equal(adapter.calls.length, 0);
  const allowed = await service.decide("text", { a: yes }, { sends: ["messages"] });
  assert.equal(kindOf(allowed), "ok");
});

test("update rejects unknown switches and an unknown default", () => {
  const { service } = setup();
  addSource(service);
  assert.throws(() => service.update({ send: { bogus: true } }), /Unknown send switch/);
  assert.throws(() => service.update({ defaultSource: "nope" }));
});

test("a feature id that is not registered is disabled", async () => {
  const { service, adapter } = setup();
  addSource(service);
  const r = await service.decide("text", { a: yes }, { feature: "nope" });
  assert.equal(kindOf(r), "disabled");
  assert.equal(adapter.calls.length, 0);
});

test("test() asks the sunny question through the source", async () => {
  const { service } = setup();
  const id = addSource(service);
  const r = await answered(service.test(id));
  assert.equal(r.source, id);
  assert.equal(r.answers.sunny.type, "yesno");
});
