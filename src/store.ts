import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { cleanupOrphanAssets, deleteTabAssets, normalizeTabAssets, writePreparedAssets } from "./assets.js";
import { searchArchive, ARCHIVE_PAGE_DEFAULT, type ArchiveSearchResult } from "./archiveSearch.js";
import { MAX_HTML_BYTES, MAX_STATE_BYTES, dbPath, statePath } from "./config.js";
import { BoardDb, type StoredTab } from "./db.js";
import { log } from "./log.js";
import { normalizeSignalName } from "./signal.js";
import {
  DELETE_LIMIT,
  isPlainObject,
  toMeta,
  type BoardState,
  type DeletedEntry,
  type RestorePlacement,
  type SetStateInput,
  type SetStateResult,
  type SignalInput,
  type Tab,
  type TabAsset,
  type TabMeta,
  type UpsertInput,
} from "./types.js";
import { applyEdits, type HtmlEdit } from "./htmlEdit.js";
import { wrapHtml } from "./wrapHtml.js";

type Located = { tab: Tab; where: "open" | "archive" };

export class BoardStore extends EventEmitter {
  private tabs = new Map<string, Tab>();
  private order: string[] = [];
  private archive = new Map<string, Tab>();
  private archiveOrder: string[] = [];
  private deleted: DeletedEntry[] = [];
  private activeId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStamp = 0;
  private lastSeq = 0;
  private db: BoardDb | null = null;
  private dirty = new Set<string>();
  private removed = new Set<string>();

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  load(): void {
    this.db = BoardDb.open(dbPath(), statePath());
    const snapshot = this.db.load();
    for (const row of snapshot.rows) {
      const tab = withStateDefaults(row.tab);
      this.lastSeq = Math.max(this.lastSeq, tab.stripSeq);
      if (row.status === "open") {
        delete tab.archivedAt;
        this.tabs.set(tab.id, tab);
      } else if (row.status === "archived") {
        tab.archivedAt = typeof tab.archivedAt === "number" ? tab.archivedAt : tab.updatedAt;
        this.archive.set(tab.id, tab);
        this.archiveOrder.push(tab.id);
      } else {
        this.deleted.push({
          tab,
          deletedAt: typeof row.deletedAt === "number" ? row.deletedAt : tab.updatedAt,
        });
      }
    }
    this.deleted.sort((a, b) => a.deletedAt - b.deletedAt);
    if (this.deleted.length > DELETE_LIMIT) {
      const extra = this.deleted.splice(0, this.deleted.length - DELETE_LIMIT);
      for (const gone of extra) {
        this.removed.add(gone.tab.id);
        if (!this.tabs.has(gone.tab.id) && !this.archive.has(gone.tab.id)) {
          deleteTabAssets(gone.tab.id);
        }
      }
    }
    this.rebuildOrder();
    this.sortArchive();
    this.lastStamp = Math.max(
      this.lastStamp,
      ...[...this.archive.values()].map((tab) => tab.archivedAt ?? 0),
      ...this.deleted.map((entry) => entry.deletedAt)
    );
    this.activeId =
      snapshot.activeId && this.tabs.has(snapshot.activeId) ? snapshot.activeId : (this.order[0] ?? null);
    try {
      cleanupOrphanAssets(this.knownAssetTabIds());
    } catch (err) {
      log("Failed to clean orphan assets", String(err));
    }
    if (this.removed.size) {
      this.persistSoon();
    }
  }

  snapshot(): { tabs: TabMeta[]; archive: TabMeta[]; activeId: string | null } {
    return {
      tabs: this.order.map((id) => toMeta(this.tabs.get(id)!)).filter(Boolean),
      archive: this.archiveOrder.map((id) => toMeta(this.archive.get(id)!)),
      activeId: this.activeId,
    };
  }

  list(): TabMeta[] {
    return this.snapshot().tabs;
  }

  archiveCount(): number {
    return this.archiveOrder.length;
  }

  listOpenTabs(): Tab[] {
    return this.order.map((id) => this.tabs.get(id)!).filter(Boolean);
  }

  listArchiveTabs(): Tab[] {
    return this.archiveOrder.map((id) => this.archive.get(id)!);
  }

  searchOpen(query: string): ArchiveSearchResult {
    const tabs = this.listOpenTabs();
    return searchArchive(tabs, query, 0, Math.max(tabs.length, 1));
  }

  searchArchive(query: string, offset = 0, limit = ARCHIVE_PAGE_DEFAULT): ArchiveSearchResult {
    const off = Math.max(0, Math.floor(offset));
    const lim = Math.max(1, Math.floor(limit));
    return searchArchive(this.listArchiveTabs(), query, off, lim);
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  get(idOrKey: string): Tab | undefined {
    return this.locate(idOrKey)?.tab;
  }

  isArchived(idOrKey: string): boolean {
    return this.locate(idOrKey)?.where === "archive";
  }

  isOpen(idOrKey: string): boolean {
    return this.locate(idOrKey)?.where === "open";
  }

  upsert(input: UpsertInput): { tab: Tab; created: boolean; archived: boolean } {
    const title = input.title.trim();
    if (!title) {
      throw new Error("title is required");
    }
    if (!input.html || !input.html.trim()) {
      throw new Error("html is required");
    }
    const html = wrapHtml(title, input.html);
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }

    const existing = input.key ? this.locate(input.key) : undefined;
    if (existing?.where === "archive" && input.activate !== false) {
      this.restore(existing.tab.id, { placement: "append", activate: true });
    }

    const located = input.key ? this.locate(input.key) : undefined;
    const now = Date.now();
    if (located?.where === "archive") {
      const tab = located.tab;
      tab.assets = applyAssets(tab.id, tab.assets ?? [], input.assets);
      tab.title = title;
      tab.html = html;
      tab.updatedAt = now;
      tab.revision += 1;
      tab.signal = null;
      seedState(tab, input.state);
      if (input.pin !== undefined) {
        tab.pinned = input.pin;
      }
      this.touchArchive(tab);
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, {
        activate: false,
        structural: true,
      });
      return { tab, created: false, archived: true };
    }

    if (located?.where === "open") {
      const tab = located.tab;
      tab.assets = applyAssets(tab.id, tab.assets ?? [], input.assets);
      tab.title = title;
      tab.html = html;
      tab.updatedAt = now;
      tab.revision += 1;
      tab.signal = null;
      seedState(tab, input.state);
      let pinIndex: number | undefined;
      if (input.pin !== undefined && tab.pinned !== input.pin) {
        this.setPinned(tab, input.pin);
        pinIndex = this.order.indexOf(tab.id);
      } else if (input.pin !== undefined) {
        tab.pinned = input.pin;
      }
      if (input.activate !== false) {
        this.activeId = tab.id;
      }
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), pinIndex, {
        activate: input.activate !== false,
        structural: true,
      });
      if (input.activate !== false) {
        this.emit("tab_focused", tab.id);
      }
      return { tab, created: false, archived: false };
    }

    const id = newId();
    let assets: TabAsset[] = [];
    try {
      assets = applyAssets(id, [], input.assets);
    } catch (err) {
      deleteTabAssets(id);
      throw err;
    }
    const tab: Tab = {
      id,
      key: uniqueKey(this, input.key, title, id),
      title,
      html,
      pinned: Boolean(input.pin),
      createdAt: now,
      updatedAt: now,
      stripSeq: this.nextSeq(),
      revision: 1,
      state: {},
      stateRevision: 0,
      stateUpdatedAt: 0,
      signalRevision: 0,
      signal: null,
      assets,
    };
    seedState(tab, input.state);
    this.tabs.set(id, tab);
    this.rebuildOrder();
    const createdAt = this.order.indexOf(id);
    if (input.activate !== false) {
      this.activeId = id;
    }
    this.markDirty(id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), createdAt, {
      activate: input.activate !== false,
      structural: true,
    });
    if (input.activate !== false) {
      this.emit("tab_focused", id);
    }
    return { tab, created: true, archived: false };
  }

  patchHtml(
    idOrKey: string,
    input: { edits: HtmlEdit[]; title?: string; activate?: boolean }
  ): { tab: Tab; applied: number; archived: boolean } {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    let nextTitle = located.tab.title;
    if (input.title !== undefined) {
      nextTitle = input.title.trim();
      if (!nextTitle) {
        throw new Error("title is required");
      }
    }
    const result = applyEdits(located.tab.html, input.edits);
    const bytes = Buffer.byteLength(result.html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }

    const htmlChanged = result.html !== located.tab.html;
    const titleChanged = nextTitle !== located.tab.title;
    if (!htmlChanged && !titleChanged) {
      return {
        tab: located.tab,
        applied: result.applied,
        archived: located.where === "archive",
      };
    }

    if (located.where === "archive" && input.activate !== false) {
      this.restore(located.tab.id, { placement: "append", activate: true });
    }
    const found = this.locate(idOrKey);
    if (!found) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = found.tab;
    tab.title = nextTitle;
    tab.html = result.html;
    tab.updatedAt = Date.now();
    tab.revision += 1;
    if (found.where === "archive") {
      this.touchArchive(tab);
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
      return { tab, applied: result.applied, archived: true };
    }
    if (input.activate !== false) {
      this.activeId = tab.id;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, {
      activate: input.activate !== false,
      structural: true,
    });
    if (input.activate !== false) {
      this.emit("tab_focused", tab.id);
    }
    return { tab, applied: result.applied, archived: false };
  }

  update(
    idOrKey: string,
    patch: { title?: string; html?: string; pin?: boolean; activate?: boolean }
  ): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (located.where === "archive" && patch.activate !== false) {
      this.restore(located.tab.id, { placement: "append", activate: true });
    }
    const found = this.locate(idOrKey);
    if (!found) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = found.tab;
    let pinIndex: number | undefined;
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) {
        throw new Error("title is required");
      }
      tab.title = title;
    }
    if (patch.html !== undefined) {
      if (!patch.html.trim()) {
        throw new Error("html is required");
      }
      tab.html = wrapHtml(tab.title, patch.html);
      const bytes = Buffer.byteLength(tab.html, "utf8");
      if (bytes > MAX_HTML_BYTES) {
        throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
      }
    }
    if (patch.pin !== undefined && found.where === "open" && tab.pinned !== patch.pin) {
      this.setPinned(tab, patch.pin);
      pinIndex = this.order.indexOf(tab.id);
    } else if (patch.pin !== undefined) {
      tab.pinned = patch.pin;
    }
    tab.updatedAt = Date.now();
    const structural = patch.title !== undefined || patch.html !== undefined;
    if (structural) {
      tab.revision += 1;
    }
    if (found.where === "archive") {
      this.touchArchive(tab);
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
      return tab;
    }
    if (patch.activate !== false) {
      this.activeId = tab.id;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), pinIndex, {
      activate: patch.activate !== false,
      structural,
    });
    if (patch.activate !== false && structural) {
      this.emit("tab_focused", tab.id);
    }
    return tab;
  }

  setState(idOrKey: string, input: SetStateInput): SetStateResult {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = located.tab;
    if (!isPlainObject(input.state)) {
      throw new Error("state must be a JSON object");
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== tab.stateRevision) {
      return { ok: false, state: tab.state, stateRevision: tab.stateRevision };
    }
    const next = input.replace ? { ...input.state } : { ...tab.state, ...input.state };
    const serialized = JSON.stringify(next);
    if (serialized === JSON.stringify(tab.state)) {
      return { ok: true, tab };
    }
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_STATE_BYTES) {
      throw new Error(`state is too large (${bytes} bytes, max ${MAX_STATE_BYTES})`);
    }
    tab.state = next;
    tab.stateRevision += 1;
    tab.stateUpdatedAt = Date.now();
    if (located.where === "archive") {
      tab.updatedAt = tab.stateUpdatedAt;
      this.touchArchive(tab);
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_state", tab, input.client);
    return { ok: true, tab };
  }

  signal(idOrKey: string, input: SignalInput): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = located.tab;
    const name = normalizeSignalName(input.name);
    if (input.state !== undefined) {
      if (!isPlainObject(input.state)) {
        throw new Error("state must be a JSON object");
      }
      const next = { ...tab.state, ...input.state };
      const serialized = JSON.stringify(next);
      if (serialized !== JSON.stringify(tab.state)) {
        const bytes = Buffer.byteLength(serialized, "utf8");
        if (bytes > MAX_STATE_BYTES) {
          throw new Error(`state is too large (${bytes} bytes, max ${MAX_STATE_BYTES})`);
        }
        tab.state = next;
        tab.stateRevision += 1;
        tab.stateUpdatedAt = Date.now();
        this.emit("tab_state", tab, input.client);
      }
    }
    tab.signalRevision += 1;
    tab.signal = { name, revision: tab.signalRevision, at: Date.now() };
    tab.updatedAt = Date.now();
    if (located.where === "archive") {
      this.touchArchive(tab);
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_signal", tab);
    return tab;
  }

  focus(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (located.where === "archive") {
      return this.restore(located.tab.id, { placement: "append", activate: true });
    }
    this.activeId = located.tab.id;
    this.persistSoon();
    this.emit("tab_focused", located.tab.id);
    return located.tab;
  }

  archiveTab(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (located.where === "archive") {
      return located.tab;
    }
    const tab = located.tab;
    this.tabs.delete(tab.id);
    this.rebuildOrder();
    const stamped = this.stamp();
    tab.archivedAt = stamped;
    tab.updatedAt = stamped;
    this.archive.set(tab.id, tab);
    this.archiveOrder.unshift(tab.id);
    if (this.activeId === tab.id) {
      this.activeId = this.order[this.order.length - 1] ?? null;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
    this.emit("tab_archived", tab.id);
    this.emit("tab_focused", this.activeId);
    return tab;
  }

  archiveMany(filter: "all" | "unpinned"): string[] {
    const ids = this.order.filter((id) => {
      const tab = this.tabs.get(id);
      return tab && (filter === "all" || !tab.pinned);
    });
    for (const id of ids) {
      this.archiveTab(id);
    }
    return ids;
  }

  deletePermanent(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (located.where === "archive") {
      return this.deleteFromArchive(located.tab.id);
    }
    const tab = located.tab;
    this.tabs.delete(tab.id);
    this.rebuildOrder();
    delete tab.archivedAt;
    this.pushDeleted({ tab, deletedAt: this.stamp() });
    if (this.activeId === tab.id) {
      this.activeId = this.order[this.order.length - 1] ?? null;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_closed", tab.id);
    this.emit("tab_focused", this.activeId);
    return tab;
  }

  emptyArchive(): string[] {
    const ids = [...this.archiveOrder];
    for (const id of ids) {
      const tab = this.archive.get(id);
      this.archive.delete(id);
      this.removed.add(id);
      this.dirty.delete(id);
      if (tab && !this.tabs.has(id) && !this.deleted.some((item) => item.tab.id === id)) {
        deleteTabAssets(id);
      }
    }
    this.archiveOrder = [];
    this.persistSoon();
    this.emit("archive_cleared");
    return ids;
  }

  restore(idOrKey: string, opts?: { placement?: RestorePlacement; activate?: boolean }): Tab {
    const id = this.locate(idOrKey)?.tab.id ?? idOrKey;
    const tab = this.archive.get(id);
    if (!tab) {
      throw new Error(`archived tab not found: ${idOrKey}`);
    }
    return this.restoreTab(tab, opts?.placement ?? "append", opts?.activate !== false);
  }

  restoreLast(): Tab {
    const newestArchive = this.archiveOrder[0] ? this.archive.get(this.archiveOrder[0]) : undefined;
    let newestDeleted: DeletedEntry | undefined;
    let deletedIndex = -1;
    for (let i = 0; i < this.deleted.length; i += 1) {
      const entry = this.deleted[i];
      if (!newestDeleted || entry.deletedAt >= newestDeleted.deletedAt) {
        newestDeleted = entry;
        deletedIndex = i;
      }
    }
    const archiveAt = newestArchive?.archivedAt ?? 0;
    const deletedAt = newestDeleted?.deletedAt ?? 0;
    if (!newestArchive && !newestDeleted) {
      throw new Error("nothing to restore");
    }
    if (newestDeleted && (!newestArchive || deletedAt >= archiveAt)) {
      this.deleted.splice(deletedIndex, 1);
      return this.reopen(newestDeleted.tab, "index", true);
    }
    return this.restoreTab(newestArchive!, "index", true);
  }

  close(idOrKey: string): Tab {
    return this.archiveTab(idOrKey);
  }

  closeMany(filter: "all" | "unpinned"): string[] {
    return this.archiveMany(filter);
  }

  persist(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.db) {
      return;
    }
    const upserts: StoredTab[] = [];
    for (const id of this.dirty) {
      const stored = this.storedOf(id);
      if (stored) {
        upserts.push(stored);
      }
    }
    try {
      this.db.save({
        activeId: this.activeId,
        upserts,
        removedIds: [...this.removed],
      });
      this.dirty.clear();
      this.removed.clear();
    } catch (err) {
      log("Failed to persist board state", String(err));
    }
  }

  closeDb(): void {
    this.persist();
    try {
      this.db?.close();
    } catch (err) {
      log("Failed to close board database", String(err));
    }
    this.db = null;
  }

  private locate(idOrKey: string): Located | undefined {
    const openById = this.tabs.get(idOrKey);
    if (openById) {
      return { tab: openById, where: "open" };
    }
    const archivedById = this.archive.get(idOrKey);
    if (archivedById) {
      return { tab: archivedById, where: "archive" };
    }
    const key = normalizeKey(idOrKey);
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (tab && tab.key === key) {
        return { tab, where: "open" };
      }
    }
    for (const id of this.archiveOrder) {
      const tab = this.archive.get(id);
      if (tab && tab.key === key) {
        return { tab, where: "archive" };
      }
    }
    return undefined;
  }

  private setPinned(tab: Tab, pinned: boolean): void {
    tab.pinned = pinned;
    if (pinned) {
      tab.stripSeq = this.nextSeq();
    } else {
      const others = [...this.tabs.values()].filter((item) => item.id !== tab.id && !item.pinned);
      if (others.length) {
        const min = Math.min(...others.map((item) => item.stripSeq));
        tab.stripSeq = this.allocBefore(min);
      }
    }
    this.rebuildOrder();
  }

  private restoreTab(tab: Tab, placement: RestorePlacement, activate: boolean): Tab {
    this.archive.delete(tab.id);
    this.archiveOrder = this.archiveOrder.filter((id) => id !== tab.id);
    return this.reopen(tab, placement, activate);
  }

  private reopen(tab: Tab, placement: RestorePlacement, activate: boolean): Tab {
    if (this.tabs.has(tab.id) || this.archive.has(tab.id)) {
      throw new Error(`tab already open: ${tab.id}`);
    }
    const keyOwner = this.locate(tab.key);
    if (keyOwner && keyOwner.tab.id !== tab.id) {
      tab.key = uniqueKey(this, tab.key, tab.title, tab.id);
    }
    delete tab.archivedAt;
    switch (placement) {
      case "append":
        tab.stripSeq = this.nextSeq();
        break;
      case "index":
        break;
      default: {
        const _never: never = placement;
        return _never;
      }
    }
    this.tabs.set(tab.id, tab);
    this.rebuildOrder();
    const at = this.order.indexOf(tab.id);
    if (activate) {
      this.activeId = tab.id;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), at, { activate, structural: true });
    if (activate) {
      this.emit("tab_focused", tab.id);
    }
    return tab;
  }

  private deleteFromArchive(id: string): Tab {
    const tab = this.archive.get(id);
    if (!tab) {
      throw new Error(`tab not found: ${id}`);
    }
    this.archive.delete(id);
    this.archiveOrder = this.archiveOrder.filter((item) => item !== id);
    this.removed.add(id);
    this.dirty.delete(id);
    if (!this.tabs.has(id) && !this.deleted.some((item) => item.tab.id === id)) {
      deleteTabAssets(id);
    }
    this.persistSoon();
    this.emit("tab_closed", id);
    return tab;
  }

  private touchArchive(tab: Tab): void {
    const stamped = this.stamp();
    tab.archivedAt = stamped;
    tab.updatedAt = stamped;
    this.archiveOrder = [tab.id, ...this.archiveOrder.filter((id) => id !== tab.id)];
  }

  private sortArchive(): void {
    this.archiveOrder.sort((a, b) => {
      const left = this.archive.get(a)?.archivedAt ?? 0;
      const right = this.archive.get(b)?.archivedAt ?? 0;
      return right - left;
    });
  }

  private rebuildOrder(): void {
    this.order = [...this.tabs.values()]
      .sort((a, b) => {
        const ap = a.pinned ? 0 : 1;
        const bp = b.pinned ? 0 : 1;
        if (ap !== bp) {
          return ap - bp;
        }
        return a.stripSeq - b.stripSeq;
      })
      .map((tab) => tab.id);
  }

  private nextSeq(): number {
    this.lastSeq += 1;
    return this.lastSeq;
  }

  private allocBefore(n: number): number {
    const used = new Set(this.allKnownTabs().map((tab) => tab.stripSeq));
    let seq = n - 1;
    while (used.has(seq)) {
      seq -= 1;
    }
    return seq;
  }

  private allKnownTabs(): Tab[] {
    return [...this.tabs.values(), ...this.archive.values(), ...this.deleted.map((entry) => entry.tab)];
  }

  private persistSoon(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.persist(), 150);
  }

  private markDirty(id: string): void {
    this.dirty.add(id);
    this.removed.delete(id);
  }

  private storedOf(id: string): StoredTab | undefined {
    const open = this.tabs.get(id);
    if (open) {
      return { tab: open, status: "open" };
    }
    const archived = this.archive.get(id);
    if (archived) {
      return { tab: archived, status: "archived" };
    }
    const deleted = this.deleted.find((entry) => entry.tab.id === id);
    if (deleted) {
      return { tab: deleted.tab, status: "deleted", deletedAt: deleted.deletedAt };
    }
    return undefined;
  }

  private pushDeleted(entry: DeletedEntry): void {
    this.deleted.push(entry);
    this.markDirty(entry.tab.id);
    if (this.deleted.length > DELETE_LIMIT) {
      const removed = this.deleted.splice(0, this.deleted.length - DELETE_LIMIT);
      for (const gone of removed) {
        this.removed.add(gone.tab.id);
        this.dirty.delete(gone.tab.id);
        if (!this.tabs.has(gone.tab.id) && !this.archive.has(gone.tab.id)) {
          deleteTabAssets(gone.tab.id);
        }
      }
    }
  }

  private stamp(): number {
    const now = Date.now();
    const next = Math.max(now, this.lastStamp + 1);
    this.lastStamp = next;
    return next;
  }

  private knownAssetTabIds(): string[] {
    return [...this.tabs.keys(), ...this.archive.keys(), ...this.deleted.map((entry) => entry.tab.id)];
  }
}

function newId(): string {
  return "t_" + randomBytes(4).toString("hex");
}

function withStateDefaults(tab: Tab): Tab {
  const signal =
    tab.signal && typeof tab.signal === "object" && typeof tab.signal.name === "string"
      ? {
          name: tab.signal.name,
          revision: typeof tab.signal.revision === "number" ? tab.signal.revision : 0,
          at: typeof tab.signal.at === "number" ? tab.signal.at : 0,
        }
      : null;
  return {
    ...tab,
    stripSeq: typeof tab.stripSeq === "number" ? tab.stripSeq : 0,
    state: isPlainObject(tab.state) ? tab.state : {},
    stateRevision: typeof tab.stateRevision === "number" ? tab.stateRevision : 0,
    stateUpdatedAt: typeof tab.stateUpdatedAt === "number" ? tab.stateUpdatedAt : 0,
    signalRevision: typeof tab.signalRevision === "number" ? tab.signalRevision : (signal?.revision ?? 0),
    signal,
    assets: normalizeTabAssets(tab.assets),
  };
}

function applyAssets(tabId: string, current: TabAsset[], incoming: UpsertInput["assets"]): TabAsset[] {
  if (!incoming?.length) {
    return current;
  }
  return writePreparedAssets(tabId, current, incoming);
}

/** Initial state only lands on a tab that has none, so re-showing a page never resets what the user changed. */
function seedState(tab: Tab, state: BoardState | undefined): void {
  if (!state || !isPlainObject(state) || tab.stateRevision > 0) {
    return;
  }
  tab.state = { ...state };
  tab.stateRevision = 1;
  tab.stateUpdatedAt = Date.now();
}

function normalizeKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const cleaned = trimmed.replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80);
}

function uniqueKey(store: BoardStore, requested: string | undefined, title: string, id: string): string {
  if (requested) {
    const key = normalizeKey(requested);
    if (key && !store.get(key)) {
      return key;
    }
    if (key) {
      return `${key}-${id.slice(2)}`;
    }
  }
  const base = normalizeKey(title) || "page";
  if (!store.get(base)) {
    return base;
  }
  return `${base}-${id.slice(2)}`;
}

export const store = new BoardStore();
