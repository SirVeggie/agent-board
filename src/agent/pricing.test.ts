import assert from "node:assert/strict";
import test from "node:test";
import { addCostRecord, estimateCost, normalizePrices, type RateSnapshot } from "./pricing.js";
import { normalizeSource } from "./openaiSources.js";
import { sumUsageTree } from "./usage.js";
import type { Turn } from "./types.js";

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
