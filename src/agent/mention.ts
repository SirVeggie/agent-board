/** The @token around the caret. Keep in sync with mentionAt in public/agent.js. */
export function mentionAt(value: string, cursor: number): { start: number; end: number; query: string } | null {
  const before = value.slice(0, cursor);
  const m = /(^|[\s])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const start = before.length - 1 - m[2].length;
  const rest = /^[^\s@]*/.exec(value.slice(cursor))?.[0] || "";
  return { start, end: cursor + rest.length, query: m[2] };
}
