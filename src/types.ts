export type BoardState = Record<string, unknown>;

export type TabSignal = {
  name: string;
  revision: number;
  at: number;
};

export type TabAsset = {
  name: string;
  mimeType: string;
  bytes: number;
};

export type PreparedAsset = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

export type Tab = {
  id: string;
  key: string;
  title: string;
  html: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
  state: BoardState;
  stateRevision: number;
  stateUpdatedAt: number;
  /** Monotonic counter; survives board_show clearing `signal`. */
  signalRevision: number;
  /** Last signal, or null after board_show resets the wait handshake. */
  signal: TabSignal | null;
  assets: TabAsset[];
};

export type TabMeta = Omit<Tab, "html" | "state" | "signal" | "signalRevision"> & { htmlBytes: number };

export type TrashEntry = {
  tab: Tab;
  index: number;
};

export const TRASH_LIMIT = 5;

export type UpsertNotice = {
  activate: boolean;
  /** HTML or title changed; pin-only updates are not structural. */
  structural: boolean;
};

export type BoardEvent =
  | { type: "snapshot"; tabs: TabMeta[]; activeId: string | null }
  | { type: "tab_upserted"; tab: TabMeta; index?: number }
  | { type: "tab_closed"; id: string }
  | { type: "tab_focused"; id: string | null }
  | { type: "tab_focus_request"; id: string }
  | { type: "tab_state"; id: string; state: BoardState; stateRevision: number; client?: string }
  | { type: "tab_signal"; id: string; signal: TabSignal };

export type UpsertInput = {
  key?: string;
  title: string;
  html: string;
  activate?: boolean;
  pin?: boolean;
  state?: BoardState;
  assets?: PreparedAsset[];
};

export type SetStateInput = {
  state: BoardState;
  replace?: boolean;
  expectedRevision?: number;
  client?: string;
};

export type SignalInput = {
  name: string;
  state?: BoardState;
  client?: string;
};

/** A stale expectedRevision resolves to ok:false carrying the current state so the caller can merge and retry. */
export type SetStateResult =
  | { ok: true; tab: Tab }
  | { ok: false; state: BoardState; stateRevision: number };

export function toMeta(tab: Tab): TabMeta {
  return {
    id: tab.id,
    key: tab.key,
    title: tab.title,
    pinned: tab.pinned,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    revision: tab.revision,
    stateRevision: tab.stateRevision,
    stateUpdatedAt: tab.stateUpdatedAt,
    htmlBytes: Buffer.byteLength(tab.html, "utf8"),
    assets: tab.assets,
  };
}

export function isPlainObject(value: unknown): value is BoardState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
