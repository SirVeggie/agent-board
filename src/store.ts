import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { MAX_HTML_BYTES, dataDir, statePath } from "./config.js";
import { log } from "./log.js";
import { TRASH_LIMIT, toMeta, type Tab, type TabMeta, type TrashEntry, type UpsertInput } from "./types.js";
import { wrapHtml } from "./wrapHtml.js";

type Persisted = {
  activeId: string | null;
  tabs: Tab[];
  trash?: TrashEntry[];
};

class BoardStore extends EventEmitter {
  private tabs = new Map<string, Tab>();
  private order: string[] = [];
  private activeId: string | null = null;
  private trash: TrashEntry[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  load(): void {
    try {
      const raw = fs.readFileSync(statePath(), "utf8");
      const parsed = JSON.parse(raw) as Persisted;
      if (!Array.isArray(parsed.tabs)) {
        return;
      }
      for (const tab of parsed.tabs) {
        if (!tab?.id || !tab?.html) {
          continue;
        }
        this.tabs.set(tab.id, tab);
        this.order.push(tab.id);
      }
      this.activeId =
        parsed.activeId && this.tabs.has(parsed.activeId) ? parsed.activeId : (this.order[0] ?? null);
      if (Array.isArray(parsed.trash)) {
        this.trash = parsed.trash
          .filter((entry) => entry?.tab?.id && entry.tab.html && typeof entry.index === "number")
          .slice(-TRASH_LIMIT);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log("Failed to load board state", String(err));
      }
    }
  }

  snapshot(): { tabs: TabMeta[]; activeId: string | null } {
    return {
      tabs: this.order.map((id) => toMeta(this.tabs.get(id)!)).filter(Boolean),
      activeId: this.activeId,
    };
  }

  list(): TabMeta[] {
    return this.snapshot().tabs;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  get(idOrKey: string): Tab | undefined {
    const byId = this.tabs.get(idOrKey);
    if (byId) {
      return byId;
    }
    const key = normalizeKey(idOrKey);
    for (const tab of this.tabs.values()) {
      if (tab.key === key) {
        return tab;
      }
    }
    return undefined;
  }

  upsert(input: UpsertInput): { tab: Tab; created: boolean } {
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

    const existing = input.key ? this.get(input.key) : undefined;
    const now = Date.now();
    if (existing) {
      existing.title = title;
      existing.html = html;
      existing.updatedAt = now;
      existing.revision += 1;
      if (input.pin !== undefined) {
        existing.pinned = input.pin;
      }
      if (input.activate !== false) {
        this.activeId = existing.id;
      }
      this.persistSoon();
      this.emit("tab_upserted", toMeta(existing));
      if (input.activate !== false) {
        this.emit("tab_focused", existing.id);
      }
      return { tab: existing, created: false };
    }

    const id = newId();
    const tab: Tab = {
      id,
      key: uniqueKey(this, input.key, title, id),
      title,
      html,
      pinned: Boolean(input.pin),
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.tabs.set(id, tab);
    this.order.push(id);
    if (input.activate !== false) {
      this.activeId = id;
    }
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab));
    if (input.activate !== false) {
      this.emit("tab_focused", id);
    }
    return { tab, created: true };
  }

  update(
    idOrKey: string,
    patch: { title?: string; html?: string; pin?: boolean; activate?: boolean }
  ): Tab {
    const tab = this.get(idOrKey);
    if (!tab) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
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
    if (patch.pin !== undefined) {
      tab.pinned = patch.pin;
    }
    tab.updatedAt = Date.now();
    if (patch.title !== undefined || patch.html !== undefined) {
      tab.revision += 1;
    }
    if (patch.activate !== false) {
      this.activeId = tab.id;
    }
    this.persistSoon();
    this.emit("tab_upserted", toMeta(tab));
    if (patch.activate !== false) {
      this.emit("tab_focused", tab.id);
    }
    return tab;
  }

  focus(idOrKey: string): Tab {
    const tab = this.get(idOrKey);
    if (!tab) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    this.activeId = tab.id;
    this.persistSoon();
    this.emit("tab_focused", tab.id);
    return tab;
  }

  close(idOrKey: string): Tab {
    const tab = this.get(idOrKey);
    if (!tab) {
      throw new Error(`tab not found: ${idOrKey}`);
    }
    const index = this.order.indexOf(tab.id);
    this.tabs.delete(tab.id);
    this.order = this.order.filter((id) => id !== tab.id);
    this.pushTrash({ tab, index: Math.max(0, index) });
    if (this.activeId === tab.id) {
      this.activeId = this.order[this.order.length - 1] ?? null;
    }
    this.persistSoon();
    this.emit("tab_closed", tab.id);
    this.emit("tab_focused", this.activeId);
    return tab;
  }

  restoreLast(): Tab {
    const entry = this.trash.pop();
    if (!entry) {
      throw new Error("nothing to restore");
    }
    if (this.tabs.has(entry.tab.id)) {
      throw new Error(`tab already open: ${entry.tab.id}`);
    }
    const keyOwner = this.get(entry.tab.key);
    if (keyOwner && keyOwner.id !== entry.tab.id) {
      entry.tab.key = uniqueKey(this, entry.tab.key, entry.tab.title, entry.tab.id);
    }
    const index = Math.max(0, Math.min(entry.index, this.order.length));
    this.tabs.set(entry.tab.id, entry.tab);
    this.order.splice(index, 0, entry.tab.id);
    this.activeId = entry.tab.id;
    this.persistSoon();
    this.emit("tab_upserted", toMeta(entry.tab), index);
    this.emit("tab_focused", entry.tab.id);
    return entry.tab;
  }

  closeMany(filter: "all" | "unpinned"): string[] {
    const ids = this.order.filter((id) => {
      const tab = this.tabs.get(id);
      return tab && (filter === "all" || !tab.pinned);
    });
    for (const id of ids) {
      this.close(id);
    }
    return ids;
  }

  private persistSoon(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.persist(), 150);
  }

  persist(): void {
    const payload: Persisted = {
      activeId: this.activeId,
      tabs: this.order.map((id) => this.tabs.get(id)!),
      trash: this.trash,
    };
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      const tmp = statePath() + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.copyFileSync(tmp, statePath());
      fs.unlinkSync(tmp);
    } catch (err) {
      log("Failed to persist board state", String(err));
    }
  }

  private pushTrash(entry: TrashEntry): void {
    this.trash.push(entry);
    if (this.trash.length > TRASH_LIMIT) {
      this.trash.splice(0, this.trash.length - TRASH_LIMIT);
    }
  }
}

function newId(): string {
  return "t_" + randomBytes(4).toString("hex");
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
