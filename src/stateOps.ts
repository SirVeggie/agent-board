/**
 * Edits to a page's JSON state as a list of ops. Agents and pages both write this way, the
 * daemon applies the ops to the latest state, and viewers receive the same ops as a delta.
 *
 * A path is a "/"-separated list of segments ("~1" is a literal "/", "~0" a literal "~").
 * On an object a segment is a key. On an array it picks one item: "c_12ab" matches the item
 * whose `id` is that value, "num=31" the first item whose `num` field equals 31 (compared as
 * text), and "#3" the item at index 3. The empty path is the whole state (only for set and test).
 *
 * Everything lives in createStateOps so the page bridge can embed the very same code with
 * Function.prototype.toString. Keep it free of imports and outside references (bridge.ts
 * stubs esbuild's __name helper, which tsx adds in dev mode).
 */

export type StatePosition = {
  /** Selector of an item in the same array to place the item before or after. */
  before?: string;
  after?: string;
  /** "start", "end", or an index. */
  at?: "start" | "end" | number;
};

export type StateOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "merge"; path: string; value: Record<string, unknown> }
  | { op: "remove"; path: string }
  | ({ op: "insert"; path: string; value: unknown } & StatePosition)
  | ({ op: "move"; path: string } & StatePosition)
  | { op: "test"; path: string; value?: unknown };

export type SkippedOp = { index: number; op: unknown; error: string };

export type ApplyResult = {
  state: Record<string, unknown>;
  /** The ops that took effect, in order. Replaying them on the old state gives the new one. */
  applied: StateOp[];
  /** Lenient mode only: ops that failed and were left out. */
  skipped: SkippedOp[];
};

export const STATE_OP_NAMES = ["set", "merge", "remove", "insert", "move", "test"] as const;

export function createStateOps() {
  type Json = Record<string, unknown>;
  type Op = { op: string; path: string; value?: unknown; before?: string; after?: string; at?: unknown };

  function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function escapeSegment(segment: string): string {
    return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
  }

  function splitPath(path: string): string[] {
    if (typeof path !== "string") {
      throw new Error("path must be a string");
    }
    return path
      .split("/")
      .filter((part) => part !== "")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  }

  function joinPath(parts: string[]): string {
    return parts.map(escapeSegment).join("/");
  }

  /** Index of the array item a selector picks, or -1. */
  function findIndex(list: unknown[], selector: string): number {
    if (/^#\d+$/.test(selector)) {
      const index = Number(selector.slice(1));
      return index < list.length ? index : -1;
    }
    const eq = selector.indexOf("=");
    if (eq > 0) {
      const field = selector.slice(0, eq);
      const want = selector.slice(eq + 1);
      return list.findIndex((item) => isObject(item) && item[field] !== undefined && item[field] !== null && String(item[field]) === want);
    }
    return list.findIndex((item) => isObject(item) && item.id !== undefined && String(item.id) === selector);
  }

  function child(container: unknown, segment: string, where: string): unknown {
    if (Array.isArray(container)) {
      const index = findIndex(container, segment);
      if (index === -1) {
        throw new Error(`no item matches "${segment}" in ${where || "state"}`);
      }
      return container[index];
    }
    if (isObject(container)) {
      if (!Object.prototype.hasOwnProperty.call(container, segment)) {
        throw new Error(`no key "${segment}" in ${where || "state"}`);
      }
      return container[segment];
    }
    throw new Error(`${where || "state"} is not an object or array`);
  }

  /** The value at a path. Throws naming the first segment that did not resolve. */
  function getAt(state: unknown, path: string): unknown {
    let current = state;
    const done: string[] = [];
    for (const segment of splitPath(path)) {
      current = child(current, segment, joinPath(done));
      done.push(segment);
    }
    return current;
  }

  /** Items of an array whose fields equal every entry of `where` (compared as text). */
  function filterItems(value: unknown, where: Record<string, unknown>): unknown[] {
    if (!Array.isArray(value)) {
      throw new Error("where only applies to an array");
    }
    const entries = Object.entries(where);
    return value.filter(
      (item) =>
        isObject(item) &&
        entries.every(([field, want]) => item[field] !== undefined && item[field] !== null && String(item[field]) === String(want))
    );
  }

  function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
      return true;
    }
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
      return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      return false;
    }
    if (Array.isArray(a)) {
      const other = b as unknown[];
      return a.length === other.length && a.every((item, i) => deepEqual(item, other[i]));
    }
    const ak = Object.keys(a as Json);
    const bk = Object.keys(b as Json);
    return ak.length === bk.length && ak.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual((a as Json)[key], (b as Json)[key]));
  }

  function clone<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  }

  /**
   * Where an insert or move lands. An anchor that no longer exists (another writer removed it)
   * falls back to the end, so a rebased page edit never loses the item it was placing.
   */
  function positionIndex(list: unknown[], op: Op): number {
    const given = [op.before, op.after, op.at].filter((v) => v !== undefined).length;
    if (given > 1) {
      throw new Error("pass only one of before, after, at");
    }
    if (op.before !== undefined || op.after !== undefined) {
      const index = findIndex(list, String(op.before ?? op.after));
      if (index === -1) {
        return list.length;
      }
      return op.before !== undefined ? index : index + 1;
    }
    if (op.at === "start") {
      return 0;
    }
    if (op.at === undefined || op.at === "end") {
      return list.length;
    }
    if (typeof op.at !== "number" || !Number.isInteger(op.at) || op.at < 0) {
      throw new Error(`at must be "start", "end" or an index`);
    }
    return Math.min(op.at, list.length);
  }

  /** Apply one op in place. Throws before changing anything when the op cannot apply. */
  function applyOne(root: { state: Json }, op: Op): void {
    if (!isObject(op)) {
      throw new Error("an op must be an object");
    }
    const parts = splitPath(op.path);
    if (op.op === "test") {
      let actual: unknown;
      try {
        actual = parts.length ? getAt(root.state, op.path) : root.state;
      } catch {
        actual = undefined;
      }
      if (!deepEqual(actual ?? null, op.value ?? null)) {
        throw new Error(`test failed: ${op.path || "state"} is ${JSON.stringify(actual ?? null)}`);
      }
      return;
    }
    if (!parts.length) {
      if (op.op !== "set" || !isObject(op.value)) {
        throw new Error("the empty path only takes set with an object value");
      }
      root.state = clone(op.value);
      return;
    }
    const last = parts[parts.length - 1];
    const parentPath = joinPath(parts.slice(0, -1));
    const parent = parentPath ? getAt(root.state, parentPath) : root.state;
    const where = parentPath || "state";
    switch (op.op) {
      case "set": {
        if (op.value === undefined) {
          throw new Error("set needs a value");
        }
        if (Array.isArray(parent)) {
          const index = findIndex(parent, last);
          if (index === -1) {
            throw new Error(`no item matches "${last}" in ${where}`);
          }
          parent[index] = clone(op.value);
        } else if (isObject(parent)) {
          parent[last] = clone(op.value);
        } else {
          throw new Error(`${where} is not an object or array`);
        }
        return;
      }
      case "merge": {
        if (!isObject(op.value)) {
          throw new Error("merge needs an object value");
        }
        const target = child(parent, last, parentPath);
        if (!isObject(target)) {
          throw new Error(`${op.path} is not an object`);
        }
        for (const [key, value] of Object.entries(op.value)) {
          // null removes a key, so a merge can clear a field (e.g. a card's status).
          if (value === null) {
            delete target[key];
          } else {
            target[key] = clone(value);
          }
        }
        return;
      }
      case "remove": {
        if (Array.isArray(parent)) {
          const index = findIndex(parent, last);
          if (index === -1) {
            throw new Error(`no item matches "${last}" in ${where}`);
          }
          parent.splice(index, 1);
        } else if (isObject(parent)) {
          if (!Object.prototype.hasOwnProperty.call(parent, last)) {
            throw new Error(`no key "${last}" in ${where}`);
          }
          delete parent[last];
        } else {
          throw new Error(`${where} is not an object or array`);
        }
        return;
      }
      case "insert": {
        if (op.value === undefined) {
          throw new Error("insert needs a value");
        }
        // The path names the array itself. A missing array on an object is created.
        const exists = isObject(parent) ? Object.prototype.hasOwnProperty.call(parent, last) : true;
        const list = exists ? child(parent, last, parentPath) : [];
        if (!Array.isArray(list)) {
          throw new Error(`${op.path} is not an array`);
        }
        const value = op.value;
        if (isObject(value) && value.id !== undefined && list.some((item) => isObject(item) && item.id !== undefined && String(item.id) === String(value.id))) {
          throw new Error(`${op.path} already has an item with id "${String(value.id)}"`);
        }
        const index = positionIndex(list, op);
        if (!exists) {
          (parent as Json)[last] = list;
        }
        list.splice(index, 0, clone(value));
        return;
      }
      case "move": {
        if (!Array.isArray(parent)) {
          throw new Error(`${where} is not an array`);
        }
        const from = findIndex(parent, last);
        if (from === -1) {
          throw new Error(`no item matches "${last}" in ${where}`);
        }
        const [item] = parent.splice(from, 1);
        let index: number;
        try {
          index = positionIndex(parent, op);
        } catch (err) {
          parent.splice(from, 0, item);
          throw err;
        }
        parent.splice(index, 0, item);
        return;
      }
      default:
        throw new Error(`unknown op "${String(op.op)}"; use set, merge, remove, insert, move or test`);
    }
  }

  /**
   * Apply ops in order to a copy of state. Strict (the default): all or nothing, and the first
   * failing op throws naming its index. Lenient: failing ops are skipped and reported, the rest
   * apply. Pages write leniently so a concurrent change to one item never drops their other edits.
   */
  function apply(state: Json, ops: unknown[], options?: { lenient?: boolean }): ApplyResult {
    if (!Array.isArray(ops)) {
      throw new Error("ops must be an array");
    }
    const lenient = Boolean(options && options.lenient);
    const root = { state: clone(state) };
    const applied: StateOp[] = [];
    const skipped: SkippedOp[] = [];
    ops.forEach((raw, index) => {
      const op = raw as Op;
      if (lenient) {
        // Each op gets a scratch copy, so a failure halfway through one can't leave a partial edit.
        const scratch = { state: clone(root.state) };
        try {
          applyOne(scratch, op);
          root.state = scratch.state;
          applied.push(op as StateOp);
        } catch (err) {
          skipped.push({ index, op, error: (err as Error).message });
        }
        return;
      }
      try {
        applyOne(root, op);
        applied.push(op as StateOp);
      } catch (err) {
        const label = isObject(op) ? `${String(op.op)} ${String(op.path)}` : "op";
        throw new Error(`ops[${index}] (${label}): ${(err as Error).message}`);
      }
    });
    return { state: root.state, applied, skipped };
  }

  /** An array whose items are all objects with distinct ids, so items can be addressed by id. */
  function keyedIds(list: unknown[]): string[] | null {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (!isObject(item) || (typeof item.id !== "string" && typeof item.id !== "number")) {
        return null;
      }
      const id = String(item.id);
      if (seen.has(id)) {
        return null;
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  /** Indexes (into `seq`) of a longest increasing subsequence. */
  function longestIncreasing(seq: number[]): Set<number> {
    const tails: number[] = [];
    const prev: number[] = new Array(seq.length).fill(-1);
    for (let i = 0; i < seq.length; i += 1) {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (seq[tails[mid]] < seq[i]) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[i] = tails[lo - 1];
      tails[lo] = i;
    }
    const keep = new Set<number>();
    let k = tails.length ? tails[tails.length - 1] : -1;
    while (k !== -1) {
      keep.add(k);
      k = prev[k];
    }
    return keep;
  }

  function diffArray(parts: string[], before: unknown[], after: unknown[], out: Op[]): void {
    const oldIds = keyedIds(before);
    const newIds = keyedIds(after);
    // Only arrays of id'd items (and an empty one turning into one) can be edited item by item.
    if (!oldIds || !newIds || (!oldIds.length && !newIds.length)) {
      out.push({ op: "set", path: joinPath(parts), value: clone(after) });
      return;
    }
    const path = joinPath(parts);
    const sel = (id: string) => `id=${id}`;
    const newSet = new Set(newIds);
    const oldIndex = new Map(oldIds.map((id, i) => [id, i]));
    for (const id of oldIds) {
      if (!newSet.has(id)) {
        out.push({ op: "remove", path: joinPath([...parts, sel(id)]) });
      }
    }
    // Items kept in the same relative order stay put; everything else moves after its new predecessor.
    const kept = newIds.filter((id) => oldIndex.has(id));
    const stable = longestIncreasing(kept.map((id) => oldIndex.get(id) as number));
    const stay = new Set(kept.filter((_id, i) => stable.has(i)));
    newIds.forEach((id, i) => {
      const position = i === 0 ? { at: "start" } : { after: sel(newIds[i - 1]) };
      if (!oldIndex.has(id)) {
        out.push({ op: "insert", path, value: clone(after[i]), ...position });
        return;
      }
      if (!stay.has(id)) {
        out.push({ op: "move", path: joinPath([...parts, sel(id)]), ...position });
      }
      diffValue([...parts, sel(id)], before[oldIndex.get(id) as number], after[i], out);
    });
  }

  function diffValue(parts: string[], before: unknown, after: unknown, out: Op[]): void {
    if (deepEqual(before, after)) {
      return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      diffArray(parts, before, after, out);
      return;
    }
    if (isObject(before) && isObject(after) && parts.length) {
      const removed: Json = {};
      const changed: Json = {};
      let any = false;
      for (const key of Object.keys(before)) {
        if (!Object.prototype.hasOwnProperty.call(after, key)) {
          removed[key] = null;
          any = true;
        }
      }
      for (const key of Object.keys(after)) {
        const a = after[key];
        const b = before[key];
        if (deepEqual(a, b)) {
          continue;
        }
        // Nested arrays and objects are diffed deeper; plain fields go in one merge.
        if ((Array.isArray(a) && Array.isArray(b)) || (isObject(a) && isObject(b))) {
          diffValue([...parts, key], b, a, out);
        } else if (a === null) {
          // A merge reads null as "remove", so a field set to null needs a set of its own.
          out.push({ op: "set", path: joinPath([...parts, key]), value: null });
        } else {
          changed[key] = clone(a);
          any = true;
        }
      }
      if (any) {
        out.push({ op: "merge", path: joinPath(parts), value: { ...removed, ...changed } });
      }
      return;
    }
    out.push({ op: "set", path: joinPath(parts), value: clone(after) });
  }

  /**
   * Ops that turn `before` into `after` for the given top-level keys. Arrays of objects with
   * an `id` become item-level ops, so they merge with other writers' changes to other items.
   */
  function diff(before: Json, after: Json, keys?: string[]): Op[] {
    const out: Op[] = [];
    for (const key of keys ?? Object.keys(after)) {
      if (!Object.prototype.hasOwnProperty.call(after, key) || after[key] === undefined) {
        if (Object.prototype.hasOwnProperty.call(before, key)) {
          out.push({ op: "remove", path: escapeSegment(key) });
        }
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(before, key)) {
        out.push({ op: "set", path: escapeSegment(key), value: clone(after[key]) });
        continue;
      }
      diffValue([key], before[key], after[key], out);
    }
    return out;
  }

  return { apply, diff, getAt, filterItems, findIndex, splitPath, joinPath, escapeSegment, deepEqual, clone };
}

const engine = createStateOps();

export const applyOps = engine.apply;
export const diffState = engine.diff;
export const getAt = engine.getAt;
export const filterItems = engine.filterItems;
export const findIndex = engine.findIndex;
export const splitPath = engine.splitPath;
export const deepEqual = engine.deepEqual;

/** Strict apply that returns only the new state. */
export function applyStateOps(state: Record<string, unknown>, ops: unknown[]): Record<string, unknown> {
  return engine.apply(state, ops).state;
}
