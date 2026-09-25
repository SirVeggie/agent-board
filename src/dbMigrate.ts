import type { DatabaseSync } from "node:sqlite";

/**
 * Additive template tables. Existing board.sqlite files stay on schema
 * version 1; these statements are CREATE IF NOT EXISTS only. See docs/migrations.md.
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
  updated_at INTEGER NOT NULL
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
}

/**
 * Boards created before the hide-from-agent flag have no tabs.agent_hidden.
 * SQLite has no ADD COLUMN IF NOT EXISTS, so check first. See docs/migrations.md.
 */
export function ensureAgentHiddenColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(tabs)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "agent_hidden")) {
    return;
  }
  db.exec("ALTER TABLE tabs ADD COLUMN agent_hidden INTEGER NOT NULL DEFAULT 0");
}
