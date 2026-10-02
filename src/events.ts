import { MAX_PAGE_EVENTS } from "./config.js";
import type { PageEvent } from "./types.js";

/** Events as stored, cleaned up: known fields only, in seq order, at most MAX_PAGE_EVENTS. */
export function normalizeEvents(raw: unknown): PageEvent[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PageEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const event = item as Partial<PageEvent>;
    if (typeof event.seq !== "number" || typeof event.name !== "string") {
      continue;
    }
    const by = event.by === "agent" || event.by === "scribe" ? event.by : "user";
    out.push({ seq: event.seq, name: event.name, ...(event.data !== undefined ? { data: event.data } : {}), at: typeof event.at === "number" ? event.at : 0, by });
  }
  return out.sort((a, b) => a.seq - b.seq).slice(-MAX_PAGE_EVENTS);
}
