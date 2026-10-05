/** How the thread list trims each grouping so a busy page does not drown in old or page-launched threads. */

export const THREAD_LIST_PAGE = 10;
export const THREAD_LIST_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

type Userish = { kind: string; from?: string; dropped?: boolean; text?: string };

/** True while the thread has only page-sent user turns. A typed user message (not approvals) makes it a user thread. */
export function pageOwned(items: Userish[]): boolean {
  let fromPage = false;
  for (const item of items) {
    if (item.kind !== "user" || item.dropped) continue;
    if (item.from === "page") {
      fromPage = true;
      continue;
    }
    // Scribe's own note (going on after a restart) makes a thread neither the page's nor the user's.
    if (item.from === "scribe") continue;
    if (item.text?.trim()) return false;
  }
  return fromPage;
}

export type ListThread = {
  id: string;
  pinned?: boolean;
  fromPage?: boolean;
  when: number;
};

export type WindowGroupOpts = {
  extra?: number;
  now: number;
  currentId?: string | null;
  searching?: boolean;
  hidePage?: boolean;
};

/**
 * Visible rows in one grouping. Default: threads from the last 7 days, at most 10.
 * `extra` reveals that many more from the rest (further recent, then older).
 * Pinned and the open thread stay visible. Search skips trimming; hidePage drops page-owned rows
 * unless they are pinned or current (search shows them).
 */
export function windowThreadGroup(threads: ListThread[], opts: WindowGroupOpts): { visible: ListThread[]; hidden: number } {
  const hide = Boolean(opts.hidePage) && !opts.searching;
  const pool = hide ? threads.filter((t) => !t.fromPage || t.pinned || t.id === opts.currentId) : threads;
  if (opts.searching) return { visible: pool, hidden: 0 };
  const keep = new Set<string>();
  for (const t of pool) {
    if (t.pinned || t.id === opts.currentId) keep.add(t.id);
  }
  const recent: ListThread[] = [];
  const older: ListThread[] = [];
  for (const t of pool) {
    if (opts.now - t.when <= THREAD_LIST_RECENT_MS) recent.push(t);
    else older.push(t);
  }
  const extra = opts.extra ?? 0;
  const base = recent.slice(0, THREAD_LIST_PAGE);
  const seen = new Set(base.map((t) => t.id));
  const rest: ListThread[] = [];
  for (const t of [...recent, ...older]) {
    if (!seen.has(t.id)) rest.push(t);
  }
  for (const t of [...base, ...rest.slice(0, extra)]) keep.add(t.id);
  const visible = pool.filter((t) => keep.has(t.id));
  return { visible, hidden: pool.length - visible.length };
}
