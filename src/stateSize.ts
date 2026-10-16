/**
 * The UTF-8 size of a page state as JSON.stringify would write it, without building the string.
 * Sizes of objects and arrays are cached by identity: applyOps copies only the containers on an
 * op's path and shares the rest, so after a write only that path is measured again.
 * State containers are never changed in place once stored, which is what makes the cache valid.
 */
const sizes = new WeakMap<object, number>();

export function jsonBytes(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return leafBytes(value);
  }
  const cached = sizes.get(value);
  if (cached !== undefined) {
    return cached;
  }
  let bytes = 2;
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      bytes += isSkipped(item) ? 4 : jsonBytes(item);
      count += 1;
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (isSkipped(item)) {
        continue;
      }
      bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + jsonBytes(item);
      count += 1;
    }
  }
  bytes += Math.max(0, count - 1);
  sizes.set(value, bytes);
  return bytes;
}

/** Values JSON.stringify leaves out of objects and writes as null in arrays. */
function isSkipped(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function leafBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 4 : Buffer.byteLength(text, "utf8");
}
