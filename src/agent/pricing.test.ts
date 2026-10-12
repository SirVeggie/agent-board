import assert from "node:assert/strict";
import test from "node:test";
import { addCostRecord, estimateCost, normalizePrices, type RateSnapshot } from "./pricing.js";
import { normalizeSource } from "./openaiSources.js";
import { sumUsageTree } from "./usage.js";
import type { Turn } from "./types.js";
import { deepSeekProfile, observedWindow, recordTariff } from "./tariffs.js";

test("source prices survive old clients and model discovery; endpoint edits require reconfirmation", () => {
  const source = normalizeSource({ name: "API", baseUrl: "https://example.test/v1", pricing: { "vendor/model": { mode: "custom", rates: { input: "0", output: "1.25", cacheRead: "" } } } }, undefined, new Set());
  const renamed = normalizeSource({ name: "Renamed", models: [] }, source, new Set());
  assert.deepEqual(renamed.pricing, source.pricing);
  assert.equal(renamed.pricing?.["vendor/model"].mode, "custom");
  assert.throws(() => normalizeSource({ baseUrl: "https://other.test" }, source, new Set()), /reconfirm/);
  assert.throws(() => normalizeSource({ baseUrl: "https://other.test", pricing: source.pricing }, source, new Set()), /Confirm/);
  assert.ok(normalizeSource({ baseUrl: "https://other.test", pricing: source.pricing, pricingConfirmed: true }, source, new Set()).pricing);
  assert.equal(normalizeSource({ pricing: {} }, source, new Set()).pricing, undefined);
  assert.equal(normalizePrices({ a: { mode: "automatic" } }).a, undefined);
  for (const value of ["-1", "NaN", "Infinity", "1e2", "0.1234567890", {}, 1_000_001]) {
    assert.throws(() => normalizePrices({ a: { mode: "custom", rates: { input: value, output: "0" } } }), /price/);
  }
});

test("pricing preserves decimals, known zero and missing cache rates without double counting reasoning", () => {
  const rate: RateSnapshot = { provider: "src-a", model: "x", origin: "custom", freshness: "user-entered", unit: "USD/1M tokens", rates: { input: "0.123456789", output: "2", cacheRead: "0.01" } };
  const record = estimateCost("a", 1, rate, { input: 100, output: 50, cacheRead: 900, cacheWrite: 0 });
  assert.equal(record.estimatedUsd, 0.0001213456789);
  assert.deepEqual(record.missing, []);
  rate.rates!.input = "99";
  assert.equal(record.rate.rates!.input, "0.123456789");
  const partial = estimateCost("b", 2, rate, { input: 0, output: 0, cacheRead: 0, cacheWrite: 10 });
  assert.equal(partial.estimatedUsd, 0);
  assert.deepEqual(partial.missing, ["cacheWrite price unavailable"]);
  const zero = estimateCost("c", 3, { ...rate, rates: { input: "0", output: "0" } }, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
  assert.equal(zero.estimatedUsd, 0);
  assert.deepEqual(zero.missing, []);
  const unknown = estimateCost("d", 4, { ...rate, origin: "unknown", rates: undefined }, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
  assert.equal(unknown.estimatedUsd, undefined);
  assert.ok(unknown.missing.length);
  const cumulative = addCostRecord(addCostRecord({}, record), record);
  assert.equal(cumulative.costUsd, record.estimatedUsd);
  assert.equal(cumulative.costRecords!.length, 1);
  assert.equal(addCostRecord(cumulative, unknown).costPartial, true);
});

test("helper totals retain estimated, reported, legacy and partial costs", () => {
  const makeTurn = (usage: Turn["usage"]) => ({ usage, model: "x", status: "done", mode: "code" } as Turn);
  const usage = sumUsageTree("main", [{ id: "main", provider: "pi" }, { id: "child", helperOf: "main", provider: "cursor" }], (id) => id === "main" ? [makeTurn({ costUsd: 0, estimatedCostUsd: 0 }), makeTurn({ costUsd: 2 })] : [makeTurn({ costUsd: 1, reportedCostUsd: 1, costPartial: true })]);
  assert.equal(usage?.costUsd, 3);
  assert.equal(usage?.estimatedCostUsd, 0);
  assert.equal(usage?.reportedCostUsd, 1);
  assert.equal(usage?.costPartial, true);
  assert.equal(usage?.main?.estimatedCostUsd, 0);
  assert.equal(usage?.helpers?.reportedCostUsd, 1);
});

const dsProfile = () => deepSeekProfile("deepseek", "deepseek-flash")!;
const time = (text: string) => Date.parse(text);
const dsRecord = () => estimateCost("ds", time("2026-10-12T00:59:00Z"), {
  provider: "deepseek", model: "deepseek-flash", origin: "catalog", unit: "USD/1M tokens", freshness: "unknown",
  rates: { input: "0.15", output: "0.6", cacheRead: "0.003" }, tariffProfile: dsProfile(),
}, { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 });

test("reviewed tariffs require exact official endpoint and model, including retired Flash aliases", () => {
  for (const id of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"]) {
    assert.ok(deepSeekProfile("src-ds", id, "https://api.deepseek.com/v1"));
  }
  for (const endpoint of ["https://proxy.test/v1", "https://api.deepseek.com.evil.test", "https://api.deepseek.com/anthropic", "invalid"]) {
    assert.equal(deepSeekProfile("deepseek", "deepseek-flash", endpoint), undefined);
  }
  assert.equal(deepSeekProfile("other", "deepseek-flash"), undefined);
  assert.equal(deepSeekProfile("deepseek", "future-model"), undefined);
  assert.equal(deepSeekProfile("deepseek", "deepseek-v4-pro")!.rates.peak.output, "3.96");
});

test("reviewed windows use half-open UTC boundaries, holidays and weekends without extending coverage", () => {
  const p = dsProfile();
  for (const [clock, expected] of [["00:59:59.999", "offPeak"], ["01:00:00", "peak"], ["03:59:59.999", "peak"], ["04:00:00", "offPeak"], ["06:00:00", "peak"], ["10:00:00", "offPeak"]]) {
    assert.equal(observedWindow(p, time(`2026-10-12T${clock}Z`)), expected);
  }
  assert.equal(observedWindow(p, time("2026-10-10T02:00:00Z")), "offPeak"); // adjusted working Saturday
  assert.equal(observedWindow(p, time("2026-10-04T02:00:00Z")), "holiday");
  assert.equal(observedWindow(p, time("2026-10-01T02:00:00Z")), "holiday");
  assert.equal(observedWindow(p, time("2026-09-30T16:00:00Z")), "holiday"); // tentative Shanghai date
  assert.equal(observedWindow(p, time("2027-01-01T02:00:00Z")), "calendar-unavailable");
});

test("message observations retain catalog cost, candidate bounds and an immutable unresolved decision", () => {
  const record = dsRecord();
  const p = record.rate.tariffProfile!;
  const timing = { basis: "assistant-message" as const, attempts: "unavailable" as const, payloadObservedAt: time("2026-10-12T00:59:00Z"), endedAt: time("2026-10-12T01:01:00Z") };
  recordTariff(record, timing);
  assert.equal(record.estimatedUsd, 0.15);
  assert.deepEqual(record.tariffCandidatesUsd, { lower: 0.15, upper: 0.3 });
  assert.equal(record.tariff?.status, "unresolved");
  assert.equal(record.tariff?.boundary, "crossed");
  assert.equal(record.tariff?.selected, "catalog");
  assert.equal(addCostRecord({}, record).costPartial, true);
  const saved = JSON.stringify(record.tariff);
  p.rates.peak.input = "99";
  p.calendar.holidays = [];
  timing.endedAt = 1;
  assert.equal(JSON.stringify(record.tariff), saved);
  assert.notEqual(record.timing?.endedAt, 1);
  // Same endpoint window still contains intervening peak hours.
  const long = recordTariff(dsRecord(), { basis: "assistant-message", attempts: "unavailable", payloadObservedAt: time("2026-10-12T00:59:00Z"), endedAt: time("2026-10-12T10:01:00Z") });
  assert.equal(long.tariff?.boundary, "crossed");
});

test("unobserved dispatch, expired profiles and missing cache usage never manufacture resolved tariffs", () => {
  const unobserved = recordTariff(dsRecord(), { basis: "assistant-message", attempts: "unavailable", endedAt: time("2026-10-12T02:00:00Z") });
  assert.equal(unobserved.tariff?.boundary, "unavailable");
  assert.equal(unobserved.tariffCandidatesUsd, undefined);
  for (const at of ["2026-10-11T02:00:00Z", "2027-01-01T02:00:00Z"]) {
    const expired = recordTariff(dsRecord(), { basis: "assistant-message", attempts: "unavailable", payloadObservedAt: time(at), endedAt: time(at) + 1000 });
    assert.equal(expired.tariffCandidatesUsd, undefined);
    assert.ok(expired.missing.some((s) => s.includes("applicability")));
  }
  const cache = dsRecord();
  cache.tokens.cacheWrite = 1;
  recordTariff(cache, { basis: "assistant-message", attempts: "unavailable", payloadObservedAt: time("2026-10-12T02:00:00Z"), endedAt: time("2026-10-12T02:01:00Z") });
  assert.equal(cache.tariffCandidatesUsd, undefined);
  const custom = dsRecord();
  custom.rate.origin = "custom";
  recordTariff(custom, { basis: "assistant-message", attempts: "unavailable", endedAt: time("2026-10-12T02:00:00Z") });
  assert.equal(custom.tariff, undefined);
  assert.deepEqual(custom.missing, []);
});
