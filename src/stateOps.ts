/**
 * Targeted edits to a page's JSON state, so an agent can change one item of a large array
 * (one kanban card, one todo) without sending the whole array back.
 *
 * A path is a "/"-separated list of segments. On an object a segment is a key. On an array it
 * picks one item: "c_12ab" matches the item whose `id` is that string, "num=31" the first item
 * whose `num` field equals 31 (compared as text), and "#3" the item at index 3.
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
  | ({ op: "move"; path: string } & StatePosition);

export const STATE_OP_NAMES = ["set", "merge", "remove", "insert", "move"] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function splitPath(path: string): string[] {
  if (typeof path !== "string") {
    throw new Error("path must be a string");
  }
  const parts = path.split("/").filter((part) => part !== "");
  if (!parts.length) {
    throw new Error("path is empty");
  }
  return parts;
}

/** Index of the array item a segment selects, or -1. */
export function findIndex(list: unknown[], selector: string): number {
  if (/^#\d+$/.test(selector)) {
    const index = Number(selector.slice(1));
    return index < list.length ? index : -1;
  }
  const eq = selector.indexOf("=");
  if (eq > 0) {
    const field = selector.slice(0, eq);
    const want = selector.slice(eq + 1);
    return list.findIndex((item) => isObject(item) && item[field] !== undefined && String(item[field]) === want);
  }
  return list.findIndex((item) => isObject(item) && item.id === selector);
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
    if (!(segment in container)) {
      throw new Error(`no key "${segment}" in ${where || "state"}`);
    }
    return container[segment];
  }
  throw new Error(`${where || "state"} is not an object or array`);
}

/** The value at a path. Throws with the first segment that did not resolve. */
export function getAt(state: unknown, path: string): unknown {
  let current = state;
  let where = "";
  for (const segment of splitPath(path)) {
    current = child(current, segment, where);
    where = where ? `${where}/${segment}` : segment;
  }
  return current;
}

/** Items of an array whose fields equal every entry of `where` (compared as text). */
export function filterItems(value: unknown, where: Record<string, unknown>): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("where only applies to an array");
  }
  const entries = Object.entries(where);
  return value.filter(
    (item) => isObject(item) && entries.every(([field, want]) => item[field] !== undefined && String(item[field]) === String(want))
  );
}

/** Resolve the parent container and the last segment of a path. */
function locateParent(state: Json, path: string): { parent: unknown; last: string; parentPath: string } {
  const parts = splitPath(path);
  const last = parts.pop() as string;
  const parentPath = parts.join("/");
  const parent = parentPath ? getAt(state, parentPath) : state;
  return { parent, last, parentPath };
}

function positionIndex(list: unknown[], pos: StatePosition, where: string): number {
  const given = [pos.before, pos.after, pos.at].filter((v) => v !== undefined).length;
  if (given > 1) {
    throw new Error("pass only one of before, after, at");
  }
  if (pos.before !== undefined || pos.after !== undefined) {
    const selector = (pos.before ?? pos.after) as string;
    const index = findIndex(list, selector);
    if (index === -1) {
      // An empty group (e.g. "col=done" with no cards yet) falls back to the end.
      if (selector.includes("=")) {
        return list.length;
      }
      throw new Error(`no item matches "${selector}" in ${where}`);
    }
    return pos.before !== undefined ? index : index + 1;
  }
  if (pos.at === "start") {
    return 0;
  }
  if (pos.at === undefined || pos.at === "end") {
    return list.length;
  }
  if (typeof pos.at !== "number" || !Number.isInteger(pos.at) || pos.at < 0) {
    throw new Error(`at must be "start", "end" or an index`);
  }
  return Math.min(pos.at, list.length);
}

function applyOne(state: Json, op: StateOp): void {
  const { parent, last, parentPath } = locateParent(state, op.path);
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
        parent[index] = op.value;
      } else if (isObject(parent)) {
        parent[last] = op.value;
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
        // null removes a key, so an agent can clear a field (e.g. a card's status) in a merge.
        if (value === null) {
          delete target[key];
        } else {
          target[key] = value;
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
        if (!(last in parent)) {
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
      let list: unknown;
      if (isObject(parent) && !(last in parent)) {
        list = parent[last] = [];
      } else {
        list = child(parent, last, parentPath);
      }
      if (!Array.isArray(list)) {
        throw new Error(`${op.path} is not an array`);
      }
      if (isObject(op.value) && typeof op.value.id === "string" && findIndex(list, op.value.id) !== -1) {
        throw new Error(`${op.path} already has an item with id "${op.value.id}"`);
      }
      list.splice(positionIndex(list, op, op.path), 0, op.value);
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
      parent.splice(positionIndex(parent, op, where), 0, item);
      return;
    }
    default:
      throw new Error(`unknown op "${(op as { op?: unknown }).op}"; use ${STATE_OP_NAMES.join(", ")}`);
  }
}

/** Apply ops in order to a copy of state. All or nothing: the first failing op throws, naming its index. */
export function applyStateOps(state: Json, ops: StateOp[]): Json {
  if (!Array.isArray(ops)) {
    throw new Error("ops must be an array");
  }
  const next = structuredClone(state);
  ops.forEach((op, index) => {
    if (!isObject(op)) {
      throw new Error(`ops[${index}] must be an object`);
    }
    try {
      applyOne(next, op);
    } catch (err) {
      throw new Error(`ops[${index}] (${String(op.op)} ${String(op.path)}): ${(err as Error).message}`);
    }
  });
  return next;
}
