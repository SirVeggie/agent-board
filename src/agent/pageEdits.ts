import type { Item, Turn } from "./types.js";

/** How a page looked at the end of a turn, so the next turn can see if someone changed it. */
export type PageSnapshot = {
  id: string;
  key: string;
  title: string;
  revision: number;
  /** -1 means this snapshot did not record state (legacy turn.page fallback): ignore state. */
  stateRevision: number;
};

export type PageEdit = {
  from: PageSnapshot;
  to: PageSnapshot;
  html: boolean;
  state: boolean;
};

const PAGE_WRITE_TOOLS = new Set(["page_show", "page_patch", "page_update", "page_action"]);
const MAX_SEEN_PAGES = 24;

/** MCP tool name from a transcript item: Claude's mcp__scribe__page_show, OpenAI's page_show, Cursor's title. */
export function mcpToolName(item: { kind: string; name: string; title: string }): string {
  if (item.kind !== "tool") return "";
  const name = item.name;
  if (name.startsWith("mcp__")) return name.split("__").slice(2).join("__");
  if (PAGE_WRITE_TOOLS.has(name)) return name;
  const titled = /^Scribe:\s+(\S+)/.exec(item.title);
  return titled ? titled[1] : name;
}

/** key or id a successful page write named, so we can watch that page next turn. */
export function writePageRefs(items: Item[]): string[] {
  const refs: string[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "done") continue;
    if (!PAGE_WRITE_TOOLS.has(mcpToolName(item))) continue;
    const ref = pageRefFromInput(item.input);
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function pageRefFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.id === "string" && rec.id) return rec.id;
  if (typeof rec.key === "string" && rec.key) return rec.key;
  return null;
}

/** Last snapshots this thread recorded: the newest turn that has them, else pages those turns wrote. */
export function lastSeenPages(turns: Turn[]): PageSnapshot[] {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const seen = turns[i].seenPages;
    if (seen?.length) return seen;
  }
  const byId = new Map<string, PageSnapshot>();
  for (const turn of turns) {
    if (turn.page?.after == null) continue;
    byId.set(turn.page.id, {
      id: turn.page.id,
      key: "",
      title: turn.page.title,
      revision: turn.page.after,
      stateRevision: -1,
    });
  }
  return [...byId.values()];
}

/** Pages whose HTML or state changed since the last snapshot. Missing pages are skipped. */
export function pageEditsSince(seen: PageSnapshot[], current: PageSnapshot[]): PageEdit[] {
  const now = new Map(current.map((page) => [page.id, page]));
  const edits: PageEdit[] = [];
  for (const prev of seen) {
    const next = now.get(prev.id);
    if (!next) continue;
    const html = next.revision !== prev.revision;
    const state = prev.stateRevision >= 0 && next.stateRevision !== prev.stateRevision;
    if (html || state) edits.push({ from: prev, to: next, html, state });
  }
  return edits;
}

/**
 * Snapshots to keep on this turn: pages we just watched, then ones we already followed,
 * capped so a long thread does not accumulate every page it ever touched.
 */
export function rememberPages(watched: PageSnapshot[], prior: PageSnapshot[], limit = MAX_SEEN_PAGES): PageSnapshot[] {
  const out: PageSnapshot[] = [];
  const seen = new Set<string>();
  for (const page of [...watched, ...prior]) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    out.push(page);
    if (out.length >= limit) break;
  }
  return out;
}

/** Short note at the start of the next turn, so the agent re-reads instead of overwriting. */
export function pageEditsBlock(edits: PageEdit[]): string {
  if (!edits.length) return "";
  const lines = edits.map((edit) => {
    const title = edit.to.title || edit.from.title;
    const key = edit.to.key || edit.from.key;
    const named = key ? `"${title}" (${key})` : `"${title}"`;
    return `The user edited ${named} since your last turn (${revClause(edit)}); re-read it before changing it.`;
  });
  return `<context>\n${lines.join("\n")}\n</context>\n\n`;
}

function revClause(edit: PageEdit): string {
  const bits: string[] = [];
  if (edit.html) bits.push(`rev ${edit.from.revision} → ${edit.to.revision}`);
  if (edit.state) bits.push(`state rev ${edit.from.stateRevision} → ${edit.to.stateRevision}`);
  return bits.join(", ");
}
