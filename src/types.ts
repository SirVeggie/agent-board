export type Tab = {
  id: string;
  key: string;
  title: string;
  html: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
};

export type TabMeta = Omit<Tab, "html"> & { htmlBytes: number };

export type TrashEntry = {
  tab: Tab;
  index: number;
};

export const TRASH_LIMIT = 5;

export type BoardEvent =
  | { type: "snapshot"; tabs: TabMeta[]; activeId: string | null }
  | { type: "tab_upserted"; tab: TabMeta; index?: number }
  | { type: "tab_closed"; id: string }
  | { type: "tab_focused"; id: string | null };

export type UpsertInput = {
  key?: string;
  title: string;
  html: string;
  activate?: boolean;
  pin?: boolean;
};

export function toMeta(tab: Tab): TabMeta {
  return {
    id: tab.id,
    key: tab.key,
    title: tab.title,
    pinned: tab.pinned,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    revision: tab.revision,
    htmlBytes: Buffer.byteLength(tab.html, "utf8"),
  };
}
