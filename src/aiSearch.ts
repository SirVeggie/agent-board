import { htmlToText } from "./librarySearch.js";
import type { Tab } from "./types.js";

/**
 * Palette AI search (`?`, #245): one completion that picks the pages that fit a question. With semantic
 * search on (#374) the model gets the passages closest to the question, so it sees text deep in a page;
 * otherwise a short digest of every page. It answers with the numbers of the lines that fit, each with a
 * one-line reason.
 */

/** Characters of page text and state in one digest. */
export const DIGEST_TEXT = 300;
/** Pages sent at most, newest change first; the rest are left out. */
export const DIGEST_MAX_PAGES = 600;
export const AI_SEARCH_MAX_HITS = 8;
export const AI_QUERY_MAX = 500;
/** Passages sent when semantic search is on, best first. */
export const AI_CHUNKS = 30;
/** Characters of one passage's text. */
export const CHUNK_TEXT = 500;

/** `index` is the place in the numbered list of the line the model picked. */
export type AiSearchHit = { id: string; reason: string; index: number };

/** String values in a page's state, without ids, asset refs, and other machine values. */
function stateWords(value: unknown, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (text.length < 3 || /^[a-z]{1,4}_[a-z0-9]+$/i.test(text) || /^(asset|data|https?):/.test(text) || /^#[0-9a-f]{3,8}$/i.test(text)) return;
    out.push(text);
    budget.left -= text.length + 1;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stateWords(item, out, budget);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "images" || key === "assets" || key === "workerLog") continue;
      stateWords(item, out, budget);
    }
  }
}

/** One line per page: title, folder, and the start of its text and state. */
export function pageDigest(tab: Tab, folder: string | null): string {
  const text = htmlToText(tab.html).replace(/\s+/g, " ").trim();
  const words: string[] = [];
  stateWords(tab.state, words, { left: DIGEST_TEXT });
  const body = [text, words.join(" · ")].filter(Boolean).join(" | ").slice(0, DIGEST_TEXT);
  const head = [tab.title || tab.key, folder ? `folder: ${folder}` : ""].filter(Boolean).join(" — ");
  return `${head}${body ? `: ${body}` : ""}`;
}

/** Newest change first, capped at DIGEST_MAX_PAGES. */
export function digestPages(tabs: Tab[]): Tab[] {
  return [...tabs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DIGEST_MAX_PAGES);
}

export function aiSearchPrompt(query: string, digests: string[]): string {
  return [
    "You help someone find pages in their personal page library. Each page below is one line: [number] title, folder, then the start of its text.",
    "",
    ...digests.map((line, i) => `[${i + 1}] ${line}`),
    "",
    `They are looking for: ${query}`,
    "",
    `Answer with the pages that best fit, best first, at most ${AI_SEARCH_MAX_HITS}. Leave out pages that don't fit; an empty list is fine.`,
    'Reply with JSON only, no other text: [{"n": <page number>, "why": "<one short line on why it fits>"}]',
  ].join("\n");
}

/** One line per passage: page title, folder, the section or item it is from, then its text. */
export function chunkDigest(page: { title: string; folder: string | null }, chunk: { kind: string; label: string; text: string }): string {
  const from = chunk.kind === "page" || !chunk.label || chunk.label === page.title ? "" : `${chunk.kind === "section" ? "section" : "item"}: ${chunk.label}`;
  const head = [page.title, page.folder ? `folder: ${page.folder}` : "", from].filter(Boolean).join(" — ");
  const body = chunk.text.replace(/\s+/g, " ").trim().slice(0, CHUNK_TEXT);
  return `${head}${body ? `: ${body}` : ""}`;
}

export function aiChunkPrompt(query: string, digests: string[]): string {
  return [
    "You help someone find pages in their personal page library. Each line below is one passage from their pages, picked as the closest to what they asked: [number] page title, folder, the section or item it is from, then its text. Several passages can be from the same page.",
    "",
    ...digests.map((line, i) => `[${i + 1}] ${line}`),
    "",
    `They are looking for: ${query}`,
    "",
    `Answer with the passages that best fit, best first, at most ${AI_SEARCH_MAX_HITS}, and one passage per page. Leave out passages that don't fit; an empty list is fine.`,
    'Reply with JSON only, no other text: [{"n": <passage number>, "why": "<one short line on why it fits>"}]',
  ].join("\n");
}

/** Read the model's answer, tolerating a code fence or text around the JSON. Unknown numbers and repeats (a second line of the same page) are dropped. */
export function parseAiHits(reply: string, ids: string[]): AiSearchHit[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("the model's answer had no result list");
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new Error("the model's answer was not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("the model's answer was not a list");
  const seen = new Set<string>();
  const hits: AiSearchHit[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const n = Number((item as { n?: unknown }).n);
    const id = Number.isInteger(n) ? ids[n - 1] : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const why = (item as { why?: unknown }).why;
    hits.push({ id, index: n - 1, reason: typeof why === "string" ? why.replace(/\s+/g, " ").trim().slice(0, 200) : "" });
    if (hits.length >= AI_SEARCH_MAX_HITS) break;
  }
  return hits;
}
