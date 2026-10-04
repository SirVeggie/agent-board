/**
 * Line-shaped views of a page's HTML for page_read windows and page_grep, so an agent can
 * read and search a large page the way it would a file, without pulling the whole body.
 */

/** page_read without a range refuses pages over this size and returns an outline instead. */
export const FULL_READ_MAX_BYTES = 24_000;
export const DEFAULT_READ_LINES = 400;
const OUTLINE_MAX = 80;
const OUTLINE_TEXT = 90;
export const DEFAULT_GREP_MATCHES = 50;

export function splitLines(html: string): string[] {
  return html.split(/\r?\n/);
}

/** `cat -n` style: right-aligned number, tab, line. */
export function numberLines(lines: string[], first: number): string {
  const width = String(first + lines.length - 1).length;
  return lines.map((line, i) => `${String(first + i).padStart(width, " ")}\t${line}`).join("\n");
}

export type LineWindow = {
  /** 1-based first line returned. */
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
};

/** Lines offset..offset+limit-1 (1-based). An offset past the end is an error, not an empty read. */
export function readWindow(html: string, opts: { offset?: number; limit?: number; numbered?: boolean }): LineWindow {
  const lines = splitLines(html);
  const total = lines.length;
  const offset = Math.max(1, Math.floor(opts.offset ?? 1));
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_READ_LINES));
  if (offset > total) {
    throw new RangeError(`offset ${offset} is past the end of the page (${total} lines)`);
  }
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  return {
    startLine: offset,
    endLine: offset + slice.length - 1,
    totalLines: total,
    text: opts.numbered === false ? slice.join("\n") : numberLines(slice, offset),
  };
}

export type OutlineEntry = { line: number; text: string };

const OUTLINE_RE = /<(h[1-4]|section|main|nav|header|footer|article|aside|form|table|script|style|template)\b[^>]*>/i;

/** Landmarks a reader can jump to with offset: headings, sections, script and style blocks. */
export function outline(html: string): { entries: OutlineEntry[]; more: number } {
  const lines = splitLines(html);
  const entries: OutlineEntry[] = [];
  let found = 0;
  lines.forEach((line, i) => {
    const m = OUTLINE_RE.exec(line);
    if (!m) {
      return;
    }
    found += 1;
    if (entries.length >= OUTLINE_MAX) {
      return;
    }
    entries.push({ line: i + 1, text: describeLandmark(line, m) });
  });
  return { entries, more: found - entries.length };
}

function describeLandmark(line: string, m: RegExpExecArray): string {
  const tag = m[1].toLowerCase();
  const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
  const label = `<${tag}${id ? `#${id}` : ""}>`;
  if (/^h[1-4]$/.test(tag)) {
    const rest = line.slice(m.index + m[0].length);
    const text = rest.replace(/<\/h[1-4]>[\s\S]*$/i, "").replace(/<[^>]+>/g, "").trim();
    return `${label} ${clip(text)}`.trim();
  }
  return label;
}

function clip(text: string): string {
  return text.length > OUTLINE_TEXT ? `${text.slice(0, OUTLINE_TEXT)}…` : text;
}

export class GrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrepError";
  }
}

export type GrepResult = {
  matches: number;
  /** Matches beyond maxMatches that were counted but not shown. */
  omitted: number;
  totalLines: number;
  /** grep -n style: `12:` on a match, `11-` on context, `--` between separate hunks. */
  text: string;
};

export function grepLines(
  html: string,
  pattern: string,
  opts: { literal?: boolean; ignoreCase?: boolean; context?: number; maxMatches?: number } = {}
): GrepResult {
  if (!pattern) {
    throw new GrepError("pattern is required");
  }
  let re: RegExp;
  try {
    re = new RegExp(opts.literal ? escapeRegExp(pattern) : pattern, opts.ignoreCase ? "i" : "");
  } catch (err) {
    throw new GrepError(`invalid regex: ${(err as Error).message}. Pass literal: true to search for the text as is.`);
  }
  const lines = splitLines(html);
  const context = Math.max(0, Math.min(20, Math.floor(opts.context ?? 0)));
  const max = Math.max(1, Math.floor(opts.maxMatches ?? DEFAULT_GREP_MATCHES));
  const hits: number[] = [];
  let matches = 0;
  lines.forEach((line, i) => {
    if (re.test(line)) {
      matches += 1;
      if (hits.length < max) {
        hits.push(i);
      }
    }
  });
  const width = String(lines.length).length;
  const hitSet = new Set(hits);
  const out: string[] = [];
  let last = -1;
  for (const hit of hits) {
    const from = Math.max(0, hit - context, last + 1);
    const to = Math.min(lines.length - 1, hit + context);
    if (last >= 0 && from > last + 1) {
      out.push("--");
    }
    for (let i = from; i <= to; i += 1) {
      out.push(`${String(i + 1).padStart(width, " ")}${hitSet.has(i) ? ":" : "-"}${lines[i]}`);
    }
    last = Math.max(last, to);
  }
  return { matches, omitted: matches - hits.length, totalLines: lines.length, text: out.join("\n") };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
