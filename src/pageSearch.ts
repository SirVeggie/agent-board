import { htmlToText } from "./archiveSearch.js";
import type { Tab } from "./types.js";

export const PAGE_SEARCH_DEFAULT = 40;
export const PAGE_SEARCH_MAX = 80;

export type MatchLocation = "title" | "key" | "content" | "data";
export type MatchQuality = "phrase" | "ordered" | "all" | "partial";

export type PageSearchHit = {
  tab: Tab;
  archived: boolean;
  location: MatchLocation | null;
  quality: MatchQuality | null;
  matchedParts: number;
  totalParts: number;
  snippet: string | null;
};

export type PageSearchResult = {
  hits: PageSearchHit[];
  returned: number;
  matchCount: number;
};

const LOCATION_RANK: Record<MatchLocation, number> = {
  title: 0,
  key: 1,
  content: 2,
  data: 3,
};

const QUALITY_RANK: Record<MatchQuality, number> = {
  phrase: 0,
  ordered: 1,
  all: 2,
  partial: 3,
};

export function searchPages(
  open: Tab[],
  archived: Tab[],
  query: string,
  limit = PAGE_SEARCH_DEFAULT
): PageSearchResult {
  const raw = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : PAGE_SEARCH_DEFAULT;
  const lim = Math.min(PAGE_SEARCH_MAX, Math.max(1, raw));
  const q = query.trim();
  if (!q) {
    const all = [
      ...open.map((tab) => recentHit(tab, false)),
      ...archived.map((tab) => recentHit(tab, true)),
    ];
    const hits = all.slice(0, lim);
    return { hits, returned: hits.length, matchCount: all.length };
  }

  const parts = queryParts(q);
  const ranked = [...open.map((tab) => scoreTab(tab, q, parts, false)), ...archived.map((tab) => scoreTab(tab, q, parts, true))]
    .filter((hit): hit is PageSearchHit => hit !== null)
    .sort(compareHits);

  const hits = ranked.slice(0, lim);
  return { hits, returned: hits.length, matchCount: ranked.length };
}

export function locationLabel(location: MatchLocation): string {
  switch (location) {
    case "title":
      return "Title";
    case "key":
      return "Key";
    case "content":
      return "Content";
    case "data":
      return "Data";
    default: {
      const _never: never = location;
      return _never;
    }
  }
}

export function qualityLabel(quality: MatchQuality, matchedParts: number, totalParts: number): string {
  switch (quality) {
    case "phrase":
      return "Phrase";
    case "ordered":
      return "In order";
    case "all":
      return "All terms";
    case "partial":
      return `Partial ${matchedParts}/${totalParts}`;
    default: {
      const _never: never = quality;
      return _never;
    }
  }
}

function recentHit(tab: Tab, archived: boolean): PageSearchHit {
  return {
    tab,
    archived,
    location: null,
    quality: null,
    matchedParts: 0,
    totalParts: 0,
    snippet: null,
  };
}

function compareHits(a: PageSearchHit, b: PageSearchHit): number {
  const loc = locRank(a.location) - locRank(b.location);
  if (loc) {
    return loc;
  }
  const quality = qualityRank(a.quality) - qualityRank(b.quality);
  if (quality) {
    return quality;
  }
  if (a.quality === "partial" && b.quality === "partial") {
    const aRatio = a.totalParts ? a.matchedParts / a.totalParts : 0;
    const bRatio = b.totalParts ? b.matchedParts / b.totalParts : 0;
    if (aRatio !== bRatio) {
      return bRatio - aRatio;
    }
  }
  if (a.archived !== b.archived) {
    return a.archived ? 1 : -1;
  }
  return (b.tab.updatedAt ?? 0) - (a.tab.updatedAt ?? 0);
}

function locRank(location: MatchLocation | null): number {
  return location ? LOCATION_RANK[location] : 99;
}

function qualityRank(quality: MatchQuality | null): number {
  return quality ? QUALITY_RANK[quality] : 99;
}

function queryParts(query: string): string[] {
  return normalize(query)
    .split(/[\s,.]+/)
    .filter(Boolean);
}

function scoreTab(tab: Tab, query: string, parts: string[], archived: boolean): PageSearchHit | null {
  const fields: Array<{ location: MatchLocation; hay: string; raw: string }> = [
    { location: "title", hay: normalize(tab.title), raw: tab.title },
    { location: "key", hay: normalize(tab.key), raw: tab.key },
    { location: "content", hay: normalize(htmlToText(tab.html)), raw: htmlToText(tab.html) },
    { location: "data", hay: normalize(stateText(tab)), raw: stateText(tab) },
  ];

  for (const field of fields) {
    const match = matchField(field.hay, query, parts);
    if (!match) {
      continue;
    }
    return {
      tab,
      archived,
      location: field.location,
      quality: match.quality,
      matchedParts: match.matchedParts,
      totalParts: parts.length,
      snippet: snippetFor(field.location, tab.key, field.raw, query, parts),
    };
  }
  return null;
}

function snippetFor(
  location: MatchLocation,
  key: string,
  raw: string,
  query: string,
  parts: string[]
): string | null {
  switch (location) {
    case "title":
      return null;
    case "key":
      return key;
    case "content":
    case "data":
      return makeSnippet(raw, query, parts);
    default: {
      const _never: never = location;
      return _never;
    }
  }
}

function matchField(
  hay: string,
  query: string,
  parts: string[]
): { quality: MatchQuality; matchedParts: number } | null {
  const phrase = normalize(query);
  if (phrase && hay.includes(phrase)) {
    return { quality: "phrase", matchedParts: parts.length || 1 };
  }
  if (!parts.length) {
    return null;
  }
  if (partsInOrder(hay, parts)) {
    return { quality: "ordered", matchedParts: parts.length };
  }
  const matchedParts = parts.filter((part) => hay.includes(part)).length;
  if (matchedParts === parts.length) {
    return { quality: "all", matchedParts };
  }
  if (matchedParts / parts.length >= 0.5) {
    return { quality: "partial", matchedParts };
  }
  return null;
}

function partsInOrder(hay: string, parts: string[]): boolean {
  let from = 0;
  for (const part of parts) {
    const at = hay.indexOf(part, from);
    if (at === -1) {
      return false;
    }
    from = at + part.length;
  }
  return true;
}

function stateText(tab: Tab): string {
  try {
    return JSON.stringify(tab.state ?? {});
  } catch {
    return "";
  }
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}

function makeSnippet(text: string, query: string, parts: string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  const lower = compact.toLowerCase();
  const needles = [query.trim(), ...parts].filter(Boolean);
  let at = -1;
  let needleLen = 0;
  for (const needle of needles) {
    const found = lower.indexOf(needle.toLowerCase());
    if (found >= 0) {
      at = found;
      needleLen = needle.length;
      break;
    }
  }
  const width = 160;
  if (at < 0) {
    return compact.slice(0, width) + (compact.length > width ? "…" : "");
  }
  const start = Math.max(0, at - 40);
  const end = Math.min(compact.length, Math.max(start + width, at + needleLen + 20));
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return prefix + compact.slice(start, end) + suffix;
}
