import { isPlainRecord, type Usage } from "./types.js";

export type TokenRates = { input: string; output: string; cacheRead?: string; cacheWrite?: string };
export type ModelPrice = { mode: "unknown" } | { mode: "custom"; rates: TokenRates; updatedAt: number };
export type RateSnapshot = {
  origin: "custom" | "catalog" | "unknown";
  provider: string;
  model: string;
  sourceId?: string;
  endpoint?: string;
  unit: "USD/1M tokens";
  rates?: TokenRates;
  updatedAt?: number;
  /** Catalog verification dates are not supplied by Pi. */
  freshness: "user-entered" | "unknown";
};
export type CostRecord = {
  id: string;
  /** Assistant-message timestamp, not an HTTP billing timestamp. */
  at: number;
  rate: RateSnapshot;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  estimatedUsd?: number;
  missing: string[];
};

function rate(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!/^\d+(?:\.\d{1,9})?$/.test(text) || !Number.isFinite(Number(text)) || Number(text) > 1_000_000) {
    throw new Error(`${name}: enter a non-negative USD price with up to 9 decimal places`);
  }
  return text.replace(/^0+(?=\d)/, "");
}

export function normalizePrices(value: unknown, previous: Record<string, ModelPrice> = {}): Record<string, ModelPrice> {
  if (!isPlainRecord(value) || Object.keys(value).length > 200) throw new Error("Pricing must contain at most 200 model entries");
  const out: Record<string, ModelPrice> = Object.create(null);
  for (const [model, item] of Object.entries(value)) {
    if (!model.trim() || model !== model.trim() || model.length > 500 || !isPlainRecord(item)) throw new Error("Each price needs an exact model ID");
    if (item.mode === "unknown") { out[model] = { mode: "unknown" }; continue; }
    if (item.mode === "automatic") continue;
    if (item.mode !== "custom" || !isPlainRecord(item.rates)) throw new Error(`${model}: choose Automatic, Custom or Unknown`);
    const rates: TokenRates = { input: rate(item.rates.input, `${model} input`), output: rate(item.rates.output, `${model} output`) };
    for (const key of ["cacheRead", "cacheWrite"] as const) {
      const val = item.rates[key];
      if (val !== undefined && val !== "" && val !== null) rates[key] = rate(val, `${model} ${key}`);
    }
    const old = previous[model];
    out[model] = { mode: "custom", rates, updatedAt: old?.mode === "custom" && JSON.stringify(old.rates) === JSON.stringify(rates) ? old.updatedAt : Date.now() };
  }
  return out;
}

/** Exact decimal multiplication; round to Number only after summing all known categories. */
export function estimateCost(id: string, at: number, rate: RateSnapshot, tokens: CostRecord["tokens"]): CostRecord {
  let scaled = 0n;
  let known = false;
  const missing: string[] = [];
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const count = tokens[key];
    if (!Number.isSafeInteger(count) || count < 0) { missing.push(`${key} usage unavailable`); continue; }
    const price = rate.rates?.[key];
    if (price === undefined) { if (count > 0) missing.push(`${key} price unavailable`); continue; }
    known = true;
    const [whole, fraction = ""] = price.split(".");
    scaled += BigInt(count) * (BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0")));
  }
  if (rate.origin === "unknown") missing.push("Model price unavailable");
  return { id, at, rate: structuredClone(rate), tokens: { ...tokens }, ...(known ? { estimatedUsd: Number(scaled) / 1e15 } : {}), missing };
}

/** A cumulative snapshot: repeated SDK events replace their record rather than charging twice. */
export function addCostRecord(usage: Usage, record: CostRecord): Pick<Usage, "costRecords" | "costUsd" | "estimatedCostUsd" | "costPartial"> {
  const records = [...(usage.costRecords ?? []).filter((r) => r.id !== record.id), record];
  const known = records.some((r) => r.estimatedUsd !== undefined);
  const total = records.reduce((sum, r) => sum + (r.estimatedUsd ?? 0), 0);
  return { costRecords: records, ...(known ? { costUsd: total, estimatedCostUsd: total } : {}), ...(records.some((r) => r.missing.length) ? { costPartial: true } : {}) };
}
