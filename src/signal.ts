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
