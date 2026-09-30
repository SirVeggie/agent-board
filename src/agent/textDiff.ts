/** Line diff (Myers) and unified patch output for per-tool file changes. */

type Op = { kind: " " | "-" | "+"; line: string };

const MAX_LINES = 20000;
/** Edit distance past which the diff gives up and shows a replace-all (keeps memory small). */
const MAX_EDITS = 2500;

export type TextDiff = { patch: string; added: number; removed: number };

export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Shortest edit script between two line arrays. Falls back to replace-all when the inputs are huge. */
export function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head: Op[] = a.slice(0, start).map((line) => ({ kind: " ", line }));
  const tail: Op[] = a.slice(endA).map((line) => ({ kind: " ", line }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length + midB.length > MAX_LINES) {
    return [...head, ...midA.map((line) => ({ kind: "-" as const, line })), ...midB.map((line) => ({ kind: "+" as const, line })), ...tail];
  }
  const middle = myers(midA, midB) ?? [...midA.map((line) => ({ kind: "-" as const, line })), ...midB.map((line) => ({ kind: "+" as const, line }))];
  return [...head, ...middle, ...tail];
}

/** Myers' diff keeping only each step's band of V, so memory is O(D²) for edit distance D. Null past MAX_EDITS. */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) {
    return b.map((line) => ({ kind: "+", line }));
  }
  if (m === 0) {
    return a.map((line) => ({ kind: "-", line }));
  }
  const max = n + m;
  // One slot of padding each side so the band [-d-1, d+1] always fits.
  const offset = max + 1;
  const v = new Int32Array(2 * max + 4);
  // trace[d] holds V[k] for k in [-d-1, d+1] as it was before step d; index k + d + 1.
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d += 1) {
    if (d > MAX_EDITS) return null;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        break outer;
      }
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const band = trace[d];
    const at = (k: number) => band[k + d + 1];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: "+", line: b[y - 1] });
        y -= 1;
      } else {
        ops.push({ kind: "-", line: a[x - 1] });
        x -= 1;
      }
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: " ", line: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** A git-style unified diff for one file. Empty patch when nothing changed. */
export function unifiedDiff(oldText: string | null, newText: string | null, file: string, context = 3): TextDiff {
  const a = splitLines(oldText ?? "");
  const b = splitLines(newText ?? "");
  const ops = diffLines(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added += 1;
    else if (op.kind === "-") removed += 1;
  }
  if (!added && !removed) {
    return { patch: "", added, removed };
  }
  const name = file.replaceAll("\\", "/");
  const header = [
    `diff --git a/${name} b/${name}`,
    oldText === null ? "new file" : newText === null ? "deleted file" : null,
    `--- ${oldText === null ? "/dev/null" : `a/${name}`}`,
    `+++ ${newText === null ? "/dev/null" : `b/${name}`}`,
  ].filter(Boolean) as string[];
  const hunks: string[] = [];
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  // Walk the ops, emitting hunks around changed runs with `context` lines each side.
  const positions: Array<{ a: number; b: number }> = [];
  for (const op of ops) {
    positions.push({ a: aLine, b: bLine });
    if (op.kind !== "+") aLine += 1;
    if (op.kind !== "-") bLine += 1;
  }
  while (i < ops.length) {
    while (i < ops.length && ops[i].kind === " ") i += 1;
    if (i >= ops.length) break;
    const hunkStart = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length) {
      if (ops[end].kind !== " ") {
        lastChange = end;
      } else if (end - lastChange > context * 2) {
        break;
      }
      end += 1;
    }
    const hunkEnd = Math.min(ops.length, lastChange + context + 1);
    const slice = ops.slice(hunkStart, hunkEnd);
    const aStart = positions[hunkStart].a;
    const bStart = positions[hunkStart].b;
    const aCount = slice.filter((op) => op.kind !== "+").length;
    const bCount = slice.filter((op) => op.kind !== "-").length;
    hunks.push(`@@ -${aCount ? aStart : aStart - 1},${aCount} +${bCount ? bStart : bStart - 1},${bCount} @@`);
    for (const op of slice) {
      hunks.push(op.kind + op.line);
    }
    i = hunkEnd;
  }
  return { patch: [...header, ...hunks].join("\n") + "\n", added, removed };
}

/** +/- line counts for an Edit-style old/new string pair. */
export function countChange(oldText: string, newText: string): { added: number; removed: number } {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added += 1;
    else if (op.kind === "-") removed += 1;
  }
  return { added, removed };
}
