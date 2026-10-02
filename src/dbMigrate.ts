import type { DatabaseSync } from "node:sqlite";
import { FOLDERS_TABLE_SQL, PAGE_ASSETS_TABLE_SQL, PAGE_LOCAL_TABLE_SQL, TABS_TABLE_V2_SQL } from "./schema.js";

/**
 * Additive template tables; CREATE IF NOT EXISTS only. See docs/migrations.md.
 */
export const TEMPLATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL,
  fields TEXT NOT NULL,
  title_template TEXT,
  initial_state TEXT NOT NULL DEFAULT '{}',
  state_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  builtin_key TEXT,
  builtin_fingerprint TEXT,
  guide TEXT
);
CREATE TABLE IF NOT EXISTS template_bindings (
  tab_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  values_json TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  compatible INTEGER NOT NULL DEFAULT 1,
  reason TEXT
);
`;

export function ensureTemplateSchema(db: DatabaseSync): void {
  db.exec(TEMPLATE_TABLES_SQL);
  ensureTemplateBuiltinColumns(db);
}

/** Additive page asset table; CREATE IF NOT EXISTS only. See docs/migrations.md. */
export function ensurePageAssetSchema(db: DatabaseSync): void {
  db.exec(PAGE_ASSETS_TABLE_SQL);
}

/**
 * Template tables created before built-in templates have no builtin_key / builtin_fingerprint.
 * SQLite has no ADD COLUMN IF NOT EXISTS, so check first. See docs/migrations.md.
 */
function ensureTemplateBuiltinColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(templates)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "builtin_key")) {
    db.exec("ALTER TABLE templates ADD COLUMN builtin_key TEXT");
  }
  if (!columns.some((column) => column.name === "builtin_fingerprint")) {
    db.exec("ALTER TABLE templates ADD COLUMN builtin_fingerprint TEXT");
  }
  if (!columns.some((column) => column.name === "guide")) {
    db.exec("ALTER TABLE templates ADD COLUMN guide TEXT");
  }
}

/**
 * Boards created before the hide-from-agent flag have no tabs.agent_hidden.
 * SQLite has no ADD COLUMN IF NOT EXISTS, so check first. See docs/migrations.md.
 */
function ensureAgentHiddenColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(tabs)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "agent_hidden")) {
    return;
  }
  db.exec("ALTER TABLE tabs ADD COLUMN agent_hidden INTEGER NOT NULL DEFAULT 0");
}

/**
 * Schema 1 → 2 (Library). Rebuilds `tabs` because SQLite cannot change a CHECK
 * constraint: 'archived' becomes 'closed', archived_at becomes closed_at, and the
 * Library columns are added. Every page lands in the root: open tabs first in strip
 * order, then archived pages newest first. See docs/migrations.md.
 */
export function migrateV1ToLibrarySchema(db: DatabaseSync): void {
  ensureTemplateSchema(db);
  ensureAgentHiddenColumn(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_tabs_status_archived;
      DROP INDEX IF EXISTS idx_tabs_status_deleted;
      ALTER TABLE tabs RENAME TO tabs_v1;
    `);
    db.exec(TABS_TABLE_V2_SQL);
    db.exec(FOLDERS_TABLE_SQL);
    db.exec(`
      INSERT INTO tabs (
        id, key, title, html, state, pinned, status, strip_seq,
        created_at, updated_at, closed_at, deleted_at,
        revision, state_revision, state_updated_at, signal_revision, signal, assets, agent_hidden,
        folder_id, lib_pos, deleted_batch, user_title_at
      )
      SELECT
        id, key, title, html, state, pinned,
        CASE status WHEN 'archived' THEN 'closed' ELSE status END,
        strip_seq, created_at, updated_at, archived_at, deleted_at,
        revision, state_revision, state_updated_at, signal_revision, signal, assets, agent_hidden,
        NULL, 0, NULL, NULL
      FROM tabs_v1;
      DROP TABLE tabs_v1;
    `);
    const ordered = [
      ...(db.prepare("SELECT id FROM tabs WHERE status = 'open' ORDER BY pinned DESC, strip_seq").all() as Array<{ id: string }>),
      ...(db.prepare("SELECT id FROM tabs WHERE status = 'closed' ORDER BY closed_at DESC").all() as Array<{ id: string }>),
    ];
    const setPos = db.prepare("UPDATE tabs SET lib_pos = ? WHERE id = ?");
    ordered.forEach((row, index) => setPos.run(index, row.id));
    db.prepare("UPDATE meta SET v = ? WHERE k = ?").run("2", "schema");
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Schema 2 → 3 (the Scribe release): a page's single signal slot becomes an event log.
 * signal_revision / signal are renamed to event_seq / events, and a last signal is kept as the
 * log's first event. Page keys get their scribe: prefix when the store loads (see store.load).
 */
export function migrateV2ToV3(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE tabs RENAME COLUMN signal_revision TO event_seq;
      ALTER TABLE tabs RENAME COLUMN signal TO events;
    `);
    const rows = db.prepare("SELECT id, event_seq, events FROM tabs").all() as Array<{ id: string; event_seq: number; events: string | null }>;
    const update = db.prepare("UPDATE tabs SET events = ? WHERE id = ?");
    for (const row of rows) {
      let events: unknown[] = [];
      try {
        const last = row.events ? (JSON.parse(row.events) as { name?: unknown; at?: unknown } | null) : null;
        if (last && typeof last.name === "string") {
          events = [{ seq: row.event_seq, name: last.name, at: typeof last.at === "number" ? last.at : 0, by: "user" }];
        }
      } catch {
        events = [];
      }
      update.run(JSON.stringify(events), row.id);
    }
    db.prepare("UPDATE meta SET v = ? WHERE k = ?").run("3", "schema");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function ensurePageLocalSchema(db: DatabaseSync): void {
  db.exec(PAGE_LOCAL_TABLE_SQL);
}
