import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { cleanupOrphanAssets, deleteTabAssets, normalizeTabAssets, readPreparedAssets, writePreparedAssets } from "./assets.js";
import { buildExport, type BoardExportFile, type ImportPageInput } from "./boardExport.js";
import { searchArchive, ARCHIVE_PAGE_DEFAULT, type ArchiveSearchResult } from "./archiveSearch.js";
import { searchPages as rankPages, PAGE_SEARCH_DEFAULT, type PageSearchResult } from "./pageSearch.js";
import { MAX_HTML_BYTES, MAX_STATE_BYTES, dbPath, statePath } from "./config.js";
import { BoardDb, type StoredTab } from "./db.js";
import { log } from "./log.js";
import { normalizeSignalName } from "./signal.js";
import {
  DELETE_LIMIT,
  WELCOME_KEY,
  isAppTab,
  isPlainObject,
  isTemplateBound,
  toMeta,
  toTemplateMeta,
  type BoardState,
  type DeletedEntry,
  type ImportDestination,
  type RestorePlacement,
  type SetStateInput,
  type SetStateResult,
  type SignalInput,
  type Tab,
  type TabAsset,
  type TabMeta,
  type Template,
  type TemplateBinding,
  type TemplateMeta,
  type TemplateValues,
  type UpsertInput,
} from "./types.js";
import { applyEdits, assertRevision, type HtmlEdit, type HtmlEditResult } from "./htmlEdit.js";
import {
  mergeTemplateValues,
  normalizeTemplateInput,
  parseTemplateValues,
  renderTemplateTitle,
  substituteTemplate,
  type TemplateUpsertInput,
} from "./templates.js";
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
  private persistRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private persistError: string | null = null;
  private lastStamp = 0;
  private lastSeq = 0;
  private db: BoardDb | null = null;
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private templates = new Map<string, Template>();
  private removedTemplates = new Set<string>();
  private templatesDirty = false;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  load(): void {
    this.db = BoardDb.open(dbPath(), statePath());
    const snapshot = this.db.load();
    for (const template of snapshot.templates) {
      this.templates.set(template.id, template);
    }
    const bindings = new Map(snapshot.bindings.map((binding) => [binding.tabId, binding]));
    for (const row of snapshot.rows) {
      const tab = withStateDefaults(row.tab);
      applyBinding(tab, bindings.get(tab.id));
      this.lastSeq = Math.max(this.lastSeq, tab.stripSeq);
      if (row.status === "open") {
        delete tab.archivedAt;
        this.tabs.set(tab.id, tab);
      } else if (isAppTab(tab)) {
        this.removed.add(tab.id);
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

  snapshot(): {
    tabs: TabMeta[];
    archive: TabMeta[];
    activeId: string | null;
    templates: TemplateMeta[];
    persistError: string | null;
  } {
    return {
      tabs: this.order.map((id) => toMeta(this.tabs.get(id)!)).filter(Boolean),
      archive: this.archiveOrder.map((id) => toMeta(this.archive.get(id)!)),
      activeId: this.activeId,
      templates: this.listTemplates(),
      persistError: this.persistError,
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

  searchPages(query: string, limit?: number): PageSearchResult {
    return rankPages(this.listOpenTabs(), this.listArchiveTabs(), query, limit ?? PAGE_SEARCH_DEFAULT);
  }

  listTemplates(): TemplateMeta[] {
    return [...this.templates.values()]
      .sort((a, b) => a.title.localeCompare(b.title) || a.createdAt - b.createdAt)
      .map((template) => toTemplateMeta(template, this.instanceCount(template.id)));
  }

  getTemplate(idOrKey: string): Template | undefined {
    return this.locateTemplate(idOrKey);
  }

  upsertTemplate(input: TemplateUpsertInput): { template: Template; created: boolean } {
    const parsed = normalizeTemplateInput(input);
    const existing = input.id
      ? this.locateTemplate(input.id)
      : input.key
        ? this.locateTemplate(input.key)
        : undefined;
    const now = Date.now();
    if (existing) {
      const prevVersion = existing.stateVersion;
      existing.title = parsed.title;
      existing.description = parsed.description;
      existing.html = parsed.html;
      existing.fields = parsed.fields;
      existing.titleTemplate = parsed.titleTemplate;
      existing.initialState = parsed.initialState;
      if (parsed.stateVersion !== undefined) {
        existing.stateVersion = parsed.stateVersion;
      }
      existing.updatedAt = now;
      this.markTemplateDirty(existing.id);
      this.refreshTemplateInstances(existing, parsed.stateVersion !== undefined && parsed.stateVersion !== prevVersion);
      this.persistSoon();
      this.emit("template_upserted", toTemplateMeta(existing, this.instanceCount(existing.id)));
      return { template: existing, created: false };
    }
    const id = newTemplateId();
    const template: Template = {
      id,
      key: uniqueTemplateKey(this, input.key, parsed.title, id),
      title: parsed.title,
      description: parsed.description,
      html: parsed.html,
      fields: parsed.fields,
      ...(parsed.titleTemplate ? { titleTemplate: parsed.titleTemplate } : {}),
      ...(parsed.initialState ? { initialState: parsed.initialState } : {}),
      stateVersion: parsed.stateVersion ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(id, template);
    this.markTemplateDirty(id);
    this.persistSoon();
    this.emit("template_upserted", toTemplateMeta(template, 0));
    return { template, created: true };
  }

  deleteTemplate(idOrKey: string): Template {
    const template = this.locateTemplate(idOrKey);
    if (!template) {
      throw new Error(`template not found: ${idOrKey}`);
    }
    for (const tab of this.allTabs()) {
      if (tab.templateId === template.id) {
        this.unlinkTemplate(tab);
      }
    }
    this.templates.delete(template.id);
    this.removedTemplates.add(template.id);
    this.templatesDirty = true;
    this.persistSoon();
    this.emit("template_deleted", template.id);
    return template;
  }

  openFromTemplate(
    idOrKey: string,
    values: unknown,
    opts?: { activate?: boolean }
  ): { tab: Tab; created: boolean } {
    const template = this.requireTemplate(idOrKey);
    const parsed = parseTemplateValues(template.fields, values);
    const title = renderTemplateTitle(template, parsed);
    const html = this.renderBoundHtml(template, title, parsed);
    const { tab } = this.upsert({
      title,
      html,
      pin: true,
      activate: opts?.activate !== false,
      state: template.initialState,
    });
    this.bindTab(tab, template, parsed, true);
    this.markDirty(tab.id);
    this.persistSoon();
    const index = this.order.indexOf(tab.id);
    this.emit("tab_upserted", toMeta(tab), index === -1 ? undefined : index, {
      activate: opts?.activate !== false,
      structural: true,
    });
    return { tab, created: true };
  }

  setTemplateValues(idOrKey: string, values: unknown): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (!located.tab.templateId) {
      throw new Error("this page is not bound to a template");
    }
    const template = this.requireTemplate(located.tab.templateId);
    const parsed = parseTemplateValues(template.fields, values);
    this.applyTemplateRender(located.tab, template, parsed, located.tab.templateCompatible !== false);
    this.touchIfArchived(located);
    this.markDirty(located.tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(located.tab), undefined, {
      activate: false,
      structural: true,
    });
    return located.tab;
  }

  reportIncompatible(idOrKey: string, reason?: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (!located.tab.templateId) {
      throw new Error("this page is not bound to a template");
    }
    const message = (reason ?? "").trim() || "This page's data no longer matches the template.";
    if (located.tab.templateCompatible === false && located.tab.templateIncompatibleReason === message) {
      return located.tab;
    }
    located.tab.templateCompatible = false;
    located.tab.templateIncompatibleReason = message;
    this.touchIfArchived(located);
    this.markDirty(located.tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(located.tab), undefined, {
      activate: false,
      structural: false,
    });
    return located.tab;
  }

  exportFile(idOrKey?: string): BoardExportFile {
    const tabs = idOrKey
      ? [this.requireAny(idOrKey)]
      : [...this.listOpenTabs(), ...this.listArchiveTabs()].filter((tab) => !isAppTab(tab));
    if (!tabs.length) {
      throw new Error("nothing to export");
    }
    return buildExport(
      tabs.map((tab) => ({
        tab,
        assets: readPreparedAssets(tab.id, tab.assets ?? []),
      }))
    );
  }

  importPages(
    pages: ImportPageInput[],
    destination: ImportDestination
  ): { tabs: Tab[]; opened: number; archived: number; focusedId: string | null } {
    if (!pages.length) {
      throw new Error("no pages to import");
    }
    const drafts: Tab[] = [];
    const reserved = new Set<string>();
    try {
      for (const page of pages) {
        const tab = this.buildImportedDraft(page, reserved);
        reserved.add(tab.key);
        drafts.push(tab);
      }
    } catch (err) {
      for (const tab of drafts) {
        deleteTabAssets(tab.id);
      }
      throw err;
    }

    const opened: Tab[] = [];
    const archived: Tab[] = [];
    for (let i = 0; i < drafts.length; i += 1) {
      const tab = drafts[i];
      const page = pages[i];
      if (shouldArchive(destination, page.archivedAt)) {
        tab.archivedAt = typeof page.archivedAt === "number" ? page.archivedAt : this.stamp();
        this.archive.set(tab.id, tab);
        this.archiveOrder.unshift(tab.id);
        archived.push(tab);
      } else {
        this.tabs.set(tab.id, tab);
        opened.push(tab);
      }
      this.markDirty(tab.id);
    }
    this.sortArchive();
    this.rebuildOrder();
    const focused = opened[opened.length - 1];
    if (focused) {
      this.activeId = focused.id;
    }
    this.persistSoon();
    for (const tab of archived) {
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
    }
    for (let i = 0; i < opened.length; i += 1) {
      const tab = opened[i];
      const last = i === opened.length - 1;
      this.emit("tab_upserted", toMeta(tab), this.order.indexOf(tab.id), {
        activate: last,
        structural: true,
      });
    }
    if (focused) {
      this.emit("tab_focused", focused.id);
    }
    return {
      tabs: drafts,
      opened: opened.length,
      archived: archived.length,
      focusedId: focused?.id ?? null,
    };
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
    if (existing && isTemplateBound(existing.tab)) {
      throw new Error(boundHtmlError(existing.tab, this.templateLabel(existing.tab)));
    }
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
    input: {
      edits?: HtmlEdit[];
      /** Replaces the whole body, e.g. a checked-out file. Mutually exclusive with edits. */
      html?: string;
      title?: string;
      activate?: boolean;
      expectedRevision?: number;
    }
  ): { tab: Tab; applied: number; archived: boolean } {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isTemplateBound(located.tab)) {
      throw new Error(boundHtmlError(located.tab, this.templateLabel(located.tab)));
    }
    assertRevision(located.tab.revision, input.expectedRevision);
    let nextTitle = located.tab.title;
    if (input.title !== undefined) {
      nextTitle = input.title.trim();
      if (!nextTitle) {
        throw new Error("title is required");
      }
    }
    const result = replaceOrEdit(located.tab, input);
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
    patch: { title?: string; html?: string; pin?: boolean; activate?: boolean; expectedRevision?: number }
  ): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    assertRevision(located.tab.revision, patch.expectedRevision);
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
      if (isTemplateBound(tab)) {
        throw new Error(boundHtmlError(tab, this.templateLabel(tab)));
      }
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

  /** Exchange strip coordinates of two open tabs in the same pin group. */
  swapStripSeq(aIdOrKey: string, bIdOrKey: string): void {
    const a = this.requireOpen(aIdOrKey);
    const b = this.requireOpen(bIdOrKey);
    if (a.id === b.id) {
      return;
    }
    if (a.pinned !== b.pinned) {
      throw new Error("cannot reorder across pin groups");
    }
    const seq = a.stripSeq;
    a.stripSeq = b.stripSeq;
    b.stripSeq = seq;
    this.markDirty(a.id);
    this.markDirty(b.id);
    this.rebuildOrder();
    this.persistSoon();
  }

  /**
   * Walk `id` to `targetIndexInGroup` inside its pin group by adjacent seq swaps.
   * Does not change activeId or revision.
   */
  moveByAdjacentSwaps(idOrKey: string, targetIndexInGroup: number): Tab {
    const tab = this.requireOpen(idOrKey);
    if (!Number.isFinite(targetIndexInGroup)) {
      throw new Error("target index is required");
    }
    const groupOf = (): string[] => this.order.filter((id) => this.tabs.get(id)?.pinned === tab.pinned);
    let group = groupOf();
    const from = group.indexOf(tab.id);
    if (from === -1) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const target = Math.max(0, Math.min(group.length - 1, Math.trunc(targetIndexInGroup)));
    if (from === target) {
      return tab;
    }
    const previous = new Map(this.order.map((id, index) => [id, index] as const));
    let at = from;
    while (at < target) {
      group = groupOf();
      this.swapStripSeq(group[at], group[at + 1]);
      at += 1;
    }
    while (at > target) {
      group = groupOf();
      this.swapStripSeq(group[at], group[at - 1]);
      at -= 1;
    }
    for (const id of this.order) {
      const next = this.order.indexOf(id);
      if (previous.get(id) === next) {
        continue;
      }
      const moved = this.tabs.get(id);
      if (moved) {
        this.emit("tab_upserted", toMeta(moved), next, { activate: false, structural: false });
      }
    }
    return tab;
  }

  /** Place an open tab before `before` in its pin group, or at the end when `before` is null. */
  reorderTab(idOrKey: string, before: string | null): Tab {
    const tab = this.requireOpen(idOrKey);
    const group = this.order.filter((id) => this.tabs.get(id)?.pinned === tab.pinned);
    let target = group.length - 1;
    if (before !== null) {
      const other = this.requireOpen(before);
      if (other.pinned !== tab.pinned) {
        throw new Error("cannot reorder across pin groups");
      }
      const beforeIndex = group.indexOf(other.id);
      const from = group.indexOf(tab.id);
      if (beforeIndex === -1 || from === -1) {
        throw new Error("cannot reorder across pin groups");
      }
      if (from === beforeIndex) {
        return tab;
      }
      target = from < beforeIndex ? beforeIndex - 1 : beforeIndex;
    }
    return this.moveByAdjacentSwaps(tab.id, target);
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
    const resolved = this.applyResolveIncompatibility(tab, input.resolveIncompatibility);
    const serialized = JSON.stringify(next);
    const stateChanged = serialized !== JSON.stringify(tab.state);
    if (!stateChanged && !resolved) {
      return { ok: true, tab };
    }
    if (stateChanged) {
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_STATE_BYTES) {
        throw new Error(`state is too large (${bytes} bytes, max ${MAX_STATE_BYTES})`);
      }
      tab.state = next;
      tab.stateRevision += 1;
      tab.stateUpdatedAt = Date.now();
    }
    if (located.where === "archive" && (stateChanged || resolved)) {
      tab.updatedAt = Date.now();
      this.touchArchive(tab);
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
    }
    this.markDirty(tab.id);
    this.persistSoon();
    if (stateChanged) {
      this.emit("tab_state", tab, input.client);
    }
    if (resolved && located.where !== "archive") {
      this.emit("tab_upserted", toMeta(tab), undefined, {
        activate: false,
        structural: false,
      });
    }
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
    if (isAppTab(located.tab)) {
      return this.discardAppTab(located.tab);
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
    const archived: string[] = [];
    for (const id of ids) {
      this.archiveTab(id);
      if (this.archive.has(id)) {
        archived.push(id);
      }
    }
    return archived;
  }

  deletePermanent(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isAppTab(located.tab)) {
      return this.discardAppTab(located.tab);
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
    if (this.persistRetryTimer) {
      clearTimeout(this.persistRetryTimer);
      this.persistRetryTimer = null;
    }
    if (!this.db) {
      return;
    }
    this.ensureUniqueStripSeqs();
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
        templates: [...this.templates.values()],
        removedTemplateIds: [...this.removedTemplates],
        bindings: this.collectBindings(),
        replaceBindings: true,
      });
      this.dirty.clear();
      this.removed.clear();
      this.removedTemplates.clear();
      this.templatesDirty = false;
      if (this.persistError) {
        this.persistError = null;
        this.emit("persist_ok");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("Failed to persist board state", message);
      this.persistError = message;
      this.emit("persist_error", message);
      this.schedulePersistRetry();
    }
  }

  closeDb(): void {
    this.persist();
    if (this.persistRetryTimer) {
      clearTimeout(this.persistRetryTimer);
      this.persistRetryTimer = null;
    }
    try {
      this.db?.close();
    } catch (err) {
      log("Failed to close board database", String(err));
    }
    this.db = null;
  }

  private requireOpen(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (located.where !== "open") {
      throw new Error("cannot reorder an archived tab");
    }
    return located.tab;
  }

  private requireAny(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    return located.tab;
  }

  private buildImportedDraft(page: ImportPageInput, reserved: Set<string>): Tab {
    const title = page.title.trim();
    if (!title) {
      throw new Error("title is required");
    }
    if (!page.html || !page.html.trim()) {
      throw new Error("html is required");
    }
    const html = wrapHtml(title, page.html);
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    if (page.state) {
      const stateBytes = Buffer.byteLength(JSON.stringify(page.state), "utf8");
      if (stateBytes > MAX_STATE_BYTES) {
        throw new Error(`state is too large (${stateBytes} bytes, max ${MAX_STATE_BYTES})`);
      }
    }
    const id = newId();
    let assets: TabAsset[] = [];
    try {
      assets = applyAssets(id, [], page.assets);
    } catch (err) {
      deleteTabAssets(id);
      throw err;
    }
    const now = Date.now();
    const requested = page.key && normalizeKey(page.key) !== WELCOME_KEY ? page.key : undefined;
    const tab: Tab = {
      id,
      key: uniqueKey(this, requested, title, id, reserved),
      title,
      html,
      pinned: Boolean(page.pinned),
      createdAt: finiteTs(page.createdAt) ?? now,
      updatedAt: finiteTs(page.updatedAt) ?? now,
      stripSeq: this.nextSeq(),
      revision: 1,
      state: {},
      stateRevision: 0,
      stateUpdatedAt: 0,
      signalRevision: 0,
      signal: null,
      assets,
    };
    seedState(tab, page.state);
    return tab;
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

  /** Drop an in-app page (help) without archiving or keeping it on the Ctrl+Z stack. */
  private discardAppTab(tab: Tab): Tab {
    const wasActive = this.activeId === tab.id;
    const wasOpen = this.tabs.has(tab.id);
    this.tabs.delete(tab.id);
    this.archive.delete(tab.id);
    this.archiveOrder = this.archiveOrder.filter((id) => id !== tab.id);
    this.deleted = this.deleted.filter((entry) => entry.tab.id !== tab.id);
    this.rebuildOrder();
    delete tab.archivedAt;
    if (wasActive) {
      this.activeId = this.order[this.order.length - 1] ?? null;
    }
    this.removed.add(tab.id);
    this.dirty.delete(tab.id);
    deleteTabAssets(tab.id);
    this.persistSoon();
    this.emit("tab_closed", tab.id);
    if (wasOpen) {
      this.emit("tab_focused", this.activeId);
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

  private persistSoon(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.persist(), 150);
  }

  private schedulePersistRetry(): void {
    if (this.persistRetryTimer || !this.db) {
      return;
    }
    this.persistRetryTimer = setTimeout(() => {
      this.persistRetryTimer = null;
      this.persist();
    }, 2000);
  }

  /** Later copies of a seq get a new number so SQLite UNIQUE(strip_seq) cannot stick. */
  private ensureUniqueStripSeqs(): void {
    const seen = new Set<number>();
    const tabs = [
      ...this.order.map((id) => this.tabs.get(id)),
      ...this.archiveOrder.map((id) => this.archive.get(id)),
      ...this.deleted.map((entry) => entry.tab),
    ];
    let changed = false;
    for (const tab of tabs) {
      if (!tab) {
        continue;
      }
      if (seen.has(tab.stripSeq)) {
        tab.stripSeq = this.nextSeq();
        this.markDirty(tab.id);
        changed = true;
      } else {
        seen.add(tab.stripSeq);
      }
    }
    if (changed) {
      this.rebuildOrder();
    }
  }

  private locateTemplate(idOrKey: string): Template | undefined {
    const byId = this.templates.get(idOrKey);
    if (byId) {
      return byId;
    }
    const key = normalizeKey(idOrKey);
    for (const template of this.templates.values()) {
      if (template.key === key || template.id === idOrKey) {
        return template;
      }
    }
    return undefined;
  }

  private requireTemplate(idOrKey: string): Template {
    const template = this.locateTemplate(idOrKey);
    if (!template) {
      throw new Error(`template not found: ${idOrKey}`);
    }
    return template;
  }

  private instanceCount(templateId: string): number {
    let count = 0;
    for (const tab of this.allTabs()) {
      if (tab.templateId === templateId) {
        count += 1;
      }
    }
    return count;
  }

  private allTabs(): Tab[] {
    return [
      ...this.tabs.values(),
      ...this.archive.values(),
      ...this.deleted.map((entry) => entry.tab),
    ];
  }

  private collectBindings(): TemplateBinding[] {
    const bindings: TemplateBinding[] = [];
    for (const tab of this.allTabs()) {
      if (!tab.templateId) {
        continue;
      }
      bindings.push({
        tabId: tab.id,
        templateId: tab.templateId,
        values: tab.templateValues ?? {},
        stateVersion: tab.templateStateVersion ?? 0,
        compatible: tab.templateCompatible !== false,
        ...(tab.templateIncompatibleReason ? { reason: tab.templateIncompatibleReason } : {}),
      });
    }
    return bindings;
  }

  private markTemplateDirty(id: string): void {
    this.templatesDirty = true;
    this.removedTemplates.delete(id);
  }

  private templateLabel(tab: Tab): string {
    if (!tab.templateId) {
      return "a template";
    }
    const template = this.templates.get(tab.templateId);
    return template ? template.key : tab.templateId;
  }

  private refreshTemplateInstances(template: Template, versionChanged: boolean): void {
    for (const tab of this.allTabs()) {
      if (tab.templateId !== template.id) {
        continue;
      }
      const values = mergeTemplateValues(template.fields, tab.templateValues);
      const compatible = versionChanged ? false : tab.templateCompatible !== false;
      const reason = versionChanged
        ? "The template changed and this page's data may no longer match. Ask an agent to update it."
        : tab.templateIncompatibleReason;
      this.applyTemplateRender(tab, template, values, compatible, reason);
      const located = this.locate(tab.id);
      if (located?.where === "archive") {
        this.touchArchive(tab);
      }
      this.markDirty(tab.id);
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
    }
  }

  private applyTemplateRender(
    tab: Tab,
    template: Template,
    values: TemplateValues,
    compatible: boolean,
    reason?: string
  ): void {
    const title = renderTemplateTitle(template, values);
    tab.title = title;
    tab.html = this.renderBoundHtml(template, title, values);
    tab.updatedAt = Date.now();
    tab.revision += 1;
    this.bindTab(tab, template, values, compatible, reason);
  }

  private renderBoundHtml(template: Template, title: string, values: TemplateValues): string {
    const html = wrapHtml(title, substituteTemplate(template.html, values, true));
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    return html;
  }

  private bindTab(
    tab: Tab,
    template: Template,
    values: TemplateValues,
    compatible: boolean,
    reason?: string
  ): void {
    tab.templateId = template.id;
    tab.templateValues = values;
    tab.templateStateVersion = template.stateVersion;
    tab.templateCompatible = compatible;
    if (!compatible && reason) {
      tab.templateIncompatibleReason = reason;
    } else if (compatible) {
      delete tab.templateIncompatibleReason;
    }
  }

  private unlinkTemplate(tab: Tab): void {
    delete tab.templateId;
    delete tab.templateValues;
    delete tab.templateStateVersion;
    delete tab.templateCompatible;
    delete tab.templateIncompatibleReason;
    tab.updatedAt = Date.now();
    this.markDirty(tab.id);
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
  }

  private applyResolveIncompatibility(tab: Tab, resolve?: boolean): boolean {
    if (!resolve || !tab.templateId || tab.templateCompatible !== false) {
      return false;
    }
    const template = this.templates.get(tab.templateId);
    tab.templateCompatible = true;
    delete tab.templateIncompatibleReason;
    if (template) {
      tab.templateStateVersion = template.stateVersion;
    }
    return true;
  }

  private touchIfArchived(located: Located): void {
    if (located.where === "archive") {
      this.touchArchive(located.tab);
    }
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

function replaceOrEdit(tab: Tab, input: { edits?: HtmlEdit[]; html?: string }): HtmlEditResult {
  if (input.html !== undefined) {
    if (input.edits?.length) {
      throw new Error("pass either edits or html, not both");
    }
    if (!input.html.trim()) {
      throw new Error("html is required");
    }
    return { html: wrapHtml(tab.title, input.html), applied: 1 };
  }
  return applyEdits(tab.html, input.edits ?? []);
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

function newTemplateId(): string {
  return "tpl_" + randomBytes(4).toString("hex");
}

function uniqueTemplateKey(
  store: BoardStore,
  requested: string | undefined,
  title: string,
  id: string
): string {
  const taken = (key: string) => Boolean(store.getTemplate(key));
  if (requested) {
    const key = normalizeKey(requested);
    if (key && !taken(key)) {
      return key;
    }
    if (key) {
      return `${key}-${id.slice(4)}`;
    }
  }
  const base = normalizeKey(title) || "template";
  if (!taken(base)) {
    return base;
  }
  return `${base}-${id.slice(4)}`;
}

function applyBinding(tab: Tab, binding: TemplateBinding | undefined): void {
  if (!binding) {
    return;
  }
  tab.templateId = binding.templateId;
  tab.templateValues = binding.values;
  tab.templateStateVersion = binding.stateVersion;
  tab.templateCompatible = binding.compatible;
  if (binding.reason) {
    tab.templateIncompatibleReason = binding.reason;
  }
}

function boundHtmlError(tab: Tab, label: string): string {
  return `This page (${tab.key}) is bound to template "${label}". Edit the template with board_template_upsert instead of changing this page's HTML.`;
}

function uniqueKey(
  store: BoardStore,
  requested: string | undefined,
  title: string,
  id: string,
  reserved: Set<string> = new Set()
): string {
  const taken = (key: string) => Boolean(store.get(key)) || reserved.has(key);
  if (requested) {
    const key = normalizeKey(requested);
    if (key && !taken(key)) {
      return key;
    }
    if (key) {
      return `${key}-${id.slice(2)}`;
    }
  }
  const base = normalizeKey(title) || "page";
  if (!taken(base)) {
    return base;
  }
  return `${base}-${id.slice(2)}`;
}

function shouldArchive(destination: ImportDestination, archivedAt?: number): boolean {
  switch (destination) {
    case "archive":
      return true;
    case "meta":
      return typeof archivedAt === "number";
    default: {
      const _never: never = destination;
      return _never;
    }
  }
}

function finiteTs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const store = new BoardStore();
