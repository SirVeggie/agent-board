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

/** Which thread the floating chat should show on this page, or null to start a new one. */
export function pageDockThreadId(
  threads: Iterable<PageChatThread>,
  opts: { pickId?: string | null; pageId?: string | null; now: number; staleMs?: number }
): string | null {
  const list = [...threads].filter((t) => !t.archived);
  const byId = new Map(list.map((t) => [t.id, t]));
  let id = opts.pickId && byId.has(opts.pickId) ? opts.pickId : null;
  if (!id && opts.pageId) {
    let newest: PageChatThread | null = null;
    for (const t of list) {
      if (t.scope.kind !== "page" || t.scope.ref !== opts.pageId) continue;
      if (!newest || t.activityAt > newest.activityAt) newest = t;
    }
    id = newest?.id ?? null;
  }
  const t = id ? byId.get(id) : undefined;
  if (t && pageThreadIsStale(t, opts.now, opts.staleMs)) return null;
  return id;
}
