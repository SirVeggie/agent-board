import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { cleanupOrphanAssets, deleteTabAssets, normalizeTabAssets, readPreparedAssets, writePreparedAssets } from "./assets.js";
import { buildExport, type BoardExportFile, type ImportPageInput } from "./boardExport.js";
import { BUILTIN_ID_PREFIX, isBuiltinId, loadBuiltinTemplates } from "./builtinTemplates.js";
import { searchLibrary as rankLibrary, LIBRARY_PAGE_DEFAULT, type LibrarySearchResult } from "./librarySearch.js";
import { searchPages as rankPages, PAGE_SEARCH_DEFAULT, type PageSearchResult } from "./pageSearch.js";
import {
  ASSET_SWEEP_INTERVAL_MS,
  MAX_HTML_BYTES,
  MAX_STATE_BYTES,
  PAGE_ASSET_ORPHAN_GRACE_MS,
  dbPath,
  statePath,
} from "./config.js";
import { BoardDb, type StoredFolder, type StoredTab } from "./db.js";
import { log } from "./log.js";
import {
  assertPageAssetRoom,
  assertPageAssetSize,
  cleanPageAssetName,
  collectPageAssetRefs,
  isPageAssetId,
  newPageAssetId,
  normalizePageAssetMime,
  pageAssetUrl,
  pageAssetUsage,
  readPageAssetFile,
  remapPageAssetRefs,
  substituteStateAssets,
  type PageAssetFile,
  type PageAssetDraft,
  type PageAssetInput,
  type PageAssetMeta,
  type PageAssetUsage,
} from "./pageAssets.js";
import { normalizeSignalName } from "./signal.js";
import {
  TRASH_TTL_MS,
  USER_TITLE_HOLD_MS,
  WELCOME_KEY,
  isAppTab,
  isPlainObject,
  isTemplateBound,
  toMeta,
  toTemplateMeta,
  visibleTo,
  type BoardState,
  type DeletedBatch,
  type Folder,
  type ImportDestination,
  type RestorePlacement,
  type SetStateInput,
  type SetStateResult,
  type SignalInput,
  type Tab,
  type TabAsset,
  type TabMeta,
  type BuiltinTemplateMeta,
  type Template,
  type TemplateBinding,
  type TemplateMeta,
  type TemplateValues,
  type TrashBatch,
  type UpsertInput,
  type Viewer,
} from "./types.js";
import { applyEdits, assertRevision, type HtmlEdit, type HtmlEditResult } from "./htmlEdit.js";
import {
  mergeTemplateValues,
  normalizeTemplateInput,
  parseTemplateValues,
  renderTemplateTitle,
  substituteTemplate,
  templateFingerprint,
  type TemplateUpsertInput,
} from "./templates.js";
import { wrapHtml } from "./wrapHtml.js";

type Located = { tab: Tab; where: "open" | "closed" };

export type FolderDeleteMode = "lift" | "delete";

/** Which date the Library clean-up compares: latest activity (edit, data, or close), last edit, creation, or close. */
export type CleanupBasis = "activity" | "edited" | "created" | "closed";
export const CLEANUP_BASES: CleanupBasis[] = ["activity", "edited", "created", "closed"];

export type CleanupOptions = {
  days: number;
  basis?: CleanupBasis;
  includeOpen?: boolean;
  includePinned?: boolean;
};

const FOLDER_NAME_MAX = 120;

export class BoardStore extends EventEmitter {
  private tabs = new Map<string, Tab>();
  private order: string[] = [];
  private closed = new Map<string, Tab>();
  private folders = new Map<string, Folder>();
  private deleted: DeletedBatch[] = [];
  private activeId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private persistRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private trashTimer: ReturnType<typeof setInterval> | null = null;
  private assetSweepTimer: ReturnType<typeof setInterval> | null = null;
  private assetExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private assetExpiryAt = 0;
  /** Count and bytes of page assets, for pages that have any. Mirrors the page_assets table. */
  private pageAssetTotals = new Map<string, { count: number; bytes: number }>();
  private persistError: string | null = null;
  private lastStamp = 0;
  private lastSeq = 0;
  private db: BoardDb | null = null;
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private foldersDirty = false;
  private templates = new Map<string, Template>();
  private builtins: Template[] = [];
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
    this.builtins = loadBuiltinTemplates();
    this.adoptBuiltinCopies();
    const bindings = new Map(snapshot.bindings.map((binding) => [binding.tabId, binding]));
    const batches = new Map<string, DeletedBatch>();
    const batchOf = (id: string, at: number): DeletedBatch => {
      let batch = batches.get(id);
      if (!batch) {
        batch = { id, deletedAt: at, tabs: [], folders: [] };
        batches.set(id, batch);
      }
      batch.deletedAt = Math.max(batch.deletedAt, at);
      return batch;
    };
    for (const row of snapshot.rows) {
      const tab = withStateDefaults(row.tab);
      applyBinding(tab, bindings.get(tab.id));
      this.lastSeq = Math.max(this.lastSeq, tab.stripSeq);
      if (row.status === "open") {
        delete tab.closedAt;
        this.tabs.set(tab.id, tab);
      } else if (isAppTab(tab)) {
        this.removed.add(tab.id);
      } else if (row.status === "closed") {
        tab.closedAt = typeof tab.closedAt === "number" ? tab.closedAt : tab.updatedAt;
        this.closed.set(tab.id, tab);
      } else {
        const at = typeof row.deletedAt === "number" ? row.deletedAt : tab.updatedAt;
        batchOf(row.deletedBatch ?? tab.id, at).tabs.push(tab);
      }
    }
    for (const stored of snapshot.folders) {
      if (stored.deletedAt === undefined) {
        this.folders.set(stored.folder.id, stored.folder);
      } else {
        batchOf(stored.deletedBatch ?? stored.folder.id, stored.deletedAt).folders.push(stored.folder);
      }
    }
    this.deleted = [...batches.values()].sort((a, b) => a.deletedAt - b.deletedAt);
    this.expireTrash();
    this.trashTimer = setInterval(() => {
      if (this.expireTrash()) {
        this.persistSoon();
      }
    }, 60 * 60 * 1000);
    this.trashTimer.unref?.();
    this.repairLibraryRefs();
    this.rebuildOrder();
    this.lastStamp = Math.max(
      this.lastStamp,
      ...[...this.closed.values()].map((tab) => tab.closedAt ?? 0),
      ...this.deleted.map((batch) => batch.deletedAt)
    );
    this.activeId =
      snapshot.activeId && this.tabs.has(snapshot.activeId) ? snapshot.activeId : (this.order[0] ?? null);
    this.pageAssetTotals = this.db.pageAssetTotals();
    this.sweepAssets();
    this.assetSweepTimer = setInterval(() => this.sweepAssets(), ASSET_SWEEP_INTERVAL_MS);
    this.assetSweepTimer.unref?.();
    this.syncBuiltinCopies();
    if (this.removed.size || this.foldersDirty || this.dirty.size || this.templatesDirty) {
      this.persistSoon();
    }
  }

  snapshot(): {
    tabs: TabMeta[];
    closed: TabMeta[];
    folders: Folder[];
    activeId: string | null;
    templates: TemplateMeta[];
    builtinTemplates: BuiltinTemplateMeta[];
    persistError: string | null;
  } {
    return {
      tabs: this.order.map((id) => toMeta(this.tabs.get(id)!)),
      closed: [...this.closed.values()].sort(byLibPos).map(toMeta),
      folders: this.listFolders(),
      activeId: this.activeId,
      templates: this.listTemplates(),
      builtinTemplates: this.listBuiltinTemplates(),
      persistError: this.persistError,
    };
  }

  list(viewer: Viewer = "user"): TabMeta[] {
    return this.listOpenTabs(viewer).map(toMeta);
  }

  closedCount(viewer: Viewer = "user"): number {
    let count = 0;
    for (const tab of this.closed.values()) {
      if (visibleTo(tab, viewer)) {
        count += 1;
      }
    }
    return count;
  }

  listOpenTabs(viewer: Viewer = "user"): Tab[] {
    return this.order
      .map((id) => this.tabs.get(id)!)
      .filter((tab) => tab && visibleTo(tab, viewer));
  }

  listClosedTabs(viewer: Viewer = "user"): Tab[] {
    return [...this.closed.values()].filter((tab) => visibleTo(tab, viewer)).sort(byClosedDesc);
  }

  listFolders(): Folder[] {
    return [...this.folders.values()].sort((a, b) => a.pos - b.pos);
  }

  /** Library path like "CLIMS/Releases", or null for the root. */
  folderPath(folderId: string | undefined | null): string | null {
    const names: string[] = [];
    const seen = new Set<string>();
    let at = folderId ? this.folders.get(folderId) : undefined;
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      names.unshift(at.name);
      at = at.parentId ? this.folders.get(at.parentId) : undefined;
    }
    return names.length ? names.join("/") : null;
  }

  /** Existing folder for a path, without creating anything. Undefined when any part is missing. */
  findFolderPath(path: string): string | null | undefined {
    let parentId: string | null = null;
    for (const name of splitFolderPath(path)) {
      const match: Folder | undefined = this.foldersIn(parentId).find((folder) => sameName(folder.name, name));
      if (!match) {
        return undefined;
      }
      parentId = match.id;
    }
    return parentId;
  }

  /** Every folder as a path, depth-first in Library order, with its own page count (not subfolders'). */
  folderTree(viewer: Viewer = "user"): Array<{ id: string; path: string; pages: number }> {
    const out: Array<{ id: string; path: string; pages: number }> = [];
    const walk = (parentId: string | null, prefix: string) => {
      for (const folder of this.foldersIn(parentId)) {
        const path = prefix ? `${prefix}/${folder.name}` : folder.name;
        const pages = this.pagesIn(folder.id).filter((tab) => visibleTo(tab, viewer)).length;
        out.push({ id: folder.id, path, pages });
        walk(folder.id, path);
      }
    };
    walk(null, "");
    return out;
  }

  searchOpen(query: string, viewer: Viewer = "user"): LibrarySearchResult {
    const tabs = this.listOpenTabs(viewer);
    return rankLibrary(tabs, query, 0, Math.max(tabs.length, 1));
  }

  /** Every page, open or closed, in Library tree order unless a query ranks them. */
  searchLibrary(
    query: string,
    opts: { offset?: number; limit?: number; folderId?: string | null; viewer?: Viewer } = {}
  ): LibrarySearchResult {
    const viewer = opts.viewer ?? "user";
    const off = Math.max(0, Math.floor(opts.offset ?? 0));
    const lim = Math.max(1, Math.floor(opts.limit ?? LIBRARY_PAGE_DEFAULT));
    let pages = this.treeOrder().filter((tab) => visibleTo(tab, viewer));
    if (opts.folderId !== undefined) {
      const scope = opts.folderId === null ? null : this.subtreeFolderIds(opts.folderId);
      pages = pages.filter((tab) => (scope === null ? !tab.folderId : Boolean(tab.folderId && scope.has(tab.folderId))));
    }
    return rankLibrary(pages, query, off, lim);
  }

  searchPages(query: string, limit?: number, viewer: Viewer = "user"): PageSearchResult {
    return rankPages(this.listOpenTabs(viewer), this.listClosedTabs(viewer), query, limit ?? PAGE_SEARCH_DEFAULT);
  }

  listTemplates(viewer: Viewer = "user"): TemplateMeta[] {
    return [...this.templates.values()]
      .sort((a, b) => a.title.localeCompare(b.title) || a.createdAt - b.createdAt)
      .map((template) => this.templateMeta(template, this.instanceCount(template.id, viewer)));
  }

  setAgentHidden(idOrKey: string, hidden: boolean): Tab {
    const tab = this.requireAny(idOrKey);
    if (Boolean(tab.agentHidden) === hidden) {
      return tab;
    }
    if (hidden) {
      tab.agentHidden = true;
    } else {
      delete tab.agentHidden;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  /** Template metadata, flagging a built-in's copy that fell behind its built-in. */
  templateMeta(template: Template, instanceCount = 0): TemplateMeta {
    const builtin = template.source ? this.locateBuiltin(template.source.builtin) : undefined;
    return toTemplateMeta(template, instanceCount, Boolean(builtin && template.source!.fingerprint !== templateFingerprint(builtin)));
  }

  listBuiltinTemplates(): BuiltinTemplateMeta[] {
    return this.builtins.map((builtin) => {
      const { instanceCount: _count, builtinSource: _source, ...meta } = toTemplateMeta(builtin);
      const local = this.localCopyOf(builtin.key);
      return { ...meta, builtIn: true, ...(local ? { localId: local.id } : {}) };
    });
  }

  /**
   * The agent guide for a template: its own, or for a local copy of a built-in, the built-in's.
   * `id` names the guide across copies, so an agent is not sent the same text twice.
   */
  templateGuide(idOrKey: string): { id: string; title: string; text: string } | undefined {
    const found = this.findTemplate(idOrKey);
    if (!found) {
      return undefined;
    }
    const { template } = found;
    if (template.guide) {
      return { id: template.id, title: template.title, text: template.guide };
    }
    const builtin = template.source ? this.locateBuiltin(template.source.builtin) : undefined;
    return builtin?.guide ? { id: builtin.id, title: builtin.title, text: builtin.guide } : undefined;
  }

  /** The user's own templates only. findTemplate also looks at built-ins. */
  getTemplate(idOrKey: string): Template | undefined {
    return this.locateTemplate(idOrKey);
  }

  /** A local template first, then a built-in by id or key. */
  findTemplate(idOrKey: string): { template: Template; builtIn: boolean } | undefined {
    const local = isBuiltinId(idOrKey) ? undefined : this.locateTemplate(idOrKey);
    if (local) {
      return { template: local, builtIn: false };
    }
    const builtin = this.locateBuiltin(idOrKey);
    return builtin ? { template: builtin, builtIn: true } : undefined;
  }

  /**
   * The local copy of a built-in, created on first use. An app update only changes it while it is
   * unedited and the state format is unchanged (see syncBuiltinCopies). The copy is found again by
   * its source, even after it has been edited.
   */
  copyBuiltinTemplate(idOrKey: string): { template: Template; created: boolean } {
    const builtin = this.locateBuiltin(idOrKey);
    if (!builtin) {
      throw new Error(`template not found: ${idOrKey}`);
    }
    const existing = this.localCopyOf(builtin.key);
    if (existing) {
      return { template: existing, created: false };
    }
    const id = newTemplateId();
    const now = Date.now();
    // The guide stays with the built-in, so an app update reaches copies made before it.
    const { guide: _guide, ...content } = structuredClone(builtin);
    const template: Template = {
      ...content,
      id,
      key: uniqueTemplateKey(this, builtin.key, builtin.title, id),
      createdAt: now,
      updatedAt: now,
      source: { builtin: builtin.key, fingerprint: templateFingerprint(builtin) },
    };
    this.templates.set(id, template);
    this.markTemplateDirty(id);
    this.persistSoon();
    this.emit("template_upserted", this.templateMeta(template, 0));
    this.emit("builtin_templates", this.listBuiltinTemplates());
    return { template, created: true };
  }

  upsertTemplate(input: TemplateUpsertInput): { template: Template; created: boolean } {
    if (input.id && isBuiltinId(input.id)) {
      throw new Error("built-in templates are read-only. Open it once to get a local copy, then update that copy by its key.");
    }
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
      if (parsed.guide !== undefined) {
        if (parsed.guide) {
          existing.guide = parsed.guide;
        } else {
          delete existing.guide;
        }
      }
      if (parsed.stateVersion !== undefined) {
        existing.stateVersion = parsed.stateVersion;
      }
      const builtin = existing.source ? this.locateBuiltin(existing.source.builtin) : undefined;
      if (input.syncedWithBuiltin && builtin) {
        existing.source = { builtin: builtin.key, fingerprint: templateFingerprint(builtin) };
      }
      existing.updatedAt = now;
      this.markTemplateDirty(existing.id);
      this.refreshTemplateInstances(existing, parsed.stateVersion !== undefined && parsed.stateVersion !== prevVersion);
      this.persistSoon();
      this.emit("template_upserted", this.templateMeta(existing, this.instanceCount(existing.id)));
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
      ...(parsed.guide ? { guide: parsed.guide } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(id, template);
    this.markTemplateDirty(id);
    this.persistSoon();
    this.emit("template_upserted", this.templateMeta(template, 0));
    return { template, created: true };
  }

  deleteTemplate(idOrKey: string): Template {
    const template = isBuiltinId(idOrKey) ? undefined : this.locateTemplate(idOrKey);
    if (!template) {
      if (this.locateBuiltin(idOrKey)) {
        throw new Error("built-in templates cannot be deleted");
      }
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
    if (template.source) {
      this.emit("builtin_templates", this.listBuiltinTemplates());
    }
    return template;
  }

  openFromTemplate(
    idOrKey: string,
    values: unknown,
    opts?: { activate?: boolean; agentHidden?: boolean }
  ): { tab: Tab; created: boolean; template: Template; copiedBuiltin: boolean } {
    const found = this.findTemplate(idOrKey);
    if (!found) {
      throw new Error(`template not found: ${idOrKey}`);
    }
    // Validate against the built-in first so a bad form doesn't leave a stray copy behind.
    parseTemplateValues(found.template.fields, values);
    const copy = found.builtIn ? this.copyBuiltinTemplate(found.template.id) : undefined;
    const template = copy ? copy.template : found.template;
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
    if (opts?.agentHidden) {
      tab.agentHidden = true;
    }
    this.bindTab(tab, template, parsed, true);
    this.markDirty(tab.id);
    this.persistSoon();
    const index = this.order.indexOf(tab.id);
    this.emit("tab_upserted", toMeta(tab), index === -1 ? undefined : index, {
      activate: opts?.activate !== false,
      structural: true,
    });
    return { tab, created: true, template, copiedBuiltin: Boolean(copy?.created) };
  }

  setTemplateValues(idOrKey: string, values: unknown): Tab {
    const tab = this.requireAny(idOrKey);
    if (!tab.templateId) {
      throw new Error("this page is not bound to a template");
    }
    const template = this.requireTemplate(tab.templateId);
    const parsed = parseTemplateValues(template.fields, values);
    this.applyTemplateRender(tab, template, parsed, tab.templateCompatible !== false);
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, {
      activate: false,
      structural: true,
    });
    return tab;
  }

  reportIncompatible(idOrKey: string, reason?: string): Tab {
    const tab = this.requireAny(idOrKey);
    if (!tab.templateId) {
      throw new Error("this page is not bound to a template");
    }
    const message = (reason ?? "").trim() || "This page's data no longer matches the template.";
    if (tab.templateCompatible === false && tab.templateIncompatibleReason === message) {
      return tab;
    }
    tab.templateCompatible = false;
    tab.templateIncompatibleReason = message;
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, {
      activate: false,
      structural: false,
    });
    return tab;
  }

  /** One page, one folder subtree, or the whole Library. */
  exportFile(scope: { id?: string; folderId?: string } = {}): BoardExportFile {
    let tabs: Tab[];
    if (scope.id) {
      tabs = [this.requireAny(scope.id)];
    } else if (scope.folderId) {
      if (!this.folders.has(scope.folderId)) {
        throw new Error(`folder not found: ${scope.folderId}`);
      }
      const ids = this.subtreeFolderIds(scope.folderId);
      tabs = this.treeOrder().filter((tab) => tab.folderId && ids.has(tab.folderId));
    } else {
      tabs = this.treeOrder();
    }
    const templates = scope.id || scope.folderId
      ? [...new Set(tabs.map((tab) => tab.templateId).filter((id): id is string => Boolean(id)))]
          .map((id) => this.templates.get(id))
          .filter((template): template is Template => Boolean(template))
      : [...this.templates.values()];
    if (!tabs.length && !templates.length) {
      throw new Error("nothing to export");
    }
    return buildExport(
      tabs.map((tab) => ({
        tab,
        assets: readPreparedAssets(tab.id, tab.assets ?? []),
        pageAssets: this.pageAssetTotals.has(tab.id) ? this.requireDb().readPageAssetDrafts(tab.id) : [],
        folderPath: this.folderPath(tab.folderId),
      })),
      templates
    );
  }

  /** Templates are matched by content, so importing the same file twice links to the templates created the first time. */
  importBoard(
    input: { templates: Template[]; pages: ImportPageInput[] },
    destination: ImportDestination
  ): {
    tabs: Tab[];
    opened: number;
    closed: number;
    focusedId: string | null;
    templatesCreated: number;
    templatesReused: number;
  } {
    const { pages } = input;
    if (!pages.length && !input.templates.length) {
      throw new Error("nothing to import");
    }
    const plan = this.planTemplateImport(input.templates);
    const drafts: Tab[] = [];
    const reserved = new Set<string>();
    const pendingAssets = new Map<string, PageAssetDraft[]>();
    try {
      for (const page of pages) {
        const tab = this.buildImportedDraft(page, reserved, plan.byFileId, pendingAssets);
        reserved.add(tab.key);
        drafts.push(tab);
      }
    } catch (err) {
      for (const tab of drafts) {
        deleteTabAssets(tab.id);
      }
      throw err;
    }

    for (const template of plan.created) {
      this.templates.set(template.id, template);
      this.markTemplateDirty(template.id);
    }
    const foldersBefore = this.folders.size;
    this.placeImported(drafts, pages);
    const opened: Tab[] = [];
    const closed: Tab[] = [];
    for (let i = 0; i < drafts.length; i += 1) {
      const tab = drafts[i];
      const page = pages[i];
      if (shouldClose(destination, page.closedAt)) {
        tab.closedAt = typeof page.closedAt === "number" ? page.closedAt : this.stamp();
        this.closed.set(tab.id, tab);
        closed.push(tab);
      } else {
        this.tabs.set(tab.id, tab);
        opened.push(tab);
      }
      this.markDirty(tab.id);
    }
    this.rebuildOrder();
    const focused = opened[opened.length - 1];
    if (focused) {
      this.activeId = focused.id;
    }
    if (pendingAssets.size) {
      this.insertImportedPageAssets(pendingAssets);
    } else {
      this.persistSoon();
    }
    if (this.folders.size !== foldersBefore) {
      this.emitFolders();
    }
    for (const tab of closed) {
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
    if (plan.created.some((template) => template.source)) {
      this.emit("builtin_templates", this.listBuiltinTemplates());
    }
    for (const template of new Set(plan.byFileId.values())) {
      this.emit("template_upserted", this.templateMeta(template, this.instanceCount(template.id)));
    }
    return {
      tabs: drafts,
      opened: opened.length,
      closed: closed.length,
      focusedId: focused?.id ?? null,
      templatesCreated: plan.created.length,
      templatesReused: plan.reused,
    };
  }

  getActiveId(viewer: Viewer = "user"): string | null {
    const active = this.activeId ? this.tabs.get(this.activeId) : undefined;
    return active && visibleTo(active, viewer) ? active.id : null;
  }

  get(idOrKey: string, viewer: Viewer = "user"): Tab | undefined {
    const tab = this.locate(idOrKey)?.tab;
    return tab && visibleTo(tab, viewer) ? tab : undefined;
  }

  isClosed(idOrKey: string): boolean {
    return this.locate(idOrKey)?.where === "closed";
  }

  isOpen(idOrKey: string): boolean {
    return this.locate(idOrKey)?.where === "open";
  }

  upsert(input: UpsertInput): { tab: Tab; created: boolean; closed: boolean; titleKept?: string } {
    const requestedTitle = input.title.trim();
    if (!requestedTitle) {
      throw new Error("title is required");
    }
    if (!input.html || !input.html.trim()) {
      throw new Error("html is required");
    }

    const viewer = input.viewer ?? "user";
    const existing = input.key ? this.locateFor(input.key, viewer) : undefined;
    if (existing && isTemplateBound(existing.tab)) {
      throw new Error(boundHtmlError(existing.tab, this.templateLabel(existing.tab)));
    }
    const kept = existing ? this.heldTitle(existing.tab, requestedTitle, viewer) : undefined;
    const title = kept ? existing!.tab.title : requestedTitle;
    const html = wrapHtml(title, input.html);
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    if (existing?.where === "closed" && input.activate !== false) {
      this.restore(existing.tab.id, { placement: "append", activate: true });
    }

    const located = input.key ? this.locateFor(input.key, viewer) : undefined;
    const now = Date.now();
    if (located?.where === "closed") {
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
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, {
        activate: false,
        structural: true,
      });
      return { tab, created: false, closed: true, ...(kept ? { titleKept: kept } : {}) };
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
      return { tab, created: false, closed: false, ...(kept ? { titleKept: kept } : {}) };
    }

    const id = newId();
    let assets: TabAsset[] = [];
    try {
      assets = applyAssets(id, [], input.assets);
    } catch (err) {
      deleteTabAssets(id);
      throw err;
    }
    const foldersBefore = this.folders.size;
    const folderId = input.folder ? this.ensureFolderPath(input.folder) : null;
    const tab: Tab = {
      id,
      key: uniqueKey(this, input.key, title, id),
      title,
      html,
      pinned: Boolean(input.pin),
      createdAt: now,
      updatedAt: now,
      ...(folderId ? { folderId } : {}),
      libPos: this.pagePosAt(folderId, 0),
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
    if (this.folders.size !== foldersBefore) {
      this.emitFolders();
    }
    this.emit("tab_upserted", toMeta(tab), createdAt, {
      activate: input.activate !== false,
      structural: true,
    });
    if (input.activate !== false) {
      this.emit("tab_focused", id);
    }
    return { tab, created: true, closed: false };
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
      viewer?: Viewer;
    }
  ): { tab: Tab; applied: number; closed: boolean; titleKept?: string } {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isTemplateBound(located.tab)) {
      throw new Error(boundHtmlError(located.tab, this.templateLabel(located.tab)));
    }
    this.assertTabRevision(located.tab, input.expectedRevision);
    let nextTitle = located.tab.title;
    let kept: string | undefined;
    if (input.title !== undefined) {
      const requested = input.title.trim();
      if (!requested) {
        throw new Error("title is required");
      }
      kept = this.heldTitle(located.tab, requested, input.viewer ?? "user");
      nextTitle = kept ? located.tab.title : requested;
    }
    const result = replaceOrEdit(located.tab, input);
    const bytes = Buffer.byteLength(result.html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    const keptField = kept ? { titleKept: kept } : {};

    const htmlChanged = result.html !== located.tab.html;
    const titleChanged = nextTitle !== located.tab.title;
    if (!htmlChanged && !titleChanged) {
      return {
        tab: located.tab,
        applied: result.applied,
        closed: located.where === "closed",
        ...keptField,
      };
    }

    if (located.where === "closed" && input.activate !== false) {
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
    if (found.where === "closed") {
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
      return { tab, applied: result.applied, closed: true, ...keptField };
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
    return { tab, applied: result.applied, closed: false, ...keptField };
  }

  update(
    idOrKey: string,
    patch: {
      title?: string;
      html?: string;
      pin?: boolean;
      activate?: boolean;
      expectedRevision?: number;
      viewer?: Viewer;
    }
  ): { tab: Tab; titleKept?: string } {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    this.assertTabRevision(located.tab, patch.expectedRevision);
    let title: string | undefined;
    let kept: string | undefined;
    if (patch.title !== undefined) {
      const requested = patch.title.trim();
      if (!requested) {
        throw new Error("title is required");
      }
      kept = this.heldTitle(located.tab, requested, patch.viewer ?? "user");
      title = kept ? undefined : requested;
    }
    const structural = title !== undefined || patch.html !== undefined;
    if (located.where === "closed" && patch.activate !== false && structural) {
      this.restore(located.tab.id, { placement: "append", activate: true });
    }
    const found = this.locate(idOrKey);
    if (!found) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const tab = found.tab;
    let pinIndex: number | undefined;
    if (title !== undefined) {
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
    if (structural) {
      tab.updatedAt = Date.now();
      tab.revision += 1;
    }
    const keptField = kept ? { titleKept: kept } : {};
    if (found.where === "closed") {
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural });
      return { tab, ...keptField };
    }
    if (patch.activate !== false && structural) {
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
    return { tab, ...keptField };
  }

  /** A title the user typed. Bumps the revision and holds off agent titles for USER_TITLE_HOLD_MS. */
  renamePage(idOrKey: string, title: string): Tab {
    const tab = this.requireAny(idOrKey);
    const next = title.trim();
    if (!next) {
      throw new Error("title is required");
    }
    if (next === tab.title) {
      return tab;
    }
    const now = Date.now();
    tab.title = next;
    tab.userTitleAt = now;
    tab.updatedAt = now;
    tab.revision += 1;
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
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
    let next: BoardState = input.replace ? { ...input.state } : { ...tab.state, ...input.state };
    const attached = input.assets?.length ? this.prepareStateAssets(tab, next, input.assets) : undefined;
    if (attached) {
      next = attached.state;
    }
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
      const assets = attached ? this.insertPageAssetDrafts(tab, attached.drafts) : undefined;
      tab.state = next;
      tab.stateRevision += 1;
      tab.stateUpdatedAt = Date.now();
      this.markDirty(tab.id);
      this.persistSoon();
      this.emit("tab_state", tab, input.client);
      if (located.where === "closed" || resolved) {
        this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
      }
      return { ok: true, tab, ...(assets ? { assets } : {}) };
    }
    this.markDirty(tab.id);
    this.persistSoon();
    if (stateChanged) {
      this.emit("tab_state", tab, input.client);
    }
    if (located.where === "closed" || resolved) {
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
    if (located.where === "closed") {
      return this.restore(located.tab.id, { placement: "append", activate: true });
    }
    this.activeId = located.tab.id;
    this.persistSoon();
    this.emit("tab_focused", located.tab.id);
    return located.tab;
  }

  /** Remove a page's tab from the strip. The page stays where it is in the Library. */
  closeTab(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isAppTab(located.tab)) {
      return this.discardAppTab(located.tab);
    }
    if (located.where === "closed") {
      return located.tab;
    }
    const tab = located.tab;
    const prevOrder = this.order;
    this.tabs.delete(tab.id);
    this.rebuildOrder();
    tab.closedAt = this.stamp();
    this.closed.set(tab.id, tab);
    if (this.activeId === tab.id) {
      this.activeId = this.neighborOf(prevOrder, tab.id);
    }
    this.markDirty(tab.id);
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
    this.emit("tab_closed", tab.id);
    this.emit("tab_focused", this.activeId);
    return tab;
  }

  closeMany(filter: "all" | "unpinned", viewer: Viewer = "user"): string[] {
    const ids = this.listOpenTabs(viewer)
      .filter((tab) => filter === "all" || !tab.pinned)
      .map((tab) => tab.id);
    const closed: string[] = [];
    for (const id of ids) {
      this.closeTab(id);
      if (this.closed.has(id)) {
        closed.push(id);
      }
    }
    return closed;
  }

  /** Open or closed pages to the deleted bin as one undoable batch. */
  deleteMany(idsOrKeys: string[]): Tab[] {
    const batch: DeletedBatch = { id: newBatchId(), deletedAt: this.stamp(), tabs: [], folders: [] };
    const wasActive = this.activeId;
    const prevOrder = this.order;
    for (const idOrKey of idsOrKeys) {
      const located = this.locate(idOrKey);
      if (!located) {
        continue;
      }
      if (isAppTab(located.tab)) {
        this.discardAppTab(located.tab);
        continue;
      }
      this.detach(located);
      batch.tabs.push(located.tab);
    }
    if (!batch.tabs.length) {
      return [];
    }
    this.pushDeleted(batch);
    this.rebuildOrder();
    if (this.activeId && !this.tabs.has(this.activeId)) {
      this.activeId = this.neighborOf(prevOrder, this.activeId);
    }
    this.persistSoon();
    for (const tab of batch.tabs) {
      this.emit("tab_deleted", tab.id);
    }
    if (wasActive !== this.activeId) {
      this.emit("tab_focused", this.activeId);
    }
    return batch.tabs;
  }

  deletePermanent(idOrKey: string): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isAppTab(located.tab)) {
      return this.discardAppTab(located.tab);
    }
    this.deleteMany([located.tab.id]);
    return located.tab;
  }

  /** Pages whose `basis` date is older than `days`. Closed pages only unless `includeOpen`; pinned ones only with `includePinned`. */
  cleanupCandidates(opts: CleanupOptions): Tab[] {
    const { days, basis = "activity", includeOpen = false, includePinned = false } = opts;
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error("days must be a positive number");
    }
    if (!CLEANUP_BASES.includes(basis)) {
      throw new Error(`basis must be one of: ${CLEANUP_BASES.join(", ")}`);
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const pool = includeOpen ? [...this.tabs.values(), ...this.closed.values()] : [...this.closed.values()];
    return pool.filter((tab) => {
      if (isAppTab(tab) || (tab.pinned && !includePinned)) {
        return false;
      }
      const at = cleanupDate(tab, basis);
      return at !== undefined && at < cutoff;
    });
  }

  /** Deletes the cleanup candidates as one batch (undoable from the Trash). */
  cleanup(opts: CleanupOptions): Tab[] {
    return this.deleteMany(this.cleanupCandidates(opts).map((tab) => tab.id));
  }

  restore(idOrKey: string, opts?: { placement?: RestorePlacement; activate?: boolean }): Tab {
    const id = this.locate(idOrKey)?.tab.id ?? idOrKey;
    const tab = this.closed.get(id);
    if (!tab) {
      throw new Error(`closed page not found: ${idOrKey}`);
    }
    return this.restoreTab(tab, opts?.placement ?? "append", opts?.activate !== false);
  }

  /** Give a page a tab (or reuse its tab), optionally placed before another tab in the same pin group. */
  openPage(idOrKey: string, opts: { activate?: boolean; before?: string | null } = {}): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const activate = opts.activate !== false;
    const tab =
      located.where === "closed" ? this.restoreTab(located.tab, "append", activate) : located.tab;
    if (opts.before !== undefined) {
      const other = opts.before ? this.tabs.get(opts.before) : undefined;
      if (opts.before === null || (other && other.pinned === tab.pinned && other.id !== tab.id)) {
        this.reorderTab(tab.id, opts.before);
      }
    }
    if (located.where === "open" && activate) {
      this.focus(tab.id);
    }
    return tab;
  }

  /** Ctrl+Z: the newer of the last delete batch and the last closed page. */
  restoreLast(): { tab: Tab | null } {
    let newestClosed: Tab | undefined;
    for (const tab of this.closed.values()) {
      if (!newestClosed || (tab.closedAt ?? 0) > (newestClosed.closedAt ?? 0)) {
        newestClosed = tab;
      }
    }
    const batch = this.deleted[this.deleted.length - 1];
    if (!newestClosed && !batch) {
      throw new Error("nothing to restore");
    }
    if (batch && (!newestClosed || batch.deletedAt >= (newestClosed.closedAt ?? 0))) {
      this.deleted.pop();
      const tab = this.restoreBatch(batch);
      this.emit("trash");
      return { tab };
    }
    return { tab: this.restoreTab(newestClosed!, "index", true) };
  }

  /** Deleted batches, newest first. */
  listTrash(viewer: Viewer = "user"): TrashBatch[] {
    return this.deleted
      .map((batch) => ({
        id: batch.id,
        deletedAt: batch.deletedAt,
        expiresAt: batch.deletedAt + TRASH_TTL_MS,
        tabs: batch.tabs.filter((tab) => visibleTo(tab, viewer)).map(toMeta),
        folders: batch.folders,
      }))
      .filter((batch) => batch.tabs.length || batch.folders.length)
      .reverse();
  }

  /** Put a trashed page, or a trashed folder with what it held, back in the Library (closed). */
  restoreFromTrash(id: string): { tabs: Tab[]; folders: Folder[] } {
    const part = this.takeFromTrash(id);
    for (const tab of part.tabs) {
      if (typeof tab.closedAt !== "number") {
        tab.closedAt = this.stamp();
      }
    }
    this.restoreBatch(part);
    this.emit("trash");
    return { tabs: part.tabs, folders: part.folders };
  }

  /** Delete a trashed page, or a trashed folder with what it held, for good. */
  purgeFromTrash(id: string): number {
    const part = this.takeFromTrash(id);
    this.dropForever(part);
    this.persistSoon();
    this.emit("trash");
    return part.tabs.length;
  }

  emptyTrash(): number {
    let count = 0;
    for (const batch of this.deleted.splice(0)) {
      count += batch.tabs.length;
      this.dropForever(batch);
    }
    this.persistSoon();
    this.emit("trash");
    return count;
  }

  createFolder(input: { name: string; parentId?: string | null; index?: number }): Folder {
    const parentId = input.parentId ?? null;
    if (parentId && !this.folders.has(parentId)) {
      throw new Error(`folder not found: ${parentId}`);
    }
    const now = Date.now();
    const folder: Folder = {
      id: newFolderId(),
      parentId,
      name: cleanFolderName(input.name),
      pos: this.folderPosAt(parentId, input.index ?? Number.POSITIVE_INFINITY),
      createdAt: now,
      updatedAt: now,
    };
    this.folders.set(folder.id, folder);
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return folder;
  }

  renameFolder(id: string, name: string): Folder {
    const folder = this.requireFolder(id);
    const next = cleanFolderName(name);
    if (next !== folder.name) {
      folder.name = next;
      folder.updatedAt = Date.now();
      this.foldersDirty = true;
      this.persistSoon();
      this.emitFolders();
    }
    return folder;
  }

  moveFolder(id: string, parentId: string | null, index: number): Folder {
    const folder = this.requireFolder(id);
    if (parentId) {
      this.requireFolder(parentId);
      if (this.subtreeFolderIds(folder.id).has(parentId)) {
        throw new Error("cannot move a folder into itself");
      }
    }
    folder.parentId = parentId;
    folder.pos = this.folderPosAt(parentId, index, folder.id);
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return folder;
  }

  movePage(idOrKey: string, folderId: string | null, index: number, opts: { close?: boolean } = {}): Tab {
    const located = this.locate(idOrKey);
    if (!located) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    if (isAppTab(located.tab)) {
      throw new Error("the help page is not part of the Library");
    }
    if (folderId) {
      this.requireFolder(folderId);
    }
    const tab = located.tab;
    tab.libPos = this.pagePosAt(folderId, index, tab.id);
    if (folderId) {
      tab.folderId = folderId;
    } else {
      delete tab.folderId;
    }
    this.markDirty(tab.id);
    this.persistSoon();
    if (opts.close && located.where === "open") {
      return this.closeTab(tab.id);
    }
    this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    return tab;
  }

  /** `lift` moves the folder's contents up to its parent; `delete` bins the whole subtree as one batch. */
  deleteFolder(id: string, mode: FolderDeleteMode): { deleted: Tab[]; moved: Tab[] } {
    const folder = this.requireFolder(id);
    switch (mode) {
      case "lift":
        return { deleted: [], moved: this.liftFolder(folder) };
      case "delete":
        return { deleted: this.deleteFolderTree(folder), moved: [] };
      default: {
        const _never: never = mode;
        return _never;
      }
    }
  }

  /** Open the folder's own pages in Library order and focus the first. */
  openFolder(id: string): Tab[] {
    this.requireFolder(id);
    const pages = this.pagesIn(id);
    const opened: Tab[] = [];
    for (const tab of pages) {
      if (this.closed.has(tab.id)) {
        opened.push(this.restoreTab(tab, "append", false));
      }
    }
    const first = pages[0];
    if (first) {
      this.focus(first.id);
    }
    return opened;
  }

  closeFolder(id: string): Tab[] {
    this.requireFolder(id);
    return this.pagesIn(id)
      .filter((tab) => this.tabs.has(tab.id) && !isAppTab(tab))
      .map((tab) => this.closeTab(tab.id));
  }

  /**
   * Store a blob for a page. The page keeps the returned id (or URL) in its state; once no
   * state or HTML of the page mentions it for PAGE_ASSET_ORPHAN_GRACE_MS, it is deleted.
   */
  savePageAsset(idOrKey: string, input: PageAssetInput): { asset: PageAssetMeta; usage: PageAssetUsage } {
    const tab = this.requireAny(idOrKey);
    assertPageAssetSize(input.data.length);
    const [asset] = this.insertPageAssetDrafts(tab, [
      {
        id: newPageAssetId(),
        name: cleanPageAssetName(input.name),
        mimeType: normalizePageAssetMime(input.mimeType),
        createdAt: Date.now(),
        data: input.data,
      },
    ]);
    return { asset, usage: this.pageAssetUsageOf(tab.id) };
  }

  deletePageAsset(idOrKey: string, assetId: string): PageAssetUsage {
    const tab = this.requireAny(idOrKey);
    if (!isPageAssetId(assetId) || !this.requireDb().deletePageAsset(tab.id, assetId)) {
      throw new Error(`asset not found: ${assetId}`);
    }
    this.refreshPageAssetTotal(tab.id);
    return this.pageAssetUsageOf(tab.id);
  }

  listPageAssets(idOrKey: string): { assets: PageAssetMeta[]; usage: PageAssetUsage } {
    const tab = this.requireAny(idOrKey);
    const assets = this.pageAssetTotals.has(tab.id) ? this.requireDb().listPageAssets(tab.id) : [];
    return { assets, usage: this.pageAssetUsageOf(tab.id) };
  }

  /** By asset id alone: page asset URLs do not name their page, so they survive export and import. */
  readPageAsset(assetId: string): { meta: PageAssetMeta; data: Buffer } | undefined {
    if (!this.db || !isPageAssetId(assetId)) {
      return undefined;
    }
    return this.db.readPageAsset(assetId);
  }

  pageAssetUsageOf(tabId: string): PageAssetUsage {
    return pageAssetUsage(this.pageAssetTotals.get(tabId));
  }

  /**
   * Safety net behind the per-save checks: drop asset rows whose page row is gone, re-check
   * every page that has assets, and clear agent-attached asset folders of unknown pages.
   */
  sweepAssets(): void {
    if (this.db) {
      try {
        const dangling = this.db.deleteDanglingPageAssets();
        if (dangling) {
          log(`Removed ${dangling} page assets whose page no longer exists`);
          this.pageAssetTotals = this.db.pageAssetTotals();
        }
        this.reconcilePageAssets([...this.pageAssetTotals.keys()]);
      } catch (err) {
        log("Failed to sweep page assets", String(err));
      }
    }
    try {
      cleanupOrphanAssets(this.knownAssetTabIds());
    } catch (err) {
      log("Failed to clean orphan assets", String(err));
    }
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
    const removedIds = [...this.removed];
    try {
      this.db.save({
        activeId: this.activeId,
        upserts,
        removedIds,
        ...(this.foldersDirty ? { folders: this.collectFolders() } : {}),
        templates: [...this.templates.values()],
        removedTemplateIds: [...this.removedTemplates],
        bindings: this.collectBindings(),
        replaceBindings: true,
      });
      this.dirty.clear();
      this.removed.clear();
      this.removedTemplates.clear();
      this.templatesDirty = false;
      this.foldersDirty = false;
      // Removed rows took their page assets with them (ON DELETE CASCADE).
      for (const id of removedIds) {
        this.pageAssetTotals.delete(id);
      }
      this.reconcilePageAssets(upserts.map((row) => row.tab.id));
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
    if (this.trashTimer) {
      clearInterval(this.trashTimer);
      this.trashTimer = null;
    }
    if (this.assetSweepTimer) {
      clearInterval(this.assetSweepTimer);
      this.assetSweepTimer = null;
    }
    if (this.assetExpiryTimer) {
      clearTimeout(this.assetExpiryTimer);
      this.assetExpiryTimer = null;
    }
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
      throw new Error("cannot reorder a closed page");
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

  private requireFolder(id: string): Folder {
    const folder = this.folders.get(id);
    if (!folder) {
      throw new Error(`folder not found: ${id}`);
    }
    return folder;
  }

  /** Why an agent's title was ignored, or undefined when it applies. */
  private heldTitle(tab: Tab, requested: string, viewer: Viewer): string | undefined {
    if (viewer !== "agent" || requested === tab.title || !this.titleHeld(tab)) {
      return undefined;
    }
    return `renamed by the user ${agoText(Date.now() - tab.userTitleAt!)}`;
  }

  private titleHeld(tab: Tab): boolean {
    return typeof tab.userTitleAt === "number" && Date.now() - tab.userTitleAt < USER_TITLE_HOLD_MS;
  }

  private assertTabRevision(tab: Tab, expected: number | undefined): void {
    const note = this.titleHeld(tab)
      ? `The user renamed this page to "${tab.title}" ${agoText(Date.now() - tab.userTitleAt!)}.`
      : undefined;
    assertRevision(tab.revision, expected, note);
  }

  private planTemplateImport(incoming: Template[]): {
    byFileId: Map<string, Template>;
    created: Template[];
    reused: number;
  } {
    const byFileId = new Map<string, Template>();
    const created: Template[] = [];
    const reused = new Set<string>();
    const byFingerprint = new Map<string, Template>();
    for (const template of this.templates.values()) {
      const fingerprint = templateFingerprint(template);
      if (!byFingerprint.has(fingerprint)) {
        byFingerprint.set(fingerprint, template);
      }
    }
    const reservedKeys = new Set<string>();
    for (const template of incoming) {
      const fingerprint = templateFingerprint(template);
      const sameId = this.templates.get(template.id);
      const match =
        sameId && templateFingerprint(sameId) === fingerprint ? sameId : byFingerprint.get(fingerprint);
      if (match) {
        byFileId.set(template.id, match);
        if (this.templates.has(match.id)) {
          reused.add(match.id);
        }
        continue;
      }
      const idTaken = (id: string) => this.templates.has(id) || created.some((item) => item.id === id);
      const id = idTaken(template.id) ? newTemplateId() : template.id;
      const key = uniqueTemplateKey(this, template.key || undefined, template.title, id, reservedKeys);
      reservedKeys.add(key);
      const fresh: Template = { ...template, id, key };
      // One local copy per built-in: an imported copy only keeps its link when this board has none yet.
      const builtinKey = fresh.source?.builtin;
      if (builtinKey && (this.localCopyOf(builtinKey) || created.some((item) => item.source?.builtin === builtinKey))) {
        delete fresh.source;
      }
      created.push(fresh);
      byFingerprint.set(fingerprint, fresh);
      byFileId.set(template.id, fresh);
    }
    return { byFileId, created, reused: reused.size };
  }

  private buildImportedDraft(
    page: ImportPageInput,
    reserved: Set<string>,
    templates: Map<string, Template>,
    pendingAssets: Map<string, PageAssetDraft[]>
  ): Tab {
    const title = page.title.trim();
    if (!title) {
      throw new Error("title is required");
    }
    if (!page.html || !page.html.trim()) {
      throw new Error("html is required");
    }
    const template = page.template ? templates.get(page.template.templateId) : undefined;
    if (page.template && !template) {
      throw new Error(`template not found: ${page.template.templateId}`);
    }
    const templateValues = template ? parseTemplateValues(template.fields, page.template?.values) : undefined;
    // Importing the same file twice would reuse asset ids, so taken ones get fresh ids and the
    // page's text is rewritten to match.
    const remap = new Map<string, string>();
    const pendingIds = new Set([...pendingAssets.values()].flat().map((asset) => asset.id));
    const pageAssets = (page.pageAssets ?? []).map((asset) => {
      if (!pendingIds.has(asset.id) && !this.db?.pageAssetExists(asset.id)) {
        return asset;
      }
      const id = newPageAssetId();
      remap.set(asset.id, id);
      return { ...asset, id };
    });
    const pageHtml = remapPageAssetRefs(page.html, remap);
    const pageState = page.state && remap.size
      ? (JSON.parse(remapPageAssetRefs(JSON.stringify(page.state), remap)) as BoardState)
      : page.state;
    const html = wrapHtml(title, pageHtml);
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`html is too large (${bytes} bytes, max ${MAX_HTML_BYTES})`);
    }
    if (pageState) {
      const stateBytes = Buffer.byteLength(JSON.stringify(pageState), "utf8");
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
      libPos: 0,
      stripSeq: this.nextSeq(),
      revision: 1,
      state: {},
      stateRevision: 0,
      stateUpdatedAt: 0,
      signalRevision: 0,
      signal: null,
      assets,
      ...(page.agentHidden ? { agentHidden: true } : {}),
    };
    seedState(tab, pageState);
    if (pageAssets.length) {
      pendingAssets.set(id, pageAssets);
    }
    if (template && page.template && templateValues) {
      applyBinding(tab, { ...page.template, tabId: id, templateId: template.id, values: templateValues });
    }
    return tab;
  }

  /** Imported pages go to the top of their folder, keeping the file's order. */
  private placeImported(drafts: Tab[], pages: ImportPageInput[]): void {
    const groups = new Map<string | null, Array<{ tab: Tab; libPos: number; index: number }>>();
    drafts.forEach((tab, index) => {
      const page = pages[index];
      const folderId = page.folderPath ? this.ensureFolderPath(page.folderPath) : null;
      if (folderId) {
        tab.folderId = folderId;
      }
      const list = groups.get(folderId) ?? [];
      list.push({ tab, libPos: finiteTs(page.libPos) ?? index, index });
      groups.set(folderId, list);
    });
    for (const [folderId, list] of groups) {
      list.sort((a, b) => a.libPos - b.libPos || a.index - b.index);
      const top = this.pagesIn(folderId)[0]?.libPos ?? 0;
      list.forEach((item, i) => {
        item.tab.libPos = top - list.length + i;
      });
    }
  }

  private locate(idOrKey: string): Located | undefined {
    const openById = this.tabs.get(idOrKey);
    if (openById) {
      return { tab: openById, where: "open" };
    }
    const closedById = this.closed.get(idOrKey);
    if (closedById) {
      return { tab: closedById, where: "closed" };
    }
    const key = normalizeKey(idOrKey);
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (tab && tab.key === key) {
        return { tab, where: "open" };
      }
    }
    for (const tab of this.closed.values()) {
      if (tab.key === key) {
        return { tab, where: "closed" };
      }
    }
    return undefined;
  }

  private locateFor(idOrKey: string, viewer: Viewer): Located | undefined {
    const located = this.locate(idOrKey);
    return located && visibleTo(located.tab, viewer) ? located : undefined;
  }

  private setPinned(tab: Tab, pinned: boolean): void {
    tab.pinned = pinned;
    this.rebuildOrder();
  }

  private restoreTab(tab: Tab, placement: RestorePlacement, activate: boolean): Tab {
    this.closed.delete(tab.id);
    return this.reopen(tab, placement, activate);
  }

  private reopen(tab: Tab, placement: RestorePlacement, activate: boolean): Tab {
    if (this.tabs.has(tab.id) || this.closed.has(tab.id)) {
      throw new Error(`tab already open: ${tab.id}`);
    }
    this.claimKey(tab);
    delete tab.closedAt;
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

  /** Put a deleted batch back where it was: folders first, then pages open or closed as they were. */
  private restoreBatch(batch: DeletedBatch): Tab | null {
    for (const folder of batch.folders) {
      if (folder.parentId && !this.folders.has(folder.parentId) && !batch.folders.some((f) => f.id === folder.parentId)) {
        folder.parentId = null;
      }
      this.folders.set(folder.id, folder);
    }
    if (batch.folders.length) {
      this.foldersDirty = true;
      this.emitFolders();
    }
    let focus: Tab | null = null;
    for (const tab of batch.tabs) {
      if (tab.folderId && !this.folders.has(tab.folderId)) {
        delete tab.folderId;
      }
      if (typeof tab.closedAt === "number") {
        this.claimKey(tab);
        this.closed.set(tab.id, tab);
        this.markDirty(tab.id);
        this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: true });
        focus ??= tab;
      } else {
        const reopened = this.reopen(tab, "index", false);
        if (!focus || this.closed.has(focus.id)) {
          focus = reopened;
        }
      }
    }
    if (focus && this.tabs.has(focus.id)) {
      this.activeId = focus.id;
      this.emit("tab_focused", focus.id);
    }
    this.persistSoon();
    return focus;
  }

  /**
   * A page in the Trash gives up its key when a new page wants it: the key names the page an
   * agent or the user is working with now. Restoring the trashed page later gives it a free key
   * (claimKey). Without this the key stays taken in the database and every save fails.
   */
  releaseTrashedKey(key: string): void {
    for (const batch of this.deleted) {
      for (const tab of batch.tabs) {
        if (tab.key === key) {
          tab.key = `${key}-${tab.id.slice(2)}`;
          this.markDirty(tab.id);
        }
      }
    }
  }

  private claimKey(tab: Tab): void {
    const keyOwner = this.locate(tab.key);
    if (keyOwner && keyOwner.tab.id !== tab.id) {
      tab.key = uniqueKey(this, tab.key, tab.title, tab.id);
    }
  }

  /** Take a page out of the strip or the closed set without deciding where it goes. */
  private detach(located: Located): void {
    const tab = located.tab;
    if (located.where === "open") {
      this.tabs.delete(tab.id);
      delete tab.closedAt;
    } else {
      this.closed.delete(tab.id);
    }
    this.markDirty(tab.id);
  }

  /** Drop an in-app page (help) without closing it into the Library or keeping it on the Ctrl+Z stack. */
  private discardAppTab(tab: Tab): Tab {
    const wasActive = this.activeId === tab.id;
    const wasOpen = this.tabs.has(tab.id);
    const prevOrder = this.order;
    this.tabs.delete(tab.id);
    this.closed.delete(tab.id);
    this.rebuildOrder();
    delete tab.closedAt;
    if (wasActive) {
      this.activeId = this.neighborOf(prevOrder, tab.id);
    }
    this.removed.add(tab.id);
    this.dirty.delete(tab.id);
    deleteTabAssets(tab.id);
    this.persistSoon();
    this.emit("tab_deleted", tab.id);
    if (wasOpen) {
      this.emit("tab_focused", this.activeId);
    }
    return tab;
  }

  private liftFolder(folder: Folder): Tab[] {
    const parentId = folder.parentId;
    const siblings = this.foldersIn(parentId);
    const at = siblings.findIndex((item) => item.id === folder.id);
    const lo = siblings[at - 1]?.pos ?? folder.pos - 1;
    const hi = siblings[at + 1]?.pos ?? folder.pos + 1;
    const children = this.foldersIn(folder.id);
    children.forEach((child, i) => {
      child.parentId = parentId;
      child.pos = lo + ((hi - lo) * (i + 1)) / (children.length + 1);
    });
    const pages = this.pagesIn(folder.id);
    const last = this.pagesIn(parentId).at(-1)?.libPos ?? 0;
    pages.forEach((tab, i) => {
      if (parentId) {
        tab.folderId = parentId;
      } else {
        delete tab.folderId;
      }
      tab.libPos = last + 1 + i;
      this.markDirty(tab.id);
    });
    this.folders.delete(folder.id);
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    for (const tab of pages) {
      this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
    }
    return pages;
  }

  private deleteFolderTree(folder: Folder): Tab[] {
    const ids = this.subtreeFolderIds(folder.id);
    const folders = this.listFolders().filter((item) => ids.has(item.id));
    folders.sort((a, b) => this.folderDepth(a) - this.folderDepth(b));
    const pages = this.libraryTabs().filter((tab) => tab.folderId && ids.has(tab.folderId));
    const deleted = this.deleteMany(pages.map((tab) => tab.id));
    let batch = this.deleted[this.deleted.length - 1];
    if (!deleted.length || !batch || batch.tabs[0]?.id !== deleted[0].id) {
      batch = { id: newBatchId(), deletedAt: this.stamp(), tabs: [], folders: [] };
      this.pushDeleted(batch);
    }
    batch.folders.push(...folders);
    for (const item of folders) {
      this.folders.delete(item.id);
    }
    this.foldersDirty = true;
    this.persistSoon();
    this.emitFolders();
    return deleted;
  }

  private folderDepth(folder: Folder): number {
    let depth = 0;
    let at = folder.parentId ? this.folders.get(folder.parentId) : undefined;
    while (at && depth < 64) {
      depth += 1;
      at = at.parentId ? this.folders.get(at.parentId) : undefined;
    }
    return depth;
  }

  private subtreeFolderIds(rootId: string): Set<string> {
    const ids = new Set<string>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of this.folders.values()) {
        if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
          ids.add(folder.id);
          grew = true;
        }
      }
    }
    return ids;
  }

  /** Walks a "A/B" path from the root, creating folders that don't exist yet. */
  private ensureFolderPath(path: string): string | null {
    let parentId: string | null = null;
    for (const name of splitFolderPath(path)) {
      const match: Folder | undefined = this.foldersIn(parentId).find((folder) => sameName(folder.name, name));
      if (match) {
        parentId = match.id;
        continue;
      }
      const now = Date.now();
      const folder: Folder = {
        id: newFolderId(),
        parentId,
        name: cleanFolderName(name),
        pos: this.folderPosAt(parentId, Number.POSITIVE_INFINITY),
        createdAt: now,
        updatedAt: now,
      };
      this.folders.set(folder.id, folder);
      this.foldersDirty = true;
      parentId = folder.id;
    }
    return parentId;
  }

  private libraryTabs(): Tab[] {
    return [...this.tabs.values(), ...this.closed.values()].filter((tab) => !isAppTab(tab));
  }

  private pagesIn(folderId: string | null, exceptId?: string): Tab[] {
    return this.libraryTabs()
      .filter((tab) => (tab.folderId ?? null) === folderId && tab.id !== exceptId)
      .sort(byLibPos);
  }

  private foldersIn(parentId: string | null, exceptId?: string): Folder[] {
    return this.listFolders().filter((folder) => folder.parentId === parentId && folder.id !== exceptId);
  }

  /** Pages depth-first: each folder's subfolders, then its own pages. */
  private treeOrder(): Tab[] {
    const out: Tab[] = [];
    const walk = (folderId: string | null) => {
      for (const folder of this.foldersIn(folderId)) {
        walk(folder.id);
      }
      out.push(...this.pagesIn(folderId));
    };
    walk(null);
    return out;
  }

  private pagePosAt(folderId: string | null, index: number, exceptId?: string): number {
    let siblings = this.pagesIn(folderId, exceptId);
    let pos = slotPos(siblings.map((tab) => tab.libPos), index);
    if (Number.isNaN(pos)) {
      siblings.forEach((tab, i) => {
        tab.libPos = i;
        this.markDirty(tab.id);
        this.emit("tab_upserted", toMeta(tab), undefined, { activate: false, structural: false });
      });
      siblings = this.pagesIn(folderId, exceptId);
      pos = slotPos(siblings.map((tab) => tab.libPos), index);
    }
    return pos;
  }

  private folderPosAt(parentId: string | null, index: number, exceptId?: string): number {
    const siblings = this.foldersIn(parentId, exceptId);
    let pos = slotPos(siblings.map((folder) => folder.pos), index);
    if (Number.isNaN(pos)) {
      siblings.forEach((folder, i) => {
        folder.pos = i;
      });
      this.foldersDirty = true;
      pos = slotPos(siblings.map((folder) => folder.pos), index);
    }
    return pos;
  }

  /** Pages pointing at a folder that no longer exists go to the root; orphaned folders too. */
  private repairLibraryRefs(): void {
    for (const folder of this.folders.values()) {
      if (folder.parentId && (!this.folders.has(folder.parentId) || folder.parentId === folder.id)) {
        folder.parentId = null;
        this.foldersDirty = true;
      }
    }
    for (const tab of this.libraryTabs()) {
      if (tab.folderId && !this.folders.has(tab.folderId)) {
        delete tab.folderId;
        this.markDirty(tab.id);
      }
    }
  }

  private emitFolders(): void {
    this.emit("folders", this.listFolders());
  }

  /** The nearest still-open tab left of `id` in `prevOrder`, else the nearest to its right. */
  private neighborOf(prevOrder: string[], id: string): string | null {
    const idx = prevOrder.indexOf(id);
    if (idx === -1) {
      return this.order[this.order.length - 1] ?? null;
    }
    for (let i = idx - 1; i >= 0; i--) {
      if (this.tabs.has(prevOrder[i])) {
        return prevOrder[i];
      }
    }
    for (let i = idx + 1; i < prevOrder.length; i++) {
      if (this.tabs.has(prevOrder[i])) {
        return prevOrder[i];
      }
    }
    return null;
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
      ...this.closed.values(),
      ...this.deleted.flatMap((batch) => batch.tabs),
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

  private locateBuiltin(idOrKey: string): Template | undefined {
    const key = isBuiltinId(idOrKey) ? idOrKey.slice(BUILTIN_ID_PREFIX.length) : normalizeKey(idOrKey);
    return this.builtins.find((builtin) => builtin.key === key);
  }

  private localCopyOf(builtinKey: string): Template | undefined {
    for (const template of this.templates.values()) {
      if (template.source?.builtin === builtinKey) {
        return template;
      }
    }
    return undefined;
  }

  /**
   * Bring unedited local copies up to date with a changed built-in, and re-render their pages.
   * A copy the user edited, or a built-in whose stateVersion changed, is left for an agent to update.
   */
  private syncBuiltinCopies(): void {
    for (const builtin of this.builtins) {
      const copy = this.localCopyOf(builtin.key);
      if (!copy?.source) {
        continue;
      }
      const latest = templateFingerprint(builtin);
      if (copy.source.fingerprint === latest) {
        continue;
      }
      if (templateFingerprint(copy) !== copy.source.fingerprint || copy.stateVersion !== builtin.stateVersion) {
        continue;
      }
      copy.title = builtin.title;
      copy.description = builtin.description;
      copy.html = builtin.html;
      copy.fields = structuredClone(builtin.fields);
      copy.titleTemplate = builtin.titleTemplate;
      copy.initialState = structuredClone(builtin.initialState);
      copy.source = { builtin: builtin.key, fingerprint: latest };
      copy.updatedAt = Date.now();
      this.markTemplateDirty(copy.id);
      this.refreshTemplateInstances(copy, false);
      this.emit("template_upserted", this.templateMeta(copy, this.instanceCount(copy.id)));
    }
  }

  /** Link a local template identical to a built-in (e.g. the one it was made from), so opening the built-in reuses it. */
  private adoptBuiltinCopies(): void {
    for (const builtin of this.builtins) {
      if (this.localCopyOf(builtin.key)) {
        continue;
      }
      const fingerprint = templateFingerprint(builtin);
      const twin = [...this.templates.values()].find(
        (template) => !template.source && templateFingerprint(template) === fingerprint
      );
      if (twin) {
        twin.source = { builtin: builtin.key, fingerprint };
        this.markTemplateDirty(twin.id);
      }
    }
  }

  private requireTemplate(idOrKey: string): Template {
    const template = this.locateTemplate(idOrKey);
    if (!template) {
      throw new Error(`template not found: ${idOrKey}`);
    }
    return template;
  }

  private instanceCount(templateId: string, viewer: Viewer = "user"): number {
    let count = 0;
    for (const tab of this.allTabs()) {
      if (tab.templateId === templateId && visibleTo(tab, viewer)) {
        count += 1;
      }
    }
    return count;
  }

  private allTabs(): Tab[] {
    return [...this.tabs.values(), ...this.closed.values(), ...this.deleted.flatMap((batch) => batch.tabs)];
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

  private collectFolders(): StoredFolder[] {
    return [
      ...[...this.folders.values()].map((folder) => ({ folder })),
      ...this.deleted.flatMap((batch) =>
        batch.folders.map((folder) => ({ folder, deletedAt: batch.deletedAt, deletedBatch: batch.id }))
      ),
    ];
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

  private markDirty(id: string): void {
    this.dirty.add(id);
    this.removed.delete(id);
  }

  private storedOf(id: string): StoredTab | undefined {
    const open = this.tabs.get(id);
    if (open) {
      return { tab: open, status: "open" };
    }
    const closed = this.closed.get(id);
    if (closed) {
      return { tab: closed, status: "closed" };
    }
    for (const batch of this.deleted) {
      const tab = batch.tabs.find((item) => item.id === id);
      if (tab) {
        return { tab, status: "deleted", deletedAt: batch.deletedAt, deletedBatch: batch.id };
      }
    }
    return undefined;
  }

  private pushDeleted(batch: DeletedBatch): void {
    this.deleted.push(batch);
    for (const tab of batch.tabs) {
      this.markDirty(tab.id);
    }
    this.expireTrash();
    this.emit("trash");
  }

  /** Drop batches older than the Trash keeps. True when something went. */
  private expireTrash(): boolean {
    const cutoff = Date.now() - TRASH_TTL_MS;
    let dropped = false;
    while (this.deleted.length && this.deleted[0].deletedAt < cutoff) {
      this.dropForever(this.deleted.shift()!);
      dropped = true;
    }
    if (dropped) {
      this.emit("trash");
    }
    return dropped;
  }

  /** Forget pages and folders already taken out of the Trash. */
  private dropForever(gone: DeletedBatch): void {
    for (const tab of gone.tabs) {
      this.removed.add(tab.id);
      this.dirty.delete(tab.id);
      if (!this.tabs.has(tab.id) && !this.closed.has(tab.id)) {
        deleteTabAssets(tab.id);
      }
    }
    if (gone.folders.length) {
      this.foldersDirty = true;
    }
  }

  /** Remove a page, or a folder subtree and its pages, from its Trash batch and return them as a batch. */
  private takeFromTrash(id: string): DeletedBatch {
    const at = this.deleted.findIndex(
      (batch) => batch.tabs.some((tab) => tab.id === id) || batch.folders.some((folder) => folder.id === id)
    );
    if (at === -1) {
      throw new Error(`not in the trash: ${id}`);
    }
    const batch = this.deleted[at];
    const part: DeletedBatch = { id: batch.id, deletedAt: batch.deletedAt, tabs: [], folders: [] };
    const folderIds = new Set<string>();
    if (batch.folders.some((folder) => folder.id === id)) {
      folderIds.add(id);
      let grew = true;
      while (grew) {
        grew = false;
        for (const folder of batch.folders) {
          if (!folderIds.has(folder.id) && folder.parentId && folderIds.has(folder.parentId)) {
            folderIds.add(folder.id);
            grew = true;
          }
        }
      }
      part.folders = batch.folders.filter((folder) => folderIds.has(folder.id));
      part.tabs = batch.tabs.filter((tab) => tab.folderId && folderIds.has(tab.folderId));
    } else {
      part.tabs = batch.tabs.filter((tab) => tab.id === id);
    }
    batch.folders = batch.folders.filter((folder) => !part.folders.includes(folder));
    batch.tabs = batch.tabs.filter((tab) => !part.tabs.includes(tab));
    if (!batch.tabs.length && !batch.folders.length) {
      this.deleted.splice(at, 1);
    }
    if (part.folders.length) {
      this.foldersDirty = true;
    }
    return part;
  }

  private stamp(): number {
    const now = Date.now();
    const next = Math.max(now, this.lastStamp + 1);
    this.lastStamp = next;
    return next;
  }

  private requireDb(): BoardDb {
    if (!this.db) {
      throw new Error("board database is not open");
    }
    return this.db;
  }

  /** Checks room, writes the page row first if it is new (asset rows point at it), then the assets. */
  private insertPageAssetDrafts(tab: Tab, drafts: PageAssetDraft[]): PageAssetMeta[] {
    const db = this.requireDb();
    const current = this.pageAssetTotals.get(tab.id) ?? { count: 0, bytes: 0 };
    const adding = drafts.reduce((sum, draft) => sum + draft.data.length, 0);
    assertPageAssetRoom(current, drafts.length, adding);
    if (this.dirty.has(tab.id)) {
      this.persist();
      if (this.dirty.has(tab.id)) {
        throw new Error(`could not save the page before its assets: ${this.persistError ?? "unknown error"}`);
      }
    }
    db.insertPageAssets(tab.id, drafts);
    const next = { count: current.count + drafts.length, bytes: current.bytes + adding };
    this.pageAssetTotals.set(tab.id, next);
    this.scheduleAssetExpiry(Math.min(...drafts.map((draft) => draft.createdAt)) + PAGE_ASSET_ORPHAN_GRACE_MS);
    const usage = pageAssetUsage(next);
    if (usage.warning) {
      this.emit("page_asset_warning", tab, usage);
    }
    return drafts.map((draft) => ({
      id: draft.id,
      tabId: tab.id,
      name: draft.name,
      mimeType: draft.mimeType,
      bytes: draft.data.length,
      createdAt: draft.createdAt,
      orphanedAt: draft.createdAt,
    }));
  }

  /**
   * Read the agent's files and swap each `asset:<name>` string in the state for the URL its
   * asset will have. Nothing is stored yet, so a state that turns out too large leaves nothing behind.
   */
  private prepareStateAssets(
    tab: Tab,
    state: BoardState,
    files: PageAssetFile[]
  ): { state: BoardState; drafts: PageAssetDraft[] } {
    const now = Date.now();
    const urls = new Map<string, string>();
    const drafts: PageAssetDraft[] = [];
    for (const file of files) {
      const read = readPageAssetFile(file);
      const key = read.name.toLowerCase();
      if (urls.has(key)) {
        throw new Error(`duplicate asset name: ${read.name}`);
      }
      const draft: PageAssetDraft = { id: newPageAssetId(), createdAt: now, ...read };
      urls.set(key, pageAssetUrl(draft.id));
      drafts.push(draft);
    }
    assertPageAssetRoom(
      this.pageAssetTotals.get(tab.id) ?? { count: 0, bytes: 0 },
      drafts.length,
      drafts.reduce((sum, draft) => sum + draft.data.length, 0)
    );
    const used = new Set<string>();
    const missing = new Set<string>();
    const next = substituteStateAssets(state, urls, used, missing) as BoardState;
    const unused = drafts.filter((draft) => !used.has(draft.name.toLowerCase())).map((draft) => draft.name);
    if (missing.size || unused.length) {
      const parts = [
        ...(missing.size ? [`state refers to ${[...missing].map((name) => `asset:${name}`).join(", ")} but no such file was passed`] : []),
        ...(unused.length ? [`no state value is exactly asset:<name> for ${unused.join(", ")}`] : []),
      ];
      throw new Error(`${parts.join("; ")}. Put "asset:<name>" as a whole string value where each file's URL should go.`);
    }
    return { state: next, drafts };
  }

  /** Asset rows point at page rows, so imported pages are written before their assets. */
  private insertImportedPageAssets(pending: Map<string, PageAssetDraft[]>): void {
    this.persist();
    const db = this.requireDb();
    for (const [tabId, assets] of pending) {
      try {
        db.insertPageAssets(tabId, assets);
        this.refreshPageAssetTotal(tabId);
      } catch (err) {
        log(`Failed to import page assets for ${tabId}`, String(err));
      }
    }
    // Imported assets start orphaned; check them against their pages right away.
    this.reconcilePageAssets(pending.keys());
  }

  /** Pages whose rows were deleted are skipped; the cascade already took their assets. */
  private reconcilePageAssets(ids: Iterable<string>): void {
    if (!this.db) {
      return;
    }
    const now = Date.now();
    let next: number | null = null;
    try {
      for (const id of ids) {
        if (!this.pageAssetTotals.has(id)) {
          continue;
        }
        const tab = this.storedOf(id)?.tab;
        if (!tab) {
          continue;
        }
        const refs = collectPageAssetRefs(tab.html, JSON.stringify(tab.state));
        const result = this.db.reconcilePageAssets(id, refs, now, PAGE_ASSET_ORPHAN_GRACE_MS);
        if (result.deleted) {
          this.refreshPageAssetTotal(id);
        }
        if (result.nextExpiry !== null) {
          next = Math.min(next ?? Infinity, result.nextExpiry);
        }
      }
    } catch (err) {
      log("Failed to check page assets", String(err));
    }
    if (next !== null) {
      this.scheduleAssetExpiry(next);
    }
  }

  /** One timer for the earliest orphan to run out of grace; firing re-checks every page with assets. */
  private scheduleAssetExpiry(at: number): void {
    if (this.assetExpiryTimer && this.assetExpiryAt <= at) {
      return;
    }
    if (this.assetExpiryTimer) {
      clearTimeout(this.assetExpiryTimer);
    }
    this.assetExpiryAt = at;
    this.assetExpiryTimer = setTimeout(() => {
      this.assetExpiryTimer = null;
      this.assetExpiryAt = 0;
      this.reconcilePageAssets([...this.pageAssetTotals.keys()]);
    }, Math.max(0, at - Date.now()) + 1000);
    this.assetExpiryTimer.unref?.();
  }

  private refreshPageAssetTotal(tabId: string): void {
    const total = this.db?.pageAssetTotal(tabId);
    if (total && total.count) {
      this.pageAssetTotals.set(tabId, total);
    } else {
      this.pageAssetTotals.delete(tabId);
    }
  }

  private knownAssetTabIds(): string[] {
    return this.allTabs().map((tab) => tab.id);
  }
}

function newId(): string {
  return "t_" + randomBytes(4).toString("hex");
}

function newFolderId(): string {
  return "f_" + randomBytes(4).toString("hex");
}

function newBatchId(): string {
  return "d_" + randomBytes(4).toString("hex");
}

function byLibPos(a: Tab, b: Tab): number {
  return a.libPos - b.libPos;
}

function byClosedDesc(a: Tab, b: Tab): number {
  return (b.closedAt ?? 0) - (a.closedAt ?? 0);
}

/**
 * A position for inserting at `index` among sorted `positions`. NaN when two
 * neighbours are too close to split, which tells the caller to renumber.
 */
function slotPos(positions: number[], index: number): number {
  if (!positions.length) {
    return 0;
  }
  if (index <= 0) {
    return positions[0] - 1;
  }
  if (index >= positions.length) {
    return positions[positions.length - 1] + 1;
  }
  const a = positions[index - 1];
  const b = positions[index];
  const mid = (a + b) / 2;
  return mid > a && mid < b ? mid : Number.NaN;
}

function splitFolderPath(path: string): string[] {
  return path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function cleanFolderName(name: string): string {
  const cleaned = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX);
  return cleaned || "New folder";
}

function agoText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) {
    return "just now";
  }
  if (min < 60) {
    return `${min}m ago`;
  }
  return `${Math.round(min / 60)}h ago`;
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
    libPos: typeof tab.libPos === "number" && Number.isFinite(tab.libPos) ? tab.libPos : 0,
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
  id: string,
  reserved: Set<string> = new Set()
): string {
  const taken = (key: string) => Boolean(store.getTemplate(key)) || reserved.has(key);
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
  const claim = (key: string) => {
    store.releaseTrashedKey(key);
    return key;
  };
  if (requested) {
    const key = normalizeKey(requested);
    if (key && !taken(key)) {
      return claim(key);
    }
    if (key) {
      return claim(`${key}-${id.slice(2)}`);
    }
  }
  const base = normalizeKey(title) || "page";
  if (!taken(base)) {
    return claim(base);
  }
  return claim(`${base}-${id.slice(2)}`);
}

function shouldClose(destination: ImportDestination, closedAt?: number): boolean {
  switch (destination) {
    case "closed":
      return true;
    case "meta":
      return typeof closedAt === "number";
    default: {
      const _never: never = destination;
      return _never;
    }
  }
}

/** The date a page is judged by; undefined when it has none (an open page has no close date). */
function cleanupDate(tab: Tab, basis: CleanupBasis): number | undefined {
  switch (basis) {
    case "edited":
      return Math.max(tab.updatedAt, tab.stateUpdatedAt);
    case "created":
      return tab.createdAt;
    case "closed":
      return tab.closedAt;
    default:
      return Math.max(tab.updatedAt, tab.stateUpdatedAt, tab.closedAt ?? 0);
  }
}

function finiteTs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const store = new BoardStore();
