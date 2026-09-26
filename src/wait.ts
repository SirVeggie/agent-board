import { parseAfterRevision, signalMatches } from "./signal.js";
import { store } from "./store.js";
import { visibleTo, type BoardState, type Tab, type TabSignal, type Viewer } from "./types.js";

export type WaitResult = {
  timedOut: boolean;
  /** The page was deleted (or hidden from the agent). */
  deleted: boolean;
  /** The page's tab was closed; the page is still in the Library. */
  closed: boolean;
  id: string;
  key: string;
  signal: TabSignal | null;
  state: BoardState;
  stateRevision: number;
};

type Outcome = "signal" | "timeout" | "deleted" | "closed";

export function waitForSignal(opts: {
  idOrKey: string;
  names: string[];
  afterRevision?: unknown;
  timeoutMs: number;
  viewer: Viewer;
  abort?: AbortSignal;
}): Promise<WaitResult> {
  const afterRevision = parseAfterRevision(opts.afterRevision);
  const initial = store.get(opts.idOrKey, opts.viewer);
  if (!initial) {
    return Promise.reject(new Error(`tab not found: ${opts.idOrKey}`));
  }
  const tabId = initial.id;
  const tabKey = initial.key;
  if (signalMatches(initial, opts.names, afterRevision)) {
    return Promise.resolve(toWaitResult(initial, "signal"));
  }
  if (store.isClosed(tabId)) {
    return Promise.resolve(toWaitResult(initial, "closed"));
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

    const check = (timedOut: boolean) => {
      const current = store.get(tabId);
      if (!current || !visibleTo(current, opts.viewer)) {
        finish(
          current
            ? { ...emptyResult(tabId, tabKey), deleted: true }
            : toWaitResult(last, "deleted")
        );
        return;
      }
      last = current;
      if (store.isClosed(tabId)) {
        finish(toWaitResult(current, "closed"));
        return;
      }
      if (signalMatches(current, opts.names, afterRevision)) {
        finish(toWaitResult(current, "signal"));
        return;
      }
      if (timedOut) {
        finish(toWaitResult(current, "timeout"));
      }
    };

    const onEvent = (tabOrId: Tab | string) => {
      const id = typeof tabOrId === "string" ? tabOrId : tabOrId.id;
      if (id === tabId) {
        check(false);
      }
    };
    const onAbort = () => check(true);

    const timer = setTimeout(() => check(true), opts.timeoutMs);
    const poll = setInterval(() => check(false), 50);

    store.on("tab_signal", onEvent);
    store.on("tab_deleted", onEvent);
    store.on("tab_closed", onEvent);
    if (opts.abort) {
      if (opts.abort.aborted) {
        onAbort();
      } else {
        opts.abort.addEventListener("abort", onAbort);
      }
    }

    check(false);

    function cleanup() {
      clearTimeout(timer);
      clearInterval(poll);
      store.off("tab_signal", onEvent);
      store.off("tab_deleted", onEvent);
      store.off("tab_closed", onEvent);
      opts.abort?.removeEventListener("abort", onAbort);
    }
  });
}

function emptyResult(id: string, key: string): WaitResult {
  return { timedOut: false, deleted: false, closed: false, id, key, signal: null, state: {}, stateRevision: 0 };
}

function toWaitResult(tab: Tab, outcome: Outcome): WaitResult {
  return {
    timedOut: outcome === "timeout",
    deleted: outcome === "deleted",
    closed: outcome === "closed",
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
