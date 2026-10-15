/** Opening a page's floating chat: last AI reply older than this starts a new thread. */
export const PAGE_CHAT_STALE_MS = 2 * 60 * 60 * 1000;

export type PageChatThread = {
  id: string;
  archived?: boolean;
  scope: { kind: string; ref: string | null };
  cwd?: string | null;
  worktree?: { home: string; closed?: unknown } | null;
  /** When the last turn ended (the last AI reply). Missing until a turn has completed. */
  finishedAt?: number;
  activityAt: number;
  status?: string;
};

/** The project folder a thread works on, including while it runs in a worktree. */
export function pageThreadHome(thread: Pick<PageChatThread, "cwd" | "worktree"> | null | undefined): string | null {
  if (!thread) return null;
  return thread.worktree?.home || thread.cwd || null;
}

/**
 * Workspace for a new thread on this page: the page thread with the latest AI reply.
 * No such thread (or none on the page) means no workspace — not the last global folder.
 */
export function pageThreadWorkspace(threads: Iterable<PageChatThread>, pageId: string | null | undefined): string | null {
  if (!pageId) return null;
  let best: PageChatThread | null = null;
  for (const t of threads) {
    if (t.archived || t.scope.kind !== "page" || t.scope.ref !== pageId || !t.finishedAt) continue;
    if (!best || t.finishedAt > (best.finishedAt ?? 0)) best = t;
  }
  return pageThreadHome(best);
}

/** Idle threads whose last AI reply is older than staleMs. Running or waiting threads stay. */
export function pageThreadIsStale(
  thread: Pick<PageChatThread, "finishedAt" | "status"> | null | undefined,
  now: number,
  staleMs = PAGE_CHAT_STALE_MS
): boolean {
  if (!thread) return false;
  if (thread.status === "running" || thread.status === "waiting") return false;
  if (!thread.finishedAt) return false;
  return thread.finishedAt < now - staleMs;
}

/**
 * The floating chat's remembered choice on a page: a thread, or null for a new thread the user
 * started there. `at` is when the user chose it; a choice keeps the thread fresh for two hours.
 */
export type PageDockPick = { id: string | null; at: number };

/** Which thread the floating chat should show on this page, or null to start a new one. */
export function pageDockThreadId(
  threads: Iterable<PageChatThread>,
  opts: { pick?: PageDockPick | null; pageId?: string | null; now: number; staleMs?: number }
): string | null {
  const staleMs = opts.staleMs ?? PAGE_CHAT_STALE_MS;
  const pick = opts.pick ?? null;
  // The user started a new thread here: keep it until they send or pick another.
  if (pick && pick.id === null) return null;
  const list = [...threads].filter((t) => !t.archived);
  const byId = new Map(list.map((t) => [t.id, t]));
  const picked = pick?.id ? byId.get(pick.id) : undefined;
  if (picked) {
    const last = Math.max(picked.finishedAt ?? 0, pick?.at ?? 0);
    return pageThreadIsStale({ status: picked.status, finishedAt: last || undefined }, opts.now, staleMs) ? null : picked.id;
  }
  if (!opts.pageId) return null;
  let newest: PageChatThread | null = null;
  for (const t of list) {
    if (t.scope.kind !== "page" || t.scope.ref !== opts.pageId) continue;
    if (!newest || t.activityAt > newest.activityAt) newest = t;
  }
  if (!newest || pageThreadIsStale(newest, opts.now, staleMs)) return null;
  return newest.id;
}
