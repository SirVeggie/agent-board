import { parseAfterRevision, signalMatches } from "./signal.js";
import { store } from "./store.js";
import type { BoardState, Tab, TabSignal } from "./types.js";

export type WaitResult = {
  timedOut: boolean;
  closed: boolean;
  archived: boolean;
  id: string;
  key: string;
  signal: TabSignal | null;
  state: BoardState;
  stateRevision: number;
};

export function waitForSignal(opts: {
  idOrKey: string;
  names: string[];
  afterRevision?: unknown;
  timeoutMs: number;
  abort?: AbortSignal;
}): Promise<WaitResult> {
  const afterRevision = parseAfterRevision(opts.afterRevision);
  const initial = store.get(opts.idOrKey);
  if (!initial) {
    return Promise.reject(new Error(`tab not found: ${opts.idOrKey}`));
  }
  const tabId = initial.id;
  if (signalMatches(initial, opts.names, afterRevision)) {
    return Promise.resolve(toWaitResult(initial, false, false, false));
  }
  if (store.isArchived(tabId)) {
    return Promise.resolve(toWaitResult(initial, false, false, true));
  }

  return new Promise((resolve) => {
    let settled = false;
    let last: Tab = initial;

    const finish = (result: WaitResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const check = (tab: Tab | undefined, timedOut: boolean, closed: boolean, archived: boolean) => {
      if (archived) {
        const current = tab ?? last;
        finish({
          timedOut: false,
          closed: false,
          archived: true,
          id: tabId,
          key: current.key,
          signal: snapshotSignal(current.signal),
          state: { ...current.state },
          stateRevision: current.stateRevision,
        });
        return;
      }
      if (!tab) {
        finish({
          timedOut: false,
          closed: true,
          archived: false,
          id: tabId,
          key: last.key,
          signal: snapshotSignal(last.signal),
          state: { ...last.state },
          stateRevision: last.stateRevision,
        });
        return;
      }
      last = tab;
      if (closed) {
        finish({
          timedOut: false,
          closed: true,
          archived: false,
          id: tabId,
          key: tab.key,
          signal: snapshotSignal(tab.signal),
          state: { ...tab.state },
          stateRevision: tab.stateRevision,
        });
        return;
      }
      if (signalMatches(tab, opts.names, afterRevision)) {
        finish(toWaitResult(tab, false, false, false));
        return;
      }
      if (timedOut) {
        finish(toWaitResult(tab, true, false, false));
      }
    };

    const onSignal = (tab: Tab) => {
      if (tab.id === tabId) {
        check(tab, false, false, false);
      }
    };

    const onClose = (id: string) => {
      if (id === tabId) {
        check(store.get(tabId), false, true, false);
      }
    };

    const onArchived = (id: string) => {
      if (id === tabId) {
        check(store.get(tabId) ?? last, false, false, true);
      }
    };

    const onAbort = () => {
      check(store.get(tabId) ?? last, true, false, false);
    };

    const timer = setTimeout(() => {
      check(store.get(tabId), true, false, store.isArchived(tabId));
    }, opts.timeoutMs);

    const poll = setInterval(() => {
      if (store.isArchived(tabId)) {
        check(store.get(tabId) ?? last, false, false, true);
        return;
      }
      check(store.get(tabId), false, false, false);
    }, 50);

    store.on("tab_signal", onSignal);
    store.on("tab_closed", onClose);
    store.on("tab_archived", onArchived);
    if (opts.abort) {
      if (opts.abort.aborted) {
        onAbort();
      } else {
        opts.abort.addEventListener("abort", onAbort);
      }
    }

    check(store.get(tabId), false, false, false);

    function cleanup() {
      clearTimeout(timer);
      clearInterval(poll);
      store.off("tab_signal", onSignal);
      store.off("tab_closed", onClose);
      store.off("tab_archived", onArchived);
      opts.abort?.removeEventListener("abort", onAbort);
    }
  });
}

function toWaitResult(tab: Tab, timedOut: boolean, closed: boolean, archived: boolean): WaitResult {
  return {
    timedOut,
    closed,
    archived,
    id: tab.id,
    key: tab.key,
    signal: snapshotSignal(tab.signal),
    state: { ...tab.state },
    stateRevision: tab.stateRevision,
  };
}

function snapshotSignal(signal: TabSignal | null): TabSignal | null {
  return signal ? { name: signal.name, revision: signal.revision, at: signal.at } : null;
}
