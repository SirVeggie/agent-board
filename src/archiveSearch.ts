import type { Tab } from "./types.js";

export const ARCHIVE_PAGE_DEFAULT = 20;
export const ARCHIVE_PAGE_MAX = 50;

export type ArchiveSearchHit = {
  tab: Tab;
  snippet: string | null;
  score: number;
};

export type ArchiveSearchResult = {
  hits: ArchiveSearchHit[];
  returned: number;
  remaining: number;
  matchCount: number;
  archiveCount: number;
};

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function clampArchivePage(offset: unknown, limit: unknown): { offset: number; limit: number } {
  const off = typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const raw = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : ARCHIVE_PAGE_DEFAULT;
  return { offset: off, limit: Math.min(ARCHIVE_PAGE_MAX, Math.max(1, raw)) };
}

export function searchArchive(
  tabs: Tab[],
  query: string,
  offset: number,
  limit: number
): ArchiveSearchResult {
  const archiveCount = tabs.length;
  const q = query.trim();
  const ranked: ArchiveSearchHit[] = q
    ? tabs
        .map((tab) => scoreTab(tab, q))
        .filter((hit): hit is ArchiveSearchHit => hit !== null)
        .sort((a, b) => b.score - a.score || (b.tab.archivedAt ?? 0) - (a.tab.archivedAt ?? 0))
    : tabs.map((tab) => ({ tab, snippet: null, score: 0 }));

  const slice = ranked.slice(offset, offset + limit);
  return {
    hits: slice,
    returned: slice.length,
    remaining: Math.max(0, ranked.length - offset - slice.length),
    matchCount: ranked.length,
    archiveCount,
  };
}

function scoreTab(tab: Tab, query: string): ArchiveSearchHit | null {
  const title = normalize(tab.title);
  const key = normalize(tab.key);
  const body = normalize(htmlToText(tab.html));
  const hay = `${title} ${key} ${body}`;
  const q = normalize(query);
  const toks = q.split(/\s+/).filter(Boolean);
  if (!toks.length) {
    return { tab, snippet: null, score: 0 };
  }
  const titleSeq = subsequence(title, q.replace(/\s+/g, ""));
  const allInHay = toks.every((tok) => hay.includes(tok));
  if (!allInHay && !titleSeq) {
    return null;
  }
  let score = 0;
  if (title === q) {
    score += 100;
  }
  if (title.includes(q)) {
    score += 80;
  } else if (titleSeq) {
    score += 55;
  }
  if (toks.every((tok) => title.includes(tok))) {
    score += 40;
  }
  if (toks.every((tok) => key.includes(tok))) {
    score += 25;
  }
  if (toks.every((tok) => body.includes(tok))) {
    score += 10;
  }
  if (score === 0 && allInHay) {
    score = 1;
  }
  return { tab, snippet: makeSnippet(htmlToText(tab.html) || tab.title, toks[0] ?? q), score };
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}

function subsequence(hay: string, needle: string): boolean {
  if (!needle) {
    return true;
  }
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) {
      i += 1;
      if (i >= needle.length) {
        return true;
      }
    }
  }
  return false;
}

function makeSnippet(text: string, token: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  const lower = compact.toLowerCase();
  const needle = token.toLowerCase();
  const at = needle ? lower.indexOf(needle) : 0;
  const width = 160;
  if (at < 0) {
    return compact.slice(0, width) + (compact.length > width ? "…" : "");
  }
  const start = Math.max(0, at - 40);
  const end = Math.min(compact.length, start + width);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return prefix + compact.slice(start, end) + suffix;
}
