import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from "./config.js";
import type { Tab, TabSignal } from "./types.js";

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

/** One name, a comma-separated list, or an array. */
export function parseSignalNames(input: unknown): string[] {
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
  if (names.length === 0) {
    throw new Error("signal is required");
  }
  return names;
}

export function clampWaitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(MAX_WAIT_MS, Math.max(1, Math.floor(value)));
}

export function parseAfterRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

export function signalMatches(tab: Tab, names: string[], afterRevision: number): boolean {
  return Boolean(tab.signal && tab.signal.revision > afterRevision && names.includes(tab.signal.name));
}

export function toSignalView(signal: TabSignal | null): TabSignal | null {
  if (!signal) {
    return null;
  }
  return { name: signal.name, revision: signal.revision, at: signal.at };
}
