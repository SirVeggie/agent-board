/**
 * One page_patch edit. Every kind writes newString:
 * - oldString: replace an exact snippet (replaceAll for every match).
 * - startLine..endLine: replace those lines (1-based, inclusive), as numbered by page_read / page_grep.
 * - afterLine: insert newString as new lines after that line (0 = at the top).
 * - append: insert before the closing </body> (or at the end of a page without one), to build a page in parts.
 * Line numbers count against the HTML as the previous edits left it.
 */
export type HtmlEdit =
  | { oldString: string; newString: string; replaceAll?: boolean }
  | { startLine: number; endLine: number; newString: string }
  | { afterLine: number; newString: string }
  | { append: true; newString: string };

export type HtmlEditResult = {
  html: string;
  applied: number;
};

export class HtmlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlEditError";
  }
}

export class RevisionConflictError extends Error {
  constructor(expected: number, actual: number, note?: string) {
    super(
      `tab changed since revision ${expected} (now ${actual}).${note ? ` ${note}` : ""} page_read it again (toFile: true for a fresh checkout) and reapply your change.`
    );
    this.name = "RevisionConflictError";
  }
}

export function assertRevision(actual: number, expected: number | undefined, note?: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new RevisionConflictError(expected, actual, note);
  }
}

const EDITS_REQUIRED =
  "edits is required (a non-empty array of { oldString, newString }, { startLine, endLine, newString }, { afterLine, newString } or { append: true, newString })";

export function parseHtmlEdits(value: unknown): HtmlEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HtmlEditError(EDITS_REQUIRED);
  }
  return value.map((item, index) => {
    const n = index + 1;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HtmlEditError(`edit ${n}: must be an object with newString and one of oldString, startLine/endLine, afterLine or append`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.newString !== "string") {
      throw new HtmlEditError(`edit ${n}: newString must be a string`);
    }
    const kinds = [
      rec.oldString !== undefined && "oldString",
      (rec.startLine !== undefined || rec.endLine !== undefined) && "startLine/endLine",
      rec.afterLine !== undefined && "afterLine",
      rec.append !== undefined && "append",
    ].filter(Boolean);
    if (kinds.length !== 1) {
      throw new HtmlEditError(
        kinds.length
          ? `edit ${n}: pass only one of ${kinds.join(", ")}`
          : `edit ${n}: pass oldString, startLine/endLine, afterLine or append`
      );
    }
    if (rec.oldString !== undefined) {
      if (typeof rec.oldString !== "string") {
        throw new HtmlEditError(`edit ${n}: oldString must be a string`);
      }
      if (rec.replaceAll !== undefined && typeof rec.replaceAll !== "boolean") {
        throw new HtmlEditError(`edit ${n}: replaceAll must be a boolean`);
      }
      return {
        oldString: rec.oldString,
        newString: rec.newString,
        ...(rec.replaceAll === true ? { replaceAll: true } : {}),
      };
    }
    if (rec.replaceAll !== undefined) {
      throw new HtmlEditError(`edit ${n}: replaceAll only goes with oldString`);
    }
    if (rec.afterLine !== undefined) {
      return { afterLine: lineNumber(rec.afterLine, n, "afterLine"), newString: rec.newString };
    }
    if (rec.append !== undefined) {
      if (rec.append !== true) {
        throw new HtmlEditError(`edit ${n}: append must be true`);
      }
      return { append: true, newString: rec.newString };
    }
    return {
      startLine: lineNumber(rec.startLine, n, "startLine"),
      endLine: lineNumber(rec.endLine, n, "endLine"),
      newString: rec.newString,
    };
  });
}

function lineNumber(value: unknown, n: number, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HtmlEditError(`edit ${n}: ${name} must be an integer line number`);
  }
  return value;
}

export function applyEdits(html: string, edits: HtmlEdit[]): HtmlEditResult {
  if (!edits.length) {
    throw new HtmlEditError(EDITS_REQUIRED);
  }
  let next = toLf(html);
  let applied = 0;
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    const n = i + 1;
    const newString = toLf(edit.newString);
    if ("oldString" in edit) {
      const oldString = toLf(edit.oldString);
      if (!oldString) {
        throw new HtmlEditError(`edit ${n}: oldString must not be empty`);
      }
      const matches = countNonOverlapping(next, oldString);
      if (matches === 0) {
        throw new HtmlEditError(`edit ${n}: oldString not found. ${describeMiss(next, oldString)}`);
      }
      if (!edit.replaceAll && matches > 1) {
        throw new HtmlEditError(
          `edit ${n}: oldString matched ${matches} times. Add more surrounding context to match exactly once, or pass replaceAll: true to change every match.`
        );
      }
      if (edit.replaceAll) {
        next = next.split(oldString).join(newString);
        applied += matches;
      } else {
        const at = next.indexOf(oldString);
        next = next.slice(0, at) + newString + next.slice(at + oldString.length);
        applied += 1;
      }
    } else if ("append" in edit) {
      next = appendToBody(next, newString);
      applied += 1;
    } else {
      const lines = next.split("\n");
      const total = lines.length;
      let start: number;
      let removed: number;
      if ("afterLine" in edit) {
        if (edit.afterLine < 0 || edit.afterLine > total) {
          throw new HtmlEditError(`edit ${n}: afterLine ${edit.afterLine} is outside the page (0–${total}; it has ${total} lines)`);
        }
        start = edit.afterLine;
        removed = 0;
      } else {
        if (edit.startLine < 1 || edit.endLine < edit.startLine || edit.endLine > total) {
          throw new HtmlEditError(
            `edit ${n}: lines ${edit.startLine}–${edit.endLine} are not a range in the page (1–${total}). Line numbers count against the page as earlier edits left it; list line edits bottom to top.`
          );
        }
        start = edit.startLine - 1;
        removed = edit.endLine - edit.startLine + 1;
      }
      // Empty newString on a line range deletes the lines rather than leaving a blank one.
      const inserted = newString === "" ? [] : newString.replace(/\n$/, "").split("\n");
      lines.splice(start, removed, ...inserted);
      next = lines.join("\n");
      applied += 1;
    }
  }
  if (!next.trim()) {
    throw new HtmlEditError("patch would leave the page empty");
  }
  return { html: next, applied };
}

/** Before the last </body>, on its own line, so parts land inside the page's body in order. */
function appendToBody(html: string, part: string): string {
  const block = part.endsWith("\n") ? part : `${part}\n`;
  const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  const head = at === -1 ? html : html.slice(0, at);
  const tail = at === -1 ? "" : html.slice(at);
  return `${head}${head === "" || head.endsWith("\n") ? "" : "\n"}${block}${tail}`;
}

/** Pages are stored with LF line endings so numbered windows, grep lines and copied oldStrings all agree. */
export function toLf(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

const MISS_EXCERPT_CHARS = 80;
/** Prefixes shorter than this match almost anywhere, so they say nothing about where the snippet went wrong. */
const MIN_USEFUL_PREFIX = 12;

/** Explain a miss by the longest prefix of `needle` that does occur, and where the stored text diverges from it. */
export function describeMiss(haystack: string, needle: string): string {
  const matched = longestPresentPrefix(haystack, needle);
  if (matched < MIN_USEFUL_PREFIX) {
    return "No meaningful part of it is in the stored HTML. Check that this is the right page, or page_read it (fragments are stored wrapped in a full document).";
  }
  const prefix = needle.slice(0, matched);
  const at = haystack.indexOf(prefix);
  const divergeAt = at + matched;
  const line = lineOf(haystack, divergeAt);
  const places = countNonOverlapping(haystack, prefix);
  const where = places > 1 ? ` (first of ${places} places it appears)` : "";
  return [
    `The first ${matched} of ${needle.length} chars match at line ${line} of the stored HTML${where}, then it diverges.`,
    `Stored text continues: ${JSON.stringify(haystack.slice(divergeAt, divergeAt + MISS_EXCERPT_CHARS))}`,
    `oldString expects:     ${JSON.stringify(needle.slice(matched, matched + MISS_EXCERPT_CHARS))}`,
  ].join("\n");
}

/** Every prefix of a present prefix is also present, so the length can be binary searched. */
function longestPresentPrefix(haystack: string, needle: string): number {
  let lo = 0;
  let hi = needle.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (haystack.includes(needle.slice(0, mid))) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) {
    line += 1;
  }
  return line;
}

function countNonOverlapping(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      break;
    }
    count += 1;
    from = at + needle.length;
  }
  return count;
}
