export type HtmlEdit = {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

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
  constructor(expected: number, actual: number) {
    super(
      `tab changed since revision ${expected} (now ${actual}). board_read it again (toFile: true for a fresh checkout) and reapply your change.`
    );
    this.name = "RevisionConflictError";
  }
}

export function assertRevision(actual: number, expected: number | undefined): void {
  if (expected !== undefined && expected !== actual) {
    throw new RevisionConflictError(expected, actual);
  }
}

export function parseHtmlEdits(value: unknown): HtmlEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HtmlEditError("edits is required (a non-empty array of { oldString, newString })");
  }
  return value.map((item, index) => {
    const n = index + 1;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HtmlEditError(`edit ${n}: must be an object with oldString and newString`);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.oldString !== "string") {
      throw new HtmlEditError(`edit ${n}: oldString must be a string`);
    }
    if (typeof rec.newString !== "string") {
      throw new HtmlEditError(`edit ${n}: newString must be a string`);
    }
    if (rec.replaceAll !== undefined && typeof rec.replaceAll !== "boolean") {
      throw new HtmlEditError(`edit ${n}: replaceAll must be a boolean`);
    }
    return {
      oldString: rec.oldString,
      newString: rec.newString,
      ...(rec.replaceAll === true ? { replaceAll: true } : {}),
    };
  });
}

export function applyEdits(html: string, edits: HtmlEdit[]): HtmlEditResult {
  if (!edits.length) {
    throw new HtmlEditError("edits is required (a non-empty array of { oldString, newString })");
  }
  let next = html;
  let applied = 0;
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    const n = i + 1;
    if (!edit.oldString) {
      throw new HtmlEditError(`edit ${n}: oldString must not be empty`);
    }
    const matches = countNonOverlapping(next, edit.oldString);
    if (matches === 0) {
      throw new HtmlEditError(`edit ${n}: oldString not found. ${describeMiss(next, edit.oldString)}`);
    }
    if (!edit.replaceAll && matches > 1) {
      throw new HtmlEditError(
        `edit ${n}: oldString matched ${matches} times. Add more surrounding context to match exactly once, or pass replaceAll: true to change every match.`
      );
    }
    if (edit.replaceAll) {
      next = next.split(edit.oldString).join(edit.newString);
      applied += matches;
    } else {
      const at = next.indexOf(edit.oldString);
      next = next.slice(0, at) + edit.newString + next.slice(at + edit.oldString.length);
      applied += 1;
    }
  }
  if (!next.trim()) {
    throw new HtmlEditError("patch would leave the page empty");
  }
  return { html: next, applied };
}

const MISS_EXCERPT_CHARS = 80;
/** Prefixes shorter than this match almost anywhere, so they say nothing about where the snippet went wrong. */
const MIN_USEFUL_PREFIX = 12;

/** Explain a miss by the longest prefix of `needle` that does occur, and where the stored text diverges from it. */
export function describeMiss(haystack: string, needle: string): string {
  const matched = longestPresentPrefix(haystack, needle);
  if (matched < MIN_USEFUL_PREFIX) {
    return "No meaningful part of it is in the stored HTML. Check that this is the right page, or board_read it (fragments are stored wrapped in a full document).";
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
