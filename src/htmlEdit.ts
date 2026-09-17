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
      throw new HtmlEditError(
        `edit ${n}: oldString not found. Use board_read if you need the stored HTML (fragments are stored wrapped in a full document).`
      );
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
