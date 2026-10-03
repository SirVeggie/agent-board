import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "./config.js";

const SIGNAL_NAME = /^[A-Za-z0-9._:-]{1,64}$/;

export function normalizeSignalName(value: string): string {
  const name = value.trim();
  if (!SIGNAL_NAME.test(name)) {
    throw new Error(
      `invalid signal name: ${JSON.stringify(value)} (use 1-64 letters, digits, ., _, :, or -)`
    );
  }
  return name;
}

/** One name, a comma-separated list, or an array. Empty (or missing) means any event. */
export function parseEventNames(input: unknown): string[] {
  const raw: string[] = [];
  if (typeof input === "string") {
    raw.push(...input.split(","));
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        raw.push(...item.split(","));
      }
    }
  }
  const names = [...new Set(raw.map((item) => item.trim()).filter(Boolean))].map(normalizeSignalName);
  return names;
}

export function clampWaitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(MAX_WAIT_MS, Math.max(1, Math.floor(value)));
}

/** A wait cursor: the seq of the last event already seen. Undefined means "from now on". */
export function parseCursor(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * Fields to match on event `data` (same rules as page_state `where`: compared as text).
 * A JSON string is accepted so GET /wait can pass it as a query param.
 */
export function parseWhere(input: unknown): Record<string, string | number | boolean> | undefined {
  if (input == null || input === "") {
    return undefined;
  }
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error("where must be a JSON object");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("where must be an object");
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [field, want] of Object.entries(value as Record<string, unknown>)) {
    if (typeof want === "string" || typeof want === "number" || typeof want === "boolean") {
      out[field] = want;
    }
  }
  return Object.keys(out).length ? out : undefined;
}
