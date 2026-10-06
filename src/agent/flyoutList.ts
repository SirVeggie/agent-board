/** Hover list on the island orb and the top-bar agent button: live threads plus recently checked ones. */

export const FLYOUT_HOLD_MS = 5 * 60 * 1000;
/** When the list grows past this, checked threads drop first. Live ones stay. */
export const FLYOUT_SOFT_CAP = 10;
export const FLYOUT_CAP = 10;

export type FlyoutThread = {
  id: string;
  status: string;
  unread?: boolean;
  fromPage?: boolean;
  archived?: boolean;
  pinned?: boolean;
  activityAt: number;
};

export type FlyoutFrom = "orb" | "button";

export type FlyoutHold = {
  /** id → when the user checked (read) an unread idle thread. */
  checkedAt: Map<string, number>;
  /** Unread idle ids last seen, so the next read stamps checkedAt. */
  listed: Set<string>;
};

export type FlyoutRow<T extends FlyoutThread = FlyoutThread> = { thread: T; checked: boolean };

function rank(t: FlyoutThread): number {
  return (t.pinned ? 1e15 : 0) + t.activityAt;
}

function isLive(t: FlyoutThread): boolean {
  if (t.archived) return false;
  if (t.status === "waiting" || t.status === "running") return true;
  return t.status === "idle" && Boolean(t.unread) && !t.fromPage;
}

/**
 * Stamp checkedAt when an unread idle thread is read. Drops expired and gone ids.
 * Returns the next expiry time, or null.
 */
export function syncFlyoutHold(threads: Iterable<FlyoutThread>, hold: FlyoutHold, now: number, holdMs = FLYOUT_HOLD_MS): number | null {
  const known = new Set<string>();
  for (const t of threads) {
    known.add(t.id);
    if (t.archived) {
      hold.listed.delete(t.id);
      hold.checkedAt.delete(t.id);
      continue;
    }
    if (isLive(t)) {
      hold.checkedAt.delete(t.id);
      if (t.status === "idle") hold.listed.add(t.id);
      else hold.listed.delete(t.id);
      continue;
    }
    if (hold.listed.has(t.id)) {
      if (!hold.checkedAt.has(t.id)) hold.checkedAt.set(t.id, now);
      hold.listed.delete(t.id);
    }
  }
  for (const id of [...hold.listed]) if (!known.has(id)) hold.listed.delete(id);
  for (const [id, at] of hold.checkedAt) {
    if (!known.has(id) || now - at >= holdMs) hold.checkedAt.delete(id);
  }
  let next: number | null = null;
  for (const at of hold.checkedAt.values()) {
    const until = at + holdMs;
    if (next === null || until < next) next = until;
  }
  return next;
}

/**
 * Rows for the flyout. Orb opens upward: checked dim at the top (away from the pointer),
 * newest / running / waiting at the bottom. The top-bar button opens down, so that order
 * is reversed. Over the soft cap, checked threads are dropped (newest-checked kept);
 * waiting, running and unread stay. `cap` then keeps the rows nearest the pointer.
 */
export function flyoutRows<T extends FlyoutThread>(
  threads: T[],
  hold: FlyoutHold,
  opts: { now: number; from: FlyoutFrom; holdMs?: number; softCap?: number; cap?: number }
): { rows: FlyoutRow<T>[]; hidden: number; waiting: number; running: number; ready: number } {
  const holdMs = opts.holdMs ?? FLYOUT_HOLD_MS;
  const softCap = opts.softCap ?? FLYOUT_SOFT_CAP;
  const cap = opts.cap ?? FLYOUT_CAP;
  const all = threads.filter((t) => !t.archived).sort((a, b) => rank(b) - rank(a));
  const live = [
    ...all.filter((t) => t.status === "waiting"),
    ...all.filter((t) => t.status === "running"),
    ...all.filter((t) => t.status === "idle" && t.unread && !t.fromPage),
  ];
  const liveIds = new Set(live.map((t) => t.id));
  let held = all.filter((t) => {
    const at = hold.checkedAt.get(t.id);
    return !liveIds.has(t.id) && at != null && opts.now - at < holdMs;
  });
  held.sort((a, b) => (hold.checkedAt.get(a.id) ?? 0) - (hold.checkedAt.get(b.id) ?? 0));
  if (live.length + held.length > softCap) {
    const room = Math.max(0, softCap - live.length);
    held = [...held].sort((a, b) => (hold.checkedAt.get(b.id) ?? 0) - (hold.checkedAt.get(a.id) ?? 0)).slice(0, room);
    held.sort((a, b) => (hold.checkedAt.get(a.id) ?? 0) - (hold.checkedAt.get(b.id) ?? 0));
  }
  const orb: FlyoutRow<T>[] = [
    ...held.map((thread) => ({ thread, checked: true })),
    ...[...live].reverse().map((thread) => ({ thread, checked: false })),
  ];
  const ordered = opts.from === "button" ? [...orb].reverse() : orb;
  const hidden = Math.max(0, ordered.length - cap);
  const rows = opts.from === "button" ? ordered.slice(0, cap) : ordered.slice(Math.max(0, ordered.length - cap));
  return {
    rows,
    hidden,
    waiting: live.filter((t) => t.status === "waiting").length,
    running: live.filter((t) => t.status === "running").length,
    ready: live.filter((t) => t.status === "idle").length,
  };
}
