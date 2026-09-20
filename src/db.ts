import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { normalizeTabAssets } from "./assets.js";
import { isPlainObject, type BoardState, type Tab, type TabSignal } from "./types.js";

export const SCHEMA_VERSION = 1;

export type TabStatus = "open" | "archived" | "deleted";

export type StoredTab = {
  tab: Tab;
  status: TabStatus;
  deletedAt?: number;
};

type TabRow = {
  id: string;
  key: string;
  title: string;
  html: string;
  state: string;
  pinned: number;
  status: string;
  strip_seq: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  deleted_at: number | null;
  revision: number;
  state_revision: number;
  state_updated_at: number;
  signal_revision: number;
  signal: string | null;
  assets: string;
};

type LegacyPersisted = {
  activeId?: string | null;
  tabs?: LegacyTab[];
  archive?: Array<{ tab?: LegacyTab; index?: number }>;
  deleted?: Array<{ tab?: LegacyTab; index?: number; deletedAt?: number }>;
};

type LegacyTab = Partial<Tab> & { id?: string; html?: string };

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('open','archived','deleted')),
  strip_seq INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  deleted_at INTEGER,
  revision INTEGER NOT NULL,
  state_revision INTEGER NOT NULL,
  state_updated_at INTEGER NOT NULL DEFAULT 0,
  signal_revision INTEGER NOT NULL DEFAULT 0,
  signal TEXT,
  assets TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_tabs_status_archived ON tabs(status, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_tabs_status_deleted ON tabs(status, deleted_at DESC);
`;

const UPSERT_SQL = `
INSERT INTO tabs (
  id, key, title, html, state, pinned, status, strip_seq,
  created_at, updated_at, archived_at, deleted_at,
  revision, state_revision, state_updated_at, signal_revision, signal, assets
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
  key = excluded.key,
  title = excluded.title,
  html = excluded.html,
  state = excluded.state,
  pinned = excluded.pinned,
  status = excluded.status,
  strip_seq = excluded.strip_seq,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  archived_at = excluded.archived_at,
  deleted_at = excluded.deleted_at,
  revision = excluded.revision,
  state_revision = excluded.state_revision,
  state_updated_at = excluded.state_updated_at,
  signal_revision = excluded.signal_revision,
  signal = excluded.signal,
  assets = excluded.assets
`;

export class BoardDb {
  private upsertStmt;
  private deleteStmt;
  private metaStmt;

  constructor(private readonly db: DatabaseSync) {
    this.upsertStmt = db.prepare(UPSERT_SQL);
    this.deleteStmt = db.prepare("DELETE FROM tabs WHERE id = ?");
    this.metaStmt = db.prepare(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
    );
  }

  static open(sqlitePath: string, jsonPath: string): BoardDb {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const existed = fs.existsSync(sqlitePath);
    if (existed) {
      return BoardDb.openExisting(sqlitePath);
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(sqlitePath);
      configure(db);
      db.exec(CREATE_SQL);
      db.prepare("INSERT INTO meta (k, v) VALUES (?, ?)").run("schema", String(SCHEMA_VERSION));
      const board = new BoardDb(db);
      if (fs.existsSync(jsonPath)) {
        board.importLegacyJson(jsonPath);
        renameLegacy(jsonPath);
      }
      return board;
    } catch (err) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      if (!existed) {
        removeSqlite(sqlitePath);
      }
      throw err;
    }
  }

  load(): { activeId: string | null; rows: StoredTab[] } {
    const active = this.db.prepare("SELECT v FROM meta WHERE k = ?").get("active_id") as
      | { v: string }
      | undefined;
    const rows = this.db.prepare("SELECT * FROM tabs").all() as TabRow[];
    return {
      activeId: active?.v ?? null,
      rows: rows.map(rowToStored),
    };
  }

  save(input: {
    activeId: string | null;
    upserts: StoredTab[];
    removedIds: string[];
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of input.removedIds) {
        this.deleteStmt.run(id);
      }
      for (const row of input.upserts) {
        this.upsertStmt.run(...storedToParams(row));
      }
      this.metaStmt.run("active_id", input.activeId ?? "");
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private importLegacyJson(jsonPath: string): void {
    let parsed: LegacyPersisted;
    try {
      parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as LegacyPersisted;
    } catch (err) {
      throw new Error(`Failed to migrate ${jsonPath}: ${String(err)}`);
    }
    const rows = legacyToStored(parsed);
    const active =
      parsed.activeId && rows.some((row) => row.status === "open" && row.tab.id === parsed.activeId)
        ? parsed.activeId
        : (rows.find((row) => row.status === "open")?.tab.id ?? null);
    this.save({ activeId: active, upserts: rows, removedIds: [] });
  }

  private static openExisting(sqlitePath: string): BoardDb {
    const db = new DatabaseSync(sqlitePath);
    try {
      configure(db);
      const row = db.prepare("SELECT v FROM meta WHERE k = ?").get("schema") as { v: string } | undefined;
      const version = Number(row?.v);
      if (!Number.isInteger(version)) {
        throw new Error(`board.sqlite is missing a schema version (${sqlitePath})`);
      }
      if (version > SCHEMA_VERSION) {
        throw new Error(`board.sqlite schema ${version} is newer than this daemon (${SCHEMA_VERSION})`);
      }
      if (version < SCHEMA_VERSION) {
        throw new Error(`board.sqlite schema ${version} cannot be opened by this daemon`);
      }
      return new BoardDb(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
}

function storedToParams(row: StoredTab): SQLInputValue[] {
  const { tab, status, deletedAt } = row;
  return [
    tab.id,
    tab.key,
    tab.title,
    tab.html,
    JSON.stringify(tab.state ?? {}),
    tab.pinned ? 1 : 0,
    status,
    tab.stripSeq,
    tab.createdAt,
    tab.updatedAt,
    status === "archived" ? (tab.archivedAt ?? tab.updatedAt) : null,
    status === "deleted" ? (deletedAt ?? tab.updatedAt) : null,
    tab.revision,
    tab.stateRevision,
    tab.stateUpdatedAt,
    tab.signalRevision,
    tab.signal ? JSON.stringify(tab.signal) : null,
    JSON.stringify(tab.assets ?? []),
  ];
}

function rowToStored(row: TabRow): StoredTab {
  if (row.status !== "open" && row.status !== "archived" && row.status !== "deleted") {
    throw new Error(`invalid tab status: ${row.status}`);
  }
  let state: BoardState = {};
  try {
    const parsed = JSON.parse(row.state) as unknown;
    if (isPlainObject(parsed)) {
      state = parsed;
    }
  } catch {
    state = {};
  }
  let signal: TabSignal | null = null;
  if (row.signal) {
    try {
      const parsed = JSON.parse(row.signal) as TabSignal;
      if (parsed && typeof parsed.name === "string") {
        signal = {
          name: parsed.name,
          revision: typeof parsed.revision === "number" ? parsed.revision : 0,
          at: typeof parsed.at === "number" ? parsed.at : 0,
        };
      }
    } catch {
      signal = null;
    }
  }
  let assets: Tab["assets"] = [];
  try {
    assets = normalizeTabAssets(JSON.parse(row.assets) as Tab["assets"]);
  } catch {
    assets = [];
  }
  const tab: Tab = {
    id: row.id,
    key: row.key,
    title: row.title,
    html: row.html,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stripSeq: row.strip_seq,
    revision: row.revision,
    state,
    stateRevision: row.state_revision,
    stateUpdatedAt: row.state_updated_at,
    signalRevision: row.signal_revision,
    signal,
    assets,
  };
  if (row.status === "archived") {
    tab.archivedAt = row.archived_at ?? row.updated_at;
  }
  return {
    tab,
    status: row.status,
    ...(row.status === "deleted" ? { deletedAt: row.deleted_at ?? row.updated_at } : {}),
  };
}

export function legacyToStored(parsed: LegacyPersisted): StoredTab[] {
  const rows: StoredTab[] = [];
  let seq = 0;
  const seen = new Set<string>();
  for (const raw of parsed.tabs ?? []) {
    const tab = coerceLegacyTab(raw, ++seq);
    if (!tab || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    delete tab.archivedAt;
    rows.push({ tab, status: "open" });
  }
  for (const entry of parsed.archive ?? []) {
    const tab = coerceLegacyTab(entry.tab, ++seq);
    if (!tab || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    tab.archivedAt = typeof tab.archivedAt === "number" ? tab.archivedAt : tab.updatedAt;
    rows.push({ tab, status: "archived" });
  }
  for (const entry of parsed.deleted ?? []) {
    const tab = coerceLegacyTab(entry.tab, ++seq);
    if (!tab || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    delete tab.archivedAt;
    rows.push({
      tab,
      status: "deleted",
      deletedAt: typeof entry.deletedAt === "number" ? entry.deletedAt : tab.updatedAt,
    });
  }
  return rows;
}

function coerceLegacyTab(raw: LegacyTab | undefined, seq: number): Tab | undefined {
  if (!raw?.id || !raw.html) {
    return undefined;
  }
  const signal =
    raw.signal && typeof raw.signal === "object" && typeof raw.signal.name === "string"
      ? {
          name: raw.signal.name,
          revision: typeof raw.signal.revision === "number" ? raw.signal.revision : 0,
          at: typeof raw.signal.at === "number" ? raw.signal.at : 0,
        }
      : null;
  return {
    id: raw.id,
    key: typeof raw.key === "string" && raw.key ? raw.key : raw.id,
    title: typeof raw.title === "string" && raw.title ? raw.title : "page",
    html: raw.html,
    pinned: Boolean(raw.pinned),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    ...(typeof raw.archivedAt === "number" ? { archivedAt: raw.archivedAt } : {}),
    stripSeq: seq,
    revision: typeof raw.revision === "number" ? raw.revision : 1,
    state: isPlainObject(raw.state) ? raw.state : {},
    stateRevision: typeof raw.stateRevision === "number" ? raw.stateRevision : 0,
    stateUpdatedAt: typeof raw.stateUpdatedAt === "number" ? raw.stateUpdatedAt : 0,
    signalRevision: typeof raw.signalRevision === "number" ? raw.signalRevision : (signal?.revision ?? 0),
    signal,
    assets: normalizeTabAssets(raw.assets),
  };
}

function renameLegacy(jsonPath: string): void {
  const bak = jsonPath + ".bak";
  try {
    if (fs.existsSync(bak)) {
      fs.unlinkSync(bak);
    }
    fs.renameSync(jsonPath, bak);
  } catch {
    /* keep state.json if rename fails; sqlite is already the source of truth */
  }
}

function removeSqlite(sqlitePath: string): void {
  for (const extra of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(sqlitePath + extra);
    } catch {
      /* ignore */
    }
  }
}
